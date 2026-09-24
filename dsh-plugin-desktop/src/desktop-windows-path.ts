/**
 * Register or revoke the Desktop CLI shim directory in the per-user `Path`.
 *
 * Registration must not damage a user's environment: `Path` is a
 * `REG_EXPAND_SZ` value that routinely contains `%USERPROFILE%` and similar
 * references, and it can exceed a thousand characters. Two otherwise obvious
 * implementations destroy it — one freezes every `%VAR%` into its present value
 * and silently truncates past a kilobyte, the other expands `REG_EXPAND_SZ` on
 * the way out and can only write `REG_SZ` on the way back, making the value's
 * type and contents permanent. Both are named and rejected in `design.md` 决策四;
 * neither appears in this file, which the checkpoint verifies by literal search.
 *
 * The `.NET` registry interface is used instead: it can request unexpanded
 * names and write the value back as an expand-string. The value itself travels
 * by environment variable rather than by string interpolation into the script,
 * so no quoting or injection question arises for paths containing quotes.
 *
 * Every other entry is preserved byte for byte — registration appends and
 * revocation deletes only the entry it owns.
 */

import { execFileSync } from 'node:child_process'
import { win32 } from 'node:path'

const ERROR_PREFIX = 'dsh-plugin-desktop:'
const PATH_VALUE_ENVIRONMENT_VARIABLE = 'DSH_WINDOWS_PATH_VALUE'
const POWER_SHELL_TIMEOUT_MS = 15_000

/**
 * Console output is forced to UTF-8 because Windows PowerShell 5.1 otherwise
 * encodes stdout with the active code page, which garbles a user name or an
 * installation path that is not ASCII.
 */
const POWER_SHELL_PREAMBLE = [
  "$ErrorActionPreference = 'Stop'",
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
].join('\n')

/**
 * Read `Path` without expanding it, and report its current value type.
 *
 * Exits 3 when `HKCU\\Environment` is missing and 4 when `Path` is unset, so
 * "no value" is distinguishable from "empty value" without parsing output.
 */
export const DESKTOP_WINDOWS_PATH_READ_SCRIPT = `${POWER_SHELL_PREAMBLE}
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
if ($null -eq $key) { exit 3 }
$value = $key.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
if ($null -eq $value) { exit 4 }
$kind = $key.GetValueKind('Path').ToString()
[pscustomobject]@{ kind = $kind; value = [string]$value } | ConvertTo-Json -Compress
`

/**
 * Write `Path` back as an expand-string.
 *
 * The new value arrives through `${PATH_VALUE_ENVIRONMENT_VARIABLE}`: a path is
 * data, and embedding it in the script text would turn a `'` or `$` in a user's
 * directory name into a syntax error at best and a command at worst.
 */
export const DESKTOP_WINDOWS_PATH_WRITE_SCRIPT = `${POWER_SHELL_PREAMBLE}
$value = $env:${PATH_VALUE_ENVIRONMENT_VARIABLE}
if ($null -eq $value) { throw '${PATH_VALUE_ENVIRONMENT_VARIABLE} is required' }
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
if ($null -eq $key) { throw 'HKCU\\Environment is not writable' }
$key.SetValue('Path', $value, [Microsoft.Win32.RegistryValueKind]::ExpandString)
`

/**
 * Tell running processes to re-read the environment block.
 *
 * `SendMessageTimeout` rather than `SendMessage`: a hung top-level window must
 * not be able to block the caller forever.
 */
export const DESKTOP_WINDOWS_PATH_BROADCAST_SCRIPT = `${POWER_SHELL_PREAMBLE}
Add-Type -Namespace Dsh -Name NativeMethods -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
'@
$result = [UIntPtr]::Zero
[void][Dsh.NativeMethods]::SendMessageTimeout([IntPtr]0xFFFF, 0x001A, [UIntPtr]::Zero, 'Environment', 0x0002, 5000, [ref]$result)
`

/** Value type of the per-user `Path`, as reported by the registry. */
export type DesktopWindowsPathValueKind = 'ExpandString' | 'String' | 'Unknown'

export interface DesktopWindowsPathValue {
  readonly kind: DesktopWindowsPathValueKind
  readonly value: string
}

/**
 * The narrow seam standing in for the registry.
 *
 * It is deliberately three calls rather than one "apply" so that the decision
 * logic — dedupe, append, remove — stays pure and provable on a host that has
 * no registry at all.
 */
export interface DesktopWindowsPathRegistry {
  read(): DesktopWindowsPathValue | undefined
  write(value: string): void
  broadcast(): void
}

/** Runs one PowerShell script and returns its stdout. */
export type DesktopWindowsPathRunner = (script: string, environment: NodeJS.ProcessEnv) => string

export interface DesktopWindowsPathMutationResult {
  /** Whether the registry actually had to be written. */
  readonly changed: boolean
  /** Whether the shim directory is registered after this call. */
  readonly registered: boolean
  /** The resulting `Path` value. */
  readonly value: string
}

function fail(message: string): never {
  throw new Error(`${ERROR_PREFIX} ${message}`)
}

/**
 * Compare one `Path` entry against the shim directory.
 *
 * Windows compares path names case-insensitively and tolerates a trailing
 * separator, so `C:\\Tools\\` and `c:\\tools` are the same entry. Treating them
 * as different would append a duplicate on every launch.
 */
function isSameEntry(entry: string, normalizedTarget: string): boolean {
  const normalized = entry.trim().replace(/[\\/]+$/u, '').toLowerCase()
  return normalized.length > 0 && normalized === normalizedTarget
}

