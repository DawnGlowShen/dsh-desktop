/**
 * Install offline plugins into the user's Profile.
 *
 * Unpacked plugin payloads live under `~/.dsh/offline/plugins/<name>` and reach the
 * Profile through a directory symlink in its `node_modules`. The symlink is not a
 * shortcut: Node resolves it to the real directory, then walks *that* directory's parent
 * chain looking for `node_modules`, so a plugin placed outside the application tree
 * resolves its dependencies only if those dependencies also happen to live there.
 * {@link inspectPluginDependencies} reports what will not resolve, so a plugin that
 * cannot work is reported at install time rather than at load time.
 *
 * The Profile also needs pnpm-compatible bookkeeping. Writing the dependency without it
 * would make `profileDependencyMigrationRequired` true on every launch, and the
 * migration would run a real `pnpm install` over the symlinks. With it, the Profile is
 * already consistent and the symlinks are left alone.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { readProfileManifest, writeProfileManifest } from '@deepseek-ai/dsh-app-boot'
import { parseDocument } from 'yaml'
import {
  offlineTarballExists,
  offlineTarballPath,
  readOfflineTarball,
  type OfflineInstallManifest,
  type OfflinePluginEntry,
} from './offline-install-manifest.ts'
import { DIRECTORY_MODE, STAMP_MODE, VERSION_STAMP, installedVersion } from './offline-install-store.ts'
import { unpackPackage } from './offline-install-unpack.ts'

/** The pnpm generation whose hoisted layout the Profile is written for. */
const COMPATIBLE_PNPM_PACKAGE_MANAGER = 'pnpm@11.8.0'

/** Lower-case pnpm generation, as recorded on Windows. */
const COMPATIBLE_PNPM_PACKAGE_MANAGER_WINDOWS = `${COMPATIBLE_PNPM_PACKAGE_MANAGER}+sha512`

/** Layout version pnpm 11 records for the hoisted linker; pnpm rejects a different value. */
const PNPM_MODULES_LAYOUT_VERSION = 5

/** Private hoist pattern pnpm 11 applies while `nodeLinker` is `hoisted`. */
const PNPM_HOIST_PATTERN = ['*'] as const

/** Store generation pnpm 11 puts under its data directory. */
const PNPM_STORE_VERSION = 'v11'

/** One dependency that cannot be resolved for an installed plugin. */
export interface UnresolvedDependency {
  /** Plugin that declares it. */
  readonly plugin: string
  /** Dependency package name. */
  readonly dependency: string
}

/** One plugin that was installed, or why it was not. */
export interface PluginOutcome {
  /** Package name from the manifest. */
  readonly name: string
  /** What happened. `current` means it was already at the manifest version. */
  readonly action: 'installed' | 'current' | 'failed'
  /** Where the plugin payload landed, when it did. */
  readonly directory?: string
  /** Why it failed, when it did. */
  readonly reason?: string
  /** Dependencies this plugin declares that do not resolve, when any. */
  readonly unresolved?: readonly UnresolvedDependency[]
}

/** Where offline plugins live and which Profile consumes them. */
export interface PluginInstallLocation {
  /** Root holding one unpacked directory per plugin, e.g. `~/.dsh/offline/plugins`. */
  readonly installRoot: string
  /** Profile directory whose `node_modules` receives the links. */
  readonly profileDir: string
  /**
   * The running application's own `node_modules`, whose packages are the source of
   * every dependency a plugin cannot reach on its own.
   */
  readonly appModulesDir: string
  /**
   * Tree the offline payload unpacked, for dependencies the application does not carry.
   *
   * Consulted after {@link appModulesDir}: a package the running application already ships
   * is the better source, because it stays version-matched to that application. The
   * payload only has to cover what the App cannot provide.
   */
  readonly offlineModulesDir?: string
  /** Diagnostic prefix for profile manifest errors. */
  readonly binName: string
  /** Host platform; decides the Windows virtual-store limit. */
  readonly platform: NodeJS.Platform
}

