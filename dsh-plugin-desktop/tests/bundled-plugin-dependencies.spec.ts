import { describe, expect, it } from 'vitest'
import { DEFAULT_PROFILE_PLUGIN_BUNDLES, desktopPluginDependencies, shippedPluginDependencySpecs } from '../src/product-identity.ts'

describe('shipped plugin dependency records', () => {
  it('declares every shipped default plugin as a direct installation dependency', () => {
    const dependencies = desktopPluginDependencies()
    for (const name of DEFAULT_PROFILE_PLUGIN_BUNDLES) {
      expect(dependencies[name], `${name} is not a dependency of this package`).toBeTypeOf('string')
    }
  })

  it('records one spec per shipped plugin and nothing else', () => {
    const dependencies = desktopPluginDependencies()
    const specs = shippedPluginDependencySpecs(dependencies)
    expect(Object.keys(specs)).toEqual([...DEFAULT_PROFILE_PLUGIN_BUNDLES])
    // The Plugin Manager derives `installed` from the profile's dependency names
    // alone, so a missing entry would hide that plugin's configuration page.
    for (const name of DEFAULT_PROFILE_PLUGIN_BUNDLES) expect(specs[name]).toBe(dependencies[name])
  })

  it('ignores dependencies that ship no default plugin', () => {
    expect(shippedPluginDependencySpecs({ 'some-other-package': '1.0.0' })).toEqual({})
  })
})
