import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  OFFLINE_INSTALL_MANIFEST_VERSION,
  offlineInstallDirectory,
  offlineTarballExists,
  offlineTarballPath,
  readOfflineInstallManifest,
  readOfflineTarball,
  type OfflineInstallLogger,
  type OfflineInstallManifest,
} from '../src/offline-install-manifest.ts'

const roots: string[] = []

/** A throwaway directory that is removed after each test. */
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-offline-manifest-'))
  roots.push(root)
  return root
}

/** A logger that records what the reader reported. */
function recorder(): OfflineInstallLogger & { infos: string[]; errors: string[] } {
  const infos: string[] = []
  const errors: string[] = []
  return { infos, errors, info: message => infos.push(message), error: message => errors.push(message) }
}

/** Write a manifest into a fresh payload directory and return both. */
function payload(document: unknown): { directory: string; resourcesPath: string } {
  const root = scratch()
  const resourcesPath = join(root, 'Resources')
  const directory = join(resourcesPath, 'offline-install')
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(directory, 'manifest.json'),
    typeof document === 'string' ? document : JSON.stringify(document),
  )
  return { directory, resourcesPath }
}

/** Read a payload as a packaged shell would. */
function read(resourcesPath: string, logger: OfflineInstallLogger) {
  return readOfflineInstallManifest({
    resourcesPath,
    packageRoot: '/unused',
    packaged: true,
    environment: {},
    logger,
  })
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('offline install payload location', () => {
  it('rides beside a packaged application', () => {
    expect(offlineInstallDirectory({ resourcesPath: '/r', packageRoot: '/p', packaged: true, environment: {} }))
      .toBe('/r/offline-install')
  })

  it('comes from the prepared build tree in development', () => {
    expect(offlineInstallDirectory({ resourcesPath: '/r', packageRoot: '/p', packaged: false, environment: {} }))
      .toBe('/p/.desktop-build/offline-install')
  })

  it('honours the environment override in either mode', () => {
    expect(offlineInstallDirectory({ resourcesPath: '/r', packageRoot: '/p', packaged: true, environment: { DSH_DESKTOP_OFFLINE_INSTALL_DIR: '/custom' } }))
      .toBe('/custom')
  })
})

describe('offline install manifest reading', () => {
  it('accepts a complete manifest', () => {
    const logger = recorder()
    const { resourcesPath, directory } = payload({
      version: OFFLINE_INSTALL_MANIFEST_VERSION,
      plugins: [{ name: 'dsh-mnemon', version: '0.5.24', tarball: 'tarballs/dsh-mnemon-0.5.24.tgz' }],
      clis: [{ name: 'codegraph', version: '1.6.0', tarball: 'tarballs/codegraph-1.6.0.tgz', executable: 'bin/codegraph' }],
    })
    const manifest = read(resourcesPath, logger)
    expect(manifest).toBeDefined()
    expect(manifest?.directory).toBe(directory)
    expect(manifest?.plugins).toEqual([{ name: 'dsh-mnemon', version: '0.5.24', tarball: 'tarballs/dsh-mnemon-0.5.24.tgz' }])
    expect(manifest?.clis).toEqual([{ name: 'codegraph', version: '1.6.0', tarball: 'tarballs/codegraph-1.6.0.tgz', executable: 'bin/codegraph' }])
    expect(logger.errors).toEqual([])
  })

  it('treats an absent manifest as nothing to install', () => {
    const logger = recorder()
    const root = scratch()
    expect(read(join(root, 'Resources'), logger)).toBeUndefined()
    expect(logger.errors).toEqual([])
    expect(logger.infos).toHaveLength(1)
  })

  it('refuses malformed JSON without throwing', () => {
    const logger = recorder()
    const { resourcesPath } = payload('{ this is not json')
    expect(read(resourcesPath, logger)).toBeUndefined()
    expect(logger.errors[0]).toContain('is not valid JSON')
  })

  it('refuses a document that is not an object', () => {
    const logger = recorder()
    expect(read(payload('[]').resourcesPath, logger)).toBeUndefined()
    expect(logger.errors[0]).toContain('is not an object')
  })

  it('refuses an unknown schema version', () => {
    const logger = recorder()
    const { resourcesPath } = payload({ version: 99, plugins: [] })
    expect(read(resourcesPath, logger)).toBeUndefined()
    expect(logger.errors[0]).toContain('declares version 99')
  })

  it('treats missing entry lists as empty', () => {
    const logger = recorder()
    const manifest = read(payload({ version: OFFLINE_INSTALL_MANIFEST_VERSION }).resourcesPath, logger)
    expect(manifest?.plugins).toEqual([])
    expect(manifest?.clis).toEqual([])
  })

  it('reports a non-array entry list instead of failing', () => {
    const logger = recorder()
    const { resourcesPath } = payload({ version: OFFLINE_INSTALL_MANIFEST_VERSION, plugins: 'nope' })
    const manifest = read(resourcesPath, logger)
    expect(manifest?.plugins).toEqual([])
    expect(logger.errors[0]).toContain('plugins is not an array')
  })

  it('drops unusable entries and keeps the rest', () => {
    const logger = recorder()
    const { resourcesPath } = payload({
      version: OFFLINE_INSTALL_MANIFEST_VERSION,
      plugins: [
        { name: 'good', version: '1.0.0', tarball: 'tarballs/good.tgz' },
        { name: 'no-version', tarball: 'tarballs/x.tgz' },
        { version: '1.0.0', tarball: 'tarballs/y.tgz' },
        { name: 'no-tarball', version: '1.0.0' },
        'not an object',
      ],
    })
    const manifest = read(resourcesPath, logger)
    expect(manifest?.plugins).toEqual([{ name: 'good', version: '1.0.0', tarball: 'tarballs/good.tgz' }])
    expect(logger.errors).toHaveLength(4)
  })

  it.each([
    ['an absolute plugin tarball', { name: 'p', version: '1', tarball: '/etc/passwd' }],
    ['a traversing plugin tarball', { name: 'p', version: '1', tarball: '../../outside.tgz' }],
  ])('refuses %s', (_label, entry) => {
    const logger = recorder()
    const { resourcesPath } = payload({ version: OFFLINE_INSTALL_MANIFEST_VERSION, plugins: [entry] })
    expect(read(resourcesPath, logger)?.plugins).toEqual([])
    expect(logger.errors[0]).toContain('outside the payload')
  })

  it.each([
    ['an absolute executable', { name: 'c', version: '1', tarball: 't.tgz', executable: '/bin/sh' }],
    ['a traversing executable', { name: 'c', version: '1', tarball: 't.tgz', executable: '../escape' }],
  ])('refuses %s', (_label, entry) => {
    const logger = recorder()
    const { resourcesPath } = payload({ version: OFFLINE_INSTALL_MANIFEST_VERSION, clis: [entry] })
    expect(read(resourcesPath, logger)?.clis).toEqual([])
    expect(logger.errors[0]).toContain('outside the tarball')
  })

  it('resolves a tarball against the payload directory', () => {
    const logger = recorder()
    const { resourcesPath, directory } = payload({
      version: OFFLINE_INSTALL_MANIFEST_VERSION,
      plugins: [{ name: 'p', version: '1', tarball: 'tarballs/p.tgz' }],
    })
    const manifest = read(resourcesPath, logger)
    expect(offlineTarballPath(manifest!, 'tarballs/p.tgz')).toBe(join(directory, 'tarballs/p.tgz'))
  })

  it('works without an info channel', () => {
    const errors: string[] = []
    const { resourcesPath } = payload({
      version: OFFLINE_INSTALL_MANIFEST_VERSION,
      plugins: [{ name: 'p', version: '1', tarball: 'tarballs/p.tgz' }],
    })
    const manifest = readOfflineInstallManifest({
      resourcesPath,
      packageRoot: '/unused',
      packaged: true,
      environment: {},
      logger: { error: message => errors.push(message) },
    })
    expect(manifest?.plugins).toHaveLength(1)
    expect(errors).toEqual([])
  })
})

describe('split archives', () => {
  /** Write a payload directory holding one named archive, whole or split. */
  function payloadWith(archive: Buffer, whole: boolean, parts: number): string {
    const root = scratch()
    const directory = join(root, 'offline-install')
    mkdirSync(directory, { recursive: true })
    if (whole) {
      writeFileSync(join(directory, 'dependencies-1.0.0.tgz'), archive)
      return directory
    }
    const size = Math.ceil(archive.length / parts)
    for (let index = 0; index < parts; index += 1) {
      const suffix = String.fromCharCode(97 + index).repeat(2)
      writeFileSync(
        join(directory, `dependencies-1.0.0.tgz.part-${suffix}`),
        archive.subarray(index * size, (index + 1) * size),
      )
    }
    return directory
  }

  /** A manifest pointing at one payload directory. */
  function manifestFor(directory: string): OfflineInstallManifest {
    return {
      directory,
      plugins: [],
      clis: [],
      dependencies: { version: '1.0.0', tarball: 'dependencies-1.0.0.tgz' },
    }
  }

  it('reads a whole archive unchanged', () => {
    const archive = Buffer.from('whole archive bytes')
    const manifest = manifestFor(payloadWith(archive, true, 1))
    expect(offlineTarballExists(manifest, 'dependencies-1.0.0.tgz')).toBe(true)
    expect(readOfflineTarball(manifest, 'dependencies-1.0.0.tgz')).toEqual(archive)
  })

  it('rejoins parts in name order', () => {
    // The order is the whole point: parts are written sequentially and named with
    // fixed-width suffixes, so a lexical sort must reproduce the original bytes.
    const archive = Buffer.from('0123456789abcdef')
    const manifest = manifestFor(payloadWith(archive, false, 4))
    expect(offlineTarballExists(manifest, 'dependencies-1.0.0.tgz')).toBe(true)
    expect(readOfflineTarball(manifest, 'dependencies-1.0.0.tgz')).toEqual(archive)
  })

  it('ignores another archive\'s parts', () => {
    // A payload holds several archives; matching on a bare `.part-` would splice
    // unrelated files into the result.
    const archive = Buffer.from('target archive')
    const directory = payloadWith(archive, false, 2)
    writeFileSync(join(directory, 'other-1.0.0.tgz.part-aa'), 'unrelated')
    const manifest = manifestFor(directory)
    expect(readOfflineTarball(manifest, 'dependencies-1.0.0.tgz')).toEqual(archive)
  })

  it('reports absence rather than throwing from the presence check', () => {
    const manifest = manifestFor(scratch())
    expect(offlineTarballExists(manifest, 'dependencies-1.0.0.tgz')).toBe(false)
    expect(() => readOfflineTarball(manifest, 'dependencies-1.0.0.tgz')).toThrow('is missing')
  })
})