/**
 * Compute the target a symlink should store so it resolves from the real directory.
 *
 * The target is relative, so the Profile keeps working when the home directory moves —
 * but it must be derived from the *real* path of the directory holding the link, not the
 * path as written. Resolution applies the stored target to the realpathed parent, so a
 * base that is itself reached through a symlink (`/tmp` on macOS, a linked home
 * directory) would otherwise shift every `..` and land somewhere else entirely.
 *
 * @param link - Path the symlink will occupy.
 * @param target - Absolute path the symlink should resolve to.
 * @returns A relative target valid from the link's real parent directory.
 */
function symlinkTarget(link: string, target: string): string {
  const base = realpathSync(dirname(link))
  return relative(base, realpathSync(target))
}

/**
 * Link a plugin payload into a Profile's `node_modules`.
 *
 * The link target is stored relative to the link, so the Profile keeps working when the
 * home directory is moved or restored from a backup. An existing entry is replaced only
 * when it is a symlink; a real directory belongs to pnpm and is never deleted.
 *
 * @param installDir - Unpacked plugin directory.
 * @param name - Package name, possibly scoped.
 * @param profileDir - Profile receiving the link.
 * @returns The absolute link path.
 */
export function linkPluginIntoProfile(installDir: string, name: string, profileDir: string): string {
  const link = join(profileDir, 'node_modules', name)
  mkdirSync(dirname(link), { recursive: true, mode: DIRECTORY_MODE })

  const existing = lstatSync(link, { throwIfNoEntry: false })
  if (existing !== undefined && existing.isDirectory()) return link
  if (existing !== undefined) rmSync(link, { recursive: true, force: true })
  symlinkSync(symlinkTarget(link, installDir), link, 'dir')
  return link
}

/** Read a package's declared runtime dependencies. */
function declaredDependencies(packageJsonPath: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return {}
    const dependencies = (parsed as Record<string, unknown>).dependencies
    if (typeof dependencies !== 'object' || dependencies === null) return {}
    return dependencies as Record<string, string>
  } catch {
    return {}
  }
}

/**
 * Expose the App's copies of a plugin's dependencies to the Profile.
 *
 * This is what lets a plugin live outside the application tree at all. The plugin's
 * dependencies are looked up from the App's own `node_modules`, because that tree is
 * already complete and already version-matched to the running application; the
 * alternatives — copying packages or vendoring a dependency tree per plugin — would
 * duplicate what is on disk and drift from it at the next application update.
 *
 * Only dependencies the App actually carries are linked. Anything else is left for
 * {@link inspectPluginDependencies} to report, since inventing a source for it would
 * trade a clear report for a package that fails later.
 *
 * @param installDir - Unpacked plugin directory.
 * @param location - Where plugins live and which Profile consumes them.
 * @returns The dependency names linked into the Profile.
 */
export function supplyPluginDependencies(
  installDir: string,
  location: PluginInstallLocation,
): string[] {
  const dependencies = Object.keys(declaredDependencies(join(installDir, 'package.json')))
  if (dependencies.length === 0) return []

  // Application first, payload second: a package the running App already carries is the
  // better source, because it stays matched to that App's own dependency versions.
  const sources = [location.appModulesDir, location.offlineModulesDir]
    .filter((dir): dir is string => dir !== undefined)

  const linked: string[] = []
  for (const dependency of dependencies) {
    const source = sources.map(dir => join(dir, dependency)).find(candidate => existsSync(candidate))
    if (source === undefined) continue
    if (linkDependencyIntoProfile(source, dependency, location.profileDir)) linked.push(dependency)
  }
  return linked
}

/**
 * Report which of a plugin's declared dependencies will not resolve once it is
 * linked into the Profile.
 *
 * Resolution starts from the *link* path inside the Profile, not the unpacked
 * directory, because that is where the loader will start. Node resolves the link to
 * its real directory and keeps both chains: the real directory's parents are usually
 * empty, but the link's parents reach the Profile's own `node_modules`, which is
 * where {@link linkDependencyIntoProfile} puts whatever the App tree cannot supply.
 * Testing from the unpacked directory would report every dependency as missing.
 *
 * @param installDir - Unpacked plugin directory.
 * @param name - Package name, possibly scoped.
 * @param profileDir - Profile the plugin is linked into.
 * @returns One entry per dependency that cannot be found.
 */
