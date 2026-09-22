/**
 * Publish the packaged CLIs to the user's own terminal.
 *
 * A `.dmg` has no install hook: dragging the application into `/Applications`
 * is the whole installation. The Host process can publish a CLI on its own PATH
 * at runtime, but a shell started by the user is outside that process, so the
 * only way to make a command resolve there is a shim plus a PATH entry in the
 * user's shell profile.
 *
 * Every bundled CLI shares one shim directory and therefore one marked PATH
 * block: adding a second CLI must not append a second block, or the profile
 * would accumulate one `export PATH=...` line per CLI. Only the shim files
 * differ per CLI.
 *
 * Both artifacts are generated idempotently and removed by
 * {@link uninstallDesktopCliShell}. They are deliberately persistent rather
 * than released on shutdown: the point is that the commands keep working after
 * the application quits.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

/**
 * Marker text is historical: it already contains the word `codegraph` because
 * CodeGraph was the first bundled CLI. It is deliberately NOT renamed to a
 * neutral string. An installed user profile holds a block with exactly this
 * text, so renaming would make the old block unrecognisable, append a second
 * one, and leave a stray `.dsh-backup-*` file behind.
 */
const MARKER_BEGIN = '# >>> dsh-desktop codegraph >>>'
const MARKER_END = '# <<< dsh-desktop codegraph <<<'
const SHIM_DIRECTORY = 'bin'
const PRIVATE_DIRECTORY_MODE = 0o700
const EXECUTABLE_FILE_MODE = 0o755
const PROFILE_FILE_MODE = 0o644

/** One bundled CLI to publish under the shared shim directory. */
export interface DesktopCliLauncher {
  /** Command name, and therefore the shim's file name. Must be a bare name. */
  name: string
  /** Absolute path of the packaged launcher the shim delegates to. */
  launcherPath: string
}

/** Inputs required to publish the packaged CLIs to a user's shell. */
export interface DesktopCliShellOptions {
  /** Harness home directory; receives the generated shims under `bin/`. */
  homeDir: string
  /** User's home directory; holds the shell profile that gains the PATH entry. */
  userHomeDir: string
  /** Bundled CLIs to publish; all share one shim directory and one PATH block. */
  launchers: readonly DesktopCliLauncher[]
  /** Login shell from `$SHELL`; selects which profile file is updated. */
  shell?: string | undefined
  /** Timestamp source for backup names; defaults to the wall clock. */
  now?: (() => Date) | undefined
}

/** Paths touched by one shell-integration run. */
export interface DesktopCliShellInstallation {
  /** Generated launcher shims added to PATH, in launcher order. */
  shimPaths: string[]
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

/**
 * Reject a command name that would escape the shim directory or produce an
 * unusable file name.
 */
function assertLauncherName(name: string): void {
  assertValue('launcher name', name)
  if (!/^[A-Za-z0-9._-]+$/u.test(name)) {
    fail(`launcher name ${JSON.stringify(name)} must be a bare command name`)
  }
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
export function desktopCliProfileName(shell?: string): string {
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

/** Render one shim that delegates to a packaged launcher. */
function renderShim(launcherPath: string): string {
  return [
    '#!/bin/sh',
    '# Generated by the DSH Desktop client. Do not edit: it is rewritten on launch.',
    `exec ${quoteSh(launcherPath)} "$@"`,
    '',
  ].join('\n')
}

/**
 * Write the launcher shims and add their shared directory to the user's shell
 * profile.
 *
 * Safe to run on every launch: unchanged artifacts are left untouched, and the
 * profile is only rewritten when its marked block actually differs. One shim
 * directory means one PATH block regardless of how many launchers are passed.
 */
export function installDesktopCliShell(options: DesktopCliShellOptions): DesktopCliShellInstallation {
  assertValue('harness home directory', options.homeDir)
  assertValue('user home directory', options.userHomeDir)
  if (options.launchers.length === 0) fail('at least one launcher is required')

  const pathDir = join(options.homeDir, SHIM_DIRECTORY)
  const profilePath = join(options.userHomeDir, desktopCliProfileName(options.shell))

  let changed = false
  const shimPaths: string[] = []
  let directoryCreated = false
  for (const launcher of options.launchers) {
    assertLauncherName(launcher.name)
    assertValue(`${launcher.name} launcher path`, launcher.launcherPath)
    const shimPath = join(pathDir, launcher.name)
    shimPaths.push(shimPath)
    const shim = renderShim(launcher.launcherPath)
    if (readTextIfPresent(shimPath) !== shim) {
      if (!directoryCreated) {
        mkdirSync(pathDir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
        directoryCreated = true
      }
      writeFileAtomic(shimPath, shim, EXECUTABLE_FILE_MODE)
      changed = true
    }
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

  return { shimPaths, profilePath, pathDir, changed }
}

/**
 * Remove the shims and the marked PATH block, leaving the rest of the profile
 * byte-identical. Absent artifacts are not an error.
 *
 * The marked block is only removed when no CLI is being published, so the
 * block's fate is decided by the caller passing the full desired launcher set,
 * not by which shims happen to exist.
 */
export function uninstallDesktopCliShell(options: DesktopCliShellOptions): DesktopCliShellInstallation {
  const pathDir = join(options.homeDir, SHIM_DIRECTORY)
  const profilePath = join(options.userHomeDir, desktopCliProfileName(options.shell))

  let changed = false
  const shimPaths: string[] = []
  for (const launcher of options.launchers) {
    assertLauncherName(launcher.name)
    const shimPath = join(pathDir, launcher.name)
    shimPaths.push(shimPath)
    if (existsSync(shimPath)) {
      rmSync(shimPath, { force: true })
      changed = true
    }
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

  return { shimPaths, profilePath, pathDir, changed }
}
