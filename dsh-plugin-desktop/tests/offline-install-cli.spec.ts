import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { gzipSync } from 'node:zlib'
import {
  SHIM_BANNER,
  cliShim,
  cliShimWindows,
  ensureShimDirectoryOnPath,
  installCli,
  installManifestClis,
  quoteShell,
  type CliInstallLocation,
} from '../src/offline-install-cli.ts'
import type { OfflineCliEntry, OfflineInstallManifest } from '../src/offline-install-manifest.ts'

/** Build a real gzipped tar so nothing about the install path is simulated. */
function tarGz(entries: { name: string; body: string; mode?: number }[]): Buffer {
  const chunks: Buffer[] = []
  for (const entry of entries) {
    const body = Buffer.from(entry.body, 'utf8')
    const header = Buffer.alloc(512)
    header.write(entry.name, 0, 'utf8')
    header.write(`${(entry.mode ?? 0o644).toString(8).padStart(7, '0')}\0`, 100, 'ascii')
    header.write('0000000\0', 108, 'ascii')
    header.write('0000000\0', 116, 'ascii')
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii')
    header.write('00000000000\0', 136, 'ascii')
    header.write('        ', 148, 'ascii')
    header.write('0', 156, 'ascii')
    header.write('ustar', 257, 'ascii')
    header.write('00', 263, 'ascii')
    let sum = 0
    for (const byte of header) sum += byte
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii')
    chunks.push(header, body)
    const padding = (512 - (body.length % 512)) % 512
    if (padding > 0) chunks.push(Buffer.alloc(padding))
  }
  chunks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(chunks))
}

/** A CLI tarball laid out the way the vendor trees are: one wrapper directory. */
function cliArchive(name: string, files: Record<string, string> = {}): Buffer {
  return tarGz([
    ...[{ name: `${name}/bin/${name}`, body: '#!/bin/sh\necho ok\n', mode: 0o755 },
      { name: `${name}/package.json`, body: `{"name":"${name}","version":"1.0.0"}` }],
    ...Object.entries(files).map(([path, body]) => ({ name: `${name}/${path}`, body })),
  ])
}

const CLI: OfflineCliEntry = {
  name: 'codegraph',
  version: '1.6.0',
  tarball: 'codegraph/codegraph-1.6.0.tgz',
  executable: 'bin/codegraph',
}

