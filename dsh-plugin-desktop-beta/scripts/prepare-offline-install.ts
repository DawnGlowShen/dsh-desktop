/**
 * Assemble the offline install payload the packaged application carries beside itself.
 *
 * The installer reads `<resourcesPath>/offline-install/manifest.json` at launch, so this
 * copies an authored payload tree into the build-owned directory `extraResources` picks
 * up, verifying it on the way: a manifest that names a tarball the package does not carry
 * would fail silently on a user's machine, long after the build that shipped it.
 *
 * The authored tree lives at `<repoRoot>/vendor/offline-install/` and is tracked in git,
 * so changing what a release ships is a file change rather than a code change. Every
 * Desktop package ships the same payload, so it is authored once beside them rather than
 * copied into each: two copies would drift the moment only one of them is updated, and
 * nothing in the build would notice.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OFFLINE_INSTALL_DIRECTORY, OFFLINE_INSTALL_MANIFEST, OFFLINE_INSTALL_MANIFEST_VERSION } from '../src/offline-install-manifest.ts'

/**
 * Path of the payload shared by every Desktop package, relative to the repository root.
 *
 * One level above a Desktop package rather than inside it: the payload is identical for
 * every package, and a copy per package is a copy that can silently fall out of date.
 */
export const OFFLINE_INSTALL_SOURCE = join('vendor', OFFLINE_INSTALL_DIRECTORY)

/** One plugin the payload ships. */
interface PayloadPluginEntry {
  readonly name: string
  readonly version: string
  readonly tarball: string
}

/** One CLI the payload ships. */
interface PayloadCliEntry extends PayloadPluginEntry {
  readonly executable: string
}

/** The shared dependency tree an authored payload may carry. */
interface PayloadDependencyEntry {
  readonly version: string
  readonly tarball: string
}

/** An authored payload manifest, before the on-disk shape is attached. */
interface PayloadManifest {
  readonly version: number
  readonly plugins: readonly PayloadPluginEntry[]
  readonly clis: readonly PayloadCliEntry[]
  readonly dependencies?: PayloadDependencyEntry
}

/**
 * Suffix marking one part of an archive split across files.
 *
 * GitHub rejects any single file above 100 MB and the payload contains two that exceed
 * it, so those ship as parts and are rejoined on read. Must match
 * `OFFLINE_TARBALL_PART_SUFFIX` in `src/offline-install-manifest.ts`.
 */
export const OFFLINE_TARBALL_PART_SUFFIX = '.part-'

/** Whether a payload directory entry is one part of a split archive. */
function isTarballPart(entry: string): boolean {
  return entry.includes(OFFLINE_TARBALL_PART_SUFFIX)
}

/** The archive a part belongs to, e.g. `x.tgz` from `x.tgz.part-aa`. */
function tarballOfPart(entry: string): string {
  const at = entry.indexOf(OFFLINE_TARBALL_PART_SUFFIX)
  return at === -1 ? entry : entry.slice(0, at)
}

/**
 * File naming the CLI artifacts this payload ships.
 *
 * Separate from `manifest.json` because the two sections differ in scope: plugins and
 * the dependency tree are identical on every platform, while CLI artifacts are native
 * binaries that cannot be shared. The build merges this file with `manifest.json`,
 * leaving one manifest that names only the target being packaged — so the installer
 * itself never has to reason about platforms.
 */
const OFFLINE_CLI_MANIFEST_PATTERN = 'manifest.clis.<target>.json'

export function offlineCliManifest(target: string): string {
  return `manifest.clis.${target}.json`
}

/** Targets a CLI payload can be authored for. */
export const OFFLINE_CLI_TARGETS = ['darwin-universal', 'linux-x64', 'win32-x64'] as const

/** One CLI target. */
export type OfflineCliTarget = (typeof OFFLINE_CLI_TARGETS)[number]

/**
 * Whether a directory entry is host filesystem metadata rather than payload.
 *
 * `.DS_Store` and the AppleDouble `._` siblings are created by macOS, never authored,
 * and excluded from git; treating them as payload would fail a build for having had a
 * Finder window open on the tree.
 */
/**
 * Whether a directory entry is a CLI artifact, split or whole.
 *
 * The split form must be recognized too: an oversized CLI archive ships as
 * `<name>.tgz.part-aa` and so does not end with its target suffix, which would leave
 * every other platform's CLI parts looking like unaccounted-for files.
 */
function isCliArtifactOrPart(name: string): boolean {
  return isCliArtifact(isTarballPart(name) ? tarballOfPart(name) : name)
}

/** Whether a directory entry is one platform's CLI manifest. */
function isCliManifest(name: string): boolean {
  return OFFLINE_CLI_TARGETS.some(target => name === offlineCliManifest(target))
}

