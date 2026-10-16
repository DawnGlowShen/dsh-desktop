/**
 * Offline preinstall manifest: what a shipped application installs into a Profile on
 * first launch, without a network.
 *
 * The manifest rides beside the packaged application as an extra resource
 * (`Resources/offline-install/manifest.json`), together with the tarballs it names.
 * It is deliberately the only source of truth for "what gets preinstalled": editing
 * the manifest and dropping in a new tarball is the whole update procedure — no
 * Desktop source change, no rebuild of the application's own code.
 *
 * Reading is total: every failure — a missing file, malformed JSON, an entry that
 * does not make sense — resolves to `undefined` and one logged reason rather than an
 * exception. A first launch must still reach a window when the manifest is broken.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** Directory name of the offline install payload inside Electron's resources directory. */
export const OFFLINE_INSTALL_DIRECTORY = 'offline-install'

/** File name of the manifest inside the payload directory. */
export const OFFLINE_INSTALL_MANIFEST = 'manifest.json'

/** Current manifest schema version; a manifest declaring anything else is refused. */
export const OFFLINE_INSTALL_MANIFEST_VERSION = 1

/** One plugin a Profile should carry, and the tarball that provides it. */
export interface OfflinePluginEntry {
  /** Package name, e.g. `dsh-mnemon` or `@hyzyn/dsh-codegraph`. */
  readonly name: string
  /** Version the tarball provides; compared against what the Profile already has. */
  readonly version: string
  /** Tarball path, relative to the payload directory. */
  readonly tarball: string
}

/** One command line tool the Profile should expose on the user's PATH. */
export interface OfflineCliEntry {
  /** Command name, e.g. `codegraph`. */
  readonly name: string
  /** Version the tarball provides; informational for the install decision. */
  readonly version: string
  /** Tarball path, relative to the payload directory. */
  readonly tarball: string
  /** Executable inside the unpacked tarball, relative to its root, e.g. `bin/codegraph`. */
  readonly executable: string
}

/**
 * One archive holding the `node_modules` tree a plugin's dependencies live in.
 *
 * A plugin unpacked beside the DSH home resolves its dependencies through the ordinary
 * upward search, so a single tree at `offline/node_modules` serves every plugin at once.
 * One archive rather than hundreds of packages keeps the payload a single compressed
 * blob and keeps the manifest honest about what it carries.
 */
export interface OfflineDependencyPayload {
  /** Version of the tree, compared against what is already unpacked. */
  readonly version: string
  /** Archive path, relative to the payload directory. */
  readonly tarball: string
}

/** A validated manifest and the directory that holds its tarballs. */
export interface OfflineInstallManifest {
  /** Absolute path of the payload directory, used to resolve tarball paths. */
  readonly directory: string
  /** Plugins to install into the active Profile. */
  readonly plugins: readonly OfflinePluginEntry[]
  /** Command line tools to expose. */
  readonly clis: readonly OfflineCliEntry[]
  /** The shared dependency tree, when the payload ships one. */
  readonly dependencies?: OfflineDependencyPayload
}

/** Logger surface; the desktop shell's stderr logger has no info channel, so it is optional. */
export interface OfflineInstallLogger {
  readonly info?: (message: string) => void
  readonly error: (message: string) => void
}

/** Where the manifest lives and how to report what was found. */
export interface ReadOfflineInstallManifestOptions {
  /** Electron's resources directory; the payload rides beside the application. */
  readonly resourcesPath: string
  /** Package root, used to locate a development tree's prepared payload. */
  readonly packageRoot: string
  /** Whether Electron runs the packaged application. */
  readonly packaged: boolean
  /** Environment; `DSH_DESKTOP_OFFLINE_INSTALL_DIR` overrides the payload directory. */
  readonly environment?: NodeJS.ProcessEnv
  /** Sink for the reason a manifest was refused. */
  readonly logger: OfflineInstallLogger
}

/** Whether a value is a non-empty string. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

/**
 * Reject a path that would escape the directory it is resolved against.
 *
 * The manifest ships inside the signed application, so this guards against authoring
 * mistakes rather than an attacker; a relative path pointing outside is still never
 * what the author meant.
 *
 * Judged by path segments, never by `resolve`: `resolve` is relative to the working
 * directory, so it turns `../../x` into an absolute path that looks contained.
 */
function isContained(value: string): boolean {
  if (value.startsWith('/')) return false
  return !value.split('/').includes('..')
}

