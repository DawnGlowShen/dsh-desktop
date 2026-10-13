/**
 * Configure the user's global git so git-ai can observe their repositories.
 *
 * git-ai attributes edits from Trace2 events, which Git only emits when
 * `trace2.eventTarget` points at the daemon's socket. Without it a checkpoint
 * still succeeds, but every later commit reads back as `untracked` and `git-ai
 * status` loses the line-level attribution entirely — a silent failure the user
 * only notices as wrong numbers. This module writes those two keys for them, so
 * a preinstalled git-ai works without hand-editing `~/.gitconfig`.
 *
 * ## Why the global file rather than an environment variable
 *
 * `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` would cover every
 * process DSH launches, but a user typing `git commit` in their own terminal
 * would bypass them and lose attribution. The global file covers both. The cost
 * is that this module edits a file the user owns, so it is deliberately
 * conservative: it comments the previous value out instead of deleting it,
 * marks every line it owns, and reports what it changed.
 *
 * ## Why plain text rather than `git config`
 *
 * `git config --global` normalizes the entire file, which would discard the
 * user's own comments and formatting. Writing the block directly keeps every
 * unrelated byte intact.
 *
 * ## Idempotence
 *
 * The block is delimited by sentinel comments, and a previous value is disabled
 * by prefixing {@link OWNED_COMMENT_PREFIX}. Both markers are self-identifying,
 * so repeated runs converge instead of nesting comments: a line already
 * carrying the prefix is never commented again. A duplicate key later in the
 * file wins in Git's precedence order, so the managed block is always appended
 * last.
 *
 * ## Windows uses a named pipe, not an AF_UNIX socket
 *
 * Git's `trace2.eventTarget` names a transport, and the correct value is
 * platform-specific. On Unix git-ai listens on a filesystem socket and the
 * value carries the `af_unix:stream:` scheme. Windows has no AF_UNIX support
 * in this code path, so git-ai listens on a named pipe and
 * `DaemonConfig::trace2_event_target_for_path` returns the **bare path with no
 * scheme at all**:
 *
 *   Unix:    af_unix:stream:<home>/.git-ai/internal/daemon/trace2.sock
 *   Windows: \\.\pipe\git-ai-<sha256(internal_dir)[:16]>-trace2
 *
 * Writing the Unix form on Windows is not a crash — Git degrades to emitting
 * Trace2 events on stderr when the target cannot be opened, so every command
 * still exits 0 — but no event ever reaches the daemon and attribution is lost
 * silently, which is exactly the failure this module exists to prevent.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Opening sentinel of the block this module owns in `~/.gitconfig`. */
export const GIT_AI_CONFIG_MARKER_BEGIN = '# >>> dsh-desktop git-ai >>>'
/** Closing sentinel of the block this module owns in `~/.gitconfig`. */
export const GIT_AI_CONFIG_MARKER_END = '# <<< dsh-desktop git-ai <<<'
/**
 * Prefix marking a user value this module disabled.
 *
 * Doubles as the idempotence key: a line already carrying it belongs to a
 * previous run and is left alone, so the file never grows nested comments.
 */
export const OWNED_COMMENT_PREFIX = '# [dsh-desktop] 原值已注释:'

/** Configuration keys git-ai needs; both are written into the managed block. */
const EVENT_TARGET_KEY = 'eventTarget'
const EVENT_NESTING_KEY = 'eventNesting'
/** Section both managed keys live in. */
const TRACE2_SECTION = 'trace2'
/**
 * Nesting depth Git should use while emitting Trace2 events.
 *
 * `0` keeps child-process events flat, which is what the daemon consumes; the
 * measured baseline the plugin was verified against.
 */
const EVENT_NESTING_VALUE = '0'
/**
 * Upper bound on how long `bg start` may take.
 *
 * Startup awaits this, so a wedged daemon must not hold the main window: the
 * daemon can still come up later through git-ai's own self-healing, and the
 * worst case is the race this call exists to close.
 */
const DAEMON_START_TIMEOUT_MS = 5_000

/** Socket path, relative to the home directory, that the git-ai daemon listens on. */
const SOCKET_RELATIVE_PATH = join('.git-ai', 'internal', 'daemon', 'trace2.sock')