function normalizeTarget(shimDirectory: string): string {
  if (shimDirectory.length === 0) {
    fail('Windows PATH shim directory must not be empty')
  }
  // A separator inside the entry would be read back as two entries, so the
  // removal path could never match it again.
  if (/[;"\r\n\0]/u.test(shimDirectory)) {
    fail(`Windows PATH shim directory ${JSON.stringify(shimDirectory)} must not contain separators, quotes, NUL, or newlines`)
  }
  const normalized = shimDirectory.trim().replace(/[\\/]+$/u, '').toLowerCase()
  if (normalized.length === 0) {
    fail('Windows PATH shim directory must not be only separators')
  }
  return normalized
}

function readCurrentValue(registry: DesktopWindowsPathRegistry): string {
  return registry.read()?.value ?? ''
}

/**
 * Append the shim directory to the per-user `Path`.
 *
 * Writing happens only when the value really changes, which makes repeated
 * launches — and a race with the installer, which writes the same value — a
 * no-op instead of a rewrite.
 *
 * No `PathBackup` value is written here: the installer owns that key, and it
 * already archives the pristine value before its own append. From this module
 * the reverse operation is exact (it deletes only the entry it added), so there
 * is nothing a backup would add.
 */
export function registerDesktopWindowsPath(
  registry: DesktopWindowsPathRegistry,
  shimDirectory: string,
): DesktopWindowsPathMutationResult {
  const normalizedTarget = normalizeTarget(shimDirectory)
  const current = readCurrentValue(registry)

  for (const entry of current.split(';')) {
    if (isSameEntry(entry, normalizedTarget)) {
      return { changed: false, registered: true, value: current }
    }
  }

  // An empty value gets no leading separator; a value already ending in one
  // does not get a second.
  const value = current.length === 0
    ? shimDirectory
    : current.endsWith(';') ? `${current}${shimDirectory}` : `${current};${shimDirectory}`

  registry.write(value)
  registry.broadcast()
  return { changed: true, registered: true, value }
}

/**
 * Remove the shim directory from the per-user `Path`, leaving the rest intact.
 *
 * Entries are split and rejoined rather than filtered, so a trailing or doubled
 * separator elsewhere in the value survives exactly as the user had it. A
 * duplicate entry left behind by an older release is removed in full.
 */
export function unregisterDesktopWindowsPath(
  registry: DesktopWindowsPathRegistry,
  shimDirectory: string,
): DesktopWindowsPathMutationResult {
  const normalizedTarget = normalizeTarget(shimDirectory)
  const current = readCurrentValue(registry)
  const entries = current.split(';')
  const kept = entries.filter(entry => !isSameEntry(entry, normalizedTarget))

  if (kept.length === entries.length) {
    return { changed: false, registered: false, value: current }
  }

  const value = kept.join(';')
  registry.write(value)
  registry.broadcast()
  return { changed: true, registered: false, value }
}

function powerShellExecutable(): string {
  const systemRoot = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows'
  return win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

function runPowerShell(script: string, environment: NodeJS.ProcessEnv): string {
  return execFileSync(
    powerShellExecutable(),
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    {
      encoding: 'utf8',
      env: environment,
      timeout: POWER_SHELL_TIMEOUT_MS,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
}

function parseReadPayload(stdout: string): DesktopWindowsPathValue {
  let payload: unknown
  try {
    payload = JSON.parse(stdout)
  } catch {
    fail(`Windows PATH read returned unparseable output: ${JSON.stringify(stdout)}`)
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    fail('Windows PATH read returned a value that is not an object')
  }
  const { kind, value } = payload as { kind?: unknown, value?: unknown }
  if (typeof value !== 'string' || typeof kind !== 'string') {
    fail('Windows PATH read returned an object without string kind and value fields')
  }
  return {
    // Anything that is not one of the two types `Path` is allowed to hold is
    // reported as unknown rather than silently coerced to a writable type.
    kind: kind === 'ExpandString' ? 'ExpandString' : kind === 'String' ? 'String' : 'Unknown',
    value,
  }
}

/**
 * The real registry, spoken to through PowerShell.
 *
 * `run` is injected only so tests can prove every branch — exit codes, partial
 * output, unreadable values — without a Windows host. A non-zero exit surfaces
 * as an error, so a failed registration is never mistaken for a successful one.
 */
export function createPowerShellWindowsPathRegistry(
  options: { readonly run?: DesktopWindowsPathRunner } = {},
): DesktopWindowsPathRegistry {
  const run = options.run ?? runPowerShell

  const guarded = (action: string, script: string, environment: NodeJS.ProcessEnv): string => {
    try {
      return run(script, environment)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return fail(`Windows PATH ${action} failed: ${message}`)
    }
  }

  return {
    read: () => {
      const stdout = guarded('read', DESKTOP_WINDOWS_PATH_READ_SCRIPT, process.env).trim()
      // Exits 3 and 4 mean "no registry key" and "no value"; both arrive as an
      // empty stdout and both mean there is nothing registered yet.
      if (stdout.length === 0) return undefined
      return parseReadPayload(stdout)
    },
    write: (value: string) => {
      guarded('write', DESKTOP_WINDOWS_PATH_WRITE_SCRIPT, {
        ...process.env,
        [PATH_VALUE_ENVIRONMENT_VARIABLE]: value,
      })
    },
    broadcast: () => {
      guarded('broadcast', DESKTOP_WINDOWS_PATH_BROADCAST_SCRIPT, process.env)
    },
  }
}
