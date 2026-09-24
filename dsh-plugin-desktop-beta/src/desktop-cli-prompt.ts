/**
 * Invite a portable user, once, to publish the bundled CLIs for their terminal.
 *
 * A `NSIS` installation already writes the shim directory into `Path`, so an
 * installed user's terminal works the moment the application has started once.
 * A portable copy has no installer and therefore no `Path` entry, and it cannot
 * be found by guessing: the archive is unpacked wherever the user chose. This
 * module supplies the missing conversation — one prompt, at first launch, with
 * the choice remembered in the application data directory.
 *
 * Two properties keep the prompt honest:
 *
 * - The install kind comes from {@link detectDesktopWindowsInstallKind}, i.e.
 *   from the installer's own registry records, never from the shape of the
 *   directory the application happens to sit in.
 * - The "already asked" marker lives under the Electron user-data directory, so
 *   it is an application-level preference rather than a machine-level fact and
 *   cannot be read as one by a second user or a second Profile.
 *
 * The shim generation that the prompt offers is the same operation the settings
 * entry performs, so accepting here and clicking through the settings panel
 * later are the same code path and cannot disagree.
 */

import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { DesktopLocale } from './runtime.ts'
import type { DesktopWindowsInstallKind } from './desktop-windows-install-kind.ts'

const BIN_NAME = 'dsh-plugin-desktop'
const PROMPT_ROOT_DIRECTORY = 'cli-prompt'
const PROMPT_FILENAME = 'state.json'
const PROMPT_STATE_VERSION = 1
const PROMPT_DIRECTORY_MODE = 0o700
const PROMPT_FILE_MODE = 0o600
const MAX_PROMPT_BYTES = 4 * 1024

/** What the user did with the one-time invitation. */
export type DesktopCliPromptOutcome = 'accepted' | 'declined'

/** Strict marker recording that the invitation was answered. */
export interface DesktopCliPromptState {
  readonly version: 1
  readonly outcome: DesktopCliPromptOutcome
  readonly recordedAt: string
}

/** Wording of the native invitation, in the active Desktop locale. */
export interface DesktopCliPromptCopy {
  readonly title: string
  readonly message: string
  readonly detail: string
  readonly confirm: string
  readonly cancel: string
  /** Acknowledgment on the error dialog shown when registration fails. */
  readonly dismiss: string
  /** What went wrong, without the technical detail the dialog carries. */
  readonly failed: string
}

const promptCopy: Record<DesktopLocale, DesktopCliPromptCopy> = {
  en: {
    title: 'Use the command line tools',
    message: 'Add CodeGraph and Mnemon to your terminal?',
    detail: 'This portable copy can register its command line tools so codegraph and mnemon work in a terminal you open yourself. It writes one entry to your user PATH pointing at a folder of forwarding shims, and does not touch any other entry. You can register or remove it later in Settings, under Command-line tools.',
    confirm: 'Register',
    cancel: 'Not now',
    dismiss: 'OK',
    failed: 'The command line tools could not be registered. You can try again in Settings, under Command-line tools.',
  },
  zh: {
    title: '使用命令行工具',
    message: '把 CodeGraph 与 Mnemon 加入终端？',
    detail: '这份便携版可以登记它的命令行工具，让你自己打开的终端里能直接用 codegraph 与 mnemon。它会往你的用户 PATH 里写一条指向转发 shim 目录的条目，不改动其他任何条目。之后也可以在「设置 → 命令行工具」里重新登记或撤销。',
    confirm: '登记',
    cancel: '暂不',
    dismiss: '好',
    failed: '未能登记命令行工具。可以在「设置 → 命令行工具」里重试。',
  },
}

/** Resolve the native invitation wording for the active Desktop locale. */
export function desktopCliPromptCopy(locale: DesktopLocale): DesktopCliPromptCopy {
  return promptCopy[locale]
}

/** Fixed marker path under one Electron user-data directory. */
export function desktopCliPromptStatePath(userDataDir: string): string {
  if (typeof userDataDir !== 'string' || userDataDir.length === 0 || userDataDir.includes('\0')) {
    throw new TypeError(`${BIN_NAME}: CLI prompt user-data directory must be a non-empty path without NUL`)
  }
  return join(userDataDir, PROMPT_ROOT_DIRECTORY, PROMPT_FILENAME)
}

function parsePromptState(text: string): DesktopCliPromptState {
  const invalid = (message: string): never => {
    throw new Error(`${BIN_NAME}: invalid CLI prompt state: ${message}`)
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return invalid('state is not valid JSON')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalid('state is not an object')
  }
  const { version, outcome, recordedAt } = value as Record<string, unknown>
  if (version !== PROMPT_STATE_VERSION) return invalid('unsupported version')
  if (outcome !== 'accepted' && outcome !== 'declined') return invalid('unknown outcome')
  if (typeof recordedAt !== 'string' || !Number.isFinite(Date.parse(recordedAt))) {
    return invalid('recordedAt is not a timestamp')
  }
  return Object.freeze({ version: PROMPT_STATE_VERSION, outcome, recordedAt })
}

/**
 * Read the recorded answer, or `undefined` when the invitation is unanswered.
 *
 * An unreadable or malformed marker counts as unanswered: asking one extra time
 * is a smaller harm than never offering a portable user a way to their terminal.
 */
export function readDesktopCliPromptState(userDataDir: string): DesktopCliPromptState | undefined {
  let text: string
  try {
    text = readFileSync(desktopCliPromptStatePath(userDataDir), 'utf8')
  } catch {
    return undefined
  }
  if (text.length > MAX_PROMPT_BYTES) return undefined
  try {
    return parsePromptState(text)
  } catch {
    return undefined
  }
}

