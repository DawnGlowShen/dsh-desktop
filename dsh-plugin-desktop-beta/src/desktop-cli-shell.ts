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
import { dirname, join, relative, resolve, sep, win32 } from 'node:path'

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
const WINDOWS_SHIM_EXTENSION = '.cmd'

/**
 * Arguments the packaged CodeGraph bundle's own launcher passes to `node.exe`.
 *
 * `--liftoff-only` avoids the V8 turboshaft WASM Zone OOM (upstream issues
 * #293/#298); `--disable-warning=ExperimentalWarning` mutes `node:sqlite`'s
 * per-thread warning that would otherwise interleave with the progress UI.
 * They are duplicated from the upstream launcher rather than read from it,
 * because the forwarder deliberately does not execute the upstream file.
 */
const CODEGRAPH_NODE_ARGUMENTS = ['--liftoff-only', '--disable-warning=ExperimentalWarning']

/**
 * Suffix whose presence means a shim delegates to `node.exe` plus a script.
 *
 * `launcherPath` stays a plain path so callers keep passing whatever the
 * platform packages; only the renderer decides whether the file needs an
 * interpreter.
 */
const NODE_SCRIPT_EXTENSION = '.js'

/**
 * Directory chain between the bundle root and the packaged CodeGraph entry
 * script, innermost first.
 *
 * The Windows bundle is flat — `node.exe` sits at its root — while the entry
 * script is nested under `lib\dist\bin`. The chain is checked rather than
 * blindly walked so an upstream repackaging fails loudly instead of producing a
 * shim that points at a missing interpreter.
 */
const CODEGRAPH_SCRIPT_DIRECTORIES = ['bin', 'dist', 'lib']

/** Interpreter the packaged bundle ships beside its entry script. */
const WINDOWS_NODE_EXECUTABLE = 'node.exe'

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
  /**
   * Host platform selecting the shim dialect.
   *
   * Windows gets `.cmd` forwarders and no shell profile at all — its PATH entry
   * is the installer's job — while every other platform keeps the POSIX shim and
   * the marked profile block. Defaults to the running platform, and is
   * injectable so the Windows dialect stays testable on any host.
   */
  platform?: NodeJS.Platform | undefined
  /** Login shell from `$SHELL`; selects which profile file is updated. */
  shell?: string | undefined
  /** Timestamp source for backup names; defaults to the wall clock. */
  now?: (() => Date) | undefined
}

/** Paths touched by one shell-integration run. */
export interface DesktopCliShellInstallation {
  /** Generated launcher shims added to PATH, in launcher order. */
  shimPaths: string[]
  /**
   * Shell profile that received the marked PATH block, or `''` on Windows,
   * which has no shell profile and instead relies on the registry PATH entry.
   */
  profilePath: string
  /** Directory prepended to PATH by the profile block. */
  pathDir: string
  /** Whether this run changed anything on disk. */
  changed: boolean
}

/**
 * Directory that receives the generated shims for one harness home.
 *
 * Exported so the PATH registration code addresses the same directory the
 * shims are written to, instead of re-deriving `<homeDir>/bin` and drifting.
 */
