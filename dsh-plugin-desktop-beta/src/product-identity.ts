/** Stable and Beta identities used to locate each edition's private app data. */
export const DESKTOP_RELEASE_IDENTITIES = Object.freeze({
  stable: Object.freeze({
    releaseChannel: 'stable' as const,
    packageName: 'dsh-plugin-desktop',
    productName: 'DSH Desktop',
    appId: 'ai.deepseek.dsh.desktop',
    profileName: 'desktop',
  }),
  beta: Object.freeze({
    releaseChannel: 'beta' as const,
    packageName: 'dsh-plugin-desktop-beta',
    productName: 'DSH Desktop Beta',
    appId: 'ai.deepseek.dsh.desktop.beta',
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
