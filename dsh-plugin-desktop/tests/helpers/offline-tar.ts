/**
 * Build npm-shaped package archives for offline-install tests.
 *
 * Pulled out of the tar spec so the plugin and CLI specs can produce a real archive
 * without re-deriving tar headers — a second copy would silently drift from the format
 * the reader is being tested against.
 */

import { gzipSync } from 'node:zlib'

/** One member of a tar archive under construction. */
export interface TarMember {
  /** Path recorded in the header. */
  name: string
  /** File contents; ignored for directories. */
  body?: string
  /** POSIX type flag, e.g. `5` for a directory. */
  typeflag?: string
  /** ustar prefix field, for paths too long for the name field. */
  prefix?: string
}

/** Render one 512-byte tar header block. */
function header(options: {
  name: string
  size: number
  typeflag?: string
  prefix?: string
}): Buffer {
  const block = Buffer.alloc(512)
  // Directories carry an execute bit; a 644 directory cannot be entered or removed.
  const fallbackMode = options.typeflag === '5' ? 0o755 : 0o644
  block.write(options.name, 0, 'utf8')
  block.write((fallbackMode).toString(8).padStart(7, '0') + '\0', 100, 'ascii')
  block.write('0000000\0', 108, 'ascii')
  block.write('0000000\0', 116, 'ascii')
  block.write(options.size.toString(8).padStart(11, '0') + '\0', 124, 'ascii')
  block.write('00000000000\0', 136, 'ascii')
  block.write('        ', 148, 'ascii')
  block.write(options.typeflag ?? '0', 156, 'ascii')
  block.write('ustar', 257, 'ascii')
  block.write('00', 263, 'ascii')
  if (options.prefix !== undefined) block.write(options.prefix, 345, 'utf8')
  let sum = 0
  for (const byte of block) sum += byte
  block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii')
  return block
}

/** Assemble members into a tar archive, then gzip it. */
export function tarGz(members: readonly TarMember[]): Buffer {
  const blocks: Buffer[] = []
  for (const member of members) {
    const body = member.body ?? ''
    const bytes = member.typeflag === '5' ? '' : body
    blocks.push(header({
      name: member.name,
      size: Buffer.byteLength(bytes),
      // Spread rather than assign: `exactOptionalPropertyTypes` distinguishes an
      // absent property from one explicitly set to undefined.
      ...(member.typeflag === undefined ? {} : { typeflag: member.typeflag }),
      ...(member.prefix === undefined ? {} : { prefix: member.prefix }),
    }))
    if (bytes !== '') {
      const padded = Buffer.alloc(Math.ceil(Buffer.byteLength(bytes) / 512) * 512)
      padded.write(bytes, 0, 'utf8')
      blocks.push(padded)
    }
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

/** Build a package archive the way npm does, under `package/`. */
export function packPackage(files: Record<string, string>): Buffer {
  return tarGz([
    { name: 'package', typeflag: '5' },
    ...Object.entries(files).map(([name, body]) => ({ name: `package/${name}`, body })),
  ])
}
