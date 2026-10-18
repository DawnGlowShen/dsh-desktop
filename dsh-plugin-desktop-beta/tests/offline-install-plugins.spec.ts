import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  inspectPluginDependencies,
  installManifestPlugins,
  installPlugin,
  linkDependencyIntoProfile,
  linkPluginIntoProfile,
  registerPluginsInProfileManifest,
  supplyPluginDependencies,
  writeProfilePnpmMetadata,
  type PluginInstallLocation,
} from '../src/offline-install-plugins.ts'
import type { OfflineInstallManifest, OfflinePluginEntry } from '../src/offline-install-manifest.ts'
import { packPackage } from './helpers/offline-tar.ts'

const roots: string[] = []

/** A throwaway directory that is removed after each test. */
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-offline-plugins-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A tarball holding one package with the given package.json and extra files. */
function archive(name: string, version: string, extra: Record<string, string> = {}): Buffer {
  const manifest = { name, version, dependencies: {} as Record<string, string> }
  const files: Record<string, string> = { 'package.json': JSON.stringify(manifest), ...extra }
  return packPackage(files)
}

/** A tarball whose package.json declares dependencies. */
function archiveWithDependencies(
  name: string,
  version: string,
  dependencies: Record<string, string>,
): Buffer {
  return packPackage({
    'package.json': JSON.stringify({ name, version, dependencies }),
  })
}

/** A location whose App tree holds a fake package for each given name. */
function locationWith(names: readonly string[]): PluginInstallLocation {
  const root = scratch()
  const appModulesDir = join(root, 'app', 'node_modules')
  const installRoot = join(root, 'offline', 'plugins')
  const profileDir = join(root, 'profiles', 'desktop')
  mkdirSync(appModulesDir, { recursive: true })
  mkdirSync(installRoot, { recursive: true })
  mkdirSync(profileDir, { recursive: true })
  for (const name of names) {
    const packageDir = join(appModulesDir, name)
    mkdirSync(packageDir, { recursive: true })
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name, version: '1.0.0', main: 'index.js' }))
    writeFileSync(join(packageDir, 'index.js'), 'module.exports = {}\n')
  }
  return {
    installRoot,
    profileDir,
    appModulesDir,
    binName: 'dsh-plugin-desktop',
    platform: 'darwin',
  }
}

/** Write an unpacked plugin directory holding just a package.json. */
function unpacked(location: PluginInstallLocation, name: string, body: unknown): string {
  const installDir = join(location.installRoot, name)
  mkdirSync(installDir, { recursive: true })
  writeFileSync(join(installDir, 'package.json'), JSON.stringify(body))
  return installDir
}

/**
 * Build a manifest whose tarballs sit in a `payload` directory beside the test.
 *
 * `offlineTarballPath` joins the manifest directory with the tarball name, so every
 * tarball must actually be written into that directory for the read to succeed.
 */
function tarballPayload(entries: Record<string, Buffer>): { directory: string; names: Record<string, string> } {
  const directory = scratch()
  const names: Record<string, string> = {}
  for (const [file, contents] of Object.entries(entries)) {
    writeFileSync(join(directory, file), contents)
    names[file] = file
  }
  return { directory, names }
}

/** Build a manifest around one plugin entry. */
function manifestFor(entry: OfflinePluginEntry, directory: string): OfflineInstallManifest {
  return { directory, plugins: [entry], clis: [] }
}