/**
 * Windows named-pipe name prefix, matching git-ai's `DaemonConfig`.
 *
 * The daemon derives both pipe names from its internal directory, so the hash
 * below must be fed the byte-for-byte same string git-ai hashes or the two
 * sides will never meet.
 */
const WINDOWS_PIPE_PREFIX = '\\\\.\\pipe\\git-ai-'
/** Bytes of the SHA-256 hex digest git-ai keeps when naming the pipe. */
const WINDOWS_PIPE_HASH_LENGTH = 16
/**
 * The internal directory git-ai hashes, spelled with Windows separators.
 *
 * Held as a literal rather than built via `join` so the bytes hashed are the
 * same on every host that computes them.
 */
const WINDOWS_INTERNAL_DIRECTORY = '.git-ai\\internal'

/** Inputs required to configure Trace2 attribution. */
export interface DesktopGitAiConfigOptions {
  /** User home directory; owns both the gitconfig and the daemon socket path. */
  homeDir: string
  /** Gitconfig to edit; normally `~/.gitconfig`. */
  gitConfigPath: string
  /** Logger receiving a one-line summary of every run. */
  logger: DesktopGitAiConfigLogger
  /**
   * Test seam for the file system, so the whole decision table is exercisable
   * without touching a real home directory.
   */
  fileSystem?: DesktopGitAiConfigFileSystem
  /**
   * Host platform selecting the Trace2 transport.
   *
   * Defaults to the running platform; a test pins `'win32'` to assert the
   * named-pipe spelling from a Unix host.
   */
  platform?: NodeJS.Platform
}

/** Minimal logging surface, satisfied by the Electron logger used at startup. */
export interface DesktopGitAiConfigLogger {
  /** Record an informational summary of what this run changed. */
  info(message: string): void
  /** Record a failure; the caller keeps startup alive regardless. */
  error(message: string): void
}

/** Injectable file-system operations, defaulting to `node:fs`. */
export interface DesktopGitAiConfigFileSystem {
  exists(path: string): boolean
  read(path: string): string
  write(path: string, contents: string): void
  rename(from: string, to: string): void
  remove(path: string): void
  mkdir(path: string): void
}

/** What one run did, so the caller can log and test the decision. */
export interface DesktopGitAiConfigResult {
  /** The gitconfig that was inspected. */
  gitConfigPath: string
  /** Trace2 event target written for this user. */
  eventTarget: string
  /** True when the file differs from what the run found. */
  changed: boolean
  /** User values this run disabled, as `section.key`; empty when none. */
  commentedUserValues: string[]
  /**
   * True when the previous run's block was replaced rather than appended.
   *
   * Distinguishes "first configuration" from "refreshed", which is what makes a
   * changed-but-not-first run visible in the log.
   */
  replacedExistingBlock: boolean
}

const nodeFileSystem: DesktopGitAiConfigFileSystem = {
  exists: path => existsSync(path),
  read: path => readFileSync(path, 'utf8'),
  write: (path, contents) => { writeFileSync(path, contents) },
  rename: (from, to) => { renameSync(from, to) },
  remove: path => { rmSync(path, { force: true }) },
  mkdir: path => { mkdirSync(path, { recursive: true }) },
}

/**
 * Name of the Windows named pipe git-ai's daemon traces into.
 *
 * Mirrors `DaemonConfig::from_internal_dir` in git-ai: the daemon SHA-256s its
 * internal directory path and keeps the first 16 hex digits, so the pipe name
 * is a pure function of the home directory. The hash is computed over the
 * daemon's own path string, which on Windows comes from `USERPROFILE`; DSH
 * passes Electron's `app.getPath('home')`, and the two agree whenever
 * `USERPROFILE` is set, which is the normal case.
 *
 * The path is assembled with Windows separators by hand rather than with
 * `node:path.join`, which would use the **host's** separator: building this
 * string on macOS or Linux would otherwise hash `C:\Users\me/.git-ai/internal`
 * and compute a pipe name the daemon never listens on.
 *
 * @param homeDir - user home directory, spelled the way git-ai will spell it.
 * @returns the full `\\.\pipe\...` path for this user's Trace2 pipe.
 */
