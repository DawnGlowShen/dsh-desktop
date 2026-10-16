/**
 * Point Git's Trace2 events at the git-ai daemon.
 *
 * ## Why `git config` rather than editing the file
 *
 * This module used to parse `~/.gitconfig` itself and rewrite it. That meant owning a
 * parser for a format Git defines, and it produced a failure that destroyed data: reading
 * a file the user kept encrypted does not throw, because `readFileSync(path, 'utf8')`
 * substitutes U+FFFD for every undecodable byte, so the ciphertext looked like a
 * configuration file that merely needed editing. Writing it back replaced the file with
 * mojibake.
 *
 * `git config` has none of that surface. Git parses its own format, and when the file is
 * not one — ciphertext, binary, a repository's own config — it refuses and says so. Modern
 * Git also rewrites only what changed, so the user's comments, indentation and blank lines
 * survive; the earlier assumption that it normalises the whole file is no longer true and
 * was measured before this rewrite.
 *
 * The cost is that a pre-existing `trace2.eventTarget` is replaced rather than commented
 * out. That key belongs to git-ai: a user can only have set it for another installation,
 * and leaving theirs active alongside ours would point Git at a socket that is not the
 * daemon whose events this profile needs.
 *
 * ## Why not an environment variable
 *
 * `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` would cover every process DSH
 * launches, but a user typing `git commit` in their own terminal would bypass them and
 * lose attribution. The global file covers both.
 *
 * ## Windows uses a named pipe, not an AF_UNIX socket
 *
 * Git's `trace2.eventTarget` names a transport, and the correct value is
 * platform-specific. On Unix git-ai listens on a filesystem socket and the value carries
 * the `af_unix:stream:` scheme. Windows has no AF_UNIX support in this code path, so git-ai
 * listens on a named pipe and `DaemonConfig::trace2_event_target_for_path` returns the
 * **bare path with no scheme at all**:
 *
 *   Unix:    af_unix:stream:<home>/.git-ai/internal/daemon/trace2.sock
 *   Windows: \\.\pipe\git-ai-<sha256(internal_dir)[:16]>-trace2
 *
 * Writing the Unix form on Windows is not a crash — Git degrades to emitting Trace2 events
 * on stderr when the target cannot be opened, so every command still exits 0 — but no
 * event ever reaches the daemon and attribution is lost silently, which is exactly the
 * failure this module exists to prevent.
 *
 * Escaping is no longer this module's concern: `git config` receives the value as an
 * argument and writes whatever escapes the format requires.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { ConfigureContext, ConfigureOutcome, PayloadConfiguration } from './offline-install-configure.ts'

/** Section the managed keys live in. */
const TRACE2_SECTION = 'trace2'

/** Key naming the transport Git should emit Trace2 events to. */
const EVENT_TARGET_KEY = 'eventTarget'

/** Key naming the nesting depth Git should use while emitting. */
const EVENT_NESTING_KEY = 'eventNesting'

/**
 * Nesting depth Git should use while emitting Trace2 events.
 *
 * `0` keeps child-process events flat, which is what the daemon consumes; the measured
 * baseline the plugin was verified against.
 */
const EVENT_NESTING_VALUE = '0'

/**
 * Upper bound on one `git config` invocation.
 *
 * `git config` on a local file does no network work, so this only bounds a pathological
 * case — an enormous config, or a filesystem that has stopped responding.
 */
const GIT_CONFIG_TIMEOUT_MS = 15_000

/** Socket path, relative to the home directory, that the git-ai daemon listens on. */
const SOCKET_RELATIVE_PATH = join('.git-ai', 'internal', 'daemon', 'trace2.sock')

/**
 * Windows named-pipe name prefix, matching git-ai's `DaemonConfig`.
 *
 * The daemon derives both pipe names from its internal directory, so the hash below must
 * be fed the byte-for-byte same string git-ai hashes or the two sides will never meet.
 */
const WINDOWS_PIPE_PREFIX = '\\\\.\\pipe\\git-ai-'

/** Bytes of the SHA-256 hex digest git-ai keeps when naming the pipe. */
const WINDOWS_PIPE_HASH_LENGTH = 16

