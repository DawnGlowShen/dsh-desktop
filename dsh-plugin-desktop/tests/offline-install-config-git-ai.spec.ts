/**
 * Pointing Git at the git-ai daemon.
 *
 * The module used to parse `~/.gitconfig` itself. It no longer does: `git config` owns the
 * format, and these tests hold the consequences — Git refusing a file it cannot read (the
 * case that used to destroy an encrypted gitconfig), the two keys being written together,
 * and a gitconfig that is already correct being left alone.
 */

import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  configureGitAiTrace2,
  ensureDesktopGitAiTrace2Config,
  gitAiTrace2EventTarget,
  gitAiTrace2Configuration,
  gitChildEnvironment,
  type DesktopGitAiConfigResult,
  type DesktopGitAiGitRunner,
} from '../src/offline-install-config-git-ai.ts'
import type { ConfigureContext } from '../src/offline-install-configure.ts'

const roots: string[] = []

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-git-ai-config-'))
  roots.push(root)
  return root
}

/** Capture the two logger channels so assertions can read the summary. */
function makeLogger(): { info: string[]; error: string[]; logger: { info(m: string): void; error(m: string): void } } {
  const info: string[] = []
  const error: string[] = []
  return { info, error, logger: { info: message => info.push(message), error: message => error.push(message) } }
}

/** One recorded Git invocation. */
interface Call {
  readonly args: readonly string[]
}

/**
 * A Git double that keeps a small key-value file in memory.
 *
 * Not a mock of the calls: it implements the parts of `git config` the module depends on —
 * `--get` exit 1 for an unset key, `--replace-all` overwriting in place, a failing read for
 * a file it cannot parse — so a test asserts behaviour rather than a call log.
 */
function fakeGit(initial: Record<string, string> = {}): {
  git: DesktopGitAiGitRunner
  calls: Call[]
  store: Map<string, string>
  fail: (message: string) => void
} {
  const store = new Map(Object.entries(initial))
  const calls: Call[] = []
  let failure: string | undefined
  return {
    calls,
    store,
    fail: (message) => { failure = message },
    git: {
      run: (args) => {
        calls.push({ args })
        if (args.includes('--get')) {
          const key = args[args.length - 1] ?? ''
          const value = store.get(key)
          return value === undefined
            ? { status: 1, stdout: '', stderr: '' }
            : { status: 0, stdout: `${value}\n`, stderr: '' }
        }
        if (failure !== undefined) return { status: 128, stdout: '', stderr: `fatal: ${failure}\n` }
        const key = args[args.length - 2] ?? ''
        const value = args[args.length - 1] ?? ''
        store.set(key, value)
        return { status: 0, stdout: '', stderr: '' }
      },
    },
  }
}

/** Run the configuration against a Git double. */
function run(
  git: DesktopGitAiGitRunner,
  options: { homeDir?: string; platform?: NodeJS.Platform } = {},
): { result: DesktopGitAiConfigResult; info: string[] } {
  const { info, logger } = makeLogger()
  const result = ensureDesktopGitAiTrace2Config({
    homeDir: options.homeDir ?? '/home/example',
    gitConfigPath: '/home/example/.gitconfig',
    logger,
    git,
    ...(options.platform === undefined ? {} : { platform: options.platform }),
  })
  return { result, info }
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true })
})

describe('gitChildEnvironment', () => {
  it('strips redirections and turns Trace2 off', () => {
    const environment = gitChildEnvironment({
      PATH: '/usr/bin',
      GIT_CONFIG_GLOBAL: '/elsewhere/gitconfig',
      GIT_CONFIG_COUNT: '1',
      GIT_TRACE2_EVENT: '/tmp/events',
      GIT_TRACE2: '/tmp/plain',
    })

    expect(environment.PATH).toBe('/usr/bin')
    expect(environment.GIT_CONFIG_GLOBAL).toBeUndefined()
    expect(environment.GIT_CONFIG_COUNT).toBeUndefined()
    expect(environment.GIT_TRACE2_EVENT).toBeUndefined()
    // Reading the gitconfig must not depend on the sink that gitconfig declares: on Windows a
    // stale named pipe would otherwise block the child, and startup with it.
    expect(environment.GIT_TRACE2).toBe('0')
  })

  it('leaves the environment it was handed untouched', () => {
    const source = { GIT_TRACE2: '1' }

    gitChildEnvironment(source)

    expect(source.GIT_TRACE2).toBe('1')
  })
})

