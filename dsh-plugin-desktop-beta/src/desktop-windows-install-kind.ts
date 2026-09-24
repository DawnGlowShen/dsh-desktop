/**
 * Tell an installed edition from a portable one by asking the registry.
 *
 * This is the only question the Desktop asks about its own installation shape,
 * and nothing depends on the answer except whether a portable user is invited
 * to publish the CLI shims. Shim generation is unconditional and self-healing:
 * it is driven by "the file on disk differs from what it should be", never by
 * "this is the first launch" or "this is a portable copy".
 */

import { createHash } from 'node:crypto'
import { DESKTOP_APP_ID, DESKTOP_PRODUCT_NAME } from './product-identity.ts'

/**
 * The namespace electron-builder derives every NSIS GUID from.
 *
 * `NsisTarget.js:28` parses this literal and `:162` computes
 * `UUID.v5(appInfo.id, namespace)`, so reproducing it here yields exactly the
 * key the installer writes. Using the same algorithm rather than a hardcoded
 * GUID matters because the two editions share one byte-identical `src/` tree
 * while having different app ids.
 */
export const ELECTRON_BUILDER_UUID_NAMESPACE = '50e065bc-3134-11e6-9bab-38c9862bdaf3'

/** Whether this copy of the application was put here by the installer. */
export type DesktopWindowsInstallKind = 'installed' | 'portable'

/**
 * Answer whether one registry key exists under `HKCU`.
 *
 * Injected so the decision can be tested in full on a host with no registry.
 * The predicate may only ever be asked about a registry key: the module holds
 * no path-shaped input, because the installation directory is user-selectable
 * and its shape therefore proves nothing.
 */
export type DesktopWindowsRegistryProbe = (key: string) => boolean

/**
 * Compute the GUID electron-builder assigns to an application id.
 *
 * RFC 4122 version 5 (SHA-1, name-based) with the version and variant bits
 * overwritten, matching `builder-util-runtime`'s `UUID.v5`. Kept as a local
 * implementation rather than a dependency: the package is not a direct
 * dependency of either edition, and a build-time-only package must not become a
 * runtime one just to hash one string.
 *
 * @param name - the application id, i.e. `build.appId` in `package.json`.
 * @param namespace - the namespace UUID; defaults to electron-builder's own.
 * @returns the lowercase hyphenated GUID.
 */
export function createElectronBuilderGuid(
  name: string,
  namespace: string = ELECTRON_BUILDER_UUID_NAMESPACE,
): string {
  const namespaceBytes = Buffer.from(namespace.replaceAll('-', ''), 'hex')
  const digest = createHash('sha1')
    .update(Buffer.concat([namespaceBytes, Buffer.from(name, 'utf8')]))
    .digest()
  const bytes = Buffer.from(digest.subarray(0, 16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * The GUID this installation would have if the installer had created it.
 *
 * Derived from `DESKTOP_APP_ID` so the two editions stay byte-identical at the
 * source level while resolving to their own keys at runtime.
 */
export const DESKTOP_WINDOWS_APP_GUID = createElectronBuilderGuid(DESKTOP_APP_ID)

/**
 * Per-user installation record: `INSTALL_REGISTRY_KEY` of `multiUser.nsh:8`.
 *
 * The installer writes `InstallLocation` and friends here, and
 * `uninstaller.nsh:254` deletes the whole key, so its presence is the
 * installer's own assertion that this copy is an installed one.
 */
export const DESKTOP_WINDOWS_INSTALL_REGISTRY_KEY = `Software\\${DESKTOP_WINDOWS_APP_GUID}`

/**
 * Per-machine uninstall entry: `UNINSTALL_REGISTRY_KEY` of `multiUser.nsh:9`.
 *
 * Holds the entry Windows shows in "Apps & features"; `uninstaller.nsh:250`
 * deletes it. Checked as well as the install key because either record can
 * survive without the other.
 */
export const DESKTOP_WINDOWS_UNINSTALL_REGISTRY_KEY
  = `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${DESKTOP_WINDOWS_APP_GUID}`

/**
 * Product-owned state the installer writes, e.g. the pristine `PathBackup`.
 *
 * Not authoritative on its own — but a key under the product name is only ever
 * created by the installer, so finding it also rules out a portable edition.
 */
export const DESKTOP_WINDOWS_STATE_REGISTRY_KEY = `Software\\${DESKTOP_PRODUCT_NAME}`

/**
 * Decide whether this copy came from the installer.
 *
 * Two independent records are consulted and either one is enough: the uninstall
 * entry is what Windows itself relies on, and the product state key is what the
 * installer writes its `PathBackup` under. Neither existing means no installer
 * ever ran for this user and this edition.
 *
 * Deliberately not derived from the installation directory: the NSIS installer
 * is built with `allowToChangeInstallationDirectory: true`, so a path-shape
 * guess would misclassify a custom directory as portable and then show a prompt
 * to a user who is already registered.
 *
 * @param probe - injected registry reader; see {@link DesktopWindowsRegistryProbe}.
 * @returns `'installed'` when either record exists, otherwise `'portable'`.
 */
export function detectDesktopWindowsInstallKind(
  probe: DesktopWindowsRegistryProbe,
): DesktopWindowsInstallKind {
  // Ordered from most to least authoritative, and short-circuiting so a normal
  // installed launch asks one question rather than two.
  if (probe(DESKTOP_WINDOWS_UNINSTALL_REGISTRY_KEY)) return 'installed'
  if (probe(DESKTOP_WINDOWS_STATE_REGISTRY_KEY)) return 'installed'
  return 'portable'
}
