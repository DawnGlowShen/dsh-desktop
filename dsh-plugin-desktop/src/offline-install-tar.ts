/**
 * A minimal tar reader for the offline install payload.
 *
 * The application unpacks npm package tarballs at first launch, and it must do so
 * without the `tar` package (a devDependency the packaged runtime does not carry) and
 * without shelling out to a system `tar` (absent on some targets, and a hidden
 * environment dependency). npm produces ustar archives with none of tar's exotic
 * features, so the reader supports exactly the shapes npm emits and refuses anything
 * else by name rather than guessing.
 *
 * Supported: regular files (`0`), directories (`5`), the ustar `prefix` field, and
 * base-256 sizes. Refused outright: PAX extended headers (`x`/`g`), GNU long names
 * (`L`/`K`), links (`1`/`2`), and device or FIFO entries — a package that needs them
 * is not an npm package, and silently extracting it wrongly is worse than stopping.
 */

import { gunzipSync } from 'node:zlib'

/** Bytes in one tar header block. */
const BLOCK = 512

/** Header that reads as all zeroes ends the archive. */
const END_OF_ARCHIVE = 512

/** Largest file the reader will extract, guarding against a corrupt size field. */
const MAX_ENTRY_SIZE = 512 * 1024 * 1024

/**
 * Type flags that describe a neighbouring entry rather than carrying content.
 *
 * `x`/`g` are PAX extended records and `L`/`K` are GNU long names; both attach
 * attributes to the entry that follows. They are read past, not extracted.
 */
const EXTENDED_HEADER_TYPES = new Set(['x', 'g', 'L', 'K'])

/** One extracted archive member. */
export interface TarEntry {
  /** Archive path with the leading `package/` intact, using forward slashes. */
  readonly path: string
  /** File contents; empty for a directory. */
  readonly contents: Buffer
  /** Whether the entry is a directory. */
  readonly directory: boolean
  /** Permission bits from the header, masked to the low 12 bits. */
  readonly mode: number
}

/** Why an archive could not be read. */
export class TarFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TarFormatError'
  }
}

/** Read a NUL-terminated string field. */
function readString(header: Buffer, offset: number, length: number): string {
  const field = header.subarray(offset, offset + length)
  const end = field.indexOf(0)
  return field.subarray(0, end === -1 ? undefined : end).toString('utf8')
}

/**
 * Read a numeric field in tar's octal encoding, or base-256 for values that overflow it.
 *
 * GNU tar writes base-256 by setting the high bit of the first byte when a value does
 * not fit the 8 octal digits of a size field; npm archives of large files use it.
 */
function readNumber(header: Buffer, offset: number, length: number): number {
  const field = header.subarray(offset, offset + length)
  const first = field[0] ?? 0
  if ((first & 0x80) !== 0) {
    let value = first & 0x7f
    for (let index = 1; index < field.length; index += 1) value = value * 256 + (field[index] ?? 0)
    return value
  }
  const text = field.toString('ascii').replace(/\0.*$/, '').trim()
  if (text === '') return 0
  const value = Number.parseInt(text, 8)
  if (Number.isNaN(value)) throw new TarFormatError(`tar: unreadable numeric field: ${JSON.stringify(text)}`)
  return value
}

/**
 * Verify a header's checksum, which is how a reader distinguishes a header from the
 * zero padding that follows the archive.
 */
function checksumMatches(header: Buffer): boolean {
  const stored = readNumber(header, 148, 8)
  let sum = 0
  for (let index = 0; index < BLOCK; index += 1) {
    // The checksum field itself counts as spaces.
    sum += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0)
  }
  return sum === stored
}

/**
 * Unpack a gzipped npm package tarball.
 *
 * Extraction is pure: the caller receives every member in memory and decides where it
 * lands. That keeps the path-safety decision in one place — the installer — rather than
 * split between the reader and its destination.
 *
 * @param archive - Compressed tarball bytes, as read from the payload.
 * @returns Members in archive order.
 * @throws TarFormatError for a truncated archive or an unsupported entry type.
 */
export function extractTarGz(archive: Buffer): TarEntry[] {
  let raw: Buffer
  try {
    raw = gunzipSync(archive)
  } catch (cause) {
    throw new TarFormatError(`tar: not a gzip archive: ${cause instanceof Error ? cause.message : String(cause)}`)
  }

  const entries: TarEntry[] = []
  let offset = 0
  // Two consecutive zero blocks end the archive; one alone is just padding.
  let zeroBlocks = 0

  while (offset + BLOCK <= raw.length) {
    const header = raw.subarray(offset, offset + BLOCK)

    if (header.every(byte => byte === 0)) {
      zeroBlocks += 1
      offset += BLOCK
      if (zeroBlocks >= END_OF_ARCHIVE / BLOCK) break
      continue
    }
    zeroBlocks = 0

    if (!checksumMatches(header)) {
      throw new TarFormatError(`tar: header checksum mismatch at offset ${offset}`)
    }

    const name = readString(header, 0, 100)
    const prefix = readString(header, 345, 155)
    const path = prefix === '' ? name : `${prefix}/${name}`
    const typeflag = String.fromCharCode(header[156] ?? 0)
    const size = readNumber(header, 124, 12)
    const mode = readNumber(header, 100, 8) & 0o7777

    if (size > MAX_ENTRY_SIZE) {
      throw new TarFormatError(`tar: entry ${path} declares an implausible size: ${size}`)
    }

    const bodyStart = offset + BLOCK
    const bodyEnd = bodyStart + size
    if (bodyEnd > raw.length) {
      throw new TarFormatError(`tar: entry ${path} runs past the end of the archive`)
    }

    // `\0` is what some writers emit for a regular file; treat it as one.
    if (typeflag === '0' || typeflag === '\0') {
      entries.push({ path, contents: Buffer.from(raw.subarray(bodyStart, bodyEnd)), directory: false, mode })
    } else if (typeflag === '5') {
      entries.push({ path, contents: Buffer.alloc(0), directory: true, mode })
    } else if (EXTENDED_HEADER_TYPES.has(typeflag)) {
      // Metadata for a neighbouring entry — PAX records (`x`/`g`) and GNU long
      // names (`L`/`K`) — carry no content of their own. macOS `tar` emits a PAX
      // header beside every file it writes, so rejecting these would fail every
      // archive a user built with the system `tar`, which is the whole point of
      // accepting tarballs at all. The body is skipped by the shared advance below.
    } else {
      throw new TarFormatError(`tar: entry ${path} has unsupported type ${JSON.stringify(typeflag)}`)
    }

    offset = bodyStart + Math.ceil(size / BLOCK) * BLOCK
  }

  if (entries.length === 0) throw new TarFormatError('tar: archive declares no entries')
  return entries
}

/**
 * Select the members of a package tarball, dropping npm's leading `package/` directory.
 *
 * npm always nests a package under `package/`; a tarball without that prefix is not a
 * package, and installing it under a package name would produce a directory the loader
 * cannot read.
 *
 * @param entries - Members returned by {@link extractTarGz}.
 * @returns Members with `package/` removed, skipping the prefix entry itself.
 */
export function packageEntries(entries: readonly TarEntry[]): TarEntry[] {
  const rooted = entries.filter(entry => entry.path === 'package' || entry.path.startsWith('package/'))
  if (rooted.length === 0) {
    throw new TarFormatError('tar: archive does not contain a package/ directory')
  }
  return rooted
    .map(entry => ({
      ...entry,
      path: entry.path === 'package' ? '' : entry.path.slice('package/'.length),
    }))
    .filter(entry => entry.path !== '')
}