/**
 * Whether a tarball is a CLI artifact this build is not shipping.
 *
 * CLI artifacts are named `<cli>-<version>-<target>.tgz` and every platform's are
 * tracked together, so the ones for other targets are expected orphans rather than
 * dead weight. Named with a trailing `-<target>.tgz` so a plugin tarball that happens
 * to share the prefix is still accounted for.
 */
function isCliArtifact(name: string): boolean {
  return OFFLINE_CLI_TARGETS.some(target => name.endsWith(`-${target}.tgz`))
}

function isHostMetadata(name: string): boolean {
  return name === '.DS_Store' || name.startsWith('._')
}

/** Every tarball a manifest names, whichever section it came from. */
function namedTarballs(manifest: PayloadManifest): string[] {
  return [
    ...manifest.plugins.map(entry => entry.tarball),
    ...manifest.clis.map(entry => entry.tarball),
    ...(manifest.dependencies === undefined ? [] : [manifest.dependencies.tarball]),
  ]
}

/**
 * Where the payload assembler reads from and writes to.
 *
 * `source` is the shared payload at the repository root; `prepared` is build-owned and
 * lives inside the package, where `extraResources` picks it up.
 */
export function offlineInstallBuildPaths(desktopRoot: string): { readonly source: string; readonly prepared: string } {
  return {
    source: resolve(desktopRoot, '..', OFFLINE_INSTALL_SOURCE),
    prepared: join(desktopRoot, '.desktop-build', OFFLINE_INSTALL_DIRECTORY),
  }
}

/**
 * Throw unless the shared payload directory exists.
 *
 * Its absence is never deliberate: it means the checkout is incomplete or the shared path
 * moved. Without this check either case would assemble an application that preinstalls
 * nothing and log it as "packaging none" — the same line a build that deliberately ships
 * no payload prints, leaving nothing downstream able to tell the two apart.
 *
 * Judged by what the path is rather than that it is occupied: `existsSync` is true for a
 * file too, and a file cannot hold the manifest, so testing existence alone would restore
 * exactly the silent downgrade this check exists to prevent.
 */
function requirePayloadDirectory(source: string): void {
  const entry = existsSync(source) ? statSync(source) : undefined
  if (entry?.isDirectory() !== true) {
    throw new Error(
      `offline install: no payload directory at ${source}; `
        + `the payload shared by every Desktop package lives there, and a build without it `
        + `would ship an application that preinstalls nothing`,
    )
  }
}

/** Throw unless `value` is a usable path inside the payload. */
function requireRelativePath(value: unknown, field: string, owner: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`offline install: ${owner} has no ${field}`)
  }
  // Judged by path segments, never by `resolve`: `resolve` is relative to the working
  // directory, so it turns `../../x` into an absolute path that looks contained.
  if (value.startsWith('/') || value.split('/').includes('..')) {
    throw new Error(`offline install: ${owner} names ${field} outside the payload: ${value}`)
  }
  return value
}

/** Throw unless `value` is a non-empty string. */
function requireText(value: unknown, field: string, owner: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(`offline install: ${owner} has no ${field}`)
  return value
}

/**
 * Parse and validate an authored manifest.
 *
 * Deliberately strict where the runtime reader is lenient: the runtime must survive a
 * damaged payload and still reach a window, while a build that cannot produce a usable
 * payload should stop before it ships one.
 * @param raw - Parsed JSON of the authored manifest.
 * @returns The validated entries.
 */
export function parsePayloadManifest(raw: unknown): PayloadManifest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('offline install: manifest is not an object')
  }
  const document = raw as Record<string, unknown>
  if (document.version !== OFFLINE_INSTALL_MANIFEST_VERSION) {
    throw new Error(
      `offline install: manifest version ${String(document.version)} is not ${OFFLINE_INSTALL_MANIFEST_VERSION}`,
    )
  }
  const plugins = document.plugins ?? []
  const clis = document.clis ?? []
  if (!Array.isArray(plugins)) throw new Error('offline install: plugins is not a list')
  if (!Array.isArray(clis)) throw new Error('offline install: clis is not a list')

  return {
    version: OFFLINE_INSTALL_MANIFEST_VERSION,
    ...(document.dependencies === undefined
      ? {}
      : { dependencies: parseDependencyEntry(document.dependencies) }),
    plugins: plugins.map((value, index): PayloadPluginEntry => {
      const owner = `plugin #${index + 1}`
      if (typeof value !== 'object' || value === null) throw new Error(`offline install: ${owner} is not an object`)
      const entry = value as Record<string, unknown>
      const name = requireText(entry.name, 'name', owner)
      return {
        name,
        version: requireText(entry.version, 'version', name),
        tarball: requireRelativePath(entry.tarball, 'tarball', name),
      }
    }),
    clis: clis.map((value, index): PayloadCliEntry => {
      const owner = `CLI #${index + 1}`
      if (typeof value !== 'object' || value === null) throw new Error(`offline install: ${owner} is not an object`)
      const entry = value as Record<string, unknown>
      const name = requireText(entry.name, 'name', owner)
      return {
        name,
        version: requireText(entry.version, 'version', name),
        tarball: requireRelativePath(entry.tarball, 'tarball', name),
        executable: requireRelativePath(entry.executable, 'executable', name),
      }
    }),
  }
}

