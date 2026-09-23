/**
 * The one-time invitation shown to a portable Windows copy.
 *
 * The registry is unreachable here and the platform is not Windows, so every
 * input is injected: that is exactly the property under test, because the
 * decision must not depend on the host the suite happens to run on.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DESKTOP_CLI_PROMPT_CANCEL_INDEX,
  DESKTOP_CLI_PROMPT_CONFIRM_INDEX,
  clearDesktopCliPromptState,
  desktopCliPromptConstants,
  desktopCliPromptCopy,
  desktopCliPromptRequired,
  desktopCliPromptStatePath,
  readDesktopCliPromptState,
  recordDesktopCliPromptOutcome,
  runDesktopCliPortablePrompt,
} from '../src/desktop-cli-prompt.ts'

const scratch: string[] = []

function userData(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cli-prompt-'))
  scratch.push(dir)
  return dir
}

afterEach(() => {
  while (scratch.length > 0) rmSync(scratch.pop()!, { recursive: true, force: true })
})

/** The published CLIs, as the prompt's caller supplies them. */
function harness(overrides: {
  userDataDir?: string
  installKind?: 'installed' | 'portable'
  detectThrows?: Error
  response?: number
  publishThrows?: Error
  platform?: NodeJS.Platform
  safeMode?: boolean
} = {}) {
  const userDataDir = overrides.userDataDir ?? userData()
  const publish = vi.fn(() => {
    if (overrides.publishThrows !== undefined) throw overrides.publishThrows
  })
  const confirm = vi.fn(async () => overrides.response ?? DESKTOP_CLI_PROMPT_CONFIRM_INDEX)
  const reportFailure = vi.fn(async () => {})
  const logError = vi.fn()
  const detectInstallKind = vi.fn(() => {
    if (overrides.detectThrows !== undefined) throw overrides.detectThrows
    return overrides.installKind ?? 'portable'
  })
  const run = () => runDesktopCliPortablePrompt({
    userDataDir,
    locale: 'zh',
    platform: overrides.platform ?? 'win32',
    safeMode: overrides.safeMode ?? false,
    detectInstallKind,
    confirm,
    publish,
    reportFailure,
    logError,
  })
  return { userDataDir, publish, confirm, reportFailure, logError, detectInstallKind, run }
}

describe('desktopCliPromptRequired', () => {
  it('asks a portable Windows copy that has not been asked', () => {
    expect(desktopCliPromptRequired({
      platform: 'win32',
      installKind: 'portable',
      state: undefined,
      safeMode: false,
    })).toBe(true)
  })

  it('stays silent when an installation record exists', () => {
    // The installer already wrote `Path`; inviting the user would be false.
    expect(desktopCliPromptRequired({
      platform: 'win32',
      installKind: 'installed',
      state: undefined,
      safeMode: false,
    })).toBe(false)
  })

  it('is silent off Windows, in Safe Mode, and once answered', () => {
    const base = { installKind: 'portable' as const, safeMode: false }
    expect(desktopCliPromptRequired({ ...base, platform: 'darwin', state: undefined })).toBe(false)
    expect(desktopCliPromptRequired({ ...base, platform: 'linux', state: undefined })).toBe(false)
    expect(desktopCliPromptRequired({
      ...base, platform: 'win32', safeMode: true, state: undefined,
    })).toBe(false)
    expect(desktopCliPromptRequired({
      platform: 'win32',
      installKind: 'portable',
      safeMode: false,
      state: { version: 1, outcome: 'declined', recordedAt: new Date().toISOString() },
    })).toBe(false)
  })
})

describe('prompt state', () => {
  it('round-trips an accepted answer under the user-data directory', async () => {
    const dir = userData()
    await recordDesktopCliPromptOutcome(dir, 'accepted', '2026-01-02T03:04:05.000Z')

    const path = desktopCliPromptStatePath(dir)
    expect(path.startsWith(dir)).toBe(true)
    expect(path).toContain(desktopCliPromptConstants.rootDirectory)
    expect(readDesktopCliPromptState(dir)).toEqual({
      version: 1,
      outcome: 'accepted',
      recordedAt: '2026-01-02T03:04:05.000Z',
    })
  })

  it('treats a missing marker as unanswered', () => {
    expect(readDesktopCliPromptState(userData())).toBeUndefined()
  })

  it('treats unreadable and malformed markers as unanswered', () => {
    const dir = userData()
    const path = desktopCliPromptStatePath(dir)

    // Corrupt content, a wrong version, an unknown outcome, and a non-timestamp
    // all have to fall back to asking rather than throwing: the marker is a
    // convenience, and a broken one must not close the only route a portable
    // user has to their terminal.
    for (const body of [
      'not json',
      JSON.stringify({ version: 2, outcome: 'accepted', recordedAt: '2026-01-01T00:00:00Z' }),
      JSON.stringify({ version: 1, outcome: 'maybe', recordedAt: '2026-01-01T00:00:00Z' }),
      JSON.stringify({ version: 1, outcome: 'accepted', recordedAt: 'whenever' }),
    ]) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, body)
      expect(readDesktopCliPromptState(dir)).toBeUndefined()
    }
  })

  it('clears the marker', async () => {
    const dir = userData()
    await recordDesktopCliPromptOutcome(dir, 'declined')
    clearDesktopCliPromptState(dir)
    expect(existsSync(desktopCliPromptStatePath(dir))).toBe(false)
  })
})

