/**
 * The shared dependency payload.
 *
 * Some plugins depend on packages the running application does not carry — a Markdown
 * editor's CodeMirror stack, a sidebar's Mermaid renderer. Those have to travel with the
 * payload or the plugin installs and then fails to load.
 *
 * One archive holds the whole tree, and every one of its packages is linked into the
 * Profile beside the plugins that need it. The tests below hold the two halves that make
 * that work: the tree lands where plugins can reach it, and a second run does not rewrite
 * hundreds of megabytes to reach the same state.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEPENDENCY_DIRECTORY, installDependencyPayload } from '../src/offline-install-dependencies.ts'
import { installOfflineManifest } from '../src/offline-install-run.ts'
import type { OfflineInstallManifest } from '../src/offline-install-manifest.ts'
import { tarGz } from './helpers/offline-tar.ts'

const roots: string[] = []

/** A throwaway directory that is removed after each test. */
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-offline-deps-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * A payload directory holding a dependency archive and a manifest that names it.
 *
 * The archive holds packages directly rather than under a `node_modules` directory, which
 * is what lets it unpack straight into the destination.
 */
function payload(name = 'dep', version = '1.0.0'): { directory: string; manifest: OfflineInstallManifest } {
  const directory = scratch()
  const archive = tarGz([
    { name: `${name}/package.json`, body: JSON.stringify({ name, version, main: 'index.js' }) },
    { name: `${name}/index.js`, body: 'module.exports = 1\n' },
  ])
  writeFileSync(join(directory, 'deps.tgz'), archive)
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify({
    version: 1,
    dependencies: { version, tarball: 'deps.tgz' },
    plugins: [],
    clis: [],
  }))
  return {
    directory,
    manifest: { directory, plugins: [], clis: [], dependencies: { version, tarball: 'deps.tgz' } },
  }
}

describe('installDependencyPayload', () => {
  it('unpacks the tree beside the plugins, where Node searches for it', () => {
    const root = scratch()
    const { manifest } = payload()

    const outcome = installDependencyPayload(manifest, root)

    expect(outcome?.action).toBe('installed')
    // The path is the contract: a plugin at `offline/plugins/<name>` reaches its
    // dependencies by walking up to `offline/node_modules`.
    expect(outcome?.directory).toBe(join(root, DEPENDENCY_DIRECTORY))
    expect(existsSync(join(root, DEPENDENCY_DIRECTORY, 'dep', 'package.json'))).toBe(true)
  })

  it('reports nothing to do when the payload ships no tree', () => {
    const root = scratch()
    expect(installDependencyPayload({ directory: root, plugins: [], clis: [] }, root)).toBeUndefined()
  })

  it('keeps the unpacked tree exactly as the archive held it', () => {
    // The version stamp goes beside the tree, never inside it: a file added into
    // `node_modules` could collide with a package name and change what a plugin resolves.
    const root = scratch()
    const { manifest } = payload()

    installDependencyPayload(manifest, root)

    expect(readdirSync(join(root, DEPENDENCY_DIRECTORY))).toEqual(['dep'])
  })

  it('leaves a tree already at the declared version alone', () => {
    // Re-unpacking an identical tree would rewrite hundreds of megabytes on every launch.
    const root = scratch()
    const { manifest } = payload()
    installDependencyPayload(manifest, root)
    const marker = join(root, DEPENDENCY_DIRECTORY, 'dep', 'index.js')
    const before = readFileSync(marker, 'utf8')

    const outcome = installDependencyPayload(manifest, root)

    expect(outcome?.action).toBe('current')
    expect(readFileSync(marker, 'utf8')).toBe(before)
  })

  it('replaces the tree when the payload declares a new version', () => {
    const root = scratch()
    installDependencyPayload(payload('dep', '1.0.0').manifest, root)

    const outcome = installDependencyPayload(payload('other', '2.0.0').manifest, root)

    expect(outcome?.action).toBe('installed')
    // The old tree must not survive: a stale package would shadow the new one.
    expect(readdirSync(join(root, DEPENDENCY_DIRECTORY))).toEqual(['other'])
  })

  it('fails with a reason when the archive is missing', () => {
    const root = scratch()
    const manifest: OfflineInstallManifest = {
      directory: root,
      plugins: [],
      clis: [],
      dependencies: { version: '1.0.0', tarball: 'absent.tgz' },
    }

    const outcome = installDependencyPayload(manifest, root)

    expect(outcome?.action).toBe('failed')
    expect(outcome?.reason).toContain('absent.tgz')
  })
})

describe('dependency payload through the installer', () => {
  /** A plugin whose only dependency the App tree does not carry. */
  function pluginArchive(): Buffer {
    return tarGz([
      {
        name: 'package/package.json',
        body: JSON.stringify({ name: 'needs-dep', version: '1.0.0', dependencies: { dep: '^1.0.0' } }),
      },
    ])
  }

  /** Run the installer against a payload holding a tree and one plugin. */
  function install(manifest: OfflineInstallManifest, homeDir: string): ReturnType<typeof installOfflineManifest> {
    return installOfflineManifest(manifest, {
      resourcesPath: '/nonexistent',
      packageRoot: '/nonexistent',
      homeDir,
      userHomeDir: '/nonexistent',
      profileDir: join(homeDir, 'profiles', 'desktop'),
      // Deliberately a tree with no `dep` in it: the payload is the only possible source.
      appModulesDir: scratch(),
      binName: 'dsh-plugin-desktop',
      platform: 'darwin',
      packaged: false,
      logger: { info: () => {}, error: () => {} },
    })
  }

  it('resolves a plugin dependency that only the payload carries', () => {
    const home = scratch()
    const { directory } = payload()
    writeFileSync(join(directory, 'plug.tgz'), pluginArchive())
    mkdirSync(join(home, 'profiles', 'desktop'), { recursive: true })
    writeFileSync(join(home, 'profiles', 'desktop', 'package.json'), JSON.stringify({ name: 'desktop', version: '0.0.0' }))

    const report = install({
      directory,
      dependencies: { version: '1.0.0', tarball: 'deps.tgz' },
      plugins: [{ name: 'needs-dep', version: '1.0.0', tarball: 'plug.tgz' }],
      clis: [],
    }, home)

    expect(report.plugins[0]?.action).toBe('installed')
    // The whole point: the plugin's dependency came from the payload, not the App.
    expect(report.plugins[0]?.unresolved).toEqual([])
    expect(existsSync(join(home, 'profiles', 'desktop', 'node_modules', 'dep'))).toBe(true)
  })
})
