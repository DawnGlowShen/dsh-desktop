import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { extractTarGz, packageEntries, TarFormatError } from '../src/offline-install-tar.ts'
import { unpackPackage, unpackTree, isInside } from '../src/offline-install-unpack.ts'

const scratchRoots: string[] = []

/** A throwaway directory removed after each test. */
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-offline-tar-'))
  scratchRoots.push(root)
  return root
}

/** Build a tar header for one member. */
function header(options: {
  name: string
  size: number
  typeflag?: string
  mode?: number
  prefix?: string
  checksum?: number
}): Buffer {
  const block = Buffer.alloc(512)
  // Directories carry an execute bit; a 644 directory cannot be entered or removed.
  const fallbackMode = options.typeflag === '5' ? 0o755 : 0o644
  block.write(options.name, 0, 'utf8')
  block.write((options.mode ?? fallbackMode).toString(8).padStart(7, '0') + '\0', 100, 'ascii')
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
  if (options.checksum !== undefined) {
    block.write(options.checksum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii')
  }
  return block
}

/** Assemble members into a tar archive, then gzip it. */
function tarGz(members: { name: string; body?: string; typeflag?: string; prefix?: string }[]): Buffer {
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
function packageArchive(files: Record<string, string>): Buffer {
  return tarGz([
    { name: 'package', typeflag: '5' },
    ...Object.entries(files).map(([name, body]) => ({ name: `package/${name}`, body })),
  ])
}

afterEach(() => {
  for (const root of scratchRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('tar reading', () => {
  it('reads a package archive and strips the package/ wrapper', () => {
    const entries = packageEntries(extractTarGz(packageArchive({ 'package.json': '{"name":"demo"}', 'lib/index.js': 'export {}' })))
    expect(entries.map(entry => entry.path).sort()).toEqual(['lib/index.js', 'package.json'])
    expect(entries.find(entry => entry.path === 'package.json')?.contents.toString()).toBe('{"name":"demo"}')
  })

  it('joins the ustar prefix field', () => {
    const archive = tarGz([{ name: 'index.js', prefix: 'package/lib', body: 'x' }])
    expect(packageEntries(extractTarGz(archive)).map(entry => entry.path)).toEqual(['lib/index.js'])
  })

  it('reads a base-256 size field', () => {
    // GNU tar switches to base-256 when a value overflows the octal field; the high bit
    // of the first byte marks it. Build one by hand so the encoding is actually exercised.
    const body = Buffer.alloc(300, 0x61)
    const block = Buffer.alloc(512)
    block.write('package/big.txt', 0, 'utf8')
    block.write('0000644\0', 100, 'ascii')
    block.write('0000000\0', 108, 'ascii')
    block.write('0000000\0', 116, 'ascii')
    block.fill(0, 124, 136)
    block[124] = 0x80
    block.writeUInt32BE(300, 132)
    block.write('00000000000\0', 136, 'ascii')
    block.write('        ', 148, 'ascii')
    block.write('0', 156, 'ascii')
    block.write('ustar', 257, 'ascii')
    block.write('00', 263, 'ascii')
    let sum = 0
    for (const byte of block) sum += byte
    block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii')
    const padded = Buffer.alloc(512)
    body.copy(padded)
    const archive = gzipSync(Buffer.concat([block, padded, Buffer.alloc(1024)]))
    const entries = extractTarGz(archive)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.contents.length).toBe(300)
  })

  it('refuses a checksum that does not match', () => {
    const archive = tarGz([{ name: 'package/a.txt', body: 'x' }])
    const broken = Buffer.from(gunzipSync(archive))
    // A well-formed octal field carrying the wrong value, so the comparison itself fails.
    broken.write('000001\0 ', 148, 'ascii')
    expect(() => extractTarGz(gzipSync(broken))).toThrow(TarFormatError)
    expect(() => extractTarGz(gzipSync(broken))).toThrow(/checksum mismatch/)
  })

  it('refuses an entry type it cannot honour', () => {
    const archive = tarGz([{ name: 'package/link', typeflag: '2' }])
    expect(() => extractTarGz(archive)).toThrow(/unsupported type/)
  })

  // A real archive built with the system `tar` on macOS carries a PAX header beside
  // every file; refusing them would reject every tarball a user made by hand.
  it('reads past a PAX extended header and keeps the entry it describes', () => {
    const archive = tarGz([
      { name: 'package/PaxHeader/index.js', typeflag: 'x', body: '30 mtime=1700000000.0\n' },
      { name: 'package/index.js', body: 'real' },
    ])
    const entries = extractTarGz(archive)
    expect(entries.map(entry => entry.path)).toEqual(['package/index.js'])
    expect(entries[0]?.contents.toString()).toBe('real')
  })

  it('reads past a PAX global header and a GNU long name', () => {
    const archive = tarGz([
      { name: 'package/pax_global_header', typeflag: 'g', body: 'comment=x\n' },
      { name: 'package/./@LongLink', typeflag: 'L', body: 'package/index.js\0' },
      { name: 'package/index.js', body: 'real' },
    ])
    const entries = extractTarGz(archive)
    expect(entries.map(entry => entry.path)).toEqual(['package/index.js'])
  })

  it('refuses an archive that is not gzip', () => {
    expect(() => extractTarGz(Buffer.from('not gzip'))).toThrow(/not a gzip archive/)
  })

  it('refuses an archive with no entries', () => {
    expect(() => extractTarGz(gzipSync(Buffer.alloc(1024)))).toThrow(/no entries/)
  })

  it('refuses an archive without a package/ wrapper', () => {
    const archive = tarGz([{ name: 'index.js', body: 'x' }])
    expect(() => packageEntries(extractTarGz(archive))).toThrow(/does not contain a package\/ directory/)
  })

  it('refuses an entry that runs past the end of the archive', () => {
    // Declare a size far larger than the bytes actually present. Truncating a
    // well-formed archive is not enough: cutting on a block boundary leaves a valid
    // empty header, which reads as a clean end of archive.
    const block = Buffer.alloc(512)
    block.write('package/big.txt', 0, 'utf8')
    block.write('0000644\0', 100, 'ascii')
    block.write('0000000\0', 108, 'ascii')
    block.write('0000000\0', 116, 'ascii')
    block.write((2048).toString(8).padStart(11, '0') + '\0', 124, 'ascii')
    block.write('00000000000\0', 136, 'ascii')
    block.write('        ', 148, 'ascii')
    block.write('0', 156, 'ascii')
    block.write('ustar', 257, 'ascii')
    block.write('00', 263, 'ascii')
    let sum = 0
    for (const byte of block) sum += byte
    block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii')
    const archive = gzipSync(Buffer.concat([block, Buffer.alloc(100)]))
    expect(() => extractTarGz(archive)).toThrow(/runs past the end/)
  })
})

describe('tar extraction', () => {
  it('writes a package to disk', () => {
    const root = join(scratch(), 'pkg')
    const result = unpackPackage(packageArchive({ 'package.json': '{"name":"demo"}', 'lib/index.js': 'export {}' }), root)
    expect(result.files).toBe(2)
    expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe('{"name":"demo"}')
    expect(readFileSync(join(root, 'lib', 'index.js'), 'utf8')).toBe('export {}')
  })

  it('replaces an existing package rather than merging into it', () => {
    const root = join(scratch(), 'pkg')
    unpackPackage(packageArchive({ 'old.txt': 'gone' }), root)
    unpackPackage(packageArchive({ 'new.txt': 'here' }), root)
    expect(() => readFileSync(join(root, 'old.txt'))).toThrow()
    expect(readFileSync(join(root, 'new.txt'), 'utf8')).toBe('here')
  })

  it('refuses a member that escapes the destination', () => {
    const archive = tarGz([{ name: 'package/../../evil.txt', body: 'x' }])
    expect(() => unpackPackage(archive, join(scratch(), 'pkg'))).toThrow(/escapes the extraction root/)
  })

  it('refuses an absolute member path', () => {
    const archive = tarGz([{ name: 'package//etc/evil', body: 'x' }])
    const root = join(scratch(), 'pkg')
    const result = unpackPackage(archive, root)
    expect(result.files).toBe(1)
    expect(readFileSync(join(root, 'etc', 'evil'), 'utf8')).toBe('x')
  })

  it('leaves no staging directory behind when extraction fails', () => {
    const root = join(scratch(), 'pkg')
    expect(() => unpackPackage(tarGz([{ name: 'package/x', typeflag: '2' }]), root)).toThrow()
    expect(() => readFileSync(`${root}.staging-${process.pid}`)).toThrow()
  })

  it('applies the mode from the header', () => {
    const archive = tarGz([{ name: 'package/run.sh', body: '#!/bin/sh\n' }])
    const raw = gunzipSync(archive)
    raw.write('000755\0', 100, 'ascii')
    let sum = 0
    for (let index = 0; index < 512; index += 1) sum += index >= 148 && index < 156 ? 0x20 : (raw[index] ?? 0)
    raw.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii')
    const root = join(scratch(), 'pkg')
    unpackPackage(gzipSync(raw), root)
    const mode = statSync(join(root, 'run.sh')).mode & 0o777
    expect(mode).toBe(0o755)
  })

  it('unpacks a tree and strips a single top-level directory', () => {
    const root = join(scratch(), 'cli')
    const archive = tarGz([{ name: 'codegraph/bin/codegraph', body: '#!/bin/sh\n' }])
    unpackTree(archive, root, true)
    expect(readFileSync(join(root, 'bin', 'codegraph'), 'utf8')).toBe('#!/bin/sh\n')
  })

  it('keeps the top-level directory when asked', () => {
    const root = join(scratch(), 'cli')
    unpackTree(tarGz([{ name: 'codegraph/bin/codegraph', body: 'x' }]), root, false)
    expect(readFileSync(join(root, 'codegraph', 'bin', 'codegraph'), 'utf8')).toBe('x')
  })
})

describe('path containment', () => {
  it('accepts a path inside the root', () => {
    expect(isInside('/a/b', '/a/b/c')).toBe(true)
    expect(isInside('/a/b', '/a/b')).toBe(true)
  })

  it('rejects a sibling that merely shares a prefix', () => {
    expect(isInside('/a/b', '/a/bc')).toBe(false)
  })

  it('rejects a path outside the root', () => {
    expect(isInside('/a/b', '/a/c')).toBe(false)
  })
})

// The reader must agree with the platform tar on real npm archives, not just on
// archives this test file authored.
describe('agreement with the system tar', () => {
  const available = (() => {
    try {
      execFileSync('tar', ['--version'], { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  })()

  it.runIf(available)('unpacks a real npm archive byte for byte', () => {
    const files = { 'package.json': '{"name":"x"}', 'lib/a.js': 'a'.repeat(2000) }
    const archivePath = join(scratch(), 'sample.tgz')
    writeFileSync(archivePath, packageArchive(files))
    const mine = join(scratch(), 'mine')
    unpackPackage(readFileSync(archivePath), mine)
    // Compare through the filesystem on our side only: the platform tar preserves the
    // archive's restrictive directory modes, which makes its own output hard to read back.
    for (const [name, body] of Object.entries(files)) {
      expect(readFileSync(join(mine, name), 'utf8')).toBe(body)
    }
    expect(packageEntries(extractTarGz(readFileSync(archivePath)))).toHaveLength(2)
  })
})