describe('linkPluginIntoProfile', () => {
  it('creates a relative symlink to the unpacked directory', () => {
    const location = locationWith([])
    const installDir = unpacked(location, 'demo', { name: 'demo', version: '1.0.0' })

    const link = linkPluginIntoProfile(installDir, 'demo', location.profileDir)

    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(existsSync(join(link, 'package.json'))).toBe(true)
  })

  it('creates the scope directory for a scoped package', () => {
    const location = locationWith([])
    const installDir = unpacked(location, '@scope/demo', { name: '@scope/demo', version: '1.0.0' })

    linkPluginIntoProfile(installDir, '@scope/demo', location.profileDir)

    expect(lstatSync(join(location.profileDir, 'node_modules', '@scope', 'demo')).isSymbolicLink()).toBe(true)
  })

  it('replaces an existing symlink so a moved store is corrected', () => {
    const location = locationWith([])
    const first = unpacked(location, 'demo', { name: 'demo', version: '1.0.0' })
    const link = linkPluginIntoProfile(first, 'demo', location.profileDir)

    const second = unpacked(location, 'demo-2', { name: 'demo', version: '1.0.0' })
    linkPluginIntoProfile(second, 'demo', location.profileDir)

    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    // The link now resolves to the moved store, not the removed one.
    expect(existsSync(join(link, 'package.json'))).toBe(true)
    expect(existsSync(first)).toBe(true)
  })

  it('leaves a real directory alone, because pnpm owns it', () => {
    const location = locationWith([])
    const owned = join(location.profileDir, 'node_modules', 'demo')
    mkdirSync(owned, { recursive: true })
    writeFileSync(join(owned, 'package.json'), '{"name":"demo","version":"9.9.9"}')

    const installDir = unpacked(location, 'demo', { name: 'demo', version: '1.0.0' })
    linkPluginIntoProfile(installDir, 'demo', location.profileDir)

    expect(lstatSync(owned).isSymbolicLink()).toBe(false)
    expect(JSON.parse(readFileSync(join(owned, 'package.json'), 'utf8')).version).toBe('9.9.9')
  })

  // A link's parent is resolved through its real path, but the stored `..` chain is
  // counted from the path as written. The two disagree only when the real parent sits at
  // a different depth than the written one — macOS `/tmp` → `/private/tmp` is exactly
  // that, one level deeper — and the target shares no ancestor that would absorb the
  // difference. Then every `..` is miscounted and the target lands one level too high,
  // which is what broke dependency links into the App bundle.
  it('counts path segments against the real parent, not the written one', () => {
    const outer = scratch()
    // A symlink whose target lives deeper than the link itself, so paths through it
    // resolve at a different depth than they are spelled.
    const deep = join(outer, 'a', 'b', 'real')
    mkdirSync(join(deep, 'profiles', 'desktop', 'node_modules'), { recursive: true })
    symlinkSync(deep, join(outer, 'linked'), 'dir')
    const writtenProfile = join(outer, 'linked', 'profiles', 'desktop')

    // The target sits outside the symlinked subtree, so no shared ancestor cancels the
    // depth difference.
    const installDir = join(outer, 'store', 'demo')
    mkdirSync(installDir, { recursive: true })
    writeFileSync(join(installDir, 'package.json'), '{"name":"demo","version":"1.0.0"}')

    const link = join(writtenProfile, 'node_modules', 'demo')
    // Precondition: real and written parents really do sit at different depths.
    expect(realpathSync(dirname(link)).split('/').length)
      .not.toBe(dirname(link).split('/').length)

    const created = linkPluginIntoProfile(installDir, 'demo', writtenProfile)
    const stored = readlinkSync(created)

    // Resolution follows Node: apply the stored target to the real parent.
    expect(resolve(realpathSync(dirname(created)), stored)).toBe(realpathSync(installDir))
    expect(isAbsolute(stored)).toBe(false)
    expect(existsSync(join(created, 'package.json'))).toBe(true)
  })
})

describe('linkDependencyIntoProfile', () => {
  it('links a dependency the Profile does not have yet', () => {
    const location = locationWith(['zod'])
    const created = linkDependencyIntoProfile(join(location.appModulesDir, 'zod'), 'zod', location.profileDir)

    expect(created).toBe(true)
    expect(lstatSync(join(location.profileDir, 'node_modules', 'zod')).isSymbolicLink()).toBe(true)
  })

  it('leaves an existing entry alone and reports that nothing was created', () => {
    const location = locationWith(['zod'])
    const existing = join(location.profileDir, 'node_modules', 'zod')
    mkdirSync(existing, { recursive: true })
    writeFileSync(join(existing, 'package.json'), '{"name":"zod","version":"3.0.0"}')

    const created = linkDependencyIntoProfile(join(location.appModulesDir, 'zod'), 'zod', location.profileDir)

    expect(created).toBe(false)
    expect(JSON.parse(readFileSync(join(existing, 'package.json'), 'utf8')).version).toBe('3.0.0')
  })
})

