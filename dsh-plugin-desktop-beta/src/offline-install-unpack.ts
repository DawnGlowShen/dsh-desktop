/**
 * Unpack an offline install tarball onto disk, safely.
 *
 * The reader in `offline-install-tar.ts` is pure and decides nothing about
 * destinations; this module owns that decision, so every path that reaches the
 * filesystem has passed one containment check in one place.
 *
 * Extraction is atomic per package: contents land in a staging directory and are
 * moved into place only once the whole archive unpacked. A truncated tarball
 * therefore never leaves a half-written package behind for the loader to read.
 */

import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { DIRECTORY_MODE } from './offline-install-store.ts'
import { extractTarGz, packageEntries, TarFormatError, type TarEntry } from './offline-install-tar.ts'

/** Default file mode when a header carries none. */
const DEFAULT_FILE_MODE = 0o644

/** One member with a destination path that has passed containment. */
interface PlannedEntry {
  readonly relative: string
  readonly contents: Buffer
  readonly directory: boolean
  readonly mode: number
}

/**
 * Reject a member path that would escape the extraction root.
 *
 * Judged by segments, never by `resolve` alone: `resolve` is relative to the working
 * directory, so it reports `../../x` as an absolute path that looks contained. The
 * reader already refuses the exotic entry types; this is the remaining risk, and it
 * is checked here rather than trusted from the archive.
 */
function safeRelativePath(entry: TarEntry): string | undefined {
  const normalized = entry.path.replace(/\\/g, '/').replace(/^\/+/, '')
  if (normalized === '') return undefined
  const segments = normalized.split('/')
  if (segments.includes('..')) return undefined
  // A leading drive letter or UNC share is absolute on Windows even without a slash.
  // `normalized` is non-empty, so the split always yields at least one segment.
  if ((segments[0] ?? '').includes(':')) return undefined
  return segments.filter(segment => segment !== '' && segment !== '.').join('/')
}

/** Turn archive members into a plan, or report why the archive is unusable. */
function planEntries(entries: readonly TarEntry[]): PlannedEntry[] | string {
  const planned: PlannedEntry[] = []
  for (const entry of entries) {
    const relative = safeRelativePath(entry)
    if (relative === undefined) return `entry escapes the extraction root: ${JSON.stringify(entry.path)}`
    planned.push({
      relative,
      contents: entry.contents,
      directory: entry.directory,
      mode: entry.mode === 0 ? (entry.directory ? DIRECTORY_MODE : DEFAULT_FILE_MODE) : entry.mode,
    })
  }
  return planned
}

/** Write planned members under a staging directory. */
function writeEntries(staging: string, entries: readonly PlannedEntry[]): void {
  for (const entry of entries) {
    const target = join(staging, entry.relative)
    if (entry.directory) {
      mkdirSync(target, { recursive: true, mode: entry.mode })
      continue
    }
    mkdirSync(dirname(target), { recursive: true, mode: DIRECTORY_MODE })
    writeFileSync(target, entry.contents, { mode: entry.mode })
    // writeFileSync honours the mode only when it creates the file; a leftover from a
    // previous attempt would keep its old bits.
    chmodSync(target, entry.mode)
  }
}

/** Outcome of unpacking one package tarball. */
export interface UnpackResult {
  /** Absolute path of the installed package root. */
  readonly root: string
  /** Number of files written. */
  readonly files: number
}

/**
 * Unpack an npm package tarball into `destination`, replacing whatever was there.
 *
 * The leading `package/` wrapper is removed, so `destination` becomes the package root
 * exactly as npm would install it.
 *
 * @param archive - Compressed tarball bytes.
 * @param destination - Package root to create; replaced atomically when present.
 * @returns Where the package landed and how many files it holds.
 * @throws TarFormatError when the archive cannot be read or safely placed.
 */
export function unpackPackage(archive: Buffer, destination: string): UnpackResult {
  const entries = packageEntries(extractTarGz(archive))
  const planned = planEntries(entries)
  if (typeof planned === 'string') throw new TarFormatError(`tar: ${planned}`)

  const root = resolve(destination)
  // Staging lives beside the destination so the final move stays on one filesystem.
  const staging = `${root}.staging-${process.pid}`
  rmSync(staging, { recursive: true, force: true })
  rmSync(root, { recursive: true, force: true })
  try {
    mkdirSync(staging, { recursive: true, mode: DIRECTORY_MODE })
    writeEntries(staging, planned)
    // A package root must be a directory the destination's parent already owns.
    mkdirSync(dirname(root), { recursive: true, mode: DIRECTORY_MODE })
    renameSync(staging, root)
  } catch (cause) {
    rmSync(staging, { recursive: true, force: true })
    throw cause
  }
  return { root, files: planned.filter(entry => !entry.directory).length }
}

/**
 * Unpack a tarball whose payload is not a package — a CLI whose archive root is the
 * tool itself rather than npm's `package/` wrapper.
 *
 * @param archive - Compressed tarball bytes.
 * @param destination - Directory to create; replaced atomically when present.
 * @param stripRoot - Whether to drop the archive's single top-level directory.
 * @returns Where the payload landed and how many files it holds.
 */
export function unpackTree(archive: Buffer, destination: string, stripRoot: boolean): UnpackResult {
  const entries = extractTarGz(archive)
  const planned = planEntries(stripRoot ? stripSingleRoot(entries) : entries)
  if (typeof planned === 'string') throw new TarFormatError(`tar: ${planned}`)

  const root = resolve(destination)
  const staging = `${root}.staging-${process.pid}`
  rmSync(staging, { recursive: true, force: true })
  rmSync(root, { recursive: true, force: true })
  try {
    mkdirSync(staging, { recursive: true, mode: DIRECTORY_MODE })
    writeEntries(staging, planned)
    mkdirSync(dirname(root), { recursive: true, mode: DIRECTORY_MODE })
    renameSync(staging, root)
  } catch (cause) {
    rmSync(staging, { recursive: true, force: true })
    throw cause
  }
  return { root, files: planned.filter(entry => !entry.directory).length }
}

/** Drop a common top-level directory when every member shares exactly one. */
function stripSingleRoot(entries: readonly TarEntry[]): TarEntry[] {
  const tops = new Set<string>()
  for (const entry of entries) {
    const top = entry.path.split('/')[0]
    if (top !== undefined && top !== '') tops.add(top)
    if (tops.size > 1) return [...entries]
  }
  if (tops.size !== 1) return [...entries]
  return entries
    .map(entry => ({ ...entry, path: entry.path.slice(entry.path.indexOf('/') + 1) }))
    .filter(entry => entry.path !== '')
}

/** Whether a path is already inside another, used to keep writes within a root. */
export function isInside(root: string, candidate: string): boolean {
  const base = resolve(root)
  const target = resolve(candidate)
  return target === base || target.startsWith(base + sep)
}

/** Create a directory, reporting whether it already existed. */
export function ensureDirectory(path: string, mode = DIRECTORY_MODE): boolean {
  const existed = existsSync(path)
  mkdirSync(path, { recursive: true, mode })
  return !existed
}