export function inspectPluginDependencies(installDir: string, name: string, profileDir: string): UnresolvedDependency[] {
  const dependencies = declaredDependencies(join(installDir, 'package.json'))
  const unresolved: UnresolvedDependency[] = []
  const linkPath = join(profileDir, 'node_modules', name, 'package.json')
  // With no link yet, fall back to the unpacked directory so a caller that inspects
  // before linking still gets an answer rather than a crash.
  const require = createRequire(existsSync(linkPath) ? linkPath : join(installDir, 'package.json'))

  for (const dependency of Object.keys(dependencies)) {
    if (!dependencyIsReachable(require, dependency, profileDir, name)) unresolved.push({ plugin: name, dependency })
  }
  return unresolved
}

/**
 * Whether a dependency can be found from a plugin's location.
 *
 * Deliberately not just `require.resolve(name)`: a package that exports only subpaths,
 * such as `@codemirror/legacy-modes`, rejects its own root with
 * `ERR_PACKAGE_PATH_NOT_EXPORTED` while being installed and importable at the subpaths
 * its dependents actually use. Reporting that as missing sends an operator looking for a
 * package that is already there.
 *
 * So a resolution failure is confirmed against the filesystem: the package is present
 * when a `node_modules` directory on the chain Node walks holds it. That is the same
 * test {@link supplyPluginDependencies} uses to decide what to link, so the two cannot
 * disagree about what "installed" means.
 */
function dependencyIsReachable(
  require: NodeJS.Require,
  dependency: string,
  profileDir: string,
  name: string,
): boolean {
  try {
    require.resolve(dependency)
    return true
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') return false
  }
  for (const origin of [join(profileDir, 'node_modules', name), profileDir]) {
    let directory = origin
    for (;;) {
      if (existsSync(join(directory, 'node_modules', dependency))) return true
      const parent = dirname(directory)
      if (parent === directory) break
      directory = parent
    }
  }
  return false
}

/**
 * Make one dependency reachable from the Profile.
 *
 * A plugin unpacked outside the application tree cannot see that tree's `node_modules`
 * through its own parent chain, so anything the tree already carries is linked into the
 * Profile instead — where the plugin's link *can* see it. Pointing at the App copy keeps
 * the dependency tied to the application version rather than freezing a second copy.
 *
 * An entry that already exists is left alone: pnpm owns the Profile's `node_modules`
 * once it has run, and replacing its entries would describe a different install than the
 * one it recorded.
 *
 * @param source - Absolute path of the package to expose, usually in the App tree.
 * @param dependency - Package name, possibly scoped.
 * @param profileDir - Profile whose `node_modules` receives the link.
 * @returns Whether a link was created.
 */
export function linkDependencyIntoProfile(source: string, dependency: string, profileDir: string): boolean {
  const link = join(profileDir, 'node_modules', dependency)
  if (lstatSync(link, { throwIfNoEntry: false }) !== undefined) return false
  mkdirSync(dirname(link), { recursive: true, mode: DIRECTORY_MODE })
  // A relative target keeps the Profile valid when the home directory moves.
  symlinkSync(symlinkTarget(link, source), link, 'dir')
  return true
}

/**
 * Resolve the pnpm data directory the way pnpm 11 does on this host.
 *
 * pnpm checks `PNPM_HOME`, then `XDG_DATA_HOME`, then a platform default, and hangs both
 * its global install root and its content-addressable store off the result. Mirroring that
 * order keeps a fresh Profile pointing at the store pnpm is about to use; a `store-dir` set
 * in pnpm's own configuration is out of reach here, so such a Profile needs pnpm to write
 * the module record itself.
 *
 * @param platform - Host platform.
 * @returns Absolute data directory pnpm resolves for the current process.
 */