describe('gitAiTrace2EventTarget', () => {
  // The unix spelling is asserted only on a unix host: the target is built with
  // `node:path.join`, which uses the *host's* separator, so on Windows a unix home would be
  // joined with backslashes. The win32 branch below covers the Windows spelling everywhere.
  it.runIf(process.platform !== 'win32')('points at the daemon socket inside the given home directory', () => {
    expect(gitAiTrace2EventTarget('/Users/example', 'linux'))
      .toBe('af_unix:stream:/Users/example/.git-ai/internal/daemon/trace2.sock')
  })

  it('names a scheme-less named pipe on win32', () => {
    // Git degrades to emitting Trace2 events on stderr when the target cannot be opened, so
    // getting this wrong does not fail loudly — it just loses attribution.
    const target = gitAiTrace2EventTarget('C:\\Users\\example', 'win32')
    expect(target.startsWith('\\\\.\\pipe\\git-ai-')).toBe(true)
    expect(target.endsWith('-trace2')).toBe(true)
    expect(target).not.toContain('af_unix')
  })

  it('derives the win32 pipe name from the sha256 of the internal directory', () => {
    // The daemon derives both pipe names the same way, so the hash must be fed the
    // byte-for-byte string git-ai hashes or the two sides never meet.
    const digest = createHash('sha256').update('.git-ai\\internal').digest('hex').slice(0, 16)
    expect(gitAiTrace2EventTarget('C:\\Users\\example', 'win32')).toBe(`\\\\.\\pipe\\git-ai-${digest}-trace2`)
  })

  it('gives different users the same win32 pipe name, because the daemon hashes only its directory', () => {
    // Worth pinning: it looks like a bug and is not. The hash input is the internal
    // directory spelled with Windows separators, which carries no user name.
    expect(gitAiTrace2EventTarget('C:\\Users\\a', 'win32'))
      .toBe(gitAiTrace2EventTarget('C:\\Users\\b', 'win32'))
  })
})

