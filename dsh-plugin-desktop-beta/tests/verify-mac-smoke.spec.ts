import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  verifyMacSmoke,
  type MacSmokeVerificationOptions,
} from '../scripts/verify-mac-smoke.ts'
import {
  MACOS_UNIVERSAL_BUNDLED_CLI_ENTRIES,
  MACOS_UNIVERSAL_NATIVE_ENTRIES,
} from '../scripts/mac-universal.ts'
import { DESKTOP_ARTIFACT_STEM, DESKTOP_PRODUCT_NAME } from '../src/product-identity.ts'

const temporaryRoots: string[] = []

interface AppFixture {
  readonly root: string
  readonly infoPlist: string
  readonly executable: string
  readonly appAsar: string
  /** Absolute paths of the bundled CLIs copied in through `extraResources`. */
  readonly bundledClis: Map<string, string>
  readonly modeOverrides: Map<string, number>
}

function fixture(): AppFixture {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mac-smoke-'))
  temporaryRoots.push(root)
  const contents = join(root, `${DESKTOP_PRODUCT_NAME}.app`, 'Contents')
  const macos = join(contents, 'MacOS')
  const resources = join(contents, 'Resources')
  mkdirSync(macos, { recursive: true })
  mkdirSync(resources, { recursive: true })
  const infoPlist = join(contents, 'Info.plist')
  const executable = join(macos, DESKTOP_PRODUCT_NAME)
  const appAsar = join(resources, 'app', 'package.json')
  const modeOverrides = new Map<string, number>()
  writeFileSync(infoPlist, '<?xml version="1.0" encoding="UTF-8"?>')
  writeFileSync(executable, 'binary')
  chmodSync(executable, 0o755)
  modeOverrides.set(executable, 0o755)
  mkdirSync(join(resources, 'app', 'lib'), { recursive: true })
  writeFileSync(join(resources, 'app', 'lib', 'main.js'), 'main')
  writeFileSync(appAsar, '{}')
  for (const entry of MACOS_UNIVERSAL_NATIVE_ENTRIES) {
    const path = join(join(appAsar, '..'), entry.path)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, 'native')
    if (entry.path.endsWith('/spawn-helper')) {
      chmodSync(path, 0o755)
      modeOverrides.set(path, 0o755)
    }
  }
  const bundledClis = new Map<string, string>()
  for (const entry of MACOS_UNIVERSAL_BUNDLED_CLI_ENTRIES) {
    const path = join(contents, entry.path)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, 'binary')
    const mode = entry.executable ? 0o755 : 0o644
    chmodSync(path, mode)
    modeOverrides.set(path, mode)
    bundledClis.set(entry.path, path)
  }
  return { root, infoPlist, executable, appAsar, bundledClis, modeOverrides }
}