function pnpmDataDirectory(platform: NodeJS.Platform): string {
  const env = process.env
  if (env.PNPM_HOME !== undefined && env.PNPM_HOME !== '') return env.PNPM_HOME
  if (env.XDG_DATA_HOME !== undefined && env.XDG_DATA_HOME !== '') return join(env.XDG_DATA_HOME, 'pnpm')
  if (platform === 'darwin') return join(homedir(), 'Library/pnpm')
  if (platform !== 'win32') return join(homedir(), '.local/share/pnpm')
  if (env.LOCALAPPDATA !== undefined && env.LOCALAPPDATA !== '') return join(env.LOCALAPPDATA, 'pnpm')
  return join(homedir(), '.pnpm')
}

/** Render a module record that satisfies every field pnpm 11 validates. */
function moduleRecord(expectedManager: string, expectedLimit: number, storeDir: string): string {
  return [
    `hoistPattern: ${JSON.stringify(PNPM_HOIST_PATTERN)}`,
    `layoutVersion: ${PNPM_MODULES_LAYOUT_VERSION}`,
    `nodeLinker: hoisted`,
    `packageManager: ${expectedManager}`,
    `publicHoistPattern: []`,
    `storeDir: ${JSON.stringify(storeDir)}`,
    `virtualStoreDirMaxLength: ${expectedLimit}`,
    '',
  ].join('\n')
}

/**
 * Write the pnpm bookkeeping a Profile needs to look already-installed.
 *
 * Three files make `profileDependencyMigrationRequired` false: `pnpm-workspace.yaml`
 * pinning the hoisted linker, `node_modules/.modules.yaml` describing the layout, and a
 * lockfile whose settings opt out of peer auto-install.
 *
 * `.modules.yaml` also has to survive pnpm's own validation, not only that check. pnpm 11
 * refuses a record whose `hoistPattern`, `layoutVersion` or `storeDir` differs from what
 * it would write, and reports the difference as a hint to run `pnpm install` — which
 * would flatten the links written here. A new record therefore carries those fields with
 * pnpm's defaults: the hoisted linker hoists `*` privately, the layout version is the one
 * this module pins, and the store sits under the data directory pnpm derives from
 * `PNPM_HOME`, `XDG_DATA_HOME` or a platform default (see {@link pnpmDataDirectory}).
 *
 * Existing files are corrected only where a field the launcher or pnpm checks is missing,
 * so a record pnpm wrote keeps its own values — including a `storeDir` that a configured
 * `store-dir` moved away from the default. That keeps a layout pnpm produced usable
 * instead of discarding it: an incompatible record makes pnpm refuse the next install and
 * makes the launcher reinstall the Profile, flattening the links written here.
 *
 * @param profileDir - Profile directory to make consistent.
 * @param platform - Host platform; decides the Windows virtual-store limit and default store.
 * @returns The files that were created or corrected.
 */
