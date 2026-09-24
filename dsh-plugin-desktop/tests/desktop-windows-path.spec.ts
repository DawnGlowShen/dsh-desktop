import { describe, expect, it } from 'vitest'
import {
  DESKTOP_WINDOWS_PATH_BROADCAST_SCRIPT,
  DESKTOP_WINDOWS_PATH_READ_SCRIPT,
  DESKTOP_WINDOWS_PATH_WRITE_SCRIPT,
  registerDesktopWindowsPath,
  unregisterDesktopWindowsPath,
  type DesktopWindowsPathRegistry,
  type DesktopWindowsPathValue,
} from '../src/desktop-windows-path.ts'

/**
 * A recording registry standing in for the real per-user PATH value.
 *
 * The registry is unreachable on the machines that run this suite, so the seam
 * is exercised instead: every branch has to be provable without Windows.
 */
function fakeRegistry(current?: DesktopWindowsPathValue): {
  registry: DesktopWindowsPathRegistry
  writes: string[]
  broadcasts: number
} {
  const writes: string[] = []
  const state = { broadcasts: 0, value: current }
  return {
    writes,
    get broadcasts() { return state.broadcasts },
    registry: {
      read: () => state.value,
      write: (value: string) => {
        writes.push(value)
        // Preserve the kind: a correct implementation always writes an
        // expand-string, so the fake mirrors that rather than the input kind.
        state.value = { value, kind: 'ExpandString' }
      },
      broadcast: () => { state.broadcasts += 1 },
    },
  }
}

const SHIM_DIR = 'C:\\Users\\tester\\.dsh\\bin'

describe('registerDesktopWindowsPath', () => {
  it('appends the shim directory and keeps %VAR% references literal', () => {
    const fake = fakeRegistry({ value: '%USERPROFILE%\\bin;C:\\Tools', kind: 'ExpandString' })

    const result = registerDesktopWindowsPath(fake.registry, SHIM_DIR)

    expect(result.changed).toBe(true)
    expect(result.registered).toBe(true)
    expect(fake.writes).toEqual(['%USERPROFILE%\\bin;C:\\Tools;C:\\Users\\tester\\.dsh\\bin'])
    // The literal variable reference must survive verbatim: expanding it would
    // freeze the user's PATH to today's home directory.
    expect(fake.writes[0]).toContain('%USERPROFILE%')
    expect(fake.writes[0]).not.toContain('C:\\Users\\tester\\bin')
  })

  it('registers into an empty PATH without a leading separator', () => {
    const fake = fakeRegistry({ value: '', kind: 'ExpandString' })

    const result = registerDesktopWindowsPath(fake.registry, SHIM_DIR)

    expect(result.changed).toBe(true)
    expect(fake.writes).toEqual([SHIM_DIR])
  })

  it('registers when the PATH value is absent entirely', () => {
    const fake = fakeRegistry(undefined)

    const result = registerDesktopWindowsPath(fake.registry, SHIM_DIR)

    expect(result.changed).toBe(true)
    expect(fake.writes).toEqual([SHIM_DIR])
  })

  it('writes nothing when the entry is already present', () => {
    const fake = fakeRegistry({ value: `C:\\Tools;${SHIM_DIR}`, kind: 'ExpandString' })

    const result = registerDesktopWindowsPath(fake.registry, SHIM_DIR)

    expect(result.changed).toBe(false)
    expect(result.registered).toBe(true)
    expect(fake.writes).toEqual([])
    expect(fake.broadcasts).toBe(0)
  })

  it('treats an existing entry as present regardless of case or trailing separator', () => {
    for (const existing of [
      'c:\\users\\TESTER\\.dsh\\bin',
      'C:\\Users\\tester\\.dsh\\bin\\',
      'C:\\Tools;C:\\Users\\tester\\.dsh\\bin;D:\\More',
    ]) {
      const fake = fakeRegistry({ value: existing, kind: 'ExpandString' })
      const result = registerDesktopWindowsPath(fake.registry, SHIM_DIR)

      expect(result.changed, existing).toBe(false)
      expect(fake.writes, existing).toEqual([])
    }
  })

  it('broadcasts once after a real change so already-open shells can refresh', () => {
    const fake = fakeRegistry({ value: 'C:\\Tools', kind: 'ExpandString' })

    registerDesktopWindowsPath(fake.registry, SHIM_DIR)

    expect(fake.broadcasts).toBe(1)
  })

  it('reports the resulting value and registration state', () => {
    const fake = fakeRegistry({ value: 'C:\\Tools', kind: 'ExpandString' })

    const result = registerDesktopWindowsPath(fake.registry, SHIM_DIR)

    expect(result.value).toBe(`C:\\Tools;${SHIM_DIR}`)
    expect(result.registered).toBe(true)
  })

  it('preserves every other entry verbatim when appending', () => {
    const fake = fakeRegistry({ value: '%USERPROFILE%\\bin;"quoted";tail\\', kind: 'ExpandString' })

    registerDesktopWindowsPath(fake.registry, SHIM_DIR)

    expect(fake.writes[0]).toBe(`%USERPROFILE%\\bin;"quoted";tail\\;${SHIM_DIR}`)
  })

  it('rejects an empty shim directory rather than writing nonsense', () => {
    const fake = fakeRegistry({ value: 'C:\\Tools', kind: 'ExpandString' })

    expect(() => registerDesktopWindowsPath(fake.registry, '')).toThrow(/shim directory/u)
    expect(fake.writes).toEqual([])
  })
})

