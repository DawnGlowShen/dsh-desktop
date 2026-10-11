import { existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDesktopWebProfile } from '../src/profile-manager.ts'
import { DEFAULT_PROFILE_PLUGIN_BUNDLES, desktopPluginDependencies, shippedPluginDependencySpecs } from '../src/product-identity.ts'
import { prepareDesktopProfile, ensureDesktopProfile } from '../src/profile.ts'

/**
 * End-to-end check of the offline seed. A Profile must be created the way the
 * launcher creates one — through `createDesktopWebProfile`, the path a fresh
 * installation takes — and must then satisfy the three properties the Plugin
 * Manager and the launcher depend on, without any package manager running and
 * without a registry being reachable.
 */
describe('offline profile seed', () => {
  const create = (): string => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-offline-seed-'))
    createDesktopWebProfile(home, 'web')
    return home
  }

  const profileDirOf = (home: string): string => {
    const profiles = readdirSync(join(home, 'profiles'))
    expect(profiles).toHaveLength(1)
    return join(home, 'profiles', profiles[0]!)
  }

  it('records every shipped plugin as a dependency the Plugin Manager can see', () => {
    const home = create()
    const manifest = JSON.parse(readFileSync(join(profileDirOf(home), 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    expect(manifest.dependencies).toEqual(shippedPluginDependencySpecs(desktopPluginDependencies()))
    // `installed` is derived from the dependency name alone: a missing entry
    // hides that plugin's card and its configuration page entirely.
    for (const name of DEFAULT_PROFILE_PLUGIN_BUNDLES) {
      expect(manifest.dependencies?.[name], `${name} would be filtered out of the Plugins page`).toBeTypeOf('string')
    }
    rmSync(home, { recursive: true, force: true })
  })

  it('links each shipped plugin into the Profile and resolves it to the installation copy', () => {
    const home = create()
    const profileDir = profileDirOf(home)
    const modulesDir = join(profileDir, 'node_modules')
    for (const name of DEFAULT_PROFILE_PLUGIN_BUNDLES) {
      const linkPath = join(modulesDir, ...name.split('/'))
      expect(lstatSync(linkPath).isSymbolicLink(), `${name} is not a link`).toBe(true)
      // A relative link keeps the Profile relocatable; an absolute one breaks
      // the moment the installation moves.
      expect(readlinkSync(linkPath).startsWith('/'), `${name} link is absolute`).toBe(false)
      const resolved = resolve(dirname(linkPath), readlinkSync(linkPath))
      expect(existsSync(join(resolved, 'package.json')), `${name} resolves to nothing`).toBe(true)
    }
    // pnpm leaves its own bookkeeping behind; its absence proves no install ran.
    expect(existsSync(join(modulesDir, '.modules.yaml'))).toBe(false)
    expect(existsSync(join(profileDir, 'pnpm-lock.yaml'))).toBe(false)
    rmSync(home, { recursive: true, force: true })
  })

  it('prepares without dependency migration, so no registry has to be reachable', () => {
    const home = create()
    const prepared = prepareDesktopProfile(undefined, home, 'darwin')
    // A `true` here sends the launcher into `pnpm install`, which fails offline
    // with "Profile dependency migration failed".
    expect(prepared.requiresDependencyMigration).toBe(false)
    rmSync(home, { recursive: true, force: true })
  })

  it('links only names the installation actually holds', () => {
    const home = create()
    const modulesDir = join(profileDirOf(home), 'node_modules')
    const names = readdirSync(modulesDir, { withFileTypes: true }).flatMap(entry =>
      entry.isDirectory() && entry.name.startsWith('@')
        ? readdirSync(join(modulesDir, entry.name)).map(child => `${entry.name}/${child}`)
        : [entry.name])
    expect(names.sort()).toEqual([...DEFAULT_PROFILE_PLUGIN_BUNDLES].sort())
    rmSync(home, { recursive: true, force: true })
  })

  // The Desktop application never calls `createDesktopWebProfile`: it seeds its
  // own Profile through `ensureDesktopProfile`, a separate entry point with its
  // own `initProfile` call. Both must produce the same seed, or the shipped
  // container would show plugins the development path alone can see.
  describe('through the launcher entry point', () => {
    const launch = (): { home: string; profileDir: string } => {
      const home = mkdtempSync(join(tmpdir(), 'dsh-offline-launch-'))
      const profileDir = ensureDesktopProfile(home)
      return { home, profileDir }
    }

    it('seeds the same dependency records the Plugin Manager reads', () => {
      const { home, profileDir } = launch()
      const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>
      }
      for (const name of DEFAULT_PROFILE_PLUGIN_BUNDLES) {
        expect(manifest.dependencies?.[name], `${name} would be filtered out of the Plugins page`).toBeTypeOf('string')
      }
      rmSync(home, { recursive: true, force: true })
    })

    it('links every shipped plugin and resolves each to a real package', () => {
      const { home, profileDir } = launch()
      const modulesDir = join(profileDir, 'node_modules')
      for (const name of DEFAULT_PROFILE_PLUGIN_BUNDLES) {
        const linkPath = join(modulesDir, ...name.split('/'))
        expect(lstatSync(linkPath).isSymbolicLink(), `${name} is not a link`).toBe(true)
        const resolved = resolve(dirname(linkPath), readlinkSync(linkPath))
        expect(existsSync(join(resolved, 'package.json')), `${name} resolves to nothing`).toBe(true)
      }
      expect(existsSync(join(modulesDir, '.modules.yaml'))).toBe(false)
      rmSync(home, { recursive: true, force: true })
    })

    it('prepares without dependency migration', () => {
      const { home } = launch()
      expect(prepareDesktopProfile(undefined, home, 'darwin').requiresDependencyMigration).toBe(false)
      rmSync(home, { recursive: true, force: true })
    })
  })
})