/**
 * The internal directory git-ai hashes, spelled with Windows separators.
 *
 * Held as a literal rather than built via `join` so the bytes hashed are the same on every
 * host that computes them.
 */
const WINDOWS_INTERNAL_DIRECTORY = '.git-ai\\internal'

/**
 * Environment keys that would redirect `git config` away from the file being configured.
 *
 * An inherited `GIT_CONFIG_GLOBAL` points `--global` at a different file, so the module
 * could report "already current" about a file it never touched — or write one the user
 * never reads. Removed from the child environment rather than worked around.
 */
const GIT_CONFIG_ENVIRONMENT_KEYS = [
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_CONFIG_COUNT',
] as const

/** Minimal logging surface, satisfied by the Electron logger used at startup. */
export interface DesktopGitAiConfigLogger {
  /** Record an informational summary of what this run changed. */
  info(message: string): void
  /** Record a failure; the caller keeps startup alive regardless. */
  error(message: string): void
}

/** What one run did, so the caller can log and test the decision. */
export interface DesktopGitAiConfigResult {
  /** The gitconfig that was inspected. */
  gitConfigPath: string
  /** Trace2 event target written for this user. */
  eventTarget: string
  /** True when this run set a key to a value it did not already have. */
  changed: boolean
  /**
   * Why Git refused to write, when it did.
   *
   * Absent from every other result, so a caller can tell "nothing needed doing" apart from
   * "the file was not touched on purpose". Git refusing is the normal outcome for a
   * gitconfig it cannot parse, such as one the user keeps encrypted.
   */
  refused?: string
}

/** One Git invocation, injectable so tests never need the executable. */
export interface DesktopGitAiGitRunner {
  /**
   * Run Git, returning its exit status and captured output.
   *
   * @param args - Arguments after the executable name.
   * @returns what the process did; `status` is null when it could not be started.
   */
  run(args: readonly string[]): {
    status: number | null
    stdout: string
    stderr: string
    error?: Error
  }
}

/** Inputs required to configure Trace2 attribution. */
export interface DesktopGitAiConfigOptions {
  /** User home directory; owns both the gitconfig and the daemon socket path. */
  homeDir: string
  /** Gitconfig to edit; normally `~/.gitconfig`. */
  gitConfigPath: string
  /** Logger receiving a one-line summary of every run. */
  logger: DesktopGitAiConfigLogger
  /** Test seam for running Git. */
  git?: DesktopGitAiGitRunner
  /**
   * Host platform selecting the Trace2 transport.
   *
   * Defaults to the running platform; a test pins `'win32'` to assert the named-pipe
   * spelling from a Unix host.
   */
  platform?: NodeJS.Platform
}

/**
 * Set one global key, or report why Git would not.
 *
 * `--replace-all` rather than `--add`: a duplicate key later in the file wins in Git's
 * precedence order, so adding would let a stale `[trace2]` section keep overriding the
 * value this module needs — the silent loss of attribution it exists to prevent.
 *
 * `--file` rather than `--global`: the target is then explicit, and the result cannot
 * depend on which home Git would have inferred.
 *
 * @param runner - Git invocation seam.
 * @param gitConfigPath - The file to write.
 * @param key - Dotted `section.key`.
 * @param value - Value to set.
 * @returns the failure message, or undefined on success.
 */
function setKey(
  runner: DesktopGitAiGitRunner,
  gitConfigPath: string,
  key: string,
  value: string,
): string | undefined {
  const result = runner.run(['config', '--file', gitConfigPath, '--replace-all', `${TRACE2_SECTION}.${key}`, value])
  if (result.error !== undefined) return result.error.message
  if (result.status === 0) return undefined
  const detail = (result.stderr.trim() || result.stdout.trim()).split('\n')[0] ?? ''
  return detail === '' ? `git config exited with ${String(result.status)}` : detail
}