function windowsTrace2PipePath(homeDir: string): string {
  const internalDir = `${homeDir.replace(/[\\/]+$/u, '')}\\${WINDOWS_INTERNAL_DIRECTORY}`
  const digest = createHash('sha256').update(internalDir).digest('hex')
  return `${WINDOWS_PIPE_PREFIX}${digest.slice(0, WINDOWS_PIPE_HASH_LENGTH)}-trace2`
}

/**
 * The Trace2 event target for one home directory.
 *
 * The transport is platform-specific, and Git expects the exact string git-ai
 * itself would write: a scheme-qualified AF_UNIX socket on Unix, and a bare
 * named-pipe path — no scheme — on Windows.
 *
 * @param homeDir - user home directory owning the daemon socket.
 * @param platform - Host platform; defaults to the running one so callers that
 * already know the platform can assert the Windows spelling from any host.
 * @returns the `trace2.eventTarget` value to write into the user's gitconfig.
 */
export function gitAiTrace2EventTarget(homeDir: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return windowsTrace2PipePath(homeDir)
  return `af_unix:stream:${join(homeDir, SOCKET_RELATIVE_PATH)}`
}

/** A config line, retaining whether it was disabled by a previous run. */
interface ManagedLine {
  /** Contents with any {@link OWNED_COMMENT_PREFIX} already stripped. */
  body: string
  /** True when a previous run of this module disabled the line. */
  commented: boolean
}

/**
 * Split a line into its body and whether this module already disabled it.
 *
 * Strip only a prefix at the start of the line, and only the one this module
 * writes, so a `# [dsh-desktop] 原值已注释:` appearing inside a value stays
 * untouched.
 */
function parseManagedLine(line: string): ManagedLine {
  const trimmed = line.trimStart()
  if (trimmed.startsWith(OWNED_COMMENT_PREFIX)) {
    return { body: trimmed.slice(OWNED_COMMENT_PREFIX.length).trimStart(), commented: true }
  }
  return { body: trimmed, commented: false }
}

/**
 * Match `key = value` inside a section, tolerating Git's `key=value` and
 * `key value` spellings.
 *
 * Git accepts all three forms, so a user value written as `eventTarget=x` must
 * still be recognized and disabled rather than silently left to race with the
 * managed block.
 */
function matchKey(line: string, key: string): boolean {
  const separator = line.search(/[=\s]/u)
  if (separator === -1) return false
  return line.slice(0, separator).toLowerCase() === key.toLowerCase()
}

/**
 * Rewrite the file, disabling user values in the `[trace2]` section and
 * appending the managed block.
 *
 * Exported for the tests, which exercise the text transformation directly.
 *
 * @param contents - current gitconfig contents, possibly empty.
 * @param eventTarget - socket target to write into the managed block.
 * @returns the new contents plus what the transformation changed.
 */
export function applyGitAiTrace2Config(
  contents: string,
  eventTarget: string,
): { contents: string, changed: boolean, commentedUserValues: string[], replacedExistingBlock: boolean } {
  const lines = contents.split('\n')
  // A trailing newline produces one empty final element; drop it so it cannot be
  // mistaken for a line inside `[trace2]` during the section scan.
  if (lines.at(-1) === '') lines.pop()

  const output: string[] = []
  const commentedUserValues: string[] = []
  let section = ''
  let inManagedBlock = false
  let replacedExistingBlock = false

  for (const line of lines) {
    const trimmed = line.trim()

    if (trimmed === GIT_AI_CONFIG_MARKER_BEGIN) {
      inManagedBlock = true
      replacedExistingBlock = true
      continue
    }
    if (trimmed === GIT_AI_CONFIG_MARKER_END) {
      inManagedBlock = false
      continue
    }
    // Every line between the sentinels belongs to a previous run and is
    // replaced wholesale by the block appended below.
    if (inManagedBlock) continue

    const sectionMatch = /^\s*\[([^\]]+)\]/u.exec(line)
    if (sectionMatch !== null) {
      section = sectionMatch[1] ?? ''
      output.push(line)
      continue
    }

    const managed = parseManagedLine(line)
    if (section.toLowerCase() === TRACE2_SECTION && !managed.commented) {
      const body = managed.body
      const target = matchKey(body, EVENT_TARGET_KEY)
      const nesting = target ? false : matchKey(body, EVENT_NESTING_KEY)
      if (target || nesting) {
        // The user's own value: keep it readable but inert. Reporting is
        // deduplicated at the end, so a repeated key inside the section is
        // commented every time without inflating the summary.
        commentedUserValues.push(`${TRACE2_SECTION}.${target ? EVENT_TARGET_KEY : EVENT_NESTING_KEY}`)
        output.push(`${OWNED_COMMENT_PREFIX} ${body}`)
        continue
      }
    }

    output.push(line)
  }

  // Trim trailing blank lines so repeated runs do not accumulate whitespace
  // before the block.
  while (output.length > 0 && output.at(-1)?.trim() === '') output.pop()

  const block = [
    '',
    GIT_AI_CONFIG_MARKER_BEGIN,
    `[${TRACE2_SECTION}]`,
    `\t${EVENT_NESTING_KEY} = ${EVENT_NESTING_VALUE}`,
    `\t${EVENT_TARGET_KEY} = ${eventTarget}`,
    GIT_AI_CONFIG_MARKER_END,
  ]

  const next = [...output, ...block].join('\n') + '\n'
  return {
    contents: next,
    changed: next !== contents,
    commentedUserValues: [...new Set(commentedUserValues)],
    replacedExistingBlock,
  }
}