describe('supplyPluginDependencies', () => {
  it('links only the dependencies the App tree actually carries', () => {
    const location = locationWith(['zod', 'yaml'])
    const installDir = unpacked(location, 'demo', {
      name: 'demo',
      version: '1.0.0',
      dependencies: { zod: '^4.0.0', yaml: '^2.0.0', 'not-in-app': '^1.0.0' },
    })

    const linked = supplyPluginDependencies(installDir, location)

    expect(linked).toEqual(['zod', 'yaml'])
    expect(existsSync(join(location.profileDir, 'node_modules', 'not-in-app'))).toBe(false)
  })

  it('returns nothing for a plugin without dependencies', () => {
    const location = locationWith([])
    const installDir = unpacked(location, 'demo', { name: 'demo', version: '1.0.0' })

    expect(supplyPluginDependencies(installDir, location)).toEqual([])
  })
})

describe('inspectPluginDependencies', () => {
  it('reports every dependency as unresolved when nothing was supplied', () => {
    const location = locationWith([])
    const installDir = unpacked(location, 'demo', {
      name: 'demo',
      version: '1.0.0',
      dependencies: { zod: '^4.0.0' },
    })

    expect(inspectPluginDependencies(installDir, 'demo', location.profileDir))
      .toEqual([{ plugin: 'demo', dependency: 'zod' }])
  })

  it('resolves a dependency through the Profile after it is linked', () => {
    const location = locationWith(['zod'])
    const installDir = unpacked(location, 'demo', {
      name: 'demo',
      version: '1.0.0',
      dependencies: { zod: '^4.0.0' },
    })
    linkPluginIntoProfile(installDir, 'demo', location.profileDir)
    supplyPluginDependencies(installDir, location)

    expect(inspectPluginDependencies(installDir, 'demo', location.profileDir)).toEqual([])
  })

  it('still reports a dependency the App tree does not carry', () => {
    const location = locationWith(['zod'])
    const installDir = unpacked(location, 'demo', {
      name: 'demo',
      version: '1.0.0',
      dependencies: { zod: '^4.0.0', missing: '^1.0.0' },
    })
    linkPluginIntoProfile(installDir, 'demo', location.profileDir)
    supplyPluginDependencies(installDir, location)

    expect(inspectPluginDependencies(installDir, 'demo', location.profileDir))
      .toEqual([{ plugin: 'demo', dependency: 'missing' }])
  })

  it('does not throw when the package.json cannot be read', () => {
    const location = locationWith([])
    const installDir = join(location.installRoot, 'demo')
    mkdirSync(installDir, { recursive: true })

    expect(inspectPluginDependencies(installDir, 'demo', location.profileDir)).toEqual([])
  })
})

