import { createRequire } from 'node:module'

/** Stable and Beta identities used to locate each edition's private app data. */
export const DESKTOP_RELEASE_IDENTITIES = Object.freeze({
  stable: Object.freeze({
    releaseChannel: 'stable' as const,
    packageName: 'dsh-plugin-desktop',
    productName: 'DSH Desktop',
    appId: 'ai.deepseek.dsh.desktop',
    homeDirectoryName: '.dsh',
    profileName: 'desktop',
  }),
  beta: Object.freeze({
    releaseChannel: 'beta' as const,
    packageName: 'dsh-plugin-desktop-beta',
    productName: 'DSH Desktop Beta',
    appId: 'ai.deepseek.dsh.desktop.beta',
    homeDirectoryName: '.dsh-beta',
    profileName: 'desktop',
  }),
})

export type DesktopProductIdentity = typeof DESKTOP_RELEASE_IDENTITIES[keyof typeof DESKTOP_RELEASE_IDENTITIES]

/** Beta release-channel identities that must stay aligned with electron-builder. */
export const DESKTOP_PRODUCT_IDENTITY = DESKTOP_RELEASE_IDENTITIES.beta
export const OTHER_DESKTOP_PRODUCT_IDENTITY = DESKTOP_RELEASE_IDENTITIES.stable
export const DESKTOP_PACKAGE_NAME = DESKTOP_PRODUCT_IDENTITY.packageName
export const STABLE_DESKTOP_PACKAGE_NAME = OTHER_DESKTOP_PRODUCT_IDENTITY.packageName
export const DESKTOP_PRODUCT_NAME = DESKTOP_PRODUCT_IDENTITY.productName
export const DESKTOP_APP_ID = DESKTOP_PRODUCT_IDENTITY.appId
export const DESKTOP_RELEASE_CHANNEL = DESKTOP_PRODUCT_IDENTITY.releaseChannel
export const DESKTOP_HOME_DIRECTORY_NAME = DESKTOP_PRODUCT_IDENTITY.homeDirectoryName
export const DESKTOP_PROFILE_NAME = DESKTOP_PRODUCT_IDENTITY.profileName

/**
 * Stem of the electron-builder artifact names, which is fixed in
 * `build.win/nsis.artifactName` and therefore cannot be derived from
 * `productName` at runtime. `tests/package.spec.ts` asserts the two agree.
 */
export const DESKTOP_ARTIFACT_STEM = 'DSH-Desktop-Beta'

/** Both Desktop package identities are launcher-owned, never Profile plugins. */
export const DESKTOP_PACKAGE_NAMES: ReadonlySet<string> = new Set([
  STABLE_DESKTOP_PACKAGE_NAME,
  DESKTOP_PACKAGE_NAME,
])

/**
 * Third-party plugins that ship inside the Desktop installation and are
 * preinstalled into every newly created Profile.
 *
 * Each name must also be a direct dependency of this package so that Electron
 * Builder packs it into the installation's own `node_modules`. The Launcher
 * resolves every direct bundle through the Desktop/Profile overlay, and the
 * installation wins unless the Profile declares a strictly newer version, so a
 * freshly created Profile loads these without any package-manager network
 * access. Seeding happens only at creation time: a repair never re-adds a
 * bundle the user deliberately disabled or removed from `dsh.profile.bundles`.
 */
export const DEFAULT_PROFILE_PLUGIN_BUNDLES: readonly string[] = Object.freeze([
  '@edan/edan-spec',
  '@huanlin/dsh-plugin-better-sidebar-plugin-office',
  '@hyzyn/dsh-codegraph',
  '@linxin666/dsh-client-ui-git-graph',
  'billion-context',
  'dsh-better-sidebar',
  'dsh-dream-skin',
  'dsh-mnemon',
  'dsh-rewind-plugin',
  'dsh-session-manager',
])

