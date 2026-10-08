import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { OPTIONAL_BUNDLES } from '@deepseek-ai/dsh-app-boot'
import { expect, it } from 'vitest'
const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'))
it('declares every official optional bundle as a discoverable, version-aligned installation dependency', () => {
  const next = read('../package.json')
  const require = createRequire(new URL('../package.json', import.meta.url))
  for (const name of OPTIONAL_BUNDLES) {
    expect(next.dependencies[name], name).toBe(next.dependencies['@deepseek-ai/dsh-app-boot'])
    const installed = JSON.parse(readFileSync(require.resolve(`${name}/package.json`), 'utf8'))
    expect(installed.version, name).toBe(next.dependencies[name])
    expect(installed.dsh?.bundle?.patch, name).toBeTruthy()
  }
})

it('keeps Next installer topology, native modules, fuses and Composer source aligned with Beta', () => {
  const next = read('../package.json'); const beta = read('../../dsh-plugin-desktop-beta/package.json')
  expect(next.version).toBe('2.0.17-next')
  expect(next.build.appId).toBe('ai.deepseek.dsh.desktop.next')
  expect(next.build.asar).toBe(false)
  expect(next.build.electronFuses).toEqual(beta.build.electronFuses)
  // The Evo custom edition restructures Beta's unpack pattern from
  // `**/node_modules/{...}` into `**/{node_modules/{...},Resources/codegraph/**,Resources/mnemon/**}`
  // so the bundled CodeGraph and Mnemon CLIs stay outside the archive. Next still
  // mirrors Beta's native-module list, so compare the declared package lists as
  // sets — the two editions order `@dataiku/uv-darwin-*` differently — and require
  // the two darwin node bindings that only Next keeps
  // (`@trycua/cua-driver-darwin-*`, `@ubjs/node-darwin-*`).
  const unpackedNames = (pattern: string): Set<string> => {
    const group = /node_modules\/\{([^}]*)\}/u.exec(pattern)?.[1]
    expect(group).toBeDefined()
    return new Set((group ?? '').split(','))
  }
  const betaUnpacked = unpackedNames(beta.build.mac.x64ArchFiles)
  const nextUnpacked = unpackedNames(next.build.mac.x64ArchFiles)
  expect([...betaUnpacked].filter(name => !nextUnpacked.has(name))).toEqual([])
  expect([...nextUnpacked].filter(name => !betaUnpacked.has(name))).toEqual(['@trycua/cua-driver-darwin-*/**', '@ubjs/node-darwin-*/**'])
  expect(next.build.mac.icon).toBe('build/app-icon.icon')
  expect(existsSync(new URL('../build/app-icon.icon/icon.json', import.meta.url))).toBe(true)
  expect(next.build.nsis).toMatchObject({ oneClick: false, perMachine: false, allowElevation: true, allowToChangeInstallationDirectory: true })
  expect(next.build.mac.notarize).toBe(true)
  expect(next.build.files).toContain('lib/**')
  expect(next.build.files.some((path: string) => path.includes('.desktop-next'))).toBe(false)
})