/**
 * Decide whether the invitation should be shown on this launch.
 *
 * Only a Windows portable edition is asked, and only once. Every other case —
 * an installed copy, another platform, an already answered prompt, Safe Mode —
 * is silent.
 */
export function desktopCliPromptRequired(options: {
  readonly platform: NodeJS.Platform
  readonly installKind: DesktopWindowsInstallKind
  readonly state: DesktopCliPromptState | undefined
  readonly safeMode: boolean
}): boolean {
  if (options.platform !== 'win32') return false
  if (options.safeMode) return false
  if (options.installKind !== 'portable') return false
  return options.state === undefined
}

/** Record the answer so the invitation is never shown again. */
export async function recordDesktopCliPromptOutcome(
  userDataDir: string,
  outcome: DesktopCliPromptOutcome,
  recordedAt: string = new Date().toISOString(),
): Promise<DesktopCliPromptState> {
  if (outcome !== 'accepted' && outcome !== 'declined') {
    throw new TypeError(`${BIN_NAME}: invalid CLI prompt outcome`)
  }
  const state: DesktopCliPromptState = Object.freeze({
    version: PROMPT_STATE_VERSION,
    outcome,
    recordedAt,
  })
  const path = desktopCliPromptStatePath(userDataDir)
  mkdirSync(dirname(path), { recursive: true, mode: PROMPT_DIRECTORY_MODE })
  await writeFileAtomic(path, `${JSON.stringify(state, undefined, 2)}\n`, {
    mode: PROMPT_FILE_MODE,
    dirMode: PROMPT_DIRECTORY_MODE,
  })
  return state
}

/** Forget the recorded answer, so the invitation is offered again. */
export function clearDesktopCliPromptState(userDataDir: string): void {
  rmSync(desktopCliPromptStatePath(userDataDir), { force: true })
}

/** The two answers a native confirmation can return, in button order. */
export const DESKTOP_CLI_PROMPT_CONFIRM_INDEX = 0
export const DESKTOP_CLI_PROMPT_CANCEL_INDEX = 1

/**
 * Ask a portable user once, and publish the CLIs if they accept.
 *
 * Every dependency is injected, so the whole flow — including the registry
 * answer and the user's choice — is provable on a host that is neither Windows
 * nor has a registry.
 *
 * A failure to determine the install kind is treated as "installed", i.e. as a
 * reason not to ask. A portable user who is never asked can still register from
 * Settings, whereas an installed user who is asked about a copy the installer
 * already registered is told something false. The prompt is the disposable
 * half of that trade.
 */
export async function runDesktopCliPortablePrompt(options: {
  readonly userDataDir: string
  readonly locale: DesktopLocale
  readonly platform: NodeJS.Platform
  readonly safeMode: boolean
  /** Resolve this copy's install kind; may throw when the registry is unreadable. */
  readonly detectInstallKind: () => DesktopWindowsInstallKind
  /** Show the native confirmation and return the chosen button index. */
  readonly confirm: (copy: DesktopCliPromptCopy) => Promise<number>
  /** Republish the shims and register the PATH entry; throws on failure. */
  readonly publish: () => void
  /** Surface a registration failure to the user; must not throw. */
  readonly reportFailure: (detail: string) => Promise<void>
  readonly logError: (message: string) => void
}): Promise<void> {
  if (options.platform !== 'win32' || options.safeMode) return

  let installKind: DesktopWindowsInstallKind
  try {
    installKind = options.detectInstallKind()
  } catch (cause) {
    options.logError(
      `${BIN_NAME}: could not determine the Windows install kind, so no CLI prompt was shown: `
        + `${cause instanceof Error ? cause.message : String(cause)}`,
    )
    return
  }

  const state = readDesktopCliPromptState(options.userDataDir)
  if (!desktopCliPromptRequired({
    platform: options.platform,
    installKind,
    state,
    safeMode: options.safeMode,
  })) return

  let response: number
  try {
    response = await options.confirm(desktopCliPromptCopy(options.locale))
  } catch (cause) {
    // Nothing was recorded: an unanswered invitation may be offered again on the
    // next launch, which is the correct reading of a prompt that never appeared.
    options.logError(
      `${BIN_NAME}: failed to show the portable CLI prompt: `
        + `${cause instanceof Error ? cause.message : String(cause)}`,
    )
    return
  }

  const accepted = response === DESKTOP_CLI_PROMPT_CONFIRM_INDEX
  if (accepted) {
    try {
      options.publish()
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      options.logError(`${BIN_NAME}: portable CLI registration failed: ${detail}`)
      // The user accepted and must not be left believing it worked: the failure
      // is surfaced, and the answer is still recorded so they are not asked
      // again about a decision they already made. Settings retries on demand.
      try {
        await options.reportFailure(detail)
      } catch (reportCause) {
        options.logError(
          `${BIN_NAME}: failed to report the portable CLI registration failure: `
            + `${reportCause instanceof Error ? reportCause.message : String(reportCause)}`,
        )
      }
    }
  }
  try {
    await recordDesktopCliPromptOutcome(options.userDataDir, accepted ? 'accepted' : 'declined')
  } catch (cause) {
    options.logError(
      `${BIN_NAME}: failed to record the portable CLI prompt outcome: `
        + `${cause instanceof Error ? cause.message : String(cause)}`,
    )
  }
}

export const desktopCliPromptConstants = Object.freeze({
  version: PROMPT_STATE_VERSION,
  rootDirectory: PROMPT_ROOT_DIRECTORY,
  filename: PROMPT_FILENAME,
  maxBytes: MAX_PROMPT_BYTES,
  directoryMode: PROMPT_DIRECTORY_MODE,
  fileMode: PROMPT_FILE_MODE,
})