export function writeProfilePnpmMetadata(profileDir: string, platform: NodeJS.Platform): string[] {
  const written: string[] = []

  const workspace = join(profileDir, 'pnpm-workspace.yaml')
  if (!existsSync(workspace)) {
    writeFileSync(workspace, 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
    written.push(workspace)
  }

  const modulesDir = join(profileDir, 'node_modules')
  mkdirSync(modulesDir, { recursive: true, mode: DIRECTORY_MODE })
  const modulesState = join(modulesDir, '.modules.yaml')
  const expectedLimit = platform === 'win32' ? 60 : 120
  const expectedManager = platform === 'win32'
    ? COMPATIBLE_PNPM_PACKAGE_MANAGER_WINDOWS
    : COMPATIBLE_PNPM_PACKAGE_MANAGER
  const expectedStore = join(pnpmDataDirectory(platform), 'store', PNPM_STORE_VERSION)
  if (!existsSync(modulesState)) {
    writeFileSync(modulesState, moduleRecord(expectedManager, expectedLimit, expectedStore))
    written.push(modulesState)
  } else {
    const reconciled = reconcileModulesState(
      readFileSync(modulesState, 'utf8'),
      expectedManager,
      expectedLimit,
      expectedStore,
    )
    if (reconciled !== undefined) {
      writeFileSync(modulesState, reconciled)
      written.push(modulesState)
    }
  }

  const lockfile = join(profileDir, 'pnpm-lock.yaml')
  if (!existsSync(lockfile)) {
    writeFileSync(lockfile, [
      `lockfileVersion: '9.0'`,
      '',
      `settings:`,
      `  autoInstallPeers: false`,
      `  excludeLinksFromLockfile: false`,
      '',
    ].join('\n'))
    written.push(lockfile)
  }

  return written
}

/**
 * Merge the layout fields the launcher and pnpm check into an existing module record.
 *
 * A record that already satisfies both is left byte-for-byte alone, so this never rewrites
 * a file pnpm just wrote. A malformed one is replaced outright, because there is nothing
 * worth preserving in a document that cannot be read.
 *
 * @param contents - Current text of `.modules.yaml`.
 * @param expectedManager - Package manager string the launcher accepts.
 * @param expectedLimit - Virtual-store path limit for this platform.
 * @param expectedStore - Store directory pnpm would use on this host.
 * @returns Replacement text, or undefined when the record already satisfies the check.
 */
function reconcileModulesState(
  contents: string,
  expectedManager: string,
  expectedLimit: number,
  expectedStore: string,
): string | undefined {
  let document: ReturnType<typeof parseDocument>
  try {
    document = parseDocument(contents)
    if (document.errors.length > 0) throw new Error('unparsable')
  } catch {
    return moduleRecord(expectedManager, expectedLimit, expectedStore)
  }

  const missing = (field: string): boolean => {
    const value = document.get(field)
    return value === undefined || value === null
  }

  let changed = false
  if (document.get('nodeLinker') !== 'hoisted') {
    document.set('nodeLinker', 'hoisted')
    changed = true
  }
  // Keep the version pnpm recorded when it is already acceptable; only a generation the
  // launcher rejects (or a missing field) is replaced.
  if (!compatiblePnpmPackageManager(document.get('packageManager'))) {
    document.set('packageManager', expectedManager)
    changed = true
  }
  if (document.get('virtualStoreDirMaxLength') !== expectedLimit) {
    document.set('virtualStoreDirMaxLength', expectedLimit)
    changed = true
  }
  // pnpm validates these three as well. A record missing them is accepted by the launcher
  // but rejected by `pnpm install`, which is the failure this module exists to prevent.
  if (missing('hoistPattern')) {
    document.set('hoistPattern', [...PNPM_HOIST_PATTERN])
    changed = true
  }
  if (missing('layoutVersion')) {
    document.set('layoutVersion', PNPM_MODULES_LAYOUT_VERSION)
    changed = true
  }
  if (missing('storeDir')) {
    document.set('storeDir', expectedStore)
    changed = true
  }
  return changed ? document.toString() : undefined
}

/**
 * Return whether private module metadata was written by a compatible pnpm generation.
 *
 * Mirrors the launcher's own check so this module can tell, without running pnpm, whether
 * a Profile would be reinstalled on the next start.
 *
 * @param value - The `packageManager` field read from `.modules.yaml`.
 * @returns True when the value names pnpm 10 or newer.
 */
function compatiblePnpmPackageManager(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const match = /^pnpm@(\d+)(?:\.|$)/.exec(value)
  return match !== null && Number(match[1]) >= 10
}

/**
 * Record installed plugins in the Profile's manifest.
 *
 * Both a `dependencies` entry and a `dsh.profile.bundles` entry are needed: the
 * dependency is what resolution reads, and the bundle list is what the plugin page reads
 * — a plugin present only as a dependency does not appear there at all.
 *
 * @param profileDir - Profile to update.
 * @param binName - Diagnostic prefix for manifest errors.
 * @param entries - Installations to record, keyed by package name.
 * @returns The names that were added, in the order given.
 */
export function registerPluginsInProfileManifest(
  profileDir: string,
  binName: string,
  entries: readonly { readonly name: string; readonly version: string; readonly directory: string }[],
): string[] {
  if (entries.length === 0) return []
  const manifest = readProfileManifest(binName, profileDir) as Record<string, unknown>
  const dependencies = { ...(manifest.dependencies ?? {}) } as Record<string, string>
  const added: string[] = []
  for (const entry of entries) {
    dependencies[entry.name] = `file:${entry.directory}`
    added.push(entry.name)
  }

  const dsh = { ...(manifest.dsh ?? {}) } as Record<string, unknown>
  const profile = { ...(dsh.profile ?? {}) } as Record<string, unknown>
  const bundles = Array.isArray(profile.bundles) ? [...profile.bundles] as string[] : []
  for (const entry of entries) {
    if (!bundles.includes(entry.name)) bundles.push(entry.name)
  }
  profile.bundles = bundles
  dsh.profile = profile

  writeProfileManifest(profileDir, { ...manifest, dependencies, dsh })
  return added
}

/**
 * Install one offline plugin: unpack it, link it into the Profile, supply whatever its
 * dependencies need, then report anything still unresolved.
 *
 * @param archive - Compressed npm package tarball.
 * @param entry - Plugin declaration from the manifest.
 * @param location - Where plugins live and which Profile consumes them.
 * @returns What happened, including unresolved dependencies.
 */
export function installPlugin(
  archive: Buffer,
  entry: OfflinePluginEntry,
  location: PluginInstallLocation,
): PluginOutcome {
  const root = join(location.installRoot, entry.name)
  try {
    const alreadyCurrent = installedVersion(root) === entry.version
    unpackPackage(archive, root)
    writeFileSync(join(root, VERSION_STAMP), `${entry.version}\n`, { mode: STAMP_MODE })
    linkPluginIntoProfile(root, entry.name, location.profileDir)
    supplyPluginDependencies(root, location)
    return {
      name: entry.name,
      action: alreadyCurrent ? 'current' : 'installed',
      directory: root,
      unresolved: inspectPluginDependencies(root, entry.name, location.profileDir),
    }
  } catch (cause) {
    return {
      name: entry.name,
      action: 'failed',
      reason: cause instanceof Error ? cause.message : String(cause),
    }
  }
}

/**
 * Install every plugin the manifest declares and record the successes.
 *
 * A plugin that fails is skipped without stopping the others, and only fully installed
 * plugins are registered in the Profile manifest — recording one that never landed
 * would break the next launch's bundle resolution.
 *
 * @param manifest - Validated manifest.
 * @param location - Where plugins live and which Profile consumes them.
 * @returns One outcome per declared plugin, in manifest order.
 */
export function installManifestPlugins(
  manifest: OfflineInstallManifest,
  location: PluginInstallLocation,
): PluginOutcome[] {
  const outcomes: PluginOutcome[] = []
  const installed: { name: string; version: string; directory: string }[] = []

  for (const entry of manifest.plugins) {
    const tarball = offlineTarballPath(manifest, entry.tarball)
    if (!offlineTarballExists(manifest, entry.tarball)) {
      outcomes.push({ name: entry.name, action: 'failed', reason: `tarball is missing: ${tarball}` })
      continue
    }
    let archive: Buffer
    try {
      archive = readOfflineTarball(manifest, entry.tarball)
    } catch (cause) {
      outcomes.push({
        name: entry.name,
        action: 'failed',
        reason: `cannot read ${tarball}: ${cause instanceof Error ? cause.message : String(cause)}`,
      })
      continue
    }
    const outcome = installPlugin(archive, entry, location)
    outcomes.push(outcome)
    if (outcome.action !== 'failed' && outcome.directory !== undefined) {
      installed.push({ name: entry.name, version: entry.version, directory: outcome.directory })
    }
  }

  if (installed.length > 0) {
    try {
      writeProfilePnpmMetadata(location.profileDir, location.platform)
      registerPluginsInProfileManifest(location.profileDir, location.binName, installed)
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause)
      // The payloads are on disk but the Profile does not know about them; say so rather
      // than reporting a success the next launch will not see.
      outcomes.push({
        name: '(profile manifest)',
        action: 'failed',
        reason: `plugins were unpacked but the Profile could not be updated: ${reason}`,
      })
    }
  }

  return outcomes
}
