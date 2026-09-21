/**
 * Publish the packaged CodeGraph CLI to the user's own terminal.
 *
 * A `.dmg` has no install hook: dragging the application into `/Applications`
 * is the whole installation. The Host process can publish the CLI on its own
 * PATH at runtime, but a shell started by the user is outside that process, so
 * the only way to make `codegraph` resolve there is a shim plus a PATH entry in
 * the user's shell profile.
 *
 * Both artifacts are generated idempotently and removed by
 * {@link uninstallDesktopCodegraphShell}. They are deliberately persistent
 * rather than released on shutdown: the point is that the command keeps working
 * after the application quits.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

const MARKER_BEGIN = '# >>> dsh-desktop codegraph >>>'
const MARKER_END = '# <<< dsh-desktop codegraph <<<'
const SHIM_NAME = 'codegraph'
const SHIM_DIRECTORY = 'bin'
const PRIVATE_DIRECTORY_MODE = 0o700
const EXECUTABLE_FILE_MODE = 0o755
const PROFILE_FILE_MODE = 0o644

/** Inputs required to publish the packaged CodeGraph CLI to a user's shell. */
export interface DesktopCodegraphShellOptions {
  /** Harness home directory; receives the generated shim under `bin/`. */
  homeDir: string
  /** User's home directory; holds the shell profile that gains the PATH entry. */
  userHomeDir: string
  /** Absolute path of the packaged `codegraph` launcher. */
  launcherPath: string
  /** Login shell from `$SHELL`; selects which profile file is updated. */
  shell?: string | undefined
  /** Timestamp source for backup names; defaults to the wall clock. */
  now?: (() => Date) | undefined
}

/** Paths touched by one shell-integration run. */
export interface DesktopCodegraphShellInstallation {
  /** Generated launcher shim added to PATH. */
  shimPath: string
  /** Shell profile that received the marked PATH block. */
  profilePath: string
  /** Directory prepended to PATH by the profile block. */
  pathDir: string
  /** Whether this run changed anything on disk. */
  changed: boolean
}

function fail(message: string): never {
  throw new Error(`dsh-plugin-desktop: ${message}`)
}

function assertValue(label: string, value: string): void {
  if (value.length === 0) fail(`${label} must not be empty`)
  if (/[\0\r\n]/u.test(value)) fail(`${label} must not contain NUL or newlines`)
}