describe('offline CLI install', () => {
  let root: string
  let location: CliInstallLocation

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dsh-cli-'))
    location = {
      installRoot: join(root, 'offline', 'cli'),
      shimRoot: join(root, 'bin'),
      platform: 'darwin',
    }
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  describe('quoteShell', () => {
    it('makes a value with a single quote survive the shell', () => {
      // The only safe form: close, escape, reopen.
      expect(quoteShell("/a b'c")).toBe(`'/a b'"'"'c'`)
    })

    it('keeps expansions literal', () => {
      expect(quoteShell('$HOME`id`')).toBe(`'$HOME\`id\`'`)
    })
  })

  describe('shim contents', () => {
    it('execs the installed binary and forwards every argument', () => {
      expect(cliShim('/opt/x/bin/codegraph')).toBe(
        `#!/bin/sh\n# ${SHIM_BANNER}\nexec '/opt/x/bin/codegraph' "$@"\n`,
      )
    })

    it('marks a Windows shim with rem and forwards the exit code', () => {
      const shim = cliShimWindows('C:\\x\\codegraph.exe')
      expect(shim).toContain(`rem ${SHIM_BANNER}`)
      expect(shim).toContain('"C:\\x\\codegraph.exe" %*')
      expect(shim).toContain('exit /b %errorlevel%')
    })
  })

  describe('installCli', () => {
    it('unpacks the tree with its wrapper directory stripped and writes the command', () => {
      const outcome = installCli(cliArchive('codegraph'), CLI, location)

      expect(outcome.action).toBe('installed')
      // Root stripped: the executable sits directly under the install root, not under a
      // second `codegraph/` level.
      expect(existsSync(join(location.installRoot, 'codegraph', 'bin', 'codegraph'))).toBe(true)
      expect(existsSync(join(location.installRoot, 'codegraph', 'package.json'))).toBe(true)
      expect(existsSync(join(location.installRoot, 'codegraph', 'codegraph'))).toBe(false)
    })

    it('makes the executable actually executable', () => {
      installCli(cliArchive('codegraph'), CLI, location)
      const mode = statSync(join(location.installRoot, 'codegraph', 'bin', 'codegraph')).mode & 0o777
      expect(mode & 0o111).not.toBe(0)
    })

    it('writes a runnable shim into the command directory', () => {
      const outcome = installCli(cliArchive('codegraph'), CLI, location)
      const shim = join(location.shimRoot, 'codegraph')

      expect(outcome.shimPath).toBe(shim)
      const body = readFileSync(shim, 'utf8')
      expect(body).toContain(SHIM_BANNER)
      expect(body).toContain(join(location.installRoot, 'codegraph', 'bin', 'codegraph'))
      expect(statSync(shim).mode & 0o111).not.toBe(0)
    })

    it('reports current when the recorded version already matches', () => {
      expect(installCli(cliArchive('codegraph'), CLI, location).action).toBe('installed')
      expect(installCli(cliArchive('codegraph'), CLI, location).action).toBe('current')
    })

    it('reinstalls when the manifest version moves on', () => {
      installCli(cliArchive('codegraph'), CLI, location)
      const upgraded = { ...CLI, version: '1.7.0' }
      installCli(cliArchive('codegraph', { 'CHANGELOG.md': 'new' }), upgraded, location)

      expect(readFileSync(join(location.installRoot, 'codegraph', '.dsh-offline-version'), 'utf8').trim()).toBe('1.7.0')
      expect(existsSync(join(location.installRoot, 'codegraph', 'CHANGELOG.md'))).toBe(true)
    })

    it('replaces an older payload rather than merging into it', () => {
      installCli(cliArchive('codegraph', { 'old.txt': 'stale' }), CLI, location)
      installCli(cliArchive('codegraph'), { ...CLI, version: '2.0.0' }, location)

      expect(existsSync(join(location.installRoot, 'codegraph', 'old.txt'))).toBe(false)
    })

    it('fails and leaves nothing behind when the executable is absent', () => {
      const archive = tarGz([{ name: 'codegraph/README.md', body: 'no binary' }])
      const outcome = installCli(archive, CLI, location)

      expect(outcome.action).toBe('failed')
      expect(outcome.reason).toContain('bin/codegraph')
      // A half-install would let the next run believe the version was satisfied.
      expect(existsSync(join(location.installRoot, 'codegraph'))).toBe(false)
    })

    it('fails without throwing when the archive is not a tarball', () => {
      const outcome = installCli(Buffer.from('definitely not gzip'), CLI, location)
      expect(outcome.action).toBe('failed')
      expect(outcome.reason).toBeTruthy()
    })

    it('keeps a previous install intact when the new archive is broken', () => {
      installCli(cliArchive('codegraph'), CLI, location)
      const outcome = installCli(Buffer.from('broken'), { ...CLI, version: '9.9.9' }, location)

      expect(outcome.action).toBe('failed')
      expect(existsSync(join(location.installRoot, 'codegraph', 'bin', 'codegraph'))).toBe(true)
      // The stamp must not advance, or the broken version would look installed.
      expect(readFileSync(join(location.installRoot, 'codegraph', '.dsh-offline-version'), 'utf8').trim()).toBe('1.6.0')
    })

    it('installs a batch shim on Windows', () => {
      const outcome = installCli(cliArchive('codegraph'), CLI, { ...location, platform: 'win32' })
      expect(outcome.action).toBe('installed')
      expect(existsSync(join(location.shimRoot, 'codegraph.cmd'))).toBe(true)
      expect(existsSync(join(location.shimRoot, 'codegraph'))).toBe(false)
    })

    it('adds a batch shim beside the shell shim on POSIX', () => {
      installCli(cliArchive('codegraph'), CLI, location)
      expect(existsSync(join(location.shimRoot, 'codegraph'))).toBe(true)
      expect(existsSync(join(location.shimRoot, 'codegraph.cmd'))).toBe(true)
    })
  })

  describe('installManifestClis', () => {
    /** Build a manifest whose tarballs really exist under a temporary payload root. */
    function manifestWith(entries: { entry: OfflineCliEntry; archive?: Buffer }[]): {
      manifest: OfflineInstallManifest
      payload: string
    } {
      const payload = join(root, 'offline-install')
      for (const { entry, archive } of entries) {
        const target = join(payload, entry.tarball)
        mkdirSync(dirname(target), { recursive: true })
        if (archive !== undefined) writeFileSync(target, archive)
      }
      return {
        manifest: {
          directory: payload,
          plugins: [],
          clis: entries.map(item => item.entry),
        },
        payload,
      }
    }

    it('installs every declared CLI', () => {
      const mnemon: OfflineCliEntry = {
        ...CLI, name: 'mnemon', tarball: 'mnemon/mnemon-0.2.9.tgz', executable: 'bin/mnemon',
      }
      const { manifest } = manifestWith([
        { entry: CLI, archive: cliArchive('codegraph') },
        { entry: mnemon, archive: cliArchive('mnemon') },
      ])

      const outcomes = installManifestClis(manifest, location)
      expect(outcomes.map(item => item.action)).toEqual(['installed', 'installed'])
      expect(existsSync(join(location.shimRoot, 'mnemon'))).toBe(true)
    })

    it('reports a missing tarball without stopping the others', () => {
      const missing: OfflineCliEntry = { ...CLI, name: 'git-ai', tarball: 'git-ai/git-ai-1.7.5.tgz' }
      const { manifest } = manifestWith([{ entry: missing }, { entry: CLI, archive: cliArchive('codegraph') }])

      const outcomes = installManifestClis(manifest, location)
      expect(outcomes[0]?.action).toBe('failed')
      expect(outcomes[0]?.reason).toContain('tarball is missing')
      expect(outcomes[1]?.action).toBe('installed')
    })

    it('returns one outcome per CLI in manifest order', () => {
      const second: OfflineCliEntry = { name: 'mnemon', version: '0.2.9', tarball: 'mnemon/m.tgz', executable: 'bin/mnemon' }
      const { manifest } = manifestWith([
        { entry: CLI, archive: cliArchive('codegraph') },
        { entry: second, archive: cliArchive('mnemon') },
      ])
      const outcomes = installManifestClis(manifest, location)
      expect(outcomes.map(item => item.name)).toEqual(['codegraph', 'mnemon'])
    })

    it('never throws even when every archive is broken', () => {
      const { manifest } = manifestWith([{ entry: CLI, archive: Buffer.from('junk') }])
      expect(() => installManifestClis(manifest, location)).not.toThrow()
    })
  })

  describe('ensureShimDirectoryOnPath', () => {
    it('appends an idempotent block to a shell profile that already exists', () => {
      const home = join(root, 'home')
      mkdirSync(home, { recursive: true })
      writeFileSync(join(home, '.zshrc'), 'export EDITOR=vim\n')

      const changed = ensureShimDirectoryOnPath(join(root, 'bin'), home, 'darwin')
      expect(changed).toEqual([join(home, '.zshrc')])
      const body = readFileSync(join(home, '.zshrc'), 'utf8')
      expect(body).toContain('export EDITOR=vim')
      expect(body).toContain('>>> dsh offline cli >>>')
      expect(body).toContain(join(root, 'bin'))
    })

    it('does not append twice', () => {
      const home = join(root, 'home')
      mkdirSync(home, { recursive: true })
      writeFileSync(join(home, '.zshrc'), 'x\n')

      ensureShimDirectoryOnPath(join(root, 'bin'), home, 'darwin')
      const once = readFileSync(join(home, '.zshrc'), 'utf8')
      expect(ensureShimDirectoryOnPath(join(root, 'bin'), home, 'darwin')).toEqual([])
      expect(readFileSync(join(home, '.zshrc'), 'utf8')).toBe(once)
    })

    it('rewrites the block when the directory moves', () => {
      const home = join(root, 'home')
      mkdirSync(home, { recursive: true })
      writeFileSync(join(home, '.zshrc'), 'x\n')

      ensureShimDirectoryOnPath(join(root, 'bin'), home, 'darwin')
      ensureShimDirectoryOnPath(join(root, 'bin2'), home, 'darwin')

      const body = readFileSync(join(home, '.zshrc'), 'utf8')
      expect(body).toContain(join(root, 'bin2'))
      expect(body.match(/>>> dsh offline cli >>>/g)).toHaveLength(1)
    })

    it('never creates a shell profile the user did not have', () => {
      const home = join(root, 'bare')
      mkdirSync(home, { recursive: true })
      expect(ensureShimDirectoryOnPath(join(root, 'bin'), home, 'darwin')).toEqual([])
      expect(existsSync(join(home, '.zshrc'))).toBe(false)
    })

    it('does not touch PATH handling on Windows', () => {
      const home = join(root, 'win')
      mkdirSync(home, { recursive: true })
      writeFileSync(join(home, '.bashrc'), 'x\n')
      expect(ensureShimDirectoryOnPath(join(root, 'bin'), home, 'win32')).toEqual([])
      expect(readFileSync(join(home, '.bashrc'), 'utf8')).toBe('x\n')
    })
  })

  describe('hostile input', () => {
    it('refuses a CLI tarball that tries to escape the install root', () => {
      const archive = tarGz([{ name: 'pkg/../../escape.txt', body: 'nope' }])
      const outcome = installCli(archive, CLI, location)

      expect(outcome.action).toBe('failed')
      expect(existsSync(join(root, 'escape.txt'))).toBe(false)
    })

    it('refuses an absolute path entry', () => {
      const archive = tarGz([{ name: '/tmp/dsh-absolute-escape.txt', body: 'nope' }])
      expect(installCli(archive, CLI, location).action).toBe('failed')
      expect(existsSync('/tmp/dsh-absolute-escape.txt')).toBe(false)
    })

    it('does not follow a planted symlink out of the install root', () => {
      // Pre-create the install root as a symlink pointing somewhere else.
      const outside = join(root, 'outside')
      mkdirSync(outside, { recursive: true })
      mkdirSync(location.installRoot, { recursive: true })
      symlinkSync(outside, join(location.installRoot, 'codegraph'))

      installCli(cliArchive('codegraph'), CLI, location)
      expect(lstatSync(join(location.installRoot, 'codegraph')).isSymbolicLink()).toBe(false)
    })
  })
})
