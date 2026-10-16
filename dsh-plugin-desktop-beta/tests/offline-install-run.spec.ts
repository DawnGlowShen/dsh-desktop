/**
 * The offline installer's entry point: what it does with a manifest, and what it does
 * without one.
 *
 * The value under test is mostly in the failure behaviour. This runs before the Profile
 * is composed on every launch, so the cases that matter are the ones where something is
 * missing or broken: a machine in that state has to keep starting, and the operator has
 * to be able to tell from the log what was skipped.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { packPackage } from './helpers/offline-tar.ts'
import { runOfflineInstall, type RunOfflineInstallOptions } from '../src/offline-install-run.ts'

/** Roots created by a test, removed afterwards. */
const created: string[] = []

/** A logger that records what it was told, without needing a real console. */
function recordingLogger(): {
  readonly errors: string[]
  readonly infos: string[]
  readonly logger: { error(message: string): void; info(message: string): void }
} {
  const errors: string[] = []
  const infos: string[] = []
  return {
    errors,
    infos,
    logger: {
      error: (message: string) => { errors.push(message) },
      info: (message: string) => { infos.push(message) },
    },
  }
}

/**
 * Build a home, a resources directory and a Profile, then run the installer against them.
 *
 * @param manifest - Manifest to write, or undefined to ship no manifest at all.
 * @param tarballs - Archives to place beside the manifest, by file name.
 * @returns The run's report plus the logger's output.
 */
function run(options: {
  manifest?: unknown
  tarballs?: Record<string, Buffer>
}): { readonly report: ReturnType<typeof runOfflineInstall>; readonly errors: string[]; readonly infos: string[] } {
  const root = mkdtempSync(join(tmpdir(), 'offline-run-'))
  created.push(root)
  const resources = join(root, 'resources')
  const install = join(resources, 'offline-install')
  mkdirSync(install, { recursive: true })
  for (const [name, body] of Object.entries(options.tarballs ?? {})) {
    writeFileSync(join(install, name), body)
  }
  if (options.manifest !== undefined) {
    writeFileSync(join(install, 'manifest.json'), JSON.stringify(options.manifest))
  }

  const home = join(root, 'home')
  const profile = join(home, 'profiles', 'desktop')
  mkdirSync(profile, { recursive: true })
  // A real Profile always has a manifest by the time this runs — the installer links
  // into one that already exists, it does not create it.
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'desktop', version: '0.0.0' }))
  const appModules = join(root, 'app', 'node_modules')
  mkdirSync(appModules, { recursive: true })

  const recorded = recordingLogger()
  const config: RunOfflineInstallOptions = {
    resourcesPath: resources,
    packageRoot: join(root, 'app'),
    homeDir: home,
    userHomeDir: join(root, 'user-home'),
    profileDir: profile,
    appModulesDir: appModules,
    binName: 'dsh-test',
    platform: 'darwin',
    packaged: true,
    logger: recorded.logger,
  }
  return {
    report: runOfflineInstall(config),
    errors: recorded.errors,
    infos: recorded.infos,
  }
}

