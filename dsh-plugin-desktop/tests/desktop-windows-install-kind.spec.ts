import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DESKTOP_WINDOWS_INSTALL_REGISTRY_KEY,
  DESKTOP_WINDOWS_STATE_REGISTRY_KEY,
  DESKTOP_WINDOWS_UNINSTALL_REGISTRY_KEY,
  ELECTRON_BUILDER_UUID_NAMESPACE,
  createElectronBuilderGuid,
  detectDesktopWindowsInstallKind,
} from '../src/desktop-windows-install-kind.ts'
import { DESKTOP_APP_ID, DESKTOP_PRODUCT_NAME } from '../src/product-identity.ts'

/**
 * An independent UUIDv5, computed through the plain hash rather than through the
 * module under test, so the module's derivation is checked against something
 * other than itself.
 */
function referenceUuidV5(namespace: string, name: string): string {
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

describe('electron-builder GUID derivation', () => {
  it('matches the RFC 4122 UUIDv5 test vector', () => {
    // The DNS namespace and this name/result pair are the published example, so
    // a wrong bit layout or a swapped argument order fails here.
    expect(createElectronBuilderGuid('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8'))
      .toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2')
  })

  it('reproduces what electron-builder computes for this app id', () => {
    // Derived from `DESKTOP_APP_ID`, so this asserts the algorithm and the
    // namespace rather than a literal. Hardcoding a GUID would be wrong here:
    // both editions ship one byte-identical `src/` tree but have different app
    // ids, so the literal differs per edition while this expression does not.
    expect(DESKTOP_WINDOWS_INSTALL_REGISTRY_KEY)
      .toBe(`Software\\${referenceUuidV5(ELECTRON_BUILDER_UUID_NAMESPACE, DESKTOP_APP_ID)}`)
  })
})

describe('detectDesktopWindowsInstallKind', () => {
  it('reports a portable edition when no installation record exists', () => {
    const probed: string[] = []
    const kind = detectDesktopWindowsInstallKind((key) => {
      probed.push(key)
      return false
    })

    expect(kind).toBe('portable')
    // Both authoritative records are consulted before concluding anything: a
    // record can survive in either place independently.
    expect(probed).toEqual([
      DESKTOP_WINDOWS_UNINSTALL_REGISTRY_KEY,
      DESKTOP_WINDOWS_STATE_REGISTRY_KEY,
    ])
  })

  it('reports an installed edition from the uninstall record alone', () => {
    const kind = detectDesktopWindowsInstallKind(
      key => key === DESKTOP_WINDOWS_UNINSTALL_REGISTRY_KEY,
    )

    expect(kind).toBe('installed')
  })

  it('reports an installed edition from the product state key alone', () => {
    const kind = detectDesktopWindowsInstallKind(key => key === DESKTOP_WINDOWS_STATE_REGISTRY_KEY)

    expect(kind).toBe('installed')
  })

  it('stops probing as soon as one record is found', () => {
    const probed: string[] = []
    detectDesktopWindowsInstallKind((key) => {
      probed.push(key)
      return true
    })

    expect(probed).toEqual([DESKTOP_WINDOWS_UNINSTALL_REGISTRY_KEY])
  })

  it('asks only about registry keys, never about a path', () => {
    const probed: string[] = []

    const kind = detectDesktopWindowsInstallKind((key) => {
      probed.push(key)
      return false
    })

    // The installation directory is user-selectable
    // (`allowToChangeInstallationDirectory: true`), so its shape proves
    // nothing. Every question this module asks is therefore about a registry
    // key, and the whole decision is made from those answers.
    expect(probed.every(key => key.startsWith('Software\\'))).toBe(true)
    expect(probed).toHaveLength(2)
    expect(kind).toBe('portable')
  })
})

describe('registry key layout', () => {
  it('targets the keys electron-builder itself writes and deletes', () => {
    // `INSTALL_REGISTRY_KEY` is `Software\${APP_GUID}` and the uninstall key
    // nests that same GUID under the standard uninstall root, which is what
    // `multiUser.nsh:8-9` defines and `uninstaller.nsh:250-254` deletes.
    const guidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/u
    const installGuid = DESKTOP_WINDOWS_INSTALL_REGISTRY_KEY.replace('Software\\', '')

    expect(installGuid).toMatch(guidPattern)
    expect(DESKTOP_WINDOWS_UNINSTALL_REGISTRY_KEY)
      .toBe(`Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${installGuid}`)
    expect(DESKTOP_WINDOWS_STATE_REGISTRY_KEY).toBe(`Software\\${DESKTOP_PRODUCT_NAME}`)
  })

  it('keeps the GUID out of the source so the two editions stay identical', () => {
    // Both editions share one `src/` tree byte for byte, so the key must be
    // derived from the app id rather than embedded. Two different app ids must
    // therefore produce two different GUIDs.
    expect(createElectronBuilderGuid('ai.deepseek.dsh.desktop'))
      .not.toBe(createElectronBuilderGuid('ai.deepseek.dsh.desktop.evo'))
  })
})

describe('startup wiring in main.ts', () => {
  const main = readFileSync(join(process.cwd(), 'src', 'main.ts'), 'utf8')

  it('runs shim generation on Windows as well as macOS', () => {
    // The installer publishes the shim directory, but a portable copy has no
    // installer, so the startup path is what covers both. The Host itself is
    // served by the runtime installers regardless, hence this is best-effort.
    expect(main).toContain("if (process.platform === 'darwin' || process.platform === 'win32') {")
  })

  it('points the CodeGraph forwarder at the entry script on Windows', () => {
    // The derivation now lives in `desktop-cli-publication.ts`, where it is
    // unit-tested against a real bundle layout; what matters here is that the
    // startup path and the isolated Host both route through it rather than
    // re-deriving launcher paths of their own.
    expect(main).toContain('desktopCliLaunchers({')
    expect(main).toContain('codegraphPathDir: codegraphRuntime?.pathDir,')
    expect(main).toContain('mnemonPathDir: mnemonRuntime?.pathDir,')
    expect(main).not.toContain("windows ? 'mnemon.exe' : 'mnemon'")
  })

  it('passes the resolved platform so a test host can exercise the win32 branch', () => {
    expect(main).toContain('platform: process.platform,')
  })

  it('keeps the failure contained in the existing try/catch', () => {
    const guard = main.indexOf("if (process.platform === 'darwin' || process.platform === 'win32') {")
    const attempt = main.indexOf('installDesktopCliShell({', guard)
    const caught = main.indexOf('CLI shell integration failed', attempt)

    expect(guard).toBeGreaterThan(-1)
    expect(attempt).toBeGreaterThan(guard)
    // The error is logged, not rethrown: a broken shim must not cost the user
    // the whole application.
    expect(caught).toBeGreaterThan(attempt)
  })

  it('leaves the runtime publication order untouched', () => {
    // `DSH_HOME` must be assigned before any downstream consumer reads it, so
    // the shim work is appended after rather than woven through.
    const dshHome = main.indexOf('process.env.DSH_HOME = homeDir')
    const guard = main.indexOf("if (process.platform === 'darwin' || process.platform === 'win32') {")

    expect(dshHome).toBeGreaterThan(-1)
    expect(guard).toBeGreaterThan(dshHome)
  })
})

describe('settings-entry wiring', () => {
  const main = readFileSync(join(process.cwd(), 'src', 'main.ts'), 'utf8')
  const bootstrap = readFileSync(join(process.cwd(), 'src', 'host-bootstrap.ts'), 'utf8')

  it('offers publish and revoke on both controller construction sites', () => {
    // The isolated Host and the in-process fallback must behave identically:
    // whichever one the launcher picks, the settings entry does the same thing.
    for (const source of [main, bootstrap]) {
      expect(source).toContain('publishCli: async () => cliPublisher.publish(),')
      expect(source).toContain('revokeCli: async () => cliPublisher.revoke(),')
    }
  })

  it('constructs the publisher, and therefore the capability, only on Windows', () => {
    // Elsewhere the capability stays absent so the route answers with a real
    // failure instead of reporting a no-op success. The Host reads the
    // platform from the launcher's snapshot, not from `process`.
    expect(main).toContain("process.platform === 'win32'")
    expect(bootstrap).toContain("runtime.platform === 'win32'")
    expect(bootstrap).not.toContain("process.platform === 'win32'")
  })

  it('passes the launcher-resolved bundle directories to the Host as data', () => {
    // Only the launcher knows `process.resourcesPath` and whether the bundle
    // matched this architecture, so the paths travel rather than being
    // re-derived where the answer may differ.
    expect(main).toContain('codegraphCliPathDir: codegraphRuntime?.pathDir,')
    expect(main).toContain('mnemonCliPathDir: mnemonRuntime?.pathDir')
    expect(main).toContain("userHomeDir: app.getPath('home'),")
    expect(bootstrap).toContain('userHomeDir: options.userHomeDir,')
  })
})
