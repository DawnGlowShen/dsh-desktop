import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  GIT_AI_CONFIG_MARKER_BEGIN,
  GIT_AI_CONFIG_MARKER_END,
  OWNED_COMMENT_PREFIX,
  applyGitAiTrace2Config,
  ensureDesktopGitAiTrace2Config,
  gitAiTrace2EventTarget,
} from '../src/desktop-git-ai-config.ts'

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

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true })
})

describe('gitAiTrace2EventTarget', () => {
  it('points at the daemon socket inside the given home directory', () => {
    expect(gitAiTrace2EventTarget('/Users/example'))
      .toBe('af_unix:stream:/Users/example/.git-ai/internal/daemon/trace2.sock')
  })
})

describe('applyGitAiTrace2Config', () => {
  const target = 'af_unix:stream:/home/u/.git-ai/internal/daemon/trace2.sock'

  it('appends the managed block to an empty file', () => {
    const result = applyGitAiTrace2Config('', target)

    expect(result.changed).toBe(true)
    expect(result.commentedUserValues).toEqual([])
    expect(result.replacedExistingBlock).toBe(false)
    expect(result.contents).toBe([
      '',
      GIT_AI_CONFIG_MARKER_BEGIN,
      '[trace2]',
      '\teventNesting = 0',
      `\teventTarget = ${target}`,
      GIT_AI_CONFIG_MARKER_END,
      '',
    ].join('\n'))
  })

  it('preserves unrelated user configuration byte for byte', () => {
    const original = [
      '[core]',
      '\tautocrlf = input',
      '[user]',
      '\tname = jimmy',
      '',
    ].join('\n')

    const result = applyGitAiTrace2Config(original, target)

    expect(result.contents.startsWith('[core]\n\tautocrlf = input\n[user]\n\tname = jimmy\n')).toBe(true)
    expect(result.contents).toContain(GIT_AI_CONFIG_MARKER_BEGIN)
  })

  it('comments a previous user eventTarget without deleting it', () => {
    const original = ['[trace2]', '\teventTarget = af_unix:stream:/user/own.sock', ''].join('\n')

    const result = applyGitAiTrace2Config(original, target)

    expect(result.commentedUserValues).toEqual(['trace2.eventTarget'])
    expect(result.contents).toContain(`${OWNED_COMMENT_PREFIX} eventTarget = af_unix:stream:/user/own.sock`)
    // The user's value stays readable, so it can be restored by hand.
    expect(result.contents).toContain('/user/own.sock')
  })

  it('comments a previous user eventNesting as well', () => {
    const original = ['[trace2]', '\teventNesting = 2', ''].join('\n')

    const result = applyGitAiTrace2Config(original, target)

    expect(result.commentedUserValues).toEqual(['trace2.eventNesting'])
    expect(result.contents).toContain(`${OWNED_COMMENT_PREFIX} eventNesting = 2`)
  })

  it('leaves trace2 values in other sections alone', () => {
    const original = ['[trace2 "child"]', '\teventTarget = /elsewhere.sock', ''].join('\n')

    const result = applyGitAiTrace2Config(original, target)

    expect(result.commentedUserValues).toEqual([])
    expect(result.contents).toContain('\teventTarget = /elsewhere.sock')
  })

  it('converges when run twice, never nesting the comment prefix', () => {
    const original = ['[trace2]', '\teventTarget = /user.sock', ''].join('\n')

    const once = applyGitAiTrace2Config(original, target)
    const twice = applyGitAiTrace2Config(once.contents, target)

    expect(twice.changed).toBe(false)
    expect(twice.contents).toBe(once.contents)
    expect(twice.commentedUserValues).toEqual([])
    expect(twice.replacedExistingBlock).toBe(true)
    // Exactly one occurrence: a nested prefix would double it.
    expect(twice.contents.split(OWNED_COMMENT_PREFIX)).toHaveLength(2)
  })

  it('replaces a stale block instead of appending a second one', () => {
    const stale = applyGitAiTrace2Config('', 'af_unix:stream:/old.sock').contents

    const result = applyGitAiTrace2Config(stale, target)

    expect(result.replacedExistingBlock).toBe(true)
    expect(result.contents.split(GIT_AI_CONFIG_MARKER_BEGIN)).toHaveLength(2)
    expect(result.contents).not.toContain('/old.sock')
    expect(result.contents).toContain(target)
  })

  it('recognizes user values written without spaces around the separator', () => {
    const original = ['[trace2]', '\teventTarget=/user.sock', ''].join('\n')

    const result = applyGitAiTrace2Config(original, target)

    expect(result.commentedUserValues).toEqual(['trace2.eventTarget'])
  })

  it('matches section and key names case-insensitively', () => {
    const original = ['[Trace2]', '\tEventTarget = /user.sock', ''].join('\n')

    const result = applyGitAiTrace2Config(original, target)

    expect(result.commentedUserValues).toEqual(['trace2.eventTarget'])
  })

  it('deduplicates a key repeated inside one section', () => {
    const original = ['[trace2]', '\teventTarget = /a.sock', '\teventTarget = /b.sock', ''].join('\n')

    const result = applyGitAiTrace2Config(original, target)

    expect(result.commentedUserValues).toEqual(['trace2.eventTarget'])
    expect(result.contents.split(OWNED_COMMENT_PREFIX)).toHaveLength(3)
  })

  it('writes the block last so it wins duplicate-key precedence', () => {
    const original = ['[trace2]', '\teventTarget = /user.sock', '[push]', '\tautoSetupRemote = true', ''].join('\n')

    const result = applyGitAiTrace2Config(original, target)

    expect(result.contents.indexOf(`\teventTarget = ${target}`))
      .toBeGreaterThan(result.contents.indexOf(`${OWNED_COMMENT_PREFIX} eventTarget = /user.sock`))
    expect(result.contents.indexOf(GIT_AI_CONFIG_MARKER_BEGIN))
      .toBeGreaterThan(result.contents.indexOf('[push]'))
  })

  it('handles input without a trailing newline', () => {
    const result = applyGitAiTrace2Config('[core]\n\tautocrlf = input', target)

    expect(result.contents).toContain('[core]\n\tautocrlf = input\n')
    expect(result.contents.endsWith(`${GIT_AI_CONFIG_MARKER_END}\n`)).toBe(true)
  })

  it('reports no change when the block already matches', () => {
    const settled = applyGitAiTrace2Config('', target).contents

    expect(applyGitAiTrace2Config(settled, target).changed).toBe(false)
  })
})