describe('writeProfilePnpmMetadata', () => {
  it('writes the three files that make the Profile look installed', () => {
    const location = locationWith([])

    const written = writeProfilePnpmMetadata(location.profileDir, 'darwin')

    expect(written).toHaveLength(3)
    expect(readFileSync(join(location.profileDir, 'pnpm-workspace.yaml'), 'utf8'))
      .toContain('nodeLinker: hoisted')
    expect(readFileSync(join(location.profileDir, 'node_modules', '.modules.yaml'), 'utf8'))
      .toContain('packageManager: pnpm@11.8.0')
    expect(readFileSync(join(location.profileDir, 'pnpm-lock.yaml'), 'utf8'))
      .toContain('autoInstallPeers: false')
  })

  it('uses the Windows virtual-store limit on win32', () => {
    const location = locationWith([])

    writeProfilePnpmMetadata(location.profileDir, 'win32')

    expect(readFileSync(join(location.profileDir, 'node_modules', '.modules.yaml'), 'utf8'))
      .toContain('virtualStoreDirMaxLength: 60')
  })

  // pnpm 11 validates these fields too. A record missing one is rejected with a hint to
  // run `pnpm install` — the install path that flattens the links written here.
  it('records the layout fields pnpm validates', () => {
    const location = locationWith([])

    writeProfilePnpmMetadata(location.profileDir, 'darwin')

    const contents = readFileSync(join(location.profileDir, 'node_modules', '.modules.yaml'), 'utf8')
    expect(contents).toContain('hoistPattern: ["*"]')
    expect(contents).toContain('layoutVersion: 5')
    expect(contents).toContain('publicHoistPattern: []')
    expect(contents).toMatch(/storeDir: "[^"]*store[/\\]v11"/)
  })

  // What earlier Desktop builds wrote: the launcher accepted it, pnpm rejected it.
  it('fills in the layout fields an earlier record omitted', () => {
    const location = locationWith([])
    const modulesState = join(location.profileDir, 'node_modules', '.modules.yaml')
    mkdirSync(dirname(modulesState), { recursive: true })
    writeFileSync(modulesState, 'nodeLinker: hoisted\npackageManager: pnpm@11.8.0\nvirtualStoreDirMaxLength: 120\n')

    const written = writeProfilePnpmMetadata(location.profileDir, 'darwin')

    expect(written).toContain(modulesState)
    const contents = readFileSync(modulesState, 'utf8')
    expect(contents).toContain('hoistPattern:')
    expect(contents).toMatch(/hoistPattern:\n\s+- "\*"/)
    expect(contents).toContain('layoutVersion: 5')
    expect(contents).toContain('storeDir:')
    expect(contents).toContain('packageManager: pnpm@11.8.0')
  })

  it('never overwrites metadata pnpm already wrote', () => {
    const location = locationWith([])
    const lockfile = join(location.profileDir, 'pnpm-lock.yaml')
    writeFileSync(lockfile, 'lockfileVersion: \'9.0\'\n# pnpm wrote this\n')

    const written = writeProfilePnpmMetadata(location.profileDir, 'darwin')

    expect(written).not.toContain(lockfile)
    expect(readFileSync(lockfile, 'utf8')).toContain('# pnpm wrote this')
  })

  // A record that exists but fails the launcher's check is worse than a missing one: the
  // launcher reinstalls the Profile with pnpm and flattens every link this module wrote.
  it('repairs a module record whose fields the launcher would reject', () => {
    const location = locationWith([])
    const modulesState = join(location.profileDir, 'node_modules', '.modules.yaml')
    mkdirSync(dirname(modulesState), { recursive: true })
    writeFileSync(modulesState, 'nodeLinker: hoisted\npackageManager: pnpm@9.0.0\n')

    const written = writeProfilePnpmMetadata(location.profileDir, 'darwin')

    expect(written).toContain(modulesState)
    const contents = readFileSync(modulesState, 'utf8')
    expect(contents).toContain('nodeLinker: hoisted')
    expect(contents).toContain('packageManager: pnpm@11.8.0')
    expect(contents).toContain('virtualStoreDirMaxLength: 120')
    expect(contents).toContain('hoistPattern:')
    expect(contents).toContain('layoutVersion: 5')
    expect(contents).toContain('storeDir:')
  })

  // The check reads three fields. Everything else in the record is pnpm's own account of
  // its store, registries and layout, and rewriting it would describe a state that does
  // not exist — so a repair must merge, not replace.
  it('keeps the fields pnpm recorded while repairing the ones it checks', () => {
    const location = locationWith([])
    const modulesState = join(location.profileDir, 'node_modules', '.modules.yaml')
    mkdirSync(dirname(modulesState), { recursive: true })
    writeFileSync(modulesState, [
      'layoutVersion: 5',
      'storeDir: /Users/someone/Library/pnpm/store/v11',
      'virtualStoreDir: .pnpm',
      'packageManager: pnpm@11.8.0',
      'virtualStoreDirMaxLength: 60',
      '',
    ].join('\n'))

    const written = writeProfilePnpmMetadata(location.profileDir, 'darwin')

    expect(written).toContain(modulesState)
    const contents = readFileSync(modulesState, 'utf8')
    expect(contents).toContain('layoutVersion: 5')
    expect(contents).toContain('storeDir: /Users/someone/Library/pnpm/store/v11')
    expect(contents).toContain('virtualStoreDir: .pnpm')
    expect(contents).toContain('virtualStoreDirMaxLength: 120')
    // Missing from the record, so it is filled in rather than left for pnpm to reject.
    expect(contents).toContain('hoistPattern:')
  })

  it('leaves an acceptable module record untouched, down to its formatting', () => {
    const location = locationWith([])
    const modulesState = join(location.profileDir, 'node_modules', '.modules.yaml')
    mkdirSync(dirname(modulesState), { recursive: true })
    const original = [
      '{',
      '  "hoistPattern": ["*"],',
      '  "layoutVersion": 5,',
      '  "nodeLinker": "hoisted",',
      '  "packageManager": "pnpm@11.8.0",',
      '  "publicHoistPattern": [],',
      '  "storeDir": "/Users/someone/Library/pnpm/store/v11",',
      '  "virtualStoreDirMaxLength": 120',
      '}',
      '',
    ].join('\n')
    writeFileSync(modulesState, original)

    const written = writeProfilePnpmMetadata(location.profileDir, 'darwin')

    expect(written).not.toContain(modulesState)
    expect(readFileSync(modulesState, 'utf8')).toBe(original)
  })

  it('replaces a module record that cannot be parsed at all', () => {
    const location = locationWith([])
    const modulesState = join(location.profileDir, 'node_modules', '.modules.yaml')
    mkdirSync(dirname(modulesState), { recursive: true })
    writeFileSync(modulesState, '{ not: valid: yaml: at: all\n')

    const written = writeProfilePnpmMetadata(location.profileDir, 'darwin')

    expect(written).toContain(modulesState)
    const contents = readFileSync(modulesState, 'utf8')
    expect(contents).toContain('hoistPattern: ["*"]')
    expect(contents).toContain('layoutVersion: 5')
    expect(contents).toContain('storeDir:')
    expect(contents).toContain('packageManager: pnpm@11.8.0')
    expect(contents).toContain('virtualStoreDirMaxLength: 120')
  })
})