/**
 * Summarize one run for the operator log.
 *
 * The summary names every user value that was disabled, because that is the
 * only part of this module a user can perceive as a change to their own machine
 * — so it must be recoverable from the log alone.
 */
function describeRun(result: DesktopGitAiConfigResult): string {
  if (!result.changed) {
    return `git-ai trace2 configuration already current in ${result.gitConfigPath}`
  }
  const action = result.replacedExistingBlock ? 'refreshed' : 'written'
  const commented = result.commentedUserValues.length === 0
    ? ''
    : `; commented out previous values: ${result.commentedUserValues.join(', ')}`
  return `git-ai trace2 configuration ${action} in ${result.gitConfigPath} `
    + `(eventTarget=${result.eventTarget})${commented}`
}

/**
 * Configure the global gitconfig so git-ai can attribute this user's edits.
 *
 * Never throws for a missing gitconfig (it is created), and never removes a
 * user's value: a previous `trace2.eventTarget` is commented out and reported.
 * The file is replaced atomically so a crash cannot leave a truncated
 * gitconfig, which would break every Git command for the user.
 *
 * @param options - home directory, gitconfig path, logger, and test seams.
 * @returns what this run changed, for logging and assertions.
 */
export function ensureDesktopGitAiTrace2Config(
  options: DesktopGitAiConfigOptions,
): DesktopGitAiConfigResult {
  const fileSystem = options.fileSystem ?? nodeFileSystem
  const eventTarget = gitAiTrace2EventTarget(options.homeDir, options.platform ?? process.platform)
  const existing = fileSystem.exists(options.gitConfigPath) ? fileSystem.read(options.gitConfigPath) : ''
  const applied = applyGitAiTrace2Config(existing, eventTarget)

  if (!applied.changed) {
    const unchanged: DesktopGitAiConfigResult = {
      gitConfigPath: options.gitConfigPath,
      eventTarget,
      changed: false,
      commentedUserValues: [],
      replacedExistingBlock: applied.replacedExistingBlock,
    }
    options.logger.info(describeRun(unchanged))
    return unchanged
  }

  fileSystem.mkdir(dirname(options.gitConfigPath))
  // Write beside the target and rename: `rename` is atomic within a directory,
  // so a reader never observes a half-written gitconfig. The temporary name
  // carries the pid so two instances cannot collide.
  const temporaryPath = `${options.gitConfigPath}.dsh-desktop-${process.pid}.tmp`
  try {
    fileSystem.write(temporaryPath, applied.contents)
    fileSystem.rename(temporaryPath, options.gitConfigPath)
  } catch (cause) {
    try {
      fileSystem.remove(temporaryPath)
    } catch {
      // A leftover temporary file is harmless; the original failure matters more.
    }
    throw cause
  }

  const result: DesktopGitAiConfigResult = {
    gitConfigPath: options.gitConfigPath,
    eventTarget,
    changed: true,
    commentedUserValues: applied.commentedUserValues,
    replacedExistingBlock: applied.replacedExistingBlock,
  }
  options.logger.info(describeRun(result))
  return result
}