afterEach(() => {
  for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('runOfflineInstall', () => {
  it('reports that it did nothing when no manifest was shipped', () => {
    const result = run({})
    expect(result.report).toEqual({ ran: false, clis: [], plugins: [], configurations: [] })
    // Running from source has no manifest. Nothing was wrong, so nothing is an error.
    expect(result.errors).toEqual([])
  })

  it('installs a CLI the manifest names', () => {
    const result = run({
      manifest: {
        version: 1,
        clis: [{ name: 'demo', version: '1.2.3', tarball: 'demo.tgz', executable: 'bin/demo' }],
      },
      tarballs: { 'demo.tgz': packPackage({ 'bin/demo': '#!/bin/sh\necho demo\n' }) },
    })
    expect(result.report.ran).toBe(true)
    expect(result.report.clis).toEqual([
      expect.objectContaining({ name: 'demo', action: 'installed' }),
    ])
    expect(result.errors).toEqual([])
  })

  it('reports a CLI whose tarball is missing without throwing', () => {
    const result = run({
      manifest: {
        version: 1,
        clis: [{ name: 'demo', version: '1.2.3', tarball: 'absent.tgz', executable: 'bin/demo' }],
      },
    })
    expect(result.report.clis[0]).toEqual(expect.objectContaining({ name: 'demo', action: 'failed' }))
    // The reason names the missing file: "failed" alone would not say what to fix.
    expect(result.report.clis[0]?.reason).toContain('absent.tgz')
    expect(result.errors.join('\n')).toContain('absent.tgz')
  })

  it('installs a plugin and registers it in the Profile', () => {
    const result = run({
      manifest: {
        version: 1,
        plugins: [{ name: 'demo-plugin', version: '1.0.0', tarball: 'demo-plugin.tgz' }],
      },
      tarballs: {
        'demo-plugin.tgz': packPackage({
          'package.json': JSON.stringify({ name: 'demo-plugin', version: '1.0.0' }),
          'index.js': 'export const demo = 1\n',
        }),
      },
    })
    expect(result.report.plugins).toEqual([
      expect.objectContaining({ name: 'demo-plugin', action: 'installed' }),
    ])
    expect(result.errors).toEqual([])
  })

  it('reports one bad plugin without withholding the others', () => {
    // One package cannot be installed; the rest of the manifest still is. Failing the
    // whole run here would leave a machine with none of its payloads because of one.
    const result = run({
      manifest: {
        version: 1,
        plugins: [
          { name: 'first', version: '1.0.0', tarball: 'first.tgz' },
          { name: 'second', version: '1.0.0', tarball: 'missing.tgz' },
        ],
      },
      tarballs: {
        'first.tgz': packPackage({
          'package.json': JSON.stringify({ name: 'first', version: '1.0.0' }),
        }),
      },
    })
    expect(result.report.plugins[0]).toEqual(expect.objectContaining({ name: 'first', action: 'installed' }))
    expect(result.report.plugins[1]).toEqual(expect.objectContaining({ name: 'second', action: 'failed' }))
  })

  it('treats a malformed manifest as nothing to do, not as a crash', () => {
    const root = mkdtempSync(join(tmpdir(), 'offline-bad-'))
    created.push(root)
    const install = join(root, 'resources', 'offline-install')
    mkdirSync(install, { recursive: true })
    writeFileSync(join(install, 'manifest.json'), '{ this is not json')

    const recorded = recordingLogger()
    const report = runOfflineInstall({
      resourcesPath: join(root, 'resources'),
      packageRoot: join(root, 'app'),
      homeDir: join(root, 'home'),
      userHomeDir: join(root, 'user-home'),
      profileDir: join(root, 'home', 'profiles', 'desktop'),
      appModulesDir: join(root, 'app', 'node_modules'),
      binName: 'dsh-test',
      platform: 'darwin',
      packaged: true,
      logger: recorded.logger,
    })
    expect(report).toEqual({ ran: false, clis: [], plugins: [], configurations: [] })
    // Startup must not depend on this file being well-formed, but a reader should learn
    // that one exists and was unreadable — silence would look like "no manifest shipped".
    expect(recorded.errors.join('\n')).toContain('manifest')
  })

  it('honours the environment override for the manifest directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'offline-env-'))
    created.push(root)
    const elsewhere = join(root, 'elsewhere')
    mkdirSync(elsewhere, { recursive: true })
    writeFileSync(
      join(elsewhere, 'manifest.json'),
      JSON.stringify({ version: 1, clis: [], plugins: [] }),
    )

    const recorded = recordingLogger()
    const report = runOfflineInstall({
      resourcesPath: join(root, 'resources'),
      packageRoot: join(root, 'app'),
      homeDir: join(root, 'home'),
      userHomeDir: join(root, 'user-home'),
      profileDir: join(root, 'home', 'profiles', 'desktop'),
      appModulesDir: join(root, 'app', 'node_modules'),
      binName: 'dsh-test',
      platform: 'darwin',
      packaged: true,
      environment: { DSH_DESKTOP_OFFLINE_INSTALL_DIR: elsewhere },
      logger: recorded.logger,
    })
    expect(report.ran).toBe(true)
  })

  it('runs every registered configuration and reports one outcome each', () => {
    // The shipped registry writes the user's gitconfig for git-ai. It runs on a manifest
    // install rather than only on a fresh machine: that is how a gitconfig edited by hand
    // is brought back into line on the next launch.
    const result = run({
      manifest: {
        version: 1,
        clis: [{ name: 'demo', version: '1.2.3', tarball: 'demo.tgz', executable: 'bin/demo' }],
      },
      tarballs: { 'demo.tgz': packPackage({ 'bin/demo': '#!/bin/sh\necho demo\n' }) },
    })

    // A literal, not a read-back of the registry: comparing the report against the
    // registry it came from is true by construction and would not notice a configuration
    // being dropped — which is the documented way to disable one.
    expect(result.report.configurations.map(outcome => outcome.name)).toEqual(['git-ai', 'dream-skin'])
    expect(result.report.configurations.every(outcome => outcome.action !== 'failed')).toBe(true)
    expect(result.errors).toEqual([])
  })

  it('runs the configuration stage even when every payload fails', () => {
    // Configurations are not payload entries: whether they run does not depend on a
    // tarball being readable. A machine whose CLI tarball is missing still needs its
    // settings written, and those settings do not come from the payload at all.
    const result = run({
      manifest: {
        version: 1,
        clis: [{ name: 'demo', version: '1.2.3', tarball: 'absent.tgz', executable: 'bin/demo' }],
      },
    })

    expect(result.report.clis[0]).toEqual(expect.objectContaining({ action: 'failed' }))
    expect(result.report.configurations.map(outcome => outcome.name)).toEqual(['git-ai', 'dream-skin'])
  })
})