/** Parse one plugin entry, or return the reason it is unusable. */
function parsePluginEntry(value: unknown): OfflinePluginEntry | string {
  if (typeof value !== 'object' || value === null) return 'plugin entry is not an object'
  const entry = value as Record<string, unknown>
  if (!isNonEmptyString(entry.name)) return 'plugin entry has no name'
  if (!isNonEmptyString(entry.version)) return `plugin ${entry.name} has no version`
  if (!isNonEmptyString(entry.tarball)) return `plugin ${entry.name} has no tarball`
  if (!isContained(entry.tarball)) return `plugin ${entry.name} names a tarball outside the payload: ${entry.tarball}`
  return { name: entry.name, version: entry.version, tarball: entry.tarball }
}

/** Parse one CLI entry, or return the reason it is unusable. */
function parseCliEntry(value: unknown): OfflineCliEntry | string {
  if (typeof value !== 'object' || value === null) return 'CLI entry is not an object'
  const entry = value as Record<string, unknown>
  if (!isNonEmptyString(entry.name)) return 'CLI entry has no name'
  if (!isNonEmptyString(entry.version)) return `CLI ${entry.name} has no version`
  if (!isNonEmptyString(entry.tarball)) return `CLI ${entry.name} has no tarball`
  if (!isNonEmptyString(entry.executable)) return `CLI ${entry.name} has no executable`
  if (!isContained(entry.tarball)) return `CLI ${entry.name} names a tarball outside the payload: ${entry.tarball}`
  if (!isContained(entry.executable)) {
    return `CLI ${entry.name} names an executable outside the tarball: ${entry.executable}`
  }
  return { name: entry.name, version: entry.version, tarball: entry.tarball, executable: entry.executable }
}

/**
 * Parse the shared dependency payload, or report why it cannot be used.
 *
 * A malformed payload is dropped rather than failing the whole manifest: the plugins it
 * would have fed then report their dependencies as unresolved, which names the actual
 * problem instead of hiding every plugin behind one broken field.
 */
function parseDependencyPayload(
  value: unknown,
  logger: OfflineInstallLogger,
): OfflineDependencyPayload | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null) {
    logger.error('offline-install: dependencies is not an object; ignoring it')
    return undefined
  }
  const entry = value as Record<string, unknown>
  if (!isNonEmptyString(entry.version)) {
    logger.error('offline-install: dependencies has no version; ignoring it')
    return undefined
  }
  if (!isNonEmptyString(entry.tarball)) {
    logger.error('offline-install: dependencies has no tarball; ignoring it')
    return undefined
  }
  if (!isContained(entry.tarball)) {
    logger.error(`offline-install: dependencies names a tarball outside the payload: ${entry.tarball}`)
    return undefined
  }
  return { version: entry.version, tarball: entry.tarball }
}

/** Parse a list of entries, dropping unusable ones with a reported reason. */
function parseEntries<T>(
  value: unknown,
  label: string,
  parse: (entry: unknown) => T | string,
  logger: OfflineInstallLogger,
): T[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    logger.error(`${label} is not an array; ignoring it`)
    return []
  }
  const parsed: T[] = []
  for (const raw of value) {
    const result = parse(raw)
    if (typeof result === 'string') {
      logger.error(`offline-install: skipping entry: ${result}`)
      continue
    }
    parsed.push(result)
  }
  return parsed
}

/**
 * Locate the offline install payload for this shell.
 *
 * Packaged, it rides beside the application as `Resources/offline-install`. In a
 * development tree, `prepare:offline-install` assembles it under
 * `.desktop-build/offline-install`, mirroring how the bundled runtime is found.
 */
export function offlineInstallDirectory(options: {
  readonly resourcesPath: string
  readonly packageRoot: string
  readonly packaged: boolean
  readonly environment?: NodeJS.ProcessEnv
}): string {
  const override = (options.environment ?? process.env).DSH_DESKTOP_OFFLINE_INSTALL_DIR
  if (override !== undefined && override !== '') return resolve(override)
  return options.packaged
    ? join(options.resourcesPath, OFFLINE_INSTALL_DIRECTORY)
    : join(options.packageRoot, '.desktop-build', OFFLINE_INSTALL_DIRECTORY)
}

/**
 * Read and validate the shipped offline install manifest.
 * @param options - Shell facts and the log sink.
 * @returns The manifest, or undefined when none is shipped or it could not be read.
 */