describe('registerPluginsInProfileManifest', () => {
  it('records both a dependency and a bundle entry', () => {
    const location = locationWith([])
    const installDir = join(location.installRoot, 'demo')
    mkdirSync(installDir, { recursive: true })
    writeFileSync(join(location.profileDir, 'package.json'), JSON.stringify({ name: 'desktop', version: '1.0.0' }))

    const added = registerPluginsInProfileManifest(location.profileDir, location.binName, [
      { name: 'demo', version: '1.0.0', directory: installDir },
    ])

    expect(added).toEqual(['demo'])
    const manifest = JSON.parse(readFileSync(join(location.profileDir, 'package.json'), 'utf8'))
    expect(manifest.dependencies.demo).toBe(`file:${installDir}`)
    expect(manifest.dsh.profile.bundles).toContain('demo')
  })

  it('keeps bundles that were already declared', () => {
    const location = locationWith([])
    writeFileSync(join(location.profileDir, 'package.json'), JSON.stringify({
      name: 'desktop',
      version: '1.0.0',
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    }))

    registerPluginsInProfileManifest(location.profileDir, location.binName, [
      { name: 'demo', version: '1.0.0', directory: '/tmp/demo' },
    ])

    const manifest = JSON.parse(readFileSync(join(location.profileDir, 'package.json'), 'utf8'))
    expect(manifest.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base', 'demo'])
  })

  it('does nothing for an empty list', () => {
    const location = locationWith([])

    expect(registerPluginsInProfileManifest(location.profileDir, location.binName, [])).toEqual([])
    expect(existsSync(join(location.profileDir, 'package.json'))).toBe(false)
  })
})

describe('installPlugin', () => {
  it('unpacks, links, supplies dependencies, and stamps the version', () => {
    const location = locationWith(['zod'])

    const outcome = installPlugin(
      archiveWithDependencies('demo', '1.2.3', { zod: '^4.0.0' }),
      { name: 'demo', version: '1.2.3', tarball: 'demo.tgz' },
      location,
    )

    expect(outcome.action).toBe('installed')
    expect(readFileSync(join(location.installRoot, 'demo', '.dsh-offline-version'), 'utf8').trim()).toBe('1.2.3')
    expect(lstatSync(join(location.profileDir, 'node_modules', 'demo')).isSymbolicLink()).toBe(true)
    expect(outcome.unresolved).toEqual([])
  })

  it('reports a plugin whose dependency the App tree lacks', () => {
    const location = locationWith([])

    const outcome = installPlugin(
      archiveWithDependencies('demo', '1.0.0', { 'not-in-app': '^1.0.0' }),
      { name: 'demo', version: '1.0.0', tarball: 'demo.tgz' },
      location,
    )

    expect(outcome.action).toBe('installed')
    expect(outcome.unresolved).toEqual([{ plugin: 'demo', dependency: 'not-in-app' }])
  })

  it('reports an unreadable archive instead of throwing', () => {
    const location = locationWith([])

    const outcome = installPlugin(
      Buffer.from('not a tarball at all'),
      { name: 'demo', version: '1.0.0', tarball: 'demo.tgz' },
      location,
    )

    expect(outcome.action).toBe('failed')
    expect(outcome.reason).toBeDefined()
  })

  it('overwrites an unpacked directory from a previous version', () => {
    const location = locationWith([])
    const entry = { name: 'demo', version: '1.0.0', tarball: 'demo.tgz' }
    installPlugin(archive('demo', '1.0.0', { 'old.txt': 'gone' }), entry, location)

    installPlugin(archive('demo', '2.0.0', { 'new.txt': 'here' }), { ...entry, version: '2.0.0' }, location)

    expect(existsSync(join(location.installRoot, 'demo', 'new.txt'))).toBe(true)
    expect(existsSync(join(location.installRoot, 'demo', 'old.txt'))).toBe(false)
    expect(readFileSync(join(location.installRoot, 'demo', '.dsh-offline-version'), 'utf8').trim()).toBe('2.0.0')
  })
})

describe('installManifestPlugins', () => {
  it('installs every plugin and records them in the Profile', () => {
    const location = locationWith(['zod'])
    writeFileSync(join(location.profileDir, 'package.json'), JSON.stringify({ name: 'desktop', version: '1.0.0' }))
    const payload = tarballPayload({
      'a.tgz': archiveWithDependencies('demo-a', '1.0.0', { zod: '^4.0.0' }),
      'b.tgz': archive('demo-b', '1.0.0'),
    })

    const outcomes = installManifestPlugins(
      {
        directory: payload.directory,
        plugins: [
          { name: 'demo-a', version: '1.0.0', tarball: 'a.tgz' },
          { name: 'demo-b', version: '1.0.0', tarball: 'b.tgz' },
        ],
        clis: [],
      },
      location,
    )

    expect(outcomes.map(outcome => outcome.action)).toEqual(['installed', 'installed'])
    const manifest = JSON.parse(readFileSync(join(location.profileDir, 'package.json'), 'utf8'))
    expect(Object.keys(manifest.dependencies).sort()).toEqual(['demo-a', 'demo-b'])
  })

  it('skips a plugin whose tarball is missing and keeps going', () => {
    const location = locationWith([])
    const payload = tarballPayload({})

    const outcomes = installManifestPlugins(
      manifestFor({ name: 'gone', version: '1.0.0', tarball: 'missing.tgz' }, payload.directory),
      location,
    )

    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]?.action).toBe('failed')
    expect(outcomes[0]?.reason).toContain('tarball is missing')
  })

  it('records only the plugins that fully installed', () => {
    const location = locationWith([])
    writeFileSync(join(location.profileDir, 'package.json'), JSON.stringify({ name: 'desktop', version: '1.0.0' }))
    const payload = tarballPayload({ 'good.tgz': archive('good', '1.0.0') })

    installManifestPlugins(
      {
        directory: payload.directory,
        plugins: [
          { name: 'good', version: '1.0.0', tarball: 'good.tgz' },
          { name: 'bad', version: '1.0.0', tarball: 'nope.tgz' },
        ],
        clis: [],
      },
      location,
    )

    const manifest = JSON.parse(readFileSync(join(location.profileDir, 'package.json'), 'utf8'))
    expect(Object.keys(manifest.dependencies)).toEqual(['good'])
  })

  it('reports a Profile that could not be updated rather than claiming success', () => {
    const location = locationWith([])
    // A manifest that is not an object makes the Profile write fail.
    writeFileSync(join(location.profileDir, 'package.json'), '[]')
    const payload = tarballPayload({ 'demo.tgz': archive('demo', '1.0.0') })

    const outcomes = installManifestPlugins(
      manifestFor({ name: 'demo', version: '1.0.0', tarball: 'demo.tgz' }, payload.directory),
      location,
    )

    expect(outcomes).toHaveLength(2)
    expect(outcomes[1]?.name).toBe('(profile manifest)')
    expect(outcomes[1]?.action).toBe('failed')
  })

  it('does not touch the Profile when the manifest is empty', () => {
    const location = locationWith([])

    expect(installManifestPlugins({ directory: '/tmp', plugins: [], clis: [] }, location)).toEqual([])
    expect(existsSync(join(location.profileDir, 'package.json'))).toBe(false)
  })
})