describe('desktopCliPromptCopy', () => {
  it('has non-empty, distinct zh and en wording', () => {
    for (const locale of ['zh', 'en'] as const) {
      const copy = desktopCliPromptCopy(locale)
      for (const value of Object.values(copy)) expect(value.length).toBeGreaterThan(0)
    }
    expect(desktopCliPromptCopy('zh').title).not.toBe(desktopCliPromptCopy('en').title)
  })
})

describe('runDesktopCliPortablePrompt', () => {
  it('asks once, publishes on accept, and records the answer', async () => {
    const h = harness({ response: DESKTOP_CLI_PROMPT_CONFIRM_INDEX })
    await h.run()

    expect(h.confirm).toHaveBeenCalledTimes(1)
    expect(h.publish).toHaveBeenCalledTimes(1)
    expect(readDesktopCliPromptState(h.userDataDir)?.outcome).toBe('accepted')
  })

  it('does not publish when the user declines, but still records it', async () => {
    const h = harness({ response: DESKTOP_CLI_PROMPT_CANCEL_INDEX })
    await h.run()

    expect(h.publish).not.toHaveBeenCalled()
    expect(readDesktopCliPromptState(h.userDataDir)?.outcome).toBe('declined')
  })

  it('does not ask a second time', async () => {
    const dir = userData()
    await runDesktopCliPortablePrompt({
      userDataDir: dir,
      locale: 'zh',
      platform: 'win32',
      safeMode: false,
      detectInstallKind: () => 'portable',
      confirm: async () => DESKTOP_CLI_PROMPT_CONFIRM_INDEX,
      publish: () => {},
      reportFailure: async () => {},
      logError: () => {},
    })

    const second = harness({ userDataDir: dir })
    await second.run()
    expect(second.confirm).not.toHaveBeenCalled()
  })

  it('never asks an installed copy and leaves no marker behind', async () => {
    const h = harness({ installKind: 'installed' })
    await h.run()

    expect(h.confirm).not.toHaveBeenCalled()
    expect(readDesktopCliPromptState(h.userDataDir)).toBeUndefined()
  })

  it('does not ask off Windows or in Safe Mode', async () => {
    const mac = harness({ platform: 'darwin' })
    await mac.run()
    expect(mac.confirm).not.toHaveBeenCalled()
    expect(mac.detectInstallKind).not.toHaveBeenCalled()

    const safe = harness({ safeMode: true })
    await safe.run()
    expect(safe.confirm).not.toHaveBeenCalled()
  })

  it('declines silently when the registry cannot be read', async () => {
    // An unreadable registry cannot be read as "portable": showing a prompt to a
    // user who is already registered would assert something false.
    const h = harness({ detectThrows: new Error('powershell exploded') })
    await h.run()

    expect(h.confirm).not.toHaveBeenCalled()
    expect(h.logError).toHaveBeenCalledTimes(1)
    expect(readDesktopCliPromptState(h.userDataDir)).toBeUndefined()
  })

  it('leaves the invitation unanswered when the dialog itself fails', async () => {
    const h = harness()
    h.confirm.mockRejectedValueOnce(new Error('no display'))
    await h.run()

    expect(h.publish).not.toHaveBeenCalled()
    expect(h.logError).toHaveBeenCalledTimes(1)
    // Unanswered, not declined: the user was never asked, so asking later is right.
    expect(readDesktopCliPromptState(h.userDataDir)).toBeUndefined()
  })

  it('records a decision even when publishing fails, and reports the failure', async () => {
    const h = harness({ publishThrows: new Error('registry is read-only') })
    await h.run()

    expect(h.logError).toHaveBeenCalledTimes(1)
    expect(h.reportFailure).toHaveBeenCalledTimes(1)
    expect(h.reportFailure.mock.calls[0]![0]).toContain('registry is read-only')
    // Recorded rather than re-asked: the user answered, and Settings retries.
    expect(readDesktopCliPromptState(h.userDataDir)?.outcome).toBe('accepted')
  })

  it('keeps the wording out of the state file', async () => {
    const h = harness()
    await h.run()
    const text = readFileSync(desktopCliPromptStatePath(h.userDataDir), 'utf8')
    expect(text).not.toContain(desktopCliPromptCopy('zh').detail)
  })
})
