/**
 * Split payload archives that exceed the hosting limit into readable parts.
 *
 * GitHub rejects any single file above 100 MB, and the offline payload contains two
 * that do: the shared dependency tree (~120 MB) and the fused macOS CodeGraph bundle
 * (~96 MB). Splitting them keeps the payload in ordinary Git storage, where a Windows
 * packaging run can pull it as often as it likes.
 *
 * Git LFS is the obvious alternative and is deliberately not used: its free tier meters
 * downloads at 1 GB per month, and one packaging run pulls the whole payload, so the
 * check this enables would run roughly three times a month before failing.
 *
 * ## Layout
 *
 * The payload is shared by every Desktop package and lives once at
 * `vendor/offline-install`, so there is a single copy to keep within the limit.
 *
 * A split archive becomes `<name>.tgz.part-aa`, `<name>.tgz.part-ab`, … with the
 * original removed. Parts are written in order and named with fixed-width suffixes, so
 * sorting by name reproduces the original byte order — which is what
 * `readOfflineTarball` relies on when it rejoins them.
 *
 * The whole archive is never present alongside its parts: shipping both would double
 * the payload, and a reader would silently keep using a stale whole file after an
 * upgrade.
 *
 * Usage:
 *   node scripts/split-offline-payload.mjs --check      # fail if anything exceeds the limit
 *   node scripts/split-offline-payload.mjs --write      # split what does
 */

import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))

/** Name of the directory holding the payload. */
const PAYLOAD_DIRECTORY = 'offline-install'

/**
 * Largest a single file may be.
 *
 * GitHub's limit is 100 MB, measured in decimal megabytes. 90 MB leaves room for the
 * limit being enforced on the encoded object rather than the working-tree file, and for
 * a part growing slightly as an archive is rebuilt.
 */
const PART_BYTES = 90_000_000

/** Suffix marking one part, matching `OFFLINE_TARBALL_PART_SUFFIX` in the source. */
const PART_SUFFIX = '.part-'

/** Throwing rather than exiting: the caller owns the exit code and its own message. */
function fail(message) {
  throw new Error(message)
}

/**
 * Suffix for a part index: 0 -> `aa`, 25 -> `az`, 26 -> `ba`.
 *
 * Bijective base-26, so every suffix is at least two letters and no index collides with
 * another. A plain `padStart` would map 26 back onto `aa` and silently overwrite the
 * first part — harmless at today's sizes, an invisible corruption the first time a
 * payload needs more parts.
 */
export function partLetter(index) {
  // Two letters, most significant first, covering 676 parts. A `y`/`z`-carrying letter
  // before the final one would leave the ASCII range; refusing is what keeps the name
  // from silently becoming a punctuation character that sorts before every part.
  if (!Number.isInteger(index) || index < 0 || index > 675) {
    fail(`part index ${String(index)} is outside the 0-675 a two-letter suffix can name`)
  }
  return String.fromCharCode(97 + Math.floor(index / 26)) + String.fromCharCode(97 + (index % 26))
}

/**
 * The payload directory shared by every Desktop package.
 *
 * One level above the packages rather than inside each: the payload is identical for
 * every package, so there is one copy to split and one place a reader looks.
 *
 * @returns Absolute path of the shared payload directory.
 */
export function payloadDirectory() {
  return join(root, 'vendor', PAYLOAD_DIRECTORY)
}

/**
 * Every file in the shared payload, as absolute paths.
 *
 * @returns Absolute paths, or an empty list when the payload is absent.
 */
function payloadFiles() {
  const directory = payloadDirectory()
  if (!existsSync(directory)) return []
  return readdirSync(directory).map(name => join(directory, name))
}

/** One file that must be split. */
export function oversizedPayloadFiles() {
  const found = []
  for (const path of payloadFiles()) {
    // Parts are already small, and a part of a part is not a thing.
    if (path.includes(PART_SUFFIX)) continue
    const size = statSync(path).size
    if (size > PART_BYTES) found.push({ path, size })
  }
  return found
}

/**
 * Split one file into parts and remove the original.
 *
 * @param path - File to split.
 * @returns The part paths that were written.
 */
export function splitFile(path) {
  const bytes = readFileSync(path)
  if (bytes.length <= PART_BYTES) fail(`${path} does not need splitting`)
  const parts = []
  for (let offset = 0, index = 0; offset < bytes.length; offset += PART_BYTES, index += 1) {
    const part = `${path}${PART_SUFFIX}${partLetter(index)}`
    writeFileSync(part, bytes.subarray(offset, offset + PART_BYTES))
    parts.push(part)
  }
  // Removed only after every part is on disk, so an interrupted run never leaves the
  // payload with neither the whole archive nor all of its parts.
  rmSync(path)
  return parts
}

/**
 * Rejoin a split archive back into one file.
 *
 * The inverse of `splitFile`, for rotating a payload back out of the split layout.
 *
 * @param path - Path of the archive to recreate.
 * @returns The recreated path.
 */
export function joinFile(path) {
  const directory = resolve(path, '..')
  const name = path.slice(directory.length + 1)
  const parts = readdirSync(directory)
    .filter(entry => entry.startsWith(`${name}${PART_SUFFIX}`))
    .sort()
    .map(entry => join(directory, entry))
  if (parts.length === 0) fail(`${path} has no parts to rejoin`)
  writeFileSync(path, Buffer.concat(parts.map(part => readFileSync(part))))
  for (const part of parts) rmSync(part)
  return path
}

/** Report or perform the split. */
function main() {
  const argv = process.argv.slice(2)
  const write = argv.includes('--write')
  const oversized = oversizedPayloadFiles()
  if (oversized.length === 0) {
    process.stdout.write(`offline payload: every file is within ${String(PART_BYTES)} bytes\n`)
    return
  }
  if (!write) {
    fail(
      `${String(oversized.length)} payload file(s) exceed ${String(PART_BYTES)} bytes and would be rejected by the host:\n`
        + oversized.map(item => `  ${item.path.slice(root.length + 1)} (${String(item.size)} bytes)`).join('\n')
        + '\nRun with --write to split them.',
    )
  }
  for (const item of oversized) {
    const parts = splitFile(item.path)
    process.stdout.write(
      `offline payload: ${item.path.slice(root.length + 1)} -> ${String(parts.length)} part(s)\n`,
    )
  }
}

const invoked = process.argv[1]
if (invoked !== undefined && resolve(invoked) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`split-offline-payload: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