/**
 * Read one global key, or undefined when Git could not report it.
 *
 * Separated from the write because the result distinguishes "already correct" from "this
 * run set it", which is what the startup log reports.
 *
 * @param runner - Git invocation seam.
 * @param gitConfigPath - The file to read.
 * @param key - Dotted `section.key`.
 * @returns the current value, or undefined when unset or unreadable.
 */
function readKey(
  runner: DesktopGitAiGitRunner,
  gitConfigPath: string,
  key: string,
): string | undefined {
  const result = runner.run(['config', '--file', gitConfigPath, '--get', `${TRACE2_SECTION}.${key}`])
  // Exit 1 is "not set", which is an answer rather than a failure; anything else means Git
  // could not read the file, and the write below reports that properly.
  if (result.status !== 0) return undefined
  return result.stdout.replace(/\r?\n$/u, '')
}

/**
 * The git-ai Trace2 event target for a home directory.
 *
 * @param homeDir - User home directory, which owns the daemon's socket.
 * @param platform - Host platform selecting the transport.
 * @returns a value suitable for `trace2.eventTarget`.
 */
export function gitAiTrace2EventTarget(homeDir: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    // The daemon names its pipe after a hash of its internal directory, and the spelling
    // it hashes is the Windows one regardless of the host computing it.
    const digest = createHash('sha256').update(WINDOWS_INTERNAL_DIRECTORY).digest('hex')
    return `${WINDOWS_PIPE_PREFIX}${digest.slice(0, WINDOWS_PIPE_HASH_LENGTH)}-trace2`
  }
  return `af_unix:stream:${join(homeDir, SOCKET_RELATIVE_PATH)}`
}

/**
 * Configure the global gitconfig so git-ai can attribute this user's edits.
 *
 * Never throws for a missing gitconfig, which Git creates, and never removes a key the
 * user set elsewhere — `[trace2] eventTarget` is git-ai's own, and replacing whichever
 * value was there is the point.
 *
 * @param options - home directory, gitconfig path, logger, and test seams.
 * @returns what this run changed, for logging and assertions.
 */
export function ensureDesktopGitAiTrace2Config(
  options: DesktopGitAiConfigOptions,
): DesktopGitAiConfigResult {
  const runner = options.git ?? defaultGitRunner()
  const eventTarget = gitAiTrace2EventTarget(options.homeDir, options.platform ?? process.platform)

  // Decided per key, because the two can drift independently: a gitconfig carrying the right
  // target but a different depth was written by something else, and leaving that depth would
  // change what the daemon reads.
  const targetCurrent = readKey(runner, options.gitConfigPath, EVENT_TARGET_KEY) === eventTarget
  const nestingCurrent = readKey(runner, options.gitConfigPath, EVENT_NESTING_KEY) === EVENT_NESTING_VALUE

  // Neither key needs changing, so nothing is written at all. Skipping the write is not an
  // optimisation: `git config` rewrites the file through a rename even when the value is
  // identical, so writing unconditionally would bump the mtime on every launch and leave the
  // "already current" line in the log describing a file that was in fact touched.
  if (targetCurrent && nestingCurrent) {
    const unchanged: DesktopGitAiConfigResult = {
      gitConfigPath: options.gitConfigPath,
      eventTarget,
      changed: false,
    }
    options.logger.info(describeRun(unchanged))
    return unchanged
  }

  // Only the key that differs is written, so a single drifted value cannot rewrite the other.
  const failure = (targetCurrent ? undefined : setKey(runner, options.gitConfigPath, EVENT_TARGET_KEY, eventTarget))
    ?? (nestingCurrent ? undefined : setKey(runner, options.gitConfigPath, EVENT_NESTING_KEY, EVENT_NESTING_VALUE))

  if (failure !== undefined) {
    // Git refusing is the expected outcome for a file it cannot parse, so the message it
    // printed is carried through verbatim: it names the file and the line, which is what
    // makes an encrypted or corrupted gitconfig diagnosable.
    const refused: DesktopGitAiConfigResult = {
      gitConfigPath: options.gitConfigPath,
      eventTarget,
      changed: false,
      refused: failure,
    }
    options.logger.info(describeRun(refused))
    return refused
  }

  const result: DesktopGitAiConfigResult = {
    gitConfigPath: options.gitConfigPath,
    eventTarget,
    changed: true,
  }
  options.logger.info(describeRun(result))
  return result
}

