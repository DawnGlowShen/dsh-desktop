/**
 * Dependencies that export only subpaths must not be reported as missing.
 *
 * A package whose `exports` map has no `"."` entry rejects its own root with
 * `ERR_PACKAGE_PATH_NOT_EXPORTED` while being perfectly installed. `@codemirror/legacy-modes`
 * is the real one that caught this: `dsh-better-sidebar` declares it, the link was created,
 * and the plugin was still reported as having an unresolved dependency — sending a reader
 * after a package that was already on disk.
 *
 * The check therefore falls back to the filesystem after that one specific failure, and
 * these tests hold both halves of that: subpath-only packages are accepted, and genuinely
 * absent packages are still reported.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { inspectPluginDependencies, supplyPluginDependencies } from '../src/offline-install-plugins.ts'

const roots: string[] = []

/** A throwaway directory that is removed after each test. */
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-offline-subpath-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Write one package into a `node_modules` directory, with any entry files it declares. */
function writePackage(nodeModules: string, name: string, manifest: object, files: Record<string, string> = {}): void {
  const directory = join(nodeModules, name)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...manifest }))
  for (const [relative, body] of Object.entries(files)) {
    const target = join(directory, relative)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, body)
  }
}

/**
 * A plugin already linked into a profile, with the given packages in the App tree.
 *
 * Linking is part of the setup because `inspectPluginDependencies` resolves from the profile
 * link, and a dependency only becomes reachable once {@link supplyPluginDependencies} has
 * put it there — inspecting a plugin that was never linked would test the wrong thing.
 */
function linkedPlugin(
  pluginName: string,
  dependencies: Record<string, string>,
  appPackages: readonly { name: string; manifest: object; files?: Record<string, string> }[],
): { profileDir: string; installDir: string } {
  const root = scratch()
  const appModulesDir = join(root, 'app', 'node_modules')
  const installRoot = join(root, 'offline', 'plugins')
  const profileDir = join(root, 'profiles', 'desktop')
  mkdirSync(appModulesDir, { recursive: true })
  mkdirSync(installRoot, { recursive: true })
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  for (const entry of appPackages) writePackage(appModulesDir, entry.name, entry.manifest, entry.files ?? {})

  const installDir = join(installRoot, pluginName)
  mkdirSync(installDir, { recursive: true })
  writeFileSync(join(installDir, 'package.json'), JSON.stringify({ name: pluginName, version: '1.0.0', dependencies }))

  supplyPluginDependencies(installDir, {
    installRoot, profileDir, appModulesDir, binName: 'dsh-plugin-desktop', platform: 'darwin',
  })
  mkdirSync(join(profileDir, 'node_modules', pluginName), { recursive: true })
  writeFileSync(join(profileDir, 'node_modules', pluginName, 'package.json'), JSON.stringify({ name: pluginName, version: '1.0.0', dependencies }))
  return { profileDir, installDir }
}

describe('inspectPluginDependencies with subpath-only exports', () => {
  it('accepts a dependency that exports only subpaths', () => {
    // This is the shape that produced the false report: no "." key at all.
    const { profileDir, installDir } = linkedPlugin(
      'dsh-better-sidebar',
      { '@codemirror/legacy-modes': '^6.5.3' },
      [{
        name: '@codemirror/legacy-modes',
        manifest: { exports: { './mode/clike': './mode/clike.js' } },
        files: { 'mode/clike.js': 'export const clike = {}\n' },
      }],
    )

    expect(inspectPluginDependencies(installDir, 'dsh-better-sidebar', profileDir)).toEqual([])
  })

  it('accepts an ESM subpath-only dependency', () => {
    // `type: module` reaches the same error through a different resolution path.
    const { profileDir, installDir } = linkedPlugin(
      'plugin-esm',
      { 'subpath-esm': '^1.0.0' },
      [{
        name: 'subpath-esm',
        manifest: { type: 'module', exports: { './util': './util.js' } },
        files: { 'util.js': 'export const util = 1\n' },
      }],
    )

    expect(inspectPluginDependencies(installDir, 'plugin-esm', profileDir)).toEqual([])
  })

  it('accepts a dependency with no exports field at all', () => {
    // The ordinary case must keep working; the fix must not have replaced one wrong
    // answer with another.
    const { profileDir, installDir } = linkedPlugin(
      'plugin-plain',
      { 'plain-dep': '^1.0.0' },
      [{ name: 'plain-dep', manifest: { main: 'index.js' }, files: { 'index.js': 'module.exports = {}\n' } }],
    )

    expect(inspectPluginDependencies(installDir, 'plugin-plain', profileDir)).toEqual([])
  })

  it('still reports a dependency that is genuinely absent', () => {
    // The relaxation is only for the subpath case; a missing package must not slip through.
    const { profileDir, installDir } = linkedPlugin(
      'plugin-missing',
      { 'definitely-absent': '^1.0.0' },
      [],
    )

    expect(inspectPluginDependencies(installDir, 'plugin-missing', profileDir)).toEqual([
      { plugin: 'plugin-missing', dependency: 'definitely-absent' },
    ])
  })

  it('reports the absent dependency and keeps the subpath one', () => {
    // Both in one plugin, so a fix that accepts everything fails here.
    const { profileDir, installDir } = linkedPlugin(
      'plugin-mixed',
      { '@codemirror/legacy-modes': '^6.5.3', 'definitely-absent': '^1.0.0' },
      [{
        name: '@codemirror/legacy-modes',
        manifest: { exports: { './mode/clike': './mode/clike.js' } },
        files: { 'mode/clike.js': 'export const clike = {}\n' },
      }],
    )

    expect(inspectPluginDependencies(installDir, 'plugin-mixed', profileDir)).toEqual([
      { plugin: 'plugin-mixed', dependency: 'definitely-absent' },
    ])
  })

  it('does not accept a subpath-only package that is not there', () => {
    // Guards the fallback: it must confirm presence on disk, not merely assume that an
    // exports map means the package exists.
    const { profileDir, installDir } = linkedPlugin(
      'plugin-absent-subpath',
      { 'absent-subpath': '^1.0.0' },
      [],
    )

    expect(inspectPluginDependencies(installDir, 'plugin-absent-subpath', profileDir)).toEqual([
      { plugin: 'plugin-absent-subpath', dependency: 'absent-subpath' },
    ])
  })
})