function options(
  overrides: Partial<MacSmokeVerificationOptions> = {},
  modeOverrides: ReadonlyMap<string, number> = new Map(),
) {
  const calls: Array<{ command: string; args: readonly string[] }> = []
  const removeMountPoint = vi.fn()
  const value: MacSmokeVerificationOptions = {
    distDir: '/release/dist',
    productName: DESKTOP_PRODUCT_NAME,
    listDmgs: () => [`/release/dist/${DESKTOP_ARTIFACT_STEM}-2.0.1.dmg`],
    makeMountPoint: () => '/private/tmp/dsh-desktop-dmg-smoke-test',
    run: (command, args) => { calls.push({ command, args: [...args] }) },
    removeMountPoint,
    exists: existsSync,
    stat: path => {
      const result = statSync(path)
      return {
        size: result.size,
        isFile: result.isFile(),
        mode: modeOverrides.get(path) ?? result.mode,
      }
    },
    ...overrides,
  }
  return { calls, removeMountPoint, value }
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function expectSmokeFailure(
  harness: ReturnType<typeof options>,
  expectedDetail: string,
): void {
  let caught: unknown
  try {
    verifyMacSmoke(harness.value)
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(AggregateError)
  const details = (caught as AggregateError).errors
    .map(inner => (inner instanceof Error ? inner.message : String(inner)))
  expect(details.join('\n')).toContain(expectedDetail)
}

describe('macOS DMG smoke artifact verification', () => {
  it('mounts one DMG and accepts a well-formed unsigned application bundle', () => {
    const value = fixture()
    const harness = options({ makeMountPoint: () => value.root }, value.modeOverrides)
    const appPath = join(value.root, `${DESKTOP_PRODUCT_NAME}.app`)

    expect(verifyMacSmoke(harness.value)).toEqual({
      appPath,
      dmgPath: `/release/dist/${DESKTOP_ARTIFACT_STEM}-2.0.1.dmg`,
    })

    expect(harness.calls).toEqual([
      {
        command: 'hdiutil',
        args: [
          'attach', `/release/dist/${DESKTOP_ARTIFACT_STEM}-2.0.1.dmg`,
          '-mountpoint', value.root, '-nobrowse', '-readonly',
        ],
      },
      { command: 'plutil', args: ['-lint', value.infoPlist] },
      {
        command: 'lipo',
        args: [value.executable, '-verify_arch', 'x86_64'],
      },
      { command: 'lipo', args: [value.executable, '-verify_arch', 'arm64'] },
      ...MACOS_UNIVERSAL_NATIVE_ENTRIES.map(entry => ({
        command: 'lipo',
        args: [join(join(value.appAsar, '..'), entry.path), '-verify_arch', entry.arch],
      })),
      // Each bundled CLI must be verified for both architectures.
      ...MACOS_UNIVERSAL_BUNDLED_CLI_ENTRIES.flatMap(entry => [
        { command: 'lipo', args: [value.bundledClis.get(entry.path)!, '-verify_arch', 'x86_64'] },
        { command: 'lipo', args: [value.bundledClis.get(entry.path)!, '-verify_arch', 'arm64'] },
      ]),
      { command: 'hdiutil', args: ['detach', value.root] },
    ])
    expect(harness.removeMountPoint).toHaveBeenCalledWith(value.root)
  })

  it('rejects the mount when no DMG is present', () => {
    const harness = options({ listDmgs: () => [] })

    expect(() => verifyMacSmoke(harness.value)).toThrow('requires exactly one DMG')
    expect(harness.calls).toEqual([])
    expect(harness.removeMountPoint).not.toHaveBeenCalled()
  })

  it('rejects a missing Info.plist and still detaches', () => {
    const value = fixture()
    rmSync(value.infoPlist)
    const harness = options({ makeMountPoint: () => value.root }, value.modeOverrides)

    expectSmokeFailure(harness, 'Info.plist')
    expect(harness.calls).toEqual([
      {
        command: 'hdiutil',
        args: ['attach', `/release/dist/${DESKTOP_ARTIFACT_STEM}-2.0.1.dmg`, '-mountpoint', value.root, '-nobrowse', '-readonly'],
      },
      { command: 'hdiutil', args: ['detach', value.root] },
    ])
    expect(harness.removeMountPoint).toHaveBeenCalledWith(value.root)
  })

  it('rejects an application without its declared main executable', () => {
    const value = fixture()
    rmSync(value.executable)
    const harness = options({ makeMountPoint: () => value.root }, value.modeOverrides)

    expectSmokeFailure(harness, 'main executable')
    expect(harness.removeMountPoint).toHaveBeenCalledWith(value.root)
  })

  it('rejects a non-executable main file', () => {
    const value = fixture()
    chmodSync(value.executable, 0o644)
    value.modeOverrides.set(value.executable, 0o644)
    const harness = options({ makeMountPoint: () => value.root }, value.modeOverrides)

    expectSmokeFailure(harness, 'invalid main executable')
    expect(harness.removeMountPoint).toHaveBeenCalledWith(value.root)
  })

  it('rejects a missing or empty application manifest', () => {
    const value = fixture()
    rmSync(value.appAsar)
    const harness = options({ makeMountPoint: () => value.root }, value.modeOverrides)

    expectSmokeFailure(harness, 'package.json')
    expect(harness.removeMountPoint).toHaveBeenCalledWith(value.root)
  })

  it('rejects an application whose bundled CodeGraph runtime is absent', () => {
    const value = fixture()
    rmSync(value.bundledClis.get('Resources/codegraph/node')!)
    const harness = options({ makeMountPoint: () => value.root }, value.modeOverrides)

    expectSmokeFailure(harness, 'missing bundled CLI')
    expect(harness.removeMountPoint).toHaveBeenCalledWith(value.root)
  })

  it('accepts the kernel without an execute bit, because the runtime opens it', () => {
    const value = fixture()
    const kernel = value.bundledClis.get('Resources/codegraph/lib/kernel/codegraph-kernel.node')!
    // The shipped archive really carries 0644 here; asserting it locally keeps a
    // stray `entry.executable &&` removal from killing a valid DMG.
    expect(statSync(kernel).mode & 0o111).toBe(0)
    const harness = options({ makeMountPoint: () => value.root }, value.modeOverrides)

    expect(() => verifyMacSmoke(harness.value)).not.toThrow()
  })

  it('rejects a bundled CLI that lost one of its architecture slices', () => {
    const value = fixture()
    const codegraph = value.bundledClis.get('Resources/codegraph/node')!
    const base = options({ makeMountPoint: () => value.root }, value.modeOverrides)
    const harness = {
      ...base,
      value: {
        ...base.value,
        run: (command: string, args: readonly string[]) => {
          if (command === 'lipo' && args[0] === codegraph && args[2] === 'x86_64') {
            throw new Error(`${command} ${args.join(' ')} exited with 1`)
          }
        },
      },
    }

    expectSmokeFailure(harness, 'x86_64')
    expect(harness.removeMountPoint).toHaveBeenCalledWith(value.root)
  })

  it('rejects a bundled CLI that lost its execute bit', () => {
    const value = fixture()
    const mnemon = value.bundledClis.get('Resources/mnemon/bin/mnemon')!
    chmodSync(mnemon, 0o644)
    value.modeOverrides.set(mnemon, 0o644)
    const harness = options({ makeMountPoint: () => value.root }, value.modeOverrides)

    expectSmokeFailure(harness, 'non-executable bundled CLI')
    expect(harness.removeMountPoint).toHaveBeenCalledWith(value.root)
  })
})