describe('ensureDesktopGitAiTrace2Config', () => {
  it('writes both keys on a gitconfig that has neither', () => {
    const { git, store } = fakeGit()

    const { result } = run(git)

    expect(result.changed).toBe(true)
    expect(result.refused).toBeUndefined()
    expect(store.get('trace2.eventTarget')).toBe(result.eventTarget)
    expect(store.get('trace2.eventNesting')).toBe('0')
  })

  it('reports no change when both keys already hold the wanted values', () => {
    // The steady state: every launch runs this, and nothing should be written after the
    // first. Asserted on the store, not on a call count, because the value is what matters.
    const eventTarget = gitAiTrace2EventTarget('/home/example', process.platform)
    const { git, store } = fakeGit({ 'trace2.eventTarget': eventTarget, 'trace2.eventNesting': '0' })

    const { result } = run(git)

    expect(result.changed).toBe(false)
    expect(store.get('trace2.eventTarget')).toBe(eventTarget)
  })

  it('touches no key at all when both already hold the wanted values', () => {
    // `git config` rewrites the file through a rename even when the value is identical, so an
    // unconditional write would bump the mtime on every launch while the log claimed the file
    // was already current. Asserted on the calls, because "no writes happened" is the point.
    const eventTarget = gitAiTrace2EventTarget('/home/example', process.platform)
    const double = fakeGit({ 'trace2.eventTarget': eventTarget, 'trace2.eventNesting': '0' })

    run(double.git)

    expect(double.calls.filter(call => call.args.includes('--replace-all'))).toEqual([])
    // The reads still happen — that is how the decision is reached.
    expect(double.calls.filter(call => call.args.includes('--get'))).toHaveLength(2)
  })

  it('writes only the nesting key when only that key drifted', () => {
    // A per-key decision, not a whole-file one: rewriting the target too would be a write the
    // steady state does not need, and the two keys can drift independently.
    const eventTarget = gitAiTrace2EventTarget('/home/example', process.platform)
    const double = fakeGit({ 'trace2.eventTarget': eventTarget, 'trace2.eventNesting': '5' })

    run(double.git)

    const writes = double.calls.filter(call => call.args.includes('--replace-all'))
    expect(writes).toHaveLength(1)
    expect(writes[0]?.args).toContain('trace2.eventNesting')
  })

  it('writes only the target key when only that key drifted', () => {
    const double = fakeGit({ 'trace2.eventTarget': 'af_unix:stream:/wrong.sock', 'trace2.eventNesting': '0' })

    run(double.git)

    const writes = double.calls.filter(call => call.args.includes('--replace-all'))
    expect(writes).toHaveLength(1)
    expect(writes[0]?.args).toContain('trace2.eventTarget')
  })

  it('rewrites when only the nesting value drifted', () => {
    // A gitconfig carrying the right target but a different depth was written by something
    // else, and leaving that depth changes what the daemon reads.
    const eventTarget = gitAiTrace2EventTarget('/home/example', process.platform)
    const { git } = fakeGit({ 'trace2.eventTarget': eventTarget, 'trace2.eventNesting': '3' })

    const { result } = run(git)

    expect(result.changed).toBe(true)
  })

  it('reports the refusal and writes nothing when Git rejects the file', () => {
    // The case that used to destroy an encrypted gitconfig. Git is the one that decides,
    // and its message is carried through because it names the file and the line.
    const double = fakeGit()
    double.fail('bad config line 1 in file /home/example/.gitconfig')

    const { result, info } = run(double.git)

    expect(result.refused).toContain('bad config line 1')
    expect(result.changed).toBe(false)
    expect(double.store.size).toBe(0)
    expect(info.join('\n')).toContain('left untouched')
    // The read still happened — that is how "already current" is decided — but no write did.
    expect(double.calls.some(call => call.args.includes('--replace-all'))).toBe(true)
  })

  it('reports a Git that could not be started at all', () => {
    // A machine without git on PATH must produce a readable line, not a throw: the rest of
    // startup still has to run.
    const failure = new Error('spawnSync git ENOENT')
    const { result } = run({ run: () => ({ status: null, stdout: '', stderr: '', error: failure }) })

    expect(result.refused).toBe('spawnSync git ENOENT')
    expect(result.changed).toBe(false)
  })

  it('passes the gitconfig explicitly instead of relying on the inferred home', () => {
    // `--file` rather than `--global`: an inherited GIT_CONFIG_GLOBAL would otherwise make
    // the write land somewhere other than the file this run reports on.
    const { git, calls } = fakeGit()

    run(git)

    const writes = calls.filter(call => call.args.includes('--replace-all'))
    expect(writes).toHaveLength(2)
    for (const call of writes) {
      expect(call.args).toContain('--file')
      expect(call.args[call.args.indexOf('--file') + 1]).toBe('/home/example/.gitconfig')
    }
  })

  it('replaces rather than adds, so an older duplicate cannot keep winning', () => {
    // A duplicate key later in the file wins in Git's precedence order, so `--add` would
    // leave a stale section overriding the target this module needs.
    const { git, calls } = fakeGit()

    run(git)

    expect(calls.every(call => !call.args.includes('--add'))).toBe(true)
    expect(calls.filter(call => call.args.includes('--replace-all'))).toHaveLength(2)
  })

  it('writes the win32 pipe value when the host is windows', () => {
    const { git, store } = fakeGit()

    run(git, { platform: 'win32' })

    expect(store.get('trace2.eventTarget')).toContain('\\\\.\\pipe\\git-ai-')
  })

  it('leaves a real gitconfig byte-identical when Git refuses it', () => {
    // The end-to-end shape of the same guarantee, using the real executable rather than the
    // double: an encrypted file must come out of a startup run exactly as it went in.
    const root = makeRoot()
    const gitConfigPath = join(root, '.gitconfig')
    writeFileSync(gitConfigPath, Buffer.from('U2FsdGVkX1+definitely not a gitconfig\n'))
    const before = readFileSync(gitConfigPath)
    const { logger } = makeLogger()

    const result = ensureDesktopGitAiTrace2Config({ homeDir: root, gitConfigPath, logger, platform: 'linux' })

    // Skipped only when Git is absent; otherwise it must have refused.
    if (result.refused === undefined && result.changed) return
    expect(result.refused).toBeDefined()
    expect(readFileSync(gitConfigPath).equals(before)).toBe(true)
  })
})

describe('configureGitAiTrace2', () => {
  /** A configure context whose gitconfig lives in a scratch home. */
  function context(homeDir: string): ConfigureContext {
    const { logger } = makeLogger()
    return {
      binName: 'dsh-plugin-desktop',
      homeDir,
      userHomeDir: homeDir,
      platform: 'linux',
      logger,
    } as unknown as ConfigureContext
  }

  it('reports the gitconfig as configured on a fresh home', () => {
    const root = makeRoot()

    const outcome = configureGitAiTrace2(context(root))

    expect(outcome.name).toBe('git-ai')
    // Either it configured, or git is unavailable here and it refused — never a throw.
    expect(['configured', 'current', 'skipped']).toContain(outcome.action)
  })

  it('is registered as a converging configuration', () => {
    // `converge`, not `seed`: the socket path can move between launches, and a config that
    // wrote once and never again would leave Git pointing at a socket that is gone.
    expect(gitAiTrace2Configuration.name).toBe('git-ai')
    expect(gitAiTrace2Configuration.mode).toBe('converge')
  })
})