/** Parse the optional shared dependency tree, or report why it is unusable. */
function parseDependencyEntry(value: unknown): PayloadDependencyEntry {
  if (typeof value !== 'object' || value === null) {
    throw new Error('offline install: dependencies is not an object')
  }
  const entry = value as Record<string, unknown>
  return {
    version: requireText(entry.version, 'version', 'dependencies'),
    tarball: requireRelativePath(entry.tarball, 'tarball', 'dependencies'),
  }
}

/** What one prepared payload contains. */
export interface PreparedOfflineInstall {
  /** Build-owned directory `extraResources` copies. */
  readonly directory: string
  /** Tarballs copied into it. */
  readonly tarballs: readonly string[]
}

/**
 * Read one platform's authored CLI payload.
 *
 * CLIs are platform-specific native binaries, so a single payload cannot serve every
 * platform the way the plugin section does. Each target therefore authors its own
 * `cli/<target>/` directory, and only the target being packaged is merged in.
 */
function readCliTarget(source: string, target: string): readonly PayloadCliEntry[] {
  const manifestPath = join(source, offlineCliManifest(target))
  if (!existsSync(manifestPath)) {
    throw new Error(
      `offline install: no CLI payload authored at ${manifestPath}; `
        + `run scripts/prepare-offline-clis.mjs --target ${target}`,
    )
  }
  const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as { target?: unknown; clis?: unknown }
  // The file is one target's answer to "which native binaries does this build ship",
  // so a mismatch means the payload was built for another platform and its artifacts
  // would be installed on a machine that cannot run them.
  if (raw.target !== target) {
    throw new Error(
      `offline install: ${manifestPath} describes ${String(raw.target)}, not ${target}; `
        + `re-run scripts/prepare-offline-clis.mjs --target ${target}`,
    )
  }
  const parsed = parsePayloadManifest({ version: 1, plugins: [], clis: raw.clis ?? [] })
  return parsed.clis
}

/**
 * Verify and assemble the payload for packaging.
 *
 * The shared payload directory must exist: a missing one means the checkout is incomplete
 * or the shared path moved, and stopping beats shipping an application that preinstalls
 * nothing. Within it, an absent authored manifest is not an error — a build that ships no
 * offline payload is a supported configuration, and the installer treats a missing
 * manifest as a no-op. When one is present, every tarball it names must actually be there.
 *
 * The authored plugin section is platform-independent, but the CLI section is not: native
 * binaries cannot be shared across platforms. The platform's `cli/<target>/` section is
 * therefore merged in here, and the single merged manifest that ships is what the runtime
 * reads — so the installer itself needs no notion of platforms.
 *
 * @param desktopRoot - Desktop package root.
 * @param log - Progress sink.
 * @param target - CLI payload to merge; omit to package the plugin section alone.
 * @returns The prepared directory and what it holds, or undefined when nothing is authored.
 */