describe('unregisterDesktopWindowsPath', () => {
  it('removes only its own entry and leaves the rest byte-identical', () => {
    const original = `C:\\Tools;${SHIM_DIR};%USERPROFILE%\\bin;D:\\More`
    const fake = fakeRegistry({ value: original, kind: 'ExpandString' })

    const result = unregisterDesktopWindowsPath(fake.registry, SHIM_DIR)

    expect(result.changed).toBe(true)
    expect(result.registered).toBe(false)
    // Order and spelling of every other entry must be preserved exactly, so the
    // remainder is asserted as a whole string rather than entry by entry.
    expect(fake.writes).toEqual(['C:\\Tools;%USERPROFILE%\\bin;D:\\More'])
  })

  it('removes a duplicate entry so a legacy double registration cannot survive', () => {
    const fake = fakeRegistry({ value: `${SHIM_DIR};C:\\Tools;${SHIM_DIR}`, kind: 'ExpandString' })

    unregisterDesktopWindowsPath(fake.registry, SHIM_DIR)

    expect(fake.writes).toEqual(['C:\\Tools'])
  })

  it('removes the trailing entry without leaving a dangling separator', () => {
    const fake = fakeRegistry({ value: `C:\\Tools;${SHIM_DIR}`, kind: 'ExpandString' })

    unregisterDesktopWindowsPath(fake.registry, SHIM_DIR)

    expect(fake.writes).toEqual(['C:\\Tools'])
  })

  it('is a no-op when the entry is absent', () => {
    const fake = fakeRegistry({ value: 'C:\\Tools;D:\\More', kind: 'ExpandString' })

    const result = unregisterDesktopWindowsPath(fake.registry, SHIM_DIR)

    expect(result.changed).toBe(false)
    expect(result.registered).toBe(false)
    expect(fake.writes).toEqual([])
    expect(fake.broadcasts).toBe(0)
  })

  it('is a no-op when the PATH value is absent entirely', () => {
    const fake = fakeRegistry(undefined)

    const result = unregisterDesktopWindowsPath(fake.registry, SHIM_DIR)

    expect(result.changed).toBe(false)
    expect(fake.writes).toEqual([])
  })

  it('broadcasts once after removing the entry', () => {
    const fake = fakeRegistry({ value: `C:\\Tools;${SHIM_DIR}`, kind: 'ExpandString' })

    unregisterDesktopWindowsPath(fake.registry, SHIM_DIR)

    expect(fake.broadcasts).toBe(1)
  })
})

describe('Windows PATH PowerShell scripts', () => {
  const scripts = [
    DESKTOP_WINDOWS_PATH_READ_SCRIPT,
    DESKTOP_WINDOWS_PATH_WRITE_SCRIPT,
    DESKTOP_WINDOWS_PATH_BROADCAST_SCRIPT,
  ]

  it('never uses setx, which freezes %VAR% and truncates at 1024 characters', () => {
    for (const script of scripts) expect(script.toLowerCase()).not.toContain('setx')
  })

  it('never shells out to reg.exe, which would rewrite PATH as a plain string', () => {
    for (const script of scripts) {
      // `reg query` expands REG_EXPAND_SZ on output and `reg add` can only write
      // REG_SZ, so either one would silently destroy the value type.
      expect(script).not.toMatch(/\breg(\.exe)?\s+(query|add|delete)\b/iu)
    }
  })

  it('writes PATH as an expand-string through the .NET registry interface', () => {
    expect(DESKTOP_WINDOWS_PATH_WRITE_SCRIPT).toContain('Microsoft.Win32.Registry')
    expect(DESKTOP_WINDOWS_PATH_WRITE_SCRIPT).toContain('[Microsoft.Win32.RegistryValueKind]::ExpandString')
    expect(DESKTOP_WINDOWS_PATH_WRITE_SCRIPT).toContain("OpenSubKey('Environment', $true)")
  })

  it('reads PATH without expanding the variables it contains', () => {
    // Default GetValue expansion would hand back an absolute home directory and
    // freeze it on write-back.
    expect(DESKTOP_WINDOWS_PATH_READ_SCRIPT).toContain('DoNotExpandEnvironmentNames')
    expect(DESKTOP_WINDOWS_PATH_READ_SCRIPT).toContain('GetValueKind')
  })

  it('broadcasts WM_SETTINGCHANGE with lParam Environment', () => {
    expect(DESKTOP_WINDOWS_PATH_BROADCAST_SCRIPT).toContain('SendMessageTimeout')
    expect(DESKTOP_WINDOWS_PATH_BROADCAST_SCRIPT).toContain('0x001A')
    expect(DESKTOP_WINDOWS_PATH_BROADCAST_SCRIPT).toContain('Environment')
    expect(DESKTOP_WINDOWS_PATH_BROADCAST_SCRIPT).toContain('0xFFFF')
  })

  it('never hard-codes the shim directory into the generated script', () => {
    // The value has to travel by environment variable: embedding a user path in
    // the script text would make quoting and injection a concern.
    expect(DESKTOP_WINDOWS_PATH_WRITE_SCRIPT).toContain('DSH_WINDOWS_PATH_VALUE')
    for (const script of scripts) expect(script).not.toContain(SHIM_DIR)
  })
})