export function readOfflineInstallManifest(
  options: ReadOfflineInstallManifestOptions,
): OfflineInstallManifest | undefined {
  const directory = offlineInstallDirectory(options)
  const manifestPath = join(directory, OFFLINE_INSTALL_MANIFEST)
  if (!existsSync(manifestPath)) {
    // Absent is the normal state of a build that ships no offline plugins.
    options.logger.info?.(`offline-install: no manifest at ${manifestPath}`)
    return undefined
  }

  let raw: string
  try {
    raw = readFileSync(manifestPath, 'utf8')
  } catch (cause) {
    options.logger.error(
      `offline-install: cannot read ${manifestPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
    return undefined
  }

  let document: unknown
  try {
    document = JSON.parse(raw)
  } catch (cause) {
    options.logger.error(
      `offline-install: ${manifestPath} is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
    return undefined
  }

  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    options.logger.error(`offline-install: ${manifestPath} is not an object`)
    return undefined
  }
  const record = document as Record<string, unknown>
  if (record.version !== OFFLINE_INSTALL_MANIFEST_VERSION) {
    options.logger.error(
      `offline-install: ${manifestPath} declares version ${String(record.version)}, `
        + `expected ${OFFLINE_INSTALL_MANIFEST_VERSION}`,
    )
    return undefined
  }

  const plugins = parseEntries(record.plugins, 'plugins', parsePluginEntry, options.logger)
  const clis = parseEntries(record.clis, 'clis', parseCliEntry, options.logger)
  // Absent is the common case: most payloads ship only what the App tree already feeds.
  const dependencies = parseDependencyPayload(record.dependencies, options.logger)
  options.logger.info?.(
    `offline-install: ${plugins.length} plugin(s) and ${clis.length} CLI(s) from ${manifestPath}`,
  )
  return { directory, plugins, clis, ...(dependencies === undefined ? {} : { dependencies }) }
}

/**
 * Suffix marking one part of an archive split across files.
 *
 * GitHub rejects any single file above 100 MB, and the dependency tree exceeds that, so
 * it ships as `<name>.tgz.part-aa`, `.part-ab`, … and is rejoined on read. The parts are
 * ordinary blobs rather than Git LFS objects: LFS would work, but its free tier meters
 * downloads at 1 GB per month, and a Windows packaging run pulls the whole payload — so
 * the check this exists to enable could run about three times a month.
 */
export const OFFLINE_TARBALL_PART_SUFFIX = '.part-'

/** Whether one plugin's tarball is actually present in the payload. */
export function offlineTarballPath(manifest: OfflineInstallManifest, tarball: string): string {
  return join(manifest.directory, tarball)
}

/** Every part of a split tarball, in order, or an empty list when it is not split. */
export function offlineTarballParts(manifest: OfflineInstallManifest, tarball: string): string[] {
  const directory = manifest.directory
  const names = new Set<string>()
  try {
    for (const name of readdirSync(directory)) {
      if (name.startsWith(`${tarball}${OFFLINE_TARBALL_PART_SUFFIX}`)) names.add(name)
    }
  } catch {
    return []
  }
  // Sorted by name, which is the order the parts were written: the suffixes are
  // fixed-width and increase lexically (`part-aa` … `part-az`, `part-ba` …).
  return [...names].sort().map(name => join(directory, name))
}

/**
 * Read one payload tarball, rejoining a split archive transparently.
 *
 * The single entry point every install path uses, so a caller never has to know whether
 * the archive shipped whole or in parts.
 *
 * @param manifest - Validated manifest, locating the payload directory.
 * @param tarball - Archive name as written in the manifest.
 * @returns The archive bytes.
 * @throws When neither the archive nor any of its parts is present.
 */
export function readOfflineTarball(manifest: OfflineInstallManifest, tarball: string): Buffer {
  const whole = offlineTarballPath(manifest, tarball)
  if (existsSync(whole)) return readFileSync(whole)
  const parts = offlineTarballParts(manifest, tarball)
  if (parts.length === 0) throw new Error(`offline install: ${whole} is missing`)
  return Buffer.concat(parts.map(part => readFileSync(part)))
}

/**
 * Whether a payload tarball can be read, whole or split.
 *
 * Callers check presence to report a useful "the payload is incomplete" message instead
 * of catching a read failure, and a split archive is present without the joined name
 * existing.
 */
export function offlineTarballExists(manifest: OfflineInstallManifest, tarball: string): boolean {
  return existsSync(offlineTarballPath(manifest, tarball))
    || offlineTarballParts(manifest, tarball).length > 0
}