describe('ensureDesktopGitAiTrace2Config', () => {
  it('creates the gitconfig when the user has none', () => {
    const root = makeRoot()
    const gitConfigPath = join(root, '.gitconfig')
    const { info, logger } = makeLogger()

    const result = ensureDesktopGitAiTrace2Config({ homeDir: root, gitConfigPath, logger })

    expect(result.changed).toBe(true)
    expect(existsSync(gitConfigPath)).toBe(true)
    expect(readFileSync(gitConfigPath, 'utf8')).toContain(
      `af_unix:stream:${join(root, '.git-ai', 'internal', 'daemon', 'trace2.sock')}`,
    )
    expect(info).toHaveLength(1)
  })

  it('names the disabled user values in the log summary', () => {
    const root = makeRoot()
    const gitConfigPath = join(root, '.gitconfig')
    writeFileSync(gitConfigPath, '[trace2]\n\teventTarget = /user.sock\n', 'utf8')
    const { info, logger } = makeLogger()

    ensureDesktopGitAiTrace2Config({ homeDir: root, gitConfigPath, logger })

    expect(info).toHaveLength(1)
    expect(info[0]).toContain('trace2.eventTarget')
    expect(info[0]).toContain(gitConfigPath)
  })

  it('logs the unchanged case without claiming a change', () => {
    const root = makeRoot()
    const gitConfigPath = join(root, '.gitconfig')
    const { info, logger } = makeLogger()
    ensureDesktopGitAiTrace2Config({ homeDir: root, gitConfigPath, logger })
    info.length = 0

    ensureDesktopGitAiTrace2Config({ homeDir: root, gitConfigPath, logger })

    expect(info).toHaveLength(1)
    expect(info[0]).toContain('already current')
  })

  it('creates the parent directory when it is missing', () => {
    const root = makeRoot()
    const gitConfigPath = join(root, 'nested', 'deeper', '.gitconfig')
    const { logger } = makeLogger()

    ensureDesktopGitAiTrace2Config({ homeDir: root, gitConfigPath, logger })

    expect(existsSync(gitConfigPath)).toBe(true)
  })

  it('keeps an existing gitconfig and only appends the block', () => {
    const root = makeRoot()
    const gitConfigPath = join(root, '.gitconfig')
    const original = '[user]\n\tname = jimmy\n'
    writeFileSync(gitConfigPath, original, 'utf8')
    const { logger } = makeLogger()

    ensureDesktopGitAiTrace2Config({ homeDir: root, gitConfigPath, logger })

    expect(readFileSync(gitConfigPath, 'utf8').startsWith(original)).toBe(true)
  })

  it('reports the commented user values so the caller can log them', () => {
    const root = makeRoot()
    const gitConfigPath = join(root, '.gitconfig')
    writeFileSync(gitConfigPath, '[trace2]\n\teventTarget = /user.sock\n', 'utf8')
    const { logger } = makeLogger()

    const result = ensureDesktopGitAiTrace2Config({ homeDir: root, gitConfigPath, logger })

    expect(result.commentedUserValues).toEqual(['trace2.eventTarget'])
  })

  it('is idempotent across repeated startup runs', () => {
    const root = makeRoot()
    const gitConfigPath = join(root, '.gitconfig')
    const { logger } = makeLogger()

    const first = ensureDesktopGitAiTrace2Config({ homeDir: root, gitConfigPath, logger })
    const settled = readFileSync(gitConfigPath, 'utf8')
    const second = ensureDesktopGitAiTrace2Config({ homeDir: root, gitConfigPath, logger })

    expect(first.changed).toBe(true)
    expect(second.changed).toBe(false)
    expect(second.replacedExistingBlock).toBe(true)
    expect(readFileSync(gitConfigPath, 'utf8')).toBe(settled)
  })

  it('leaves no temporary file behind', () => {
    const root = makeRoot()
    const gitConfigPath = join(root, '.gitconfig')
    const { logger } = makeLogger()

    ensureDesktopGitAiTrace2Config({ homeDir: root, gitConfigPath, logger })

    expect(readdirSync(root).filter(name => name.includes('.tmp'))).toEqual([])
  })

  it('removes the temporary file when the rename fails', () => {
    const root = makeRoot()
    const gitConfigPath = join(root, '.gitconfig')
    const { logger } = makeLogger()
    const failure = new Error('rename refused')

    expect(() => ensureDesktopGitAiTrace2Config({
      homeDir: root,
      gitConfigPath,
      logger,
      fileSystem: {
        exists: () => false,
        read: () => '',
        write: (path, contents) => { writeFileSync(path, contents) },
        rename: () => { throw failure },
        remove: path => { rmSync(path, { force: true }) },
        mkdir: () => { /* the root already exists */ },
      },
    })).toThrow(failure)

    expect(readdirSync(root).filter(name => name.includes('.tmp'))).toEqual([])
    expect(existsSync(gitConfigPath)).toBe(false)
  })

  it('does not touch the file when it is already configured', () => {
    const root = makeRoot()
    const gitConfigPath = join(root, '.gitconfig')
    const { logger } = makeLogger()
    ensureDesktopGitAiTrace2Config({ homeDir: root, gitConfigPath, logger })
    const settled = readFileSync(gitConfigPath, 'utf8')
    const write = vi.fn()

    const result = ensureDesktopGitAiTrace2Config({
      homeDir: root,
      gitConfigPath,
      logger,
      fileSystem: {
        exists: () => true,
        read: () => settled,
        write,
        rename: () => { /* unreachable */ },
        remove: () => { /* unreachable */ },
        mkdir: () => { /* unreachable */ },
      },
    })

    expect(result.changed).toBe(false)
    expect(write).not.toHaveBeenCalled()
  })
})