export function prepareOfflineInstallPayload(
  desktopRoot: string,
  log: (message: string) => void = () => {},
  target?: string,
): PreparedOfflineInstall | undefined {
  const { source, prepared } = offlineInstallBuildPaths(desktopRoot)
  requirePayloadDirectory(source)
  const sourceManifest = join(source, OFFLINE_INSTALL_MANIFEST)

  rmSync(prepared, { recursive: true, force: true })
  if (!existsSync(sourceManifest)) {
    log(`offline install: no authored payload at ${source}; packaging none`)
    return undefined
  }

  const authored = parsePayloadManifest(JSON.parse(readFileSync(sourceManifest, 'utf8')) as unknown)
  // The authored CLI section must stay empty: a CLI there would be platform-independent
  // by position but not by nature, and would ship to every platform.
  if (authored.clis.length > 0) {
    throw new Error(
      `offline install: ${sourceManifest} declares ${String(authored.clis.length)} CLI(s) directly; `
        + `CLIs are platform-specific and belong in ${OFFLINE_CLI_MANIFEST_PATTERN}, `
        + `written by scripts/prepare-offline-clis.mjs`,
    )
  }
  const clis = target === undefined ? [] : readCliTarget(source, target)
  const manifest = { ...authored, clis }
  const named = namedTarballs(manifest)

  mkdirSync(prepared, { recursive: true })
  for (const tarball of named) {
    const origin = join(source, tarball)
    // An archive ships either whole or in parts, never both: keeping both would double
    // the payload, and a reader prefers the whole file, so a stale one left beside fresh
    // parts would silently win.
    const parts = readdirSync(source).filter(entry => entry.startsWith(`${tarball}${OFFLINE_TARBALL_PART_SUFFIX}`)).sort()
    if (existsSync(origin)) {
      if (!statSync(origin).isFile()) throw new Error(`offline install: ${tarball} is not a file`)
      if (parts.length > 0) {
        throw new Error(`offline install: ${tarball} is present both whole and in ${String(parts.length)} part(s)`)
      }
      mkdirSync(dirname(join(prepared, tarball)), { recursive: true })
      copyFileSync(origin, join(prepared, tarball))
      continue
    }
    if (parts.length === 0) {
      throw new Error(`offline install: manifest names ${tarball}, which is not in ${source}`)
    }
    // The parts are what get installed, so every one of them must reach the package.
    for (const part of parts) {
      if (!statSync(join(source, part)).isFile()) throw new Error(`offline install: ${part} is not a file`)
      copyFileSync(join(source, part), join(prepared, part))
    }
  }

  // Every file in the authored root must be accounted for, so a tarball the manifest
  // forgot is reported here rather than shipping as dead weight. The `cli/` tree is
  // excluded: it is authored per target on purpose, so most of it is not this build's.
  //
  // Finder metadata is skipped rather than reported. It is git-ignored, so it is never
  // meant to ship, but macOS recreates it whenever the directory is browsed — failing
  // the build over it would make an unrelated Finder window break a release.
  for (const entry of readdirSync(source)) {
    if (entry === OFFLINE_INSTALL_MANIFEST || isCliManifest(entry)) continue
    if (isHostMetadata(entry)) continue
    // Every other target's CLI artifacts sit in this same directory and are named by
    // the CLI manifest rather than by the merged one, so they are not this build's to
    // account for.
    if (!named.includes(entry) && isCliArtifactOrPart(entry)) continue
    // A part belongs to the archive the manifest names; only the whole name is listed.
    if (isTarballPart(entry) && named.includes(tarballOfPart(entry))) continue
    if (!named.includes(entry)) {
      throw new Error(`offline install: ${entry} is in ${source} but no manifest entry names it`)
    }
  }

  // Written rather than copied: the authored manifest holds no CLI section, and the
  // merged one the installer reads does.
  writeFileSync(join(prepared, OFFLINE_INSTALL_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`)
  log(
    `offline install: prepared ${String(manifest.plugins.length)} plugin(s) and `
      + `${String(clis.length)} CLI(s)${target === undefined ? '' : ` for ${target}`} and `
      + `${manifest.dependencies === undefined ? 'no' : 'a'} dependency tree `
      + `from ${String(named.length)} tarball(s)`,
  )
  return { directory: prepared, tarballs: [...new Set(named)] }
}

/**
 * Re-check the prepared payload right before electron-builder copies it.
 *
 * The payload was assembled before the package gates ran, so a gate that failed and left
 * a partial tree would otherwise be packaged as if it were complete. The shared payload
 * directory is re-checked here as well: assembly refuses a missing one, and a packaging
 * step that somehow ran without it must not pass this check either.
 * @param desktopRoot - Desktop package root.
 * @returns The tarballs the prepared payload carries, empty when none is prepared.
 */
export function verifyPreparedOfflineInstall(desktopRoot: string): readonly string[] {
  const { source, prepared } = offlineInstallBuildPaths(desktopRoot)
  requirePayloadDirectory(source)
  const preparedManifest = join(prepared, OFFLINE_INSTALL_MANIFEST)
  if (!existsSync(preparedManifest)) {
    // Nothing was authored, so nothing was packaged; that is not a failure.
    if (existsSync(join(source, OFFLINE_INSTALL_MANIFEST))) {
      throw new Error(`offline install: ${source} has a manifest but ${prepared} does not`)
    }
    return []
  }

  const manifest = parsePayloadManifest(JSON.parse(readFileSync(preparedManifest, 'utf8')) as unknown)
  const named = [...new Set(namedTarballs(manifest))]
  for (const tarball of named) {
    if (existsSync(join(prepared, tarball))) continue
    const parts = readdirSync(prepared).filter(entry => entry.startsWith(`${tarball}${OFFLINE_TARBALL_PART_SUFFIX}`))
    if (parts.length === 0) {
      throw new Error(`offline install: prepared payload is missing ${tarball}`)
    }
  }
  return named
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  try {
    const argv = process.argv.slice(2)
    const declared = argv.indexOf('--target')
    if (declared !== -1 && argv[declared + 1] === undefined) {
      throw new Error('--target requires a value such as darwin-universal')
    }
    const target = declared === -1 ? undefined : argv[declared + 1]
    prepareOfflineInstallPayload(
      dirname(resolve(invokedPath, '..')),
      message => { console.log(message) },
      target,
    )
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