/** Inputs used to start the git-ai Trace2 daemon at startup. */
export interface DesktopGitAiDaemonOptions {
  /**
   * Published git-ai `bin` directory, or `undefined` when the bundle was
   * skipped. An unpublished CLI is not an error: git-ai may also be installed
   * by the user, and the config block stays valid either way.
   */
  gitAiPathDir?: string | undefined
  /** Logger receiving the outcome. */
  logger: DesktopGitAiConfigLogger
  /** Test seam replacing the command runner. */
  run?: DesktopGitAiDaemonRunner
}

/** Outcome of one daemon start attempt. */
export interface DesktopGitAiDaemonResult {
  /** True when the daemon reported or reached a running state. */
  started: boolean
  /** Reason the daemon is not running; absent once it started. */
  failure?: string
}

/** Runs one command and reports its exit code and merged output. */
export type DesktopGitAiDaemonRunner = (
  command: string,
  args: readonly string[],
) => { status: number | null, stdout: string, stderr: string }

/**
 * Start the git-ai Trace2 daemon so attribution is live before the first edit.
 *
 * `git-ai` starts this daemon by itself on the first checkpoint, but that leaves
 * a race: a user who edits a file and commits immediately can emit Trace2 events
 * before the daemon binds its socket, and those events are lost. Starting it at
 * launch closes that window.
 *
 * The daemon detaches (it is re-parented to the init process), so it outlives
 * this application and keeps attributing Git activity in the user's own
 * terminal after DSH closes. That is intended: attribution is a property of the
 * machine's Git, not of one session.
 *
 * Never throws. A missing or unrunnable CLI only produces a logged failure, and
 * startup continues.
 *
 * @param options - published CLI directory, logger, and test seam.
 * @returns whether the daemon is running, plus a reason when it is not.
 */
export function startDesktopGitAiDaemon(options: DesktopGitAiDaemonOptions): DesktopGitAiDaemonResult {
  if (options.gitAiPathDir === undefined) {
    return { started: false, failure: 'git-ai CLI runtime unavailable; skipped starting its daemon' }
  }
  const executable = join(options.gitAiPathDir, process.platform === 'win32' ? 'git-ai.exe' : 'git-ai')
  const run = options.run ?? defaultDaemonRunner

  try {
    // `bg start` is idempotent and returns once the daemon is up, so it is safe
    // to call on every launch rather than tracking a first-run flag.
    const result = run(executable, ['bg', 'start'])
    if (result.status !== 0) {
      const detail = (result.stderr.trim() || result.stdout.trim() || `exit ${String(result.status)}`)
      return { started: false, failure: `git-ai daemon did not start: ${detail}` }
    }
    options.logger.info(`git-ai daemon running (${executable})`)
    return { started: true }
  } catch (cause) {
    return {
      started: false,
      failure: `git-ai daemon did not start: ${cause instanceof Error ? cause.message : String(cause)}`,
    }
  }
}

function defaultDaemonRunner(
  command: string,
  args: readonly string[],
): { status: number | null, stdout: string, stderr: string } {
  const result = spawnSync(command, [...args], { encoding: 'utf8', timeout: DAEMON_START_TIMEOUT_MS })
  if (result.error !== undefined) throw result.error
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/**
 * Build the logger that mirrors one run into the DSH log and a git-ai log file.
 *
 * The file copy exists because this module's only user-visible effect is a
 * change to the user's own `~/.gitconfig`, and a DSH log rotates away. An
 * unwritable log file must not fail the configuration itself, so write errors
 * are swallowed: the DSH log still carries the summary.
 *
 * @param homeDir - user home directory owning the git-ai state directory.
 * @param forward - Optional sink receiving the same line, normally the Electron log.
 * @returns a logger suitable for every function in this module.
 */
export function desktopGitAiLogger(
  homeDir: string,
  forward?: (message: string) => void,
): DesktopGitAiConfigLogger {
  const logPath = join(homeDir, '.git-ai', 'dsh-desktop.log')
  const append = (level: string, message: string): void => {
    const line = `${new Date().toISOString()} [${level}] ${message}\n`
    forward?.(message)
    try {
      mkdirSync(dirname(logPath), { recursive: true })
      appendFileSync(logPath, line)
    } catch {
      // A log that cannot be written must never affect attribution.
    }
  }
  return {
    info: message => { append('info', message) },
    error: message => { append('error', message) },
  }
}