/**
 * Build the Git runner used outside tests.
 *
 * @returns a runner invoking the `git` on `PATH`.
 */
function defaultGitRunner(): DesktopGitAiGitRunner {
  const environment = { ...process.env }
  for (const key of GIT_CONFIG_ENVIRONMENT_KEYS) delete environment[key]
  return {
    run: (args) => {
      const result = spawnSync('git', [...args], {
        encoding: 'utf8',
        timeout: GIT_CONFIG_TIMEOUT_MS,
        windowsHide: true,
        env: environment,
      })
      return {
        status: result.status,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        ...(result.error === undefined ? {} : { error: result.error }),
      }
    },
  }
}

/** One-line summary of a run. */
function describeRun(result: DesktopGitAiConfigResult): string {
  // A refusal is stated as one: "already current" would read as "the file was examined and
  // found correct", which is the opposite of what happened.
  if (result.refused !== undefined) {
    return `git-ai trace2 configuration skipped: ${result.gitConfigPath} was left untouched because ${result.refused}`
  }
  if (!result.changed) {
    return `git-ai trace2 configuration already current in ${result.gitConfigPath}`
  }
  return `git-ai trace2 configuration written to ${result.gitConfigPath} (eventTarget=${result.eventTarget})`
}

/** Wrap a configure context's logger as the module's two-channel surface. */
function moduleLogger(context: ConfigureContext): DesktopGitAiConfigLogger {
  return {
    info: message => { context.logger.info?.(`${context.binName}: ${message}`) },
    error: message => { context.logger.error(`${context.binName}: ${message}`) },
  }
}

/**
 * Configure Trace2 attribution as the registry consumes it.
 *
 * @param context - Application facts, including the home owning both files.
 * @returns what this run did, in the executor's terms.
 */
export function configureGitAiTrace2(context: ConfigureContext): ConfigureOutcome {
  const name = GIT_AI_CONFIGURATION_NAME
  const gitConfigPath = join(context.userHomeDir, '.gitconfig')

  let result: DesktopGitAiConfigResult
  try {
    result = ensureDesktopGitAiTrace2Config({
      // `userHomeDir`, not `homeDir`: the socket path is derived from `$HOME`, because that
      // is what git-ai itself uses to decide where to listen — it reads the environment,
      // not a path this product passes it. The two coincide for a build whose DSH home is
      // `~`, which is why using the DSH home here went unnoticed; for one whose home is
      // `~/.dsh-beta` it produces a target naming a socket that never exists, and Git then
      // emits Trace2 events nowhere. The CLI path below still uses `homeDir`, because the
      // unpacked binary really does live under the DSH home.
      homeDir: context.userHomeDir,
      gitConfigPath,
      platform: context.platform,
      logger: moduleLogger(context),
    })
  } catch (cause) {
    // A gitconfig this product cannot write is reported, not thrown: the executor would
    // catch it anyway, and naming the file here is what makes the log actionable.
    return {
      name,
      action: 'failed',
      reason: `${gitConfigPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
    }
  }

  // A refusal leaves the gitconfig without a target, so starting the daemon would leave a
  // process listening on a socket nothing points at.
  if (result.refused !== undefined) {
    return { name, action: 'skipped', reason: result.refused }
  }

  return { name, action: result.changed ? 'configured' : 'current' }
}

/** Registry name of the git-ai configuration. */
export const GIT_AI_CONFIGURATION_NAME = 'git-ai'

/**
 * The git-ai configuration as the registry consumes it.
 *
 * `converge`, not `seed`: the socket path can move between launches — a home directory
 * restored from a backup, or a different user — and a configuration that wrote once and
 * never again would leave Git pointing at a socket that no longer exists, which fails
 * silently in exactly the way this module exists to prevent.
 */
export const gitAiTrace2Configuration: PayloadConfiguration = {
  name: GIT_AI_CONFIGURATION_NAME,
  mode: 'converge',
  apply: configureGitAiTrace2,
}