/** Quote one arbitrary value as a POSIX shell word. */
function quoteSh(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

/**
 * Select the shell profile that receives the PATH entry.
 *
 * macOS opens interactive login shells from Terminal, and zsh has been the
 * default since Catalina. Bash login shells read `.bash_profile` instead. An
 * unknown or unset shell falls back to zsh rather than guessing further.
 */
export function desktopCodegraphProfileName(shell?: string): string {
  return (shell ?? '').endsWith('bash') ? '.bash_profile' : '.zshrc'
}

/** Escape a literal fragment so it stays literal inside a double-quoted shell word. */
function escapeDoubleQuoted(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('$', '\\$')
    .replaceAll('`', '\\`')
}

/**
 * Express `target` relative to `$HOME` when possible so the entry survives a
 * renamed user directory; otherwise fall back to the absolute path.
 *
 * Returns an unquoted fragment that the caller wraps in one pair of double
 * quotes, so the whole PATH value is quoted consistently and `$HOME` still
 * expands.
 */
function pathEntryFragment(target: string, userHomeDir: string): string {
  const root = resolve(userHomeDir)
  const resolved = resolve(target)
  if (resolved === root) return '$HOME'
  if (!resolved.startsWith(`${root}${sep}`)) return escapeDoubleQuoted(resolved)
  const suffix = relative(root, resolved).split(sep).join('/')
  return `$HOME/${escapeDoubleQuoted(suffix)}`
}

/** Write through a temporary sibling so a failure cannot truncate the target. */
function writeFileAtomic(path: string, contents: string, mode: number): void {
  const temporary = `${path}.dsh-${String(process.pid)}-${Date.now().toString(36)}.tmp`
  try {
    writeFileSync(temporary, contents, { mode })
    renameSync(temporary, path)
  } catch (cause) {
    rmSync(temporary, { force: true })
    throw cause
  }
  chmodSync(path, mode)
}

function readTextIfPresent(path: string): string | undefined {
  if (!existsSync(path)) return undefined
  return readFileSync(path, 'utf8')
}

/** Render the marked PATH block, replacing any existing one. */
function applyProfileBlock(existing: string, pathDir: string, userHomeDir: string): string {
  const block = [
    MARKER_BEGIN,
    `export PATH="${pathEntryFragment(pathDir, userHomeDir)}:$PATH"`,
    MARKER_END,
  ]
  const lines = existing.split('\n')
  const start = lines.indexOf(MARKER_BEGIN)
  const end = lines.indexOf(MARKER_END)

  if (start !== -1 && end > start) {
    const replaced = [...lines.slice(0, start), ...block, ...lines.slice(end + 1)]
    return replaced.join('\n')
  }

  // A profile ending without a newline would otherwise swallow the marker.
  const prefix = existing.length === 0 || existing.endsWith('\n') ? existing : `${existing}\n`
  const separator = prefix.length === 0 ? '' : '\n'
  return `${prefix}${separator}${block.join('\n')}\n`
}

/**
 * Write the launcher shim and add its directory to the user's shell profile.
 *
 * Safe to run on every launch: unchanged artifacts are left untouched, and the
 * profile is only rewritten when its marked block actually differs.
 */
export function installDesktopCodegraphShell(
  options: DesktopCodegraphShellOptions,
): DesktopCodegraphShellInstallation {
  assertValue('harness home directory', options.homeDir)
  assertValue('user home directory', options.userHomeDir)
  assertValue('codegraph launcher path', options.launcherPath)

  const pathDir = join(options.homeDir, SHIM_DIRECTORY)
  const shimPath = join(pathDir, SHIM_NAME)
  const profilePath = join(options.userHomeDir, desktopCodegraphProfileName(options.shell))

  const shim = [
    '#!/bin/sh',
    '# Generated by the DSH Desktop client. Do not edit: it is rewritten on launch.',
    `exec ${quoteSh(options.launcherPath)} "$@"`,
    '',
  ].join('\n')

  let changed = false
  if (readTextIfPresent(shimPath) !== shim) {
    mkdirSync(pathDir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
    writeFileAtomic(shimPath, shim, EXECUTABLE_FILE_MODE)
    changed = true
  }

  const existing = readTextIfPresent(profilePath)
  const updated = applyProfileBlock(existing ?? '', pathDir, options.userHomeDir)
  if (updated !== existing) {
    if (existing !== undefined && existing.length > 0) {
      const stamp = (options.now ?? (() => new Date()))().toISOString().replace(/[:.]/gu, '-')
      writeFileSync(`${profilePath}.dsh-backup-${stamp}`, existing, { mode: PROFILE_FILE_MODE })
    }
    mkdirSync(dirname(profilePath), { recursive: true })
    writeFileAtomic(profilePath, updated, PROFILE_FILE_MODE)
    changed = true
  }

  return { shimPath, profilePath, pathDir, changed }
}

/**
 * Remove the shim and the marked PATH block, leaving the rest of the profile
 * byte-identical. Absent artifacts are not an error.
 */
export function uninstallDesktopCodegraphShell(
  options: DesktopCodegraphShellOptions,
): DesktopCodegraphShellInstallation {
  const pathDir = join(options.homeDir, SHIM_DIRECTORY)
  const shimPath = join(pathDir, SHIM_NAME)
  const profilePath = join(options.userHomeDir, desktopCodegraphProfileName(options.shell))

  let changed = false
  if (existsSync(shimPath)) {
    rmSync(shimPath, { force: true })
    changed = true
  }

  const existing = readTextIfPresent(profilePath)
  if (existing !== undefined) {
    const lines = existing.split('\n')
    const start = lines.indexOf(MARKER_BEGIN)
    const end = lines.indexOf(MARKER_END)
    if (start !== -1 && end > start) {
      const kept = [...lines.slice(0, start), ...lines.slice(end + 1)]
      // Drop the separator line the installer added before the block.
      if (kept[start - 1] === '' && kept[start] === '') kept.splice(start, 1)
      writeFileAtomic(profilePath, kept.join('\n'), PROFILE_FILE_MODE)
      changed = true
    }
  }

  return { shimPath, profilePath, pathDir, changed }
}