/**
 * This package's own `dependencies`, read from its published manifest.
 *
 * The values are the specs Electron Builder installed into the installation's
 * `node_modules`, so a Profile seeded from them records a version that exists
 * beside it. Reading the manifest keeps the seed honest across releases instead
 * of duplicating versions in source.
 *
 * Node-only, and deliberately lazy: `createRequire` is a Node builtin, so a
 * module-level read would pull `node:module` into every consumer. The Desktop
 * client bundle imports `DESKTOP_PACKAGE_NAME` from this module for the browser,
 * where Vite rewrites the builtin to an empty stub and the call throws at load
 * time. Reading on first use keeps the manifest read on the Host face that
 * actually seeds a Profile.
 * @returns this package's `dependencies` field, or an empty record when absent.
 */
export function desktopPluginDependencies(): Readonly<Record<string, string>> {
  return Object.freeze(
    (createRequire(import.meta.url)('../package.json') as { dependencies?: Record<string, string> }).dependencies ?? {},
  )
}

/**
 * Resolve every shipped plugin to the directory this installation holds it in.
 *
 * A newly created Profile seeds a shipped plugin into `dsh.profile.bundles`
 * alone, and the Plugin Manager lists a bundle only when the Profile's own
 * `dependencies` name it: the Host reads `Object.keys(manifest.dependencies)`
 * and derives `installed` from the name alone. Seeded-but-unrecorded, a shipped
 * plugin satisfies neither `installed` nor `optional`, so the Plugins page drops
 * it from every group and its configuration page becomes unreachable.
 *
 * The same seed links each name into the Profile's own `node_modules`, so the
 * Profile can resolve a shipped plugin without a package manager and without
 * reaching the registry, which an offline installation cannot do. Each link
 * points at the installation's copy, so the Profile stores no second copy and
 * the module resolution of that copy's own dependencies — which Node performs
 * from the link's realpath, inside the installation — keeps working unchanged.
 *
 * A name this installation does not hold is skipped rather than linked to a
 * missing target; `tests/bundled-plugin-dependencies.spec.ts` asserts every
 * shipped name is one this package declares.
 * @param dependencies - this package's `dependencies` field.
 * @param resolveDir - maps one package name to its installed directory.
 * @returns the shipped plugin names with their specs and installed directories.
 */
export function shippedPluginInstallations(
  dependencies: Readonly<Record<string, string>>,
  resolveDir: (packageName: string) => string | undefined,
): readonly ShippedPluginInstallation[] {
  const installations: ShippedPluginInstallation[] = []
  for (const name of DEFAULT_PROFILE_PLUGIN_BUNDLES) {
    const spec = dependencies[name]
    /* v8 ignore next -- tests/bundled-plugin-dependencies.spec.ts asserts this package declares every shipped name */
    if (spec === undefined) continue
    const dir = resolveDir(name)
    /* v8 ignore next -- a shipped plugin this installation does not hold cannot be linked */
    if (dir === undefined) continue
    installations.push({ name, spec, dir })
  }
  return installations
}

/** One shipped plugin, the spec this installation declares, and where it is installed. */
export interface ShippedPluginInstallation {
  /** Exact npm package name, as `dsh.profile.bundles` and `dependencies` record it. */
  readonly name: string
  /** The version spec this installation's manifest declares for the name. */
  readonly spec: string
  /** Absolute directory the installation holds the plugin in. */
  readonly dir: string
}

/** Map the shipped default plugins to the specs this package declares for them.
 * @param dependencies - this package's `dependencies` field.
 * @returns one name-to-spec entry per shipped plugin, in seed order.
 */
export function shippedPluginDependencySpecs(
  dependencies: Readonly<Record<string, string>>,
): Record<string, string> {
  const declared: Record<string, string> = {}
  for (const name of DEFAULT_PROFILE_PLUGIN_BUNDLES) {
    const spec = dependencies[name]
    /* v8 ignore next -- tests/bundled-plugin-dependencies.spec.ts asserts this package declares every shipped name */
    if (spec === undefined) continue
    declared[name] = spec
  }
  return declared
}