export function desktopCliShimDirectory(homeDir: string): string {
  return join(homeDir, SHIM_DIRECTORY)
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
 *
 * `.` and `..` pass the character-class check but denote directories, so
 * `join(pathDir, '..')` would land outside the shim directory: the command
 * would be written over the harness home itself. They are rejected explicitly.
 */
function assertLauncherName(name: string): void {
  assertValue('launcher name', name)
  if (name === '.' || name === '..') {
    fail(`launcher name ${JSON.stringify(name)} must be a bare command name`)
  }
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
 * Quote one Windows batch word so the path stays a single literal argument.
 *
 * `%` is doubled because cmd.exe expands `%VAR%` even inside quotes, so an
 * installation path containing `%` would otherwise be substituted or fail with
 * `ERROR_PATH_NOT_FOUND`. A `"` or newline cannot be represented in a path this
 * shim is willing to generate, so it is rejected rather than escaped.
 *
 * Line endings are CRLF throughout: cmd.exe tolerates LF, but CRLF is what the
 * rest of the Windows toolchain produces and keeps the file readable in Notepad.
 */
function quoteBatchWord(value: string): string {
  if (/["\r\n\0]/u.test(value)) {
    fail(`launcher path ${JSON.stringify(value)} must not contain quotes, NUL, or newlines`)
  }
  return `"${value.replaceAll('%', '%%')}"`
}

/**
 * Derive the flat bundle root from a nested entry script.
 *
 * The Windows bundle keeps `node.exe` at its root but nests the CodeGraph entry
 * script under `lib\dist\bin`, so the forwarder has to walk back up. Each level
 * is validated against the expected layout: a repackaged bundle fails here with
 * a clear message instead of yielding a shim that cannot resolve its
 * interpreter.
 */
function windowsBundleRoot(launcherPath: string): string {
  let directory = win32.dirname(launcherPath)
  for (const expected of CODEGRAPH_SCRIPT_DIRECTORIES) {
    if (win32.basename(directory).toLowerCase() !== expected) {
      fail(
        `codegraph launcher path ${JSON.stringify(launcherPath)} is not inside a `
        + `${CODEGRAPH_SCRIPT_DIRECTORIES.toReversed().join('\\')} directory`,
      )
    }
    directory = win32.dirname(directory)
  }
  return directory
}

/**
 * Render the Windows `.cmd` forwarder for one launcher.
 *
 * The file is a forwarder, never a copy: it re-derives nothing at call time and
 * instead embeds absolute paths, so it is rewritten on the next launch whenever
 * the bundle moves. `%~dp0` is deliberately absent — it resolves to the shim
 * directory at call time, which is why copying the upstream `.cmd` breaks
 * immediately.
 */
function renderWindowsShim(launcherPath: string): string {
  const command = launcherPath.toLowerCase().endsWith(NODE_SCRIPT_EXTENSION)
    ? [
        quoteBatchWord(win32.join(windowsBundleRoot(launcherPath), WINDOWS_NODE_EXECUTABLE)),
        ...CODEGRAPH_NODE_ARGUMENTS,
        quoteBatchWord(launcherPath),
      ].join(' ')
    : quoteBatchWord(launcherPath)
  return `@echo off\r\n${command} %*\r\n`
}

/** Shim file name for one launcher under the given platform's dialect. */
function shimFileName(launcher: DesktopCliLauncher, windows: boolean): string {
  return windows ? `${launcher.name}${WINDOWS_SHIM_EXTENSION}` : launcher.name
}

/**
 * Write the launcher shims and add their shared directory to the user's shell
 * profile.
 *
 * Safe to run on every launch: unchanged artifacts are left untouched, and the
 * profile is only rewritten when its marked block actually differs. One shim
 * directory means one PATH block regardless of how many launchers are passed.
 *
 * On Windows only the `.cmd` forwarders are generated: there is no shell
 * profile to edit, and the directory reaches PATH through the registry entry the
 * installer writes and the settings action repairs.
 */
export function installDesktopCliShell(options: DesktopCliShellOptions): DesktopCliShellInstallation {
  assertValue('harness home directory', options.homeDir)
  assertValue('user home directory', options.userHomeDir)
  if (options.launchers.length === 0) fail('at least one launcher is required')

  const windows = (options.platform ?? process.platform) === 'win32'
  const pathDir = join(options.homeDir, SHIM_DIRECTORY)

  let changed = false
  const shimPaths: string[] = []
  let directoryCreated = false
  for (const launcher of options.launchers) {
    assertLauncherName(launcher.name)
    assertValue(`${launcher.name} launcher path`, launcher.launcherPath)
    const shimPath = join(pathDir, shimFileName(launcher, windows))
    shimPaths.push(shimPath)
    const shim = windows ? renderWindowsShim(launcher.launcherPath) : renderShim(launcher.launcherPath)
    if (readTextIfPresent(shimPath) !== shim) {
      if (!directoryCreated) {
        mkdirSync(pathDir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
        directoryCreated = true
      }
      writeFileAtomic(shimPath, shim, EXECUTABLE_FILE_MODE)
      changed = true
    }
  }

  // Windows has no shell profile: its PATH entry belongs to the registry, so
  // nothing here may create or modify a dotfile in the user's home directory.
  if (windows) return { shimPaths, profilePath: '', pathDir, changed }

  const profilePath = join(options.userHomeDir, desktopCliProfileName(options.shell))
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
 *
 * On Windows no profile is touched: the registry PATH entry is removed by the
 * settings action or the uninstaller, not here.
 */
export function uninstallDesktopCliShell(options: DesktopCliShellOptions): DesktopCliShellInstallation {
  const windows = (options.platform ?? process.platform) === 'win32'
  const pathDir = join(options.homeDir, SHIM_DIRECTORY)

  let changed = false
  const shimPaths: string[] = []
  for (const launcher of options.launchers) {
    assertLauncherName(launcher.name)
    const shimPath = join(pathDir, shimFileName(launcher, windows))
    shimPaths.push(shimPath)
    if (existsSync(shimPath)) {
      rmSync(shimPath, { force: true })
      changed = true
    }
  }

  if (windows) return { shimPaths, profilePath: '', pathDir, changed }

  const profilePath = join(options.userHomeDir, desktopCliProfileName(options.shell))
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