describe('createPowerShellWindowsPathRegistry', () => {
  it('surfaces a non-zero exit code instead of reporting success', async () => {
    const { createPowerShellWindowsPathRegistry } = await import('../src/desktop-windows-path.ts')
    const registry = createPowerShellWindowsPathRegistry({
      run: () => { throw new Error('powershell.exe exited with code 1: access denied') },
    })

    expect(() => registry.write('C:\\Tools')).toThrow(/dsh-plugin-desktop:/u)
  })

  it('reports an unreadable PATH value as undefined rather than an empty string', async () => {
    const { createPowerShellWindowsPathRegistry } = await import('../src/desktop-windows-path.ts')
    const registry = createPowerShellWindowsPathRegistry({ run: () => '' })

    expect(registry.read()).toBeUndefined()
  })

  it('round-trips the value and its kind through the injected runner', async () => {
    const { createPowerShellWindowsPathRegistry } = await import('../src/desktop-windows-path.ts')
    const calls: { script: string; env: NodeJS.ProcessEnv | undefined }[] = []
    const registry = createPowerShellWindowsPathRegistry({
      run: (script, env) => {
        calls.push({ script, env })
        if (script === DESKTOP_WINDOWS_PATH_READ_SCRIPT) {
          return JSON.stringify({ kind: 'ExpandString', value: '%USERPROFILE%\\bin' })
        }
        return ''
      },
    })

    expect(registry.read()).toEqual({ kind: 'ExpandString', value: '%USERPROFILE%\\bin' })

    registry.write('C:\\Tools')
    expect(calls.at(-1)?.env?.DSH_WINDOWS_PATH_VALUE).toBe('C:\\Tools')

    registry.broadcast()
    expect(calls.map(call => call.script)).toContain(DESKTOP_WINDOWS_PATH_BROADCAST_SCRIPT)
  })

  it('tolerates a String kind coming back from a hand-edited registry', async () => {
    const { createPowerShellWindowsPathRegistry } = await import('../src/desktop-windows-path.ts')
    const registry = createPowerShellWindowsPathRegistry({
      run: () => JSON.stringify({ kind: 'String', value: 'C:\\Tools' }),
    })

    expect(registry.read()).toEqual({ kind: 'String', value: 'C:\\Tools' })
  })

  it('rejects a malformed payload instead of guessing', async () => {
    const { createPowerShellWindowsPathRegistry } = await import('../src/desktop-windows-path.ts')
    const registry = createPowerShellWindowsPathRegistry({ run: () => 'not json' })

    expect(() => registry.read()).toThrow(/dsh-plugin-desktop:/u)
  })
})

describe('createPowerShellWindowsKeyProbe', () => {
  it('reports presence and absence from the two script literals', async () => {
    const { createPowerShellWindowsKeyProbe } = await import('../src/desktop-windows-path.ts')

    expect(createPowerShellWindowsKeyProbe(() => '1\n')('Software\\Thing')).toBe(true)
    expect(createPowerShellWindowsKeyProbe(() => '0\n')('Software\\Thing')).toBe(false)
  })

  it('passes the key as data, never as script text', async () => {
    const { createPowerShellWindowsKeyProbe, DESKTOP_WINDOWS_KEY_EXISTS_SCRIPT }
      = await import('../src/desktop-windows-path.ts')
    const calls: { script: string, env: NodeJS.ProcessEnv }[] = []
    const probe = createPowerShellWindowsKeyProbe((script, env) => {
      calls.push({ script, env })
      return '0'
    })

    // A quote or `$` in a product name must not become script syntax.
    probe('Software\\O\'Brien$Corp')

    expect(calls).toHaveLength(1)
    expect(calls[0]!.env.DSH_WINDOWS_REGISTRY_KEY).toBe('Software\\O\'Brien$Corp')
    expect(calls[0]!.script).toBe(DESKTOP_WINDOWS_KEY_EXISTS_SCRIPT)
    expect(calls[0]!.script).not.toContain('Brien')
  })

  it('refuses to read unexpected output as an answer', async () => {
    const { createPowerShellWindowsKeyProbe } = await import('../src/desktop-windows-path.ts')

    // Anything other than the two literals the script can emit is an error, so
    // a truncated or polluted stdout cannot masquerade as "the key exists".
    for (const stdout of ['', 'maybe', '1\n0\n', 'true']) {
      expect(() => createPowerShellWindowsKeyProbe(() => stdout)('Software\\Thing'))
        .toThrow(/dsh-plugin-desktop:/u)
    }
  })
})
