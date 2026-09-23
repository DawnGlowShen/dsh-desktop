// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesktopSettingsSection, type DesktopSettingsSectionProps } from '../src/client/DesktopSettingsSection.tsx'
import { en, zh } from '../src/client/desktop-settings-locales.ts'

let root: Root | undefined
let container: HTMLDivElement | undefined

function scope(value: unknown) {
  const snapshot = { status: 'ready', writable: true, value }
  return { getSnapshot: () => snapshot, subscribe: () => () => {} }
}

interface CliApi {
  publishCli?: () => Promise<{ changed: boolean; registered: boolean }>
  revokeCli?: () => Promise<{ changed: boolean; registered: boolean }>
}

async function mount(api: CliApi, locale: 'zh' | 'en' = 'zh') {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  const dictionary = locale === 'zh' ? zh : en
  const props = {
    t: (key: keyof typeof zh) => dictionary[key],
    api: {
      read: async () => ({
        current: 'desktop',
        profiles: [],
        aa: { requested: false, effective: false },
        market: { requested: 'disabled', effective: 'disabled', legacyDefaulted: false },
        web: { localUrl: '', lanUrls: [], lanState: 'inactive', lanError: null, lanCaFingerprint: null, lanCaUrls: [] },
      }),
      ...api,
    },
    platform: 'win32', initialMode: 'compatibility', micaSupported: false, setMode: async () => {},
    desktopSettings: scope({ mode: 'compatibility', openBrowser: false, networkExposure: 'loopback', macosMaterial: 'off', windowsMaterial: 'off' }),
    notificationSettings: scope({ enabled: false }),
  } as unknown as DesktopSettingsSectionProps
  await act(async () => { root!.render(createElement(DesktopSettingsSection, props)) })
  return container.querySelector<HTMLElement>('[aria-labelledby="dsh-desktop-cli-title"]')!
}

/** Buttons inside the command-line group, in document order. */
function cliButtons(section: HTMLElement): HTMLButtonElement[] {
  return [...section.querySelectorAll<HTMLButtonElement>('button')]
}

/** The standalone feedback line, ignoring the group hint and dialog copy. */
function cliStatus(section: HTMLElement): string | undefined {
  return [...section.querySelectorAll<HTMLElement>('[role="status"]')]
    .map(node => node.textContent ?? '')
    .find(text => text.length > 0)
}

/** Buttons inside the revoke confirmation dialog. */
function dialogButtons(): HTMLButtonElement[] {
  const dialog = container!.querySelector<HTMLElement>('[role="alertdialog"]')!
  return [...dialog.querySelectorAll<HTMLButtonElement>('button')]
}

afterEach(async () => {
  await act(async () => { root?.unmount() })
  root = undefined
  container?.remove()
  vi.unstubAllGlobals()
})

describe('command-line tool settings', () => {
  it('registers on click and reports the changed result', async () => {
    const publishCli = vi.fn(async () => ({ changed: true, registered: true }))
    const revokeCli = vi.fn(async () => ({ changed: true, registered: false }))
    const section = await mount({ publishCli, revokeCli })

    await act(async () => { cliButtons(section)[0]!.click() })

    expect(publishCli).toHaveBeenCalledTimes(1)
    expect(revokeCli).not.toHaveBeenCalled()
    expect(cliStatus(section)).toBe(zh.cliUpdated)
  })

  it('reports the unchanged result as already up to date', async () => {
    const publishCli = vi.fn(async () => ({ changed: false, registered: true }))
    const section = await mount({ publishCli, revokeCli: vi.fn(async () => ({ changed: false, registered: true })) })

    await act(async () => { cliButtons(section)[0]!.click() })

    expect(publishCli).toHaveBeenCalledTimes(1)
    expect(cliStatus(section)).toBe(zh.cliUpToDate)
  })

  it('revokes only after the confirmation dialog is accepted', async () => {
    const revokeCli = vi.fn(async () => ({ changed: true, registered: false }))
    const section = await mount({ publishCli: vi.fn(async () => ({ changed: false, registered: true })), revokeCli })

    await act(async () => { cliButtons(section)[1]!.click() })
    expect(revokeCli).not.toHaveBeenCalled()
    expect(container!.querySelector('[role="alertdialog"]')!.textContent).toContain(zh.cliRevokeBody)

    await act(async () => { dialogButtons()[1]!.click() })

    expect(revokeCli).toHaveBeenCalledTimes(1)
    expect(container!.querySelector('[role="alertdialog"]')).toBeNull()
    expect(cliStatus(section)).toBe(zh.cliRemoved)
  })

  it('keeps the registration untouched when the revoke dialog is cancelled', async () => {
    const revokeCli = vi.fn(async () => ({ changed: true, registered: false }))
    const section = await mount({ publishCli: vi.fn(async () => ({ changed: false, registered: true })), revokeCli })

    await act(async () => { cliButtons(section)[1]!.click() })
    await act(async () => { dialogButtons()[0]!.click() })

    expect(revokeCli).not.toHaveBeenCalled()
    expect(container!.querySelector('[role="alertdialog"]')).toBeNull()
    expect(cliStatus(section)).toBeUndefined()
  })

  it('shows a failure without a stale success line when the API rejects', async () => {
    const publishCli = vi.fn()
      .mockResolvedValueOnce({ changed: true, registered: true })
      .mockRejectedValueOnce(new Error('registry write failed'))
    const section = await mount({ publishCli, revokeCli: vi.fn(async () => ({ changed: false, registered: true })) })

    await act(async () => { cliButtons(section)[0]!.click() })
    expect(cliStatus(section)).toBe(zh.cliUpdated)

    await act(async () => { cliButtons(section)[0]!.click() })

    expect(section.querySelector('[role="alert"]')?.textContent).toBe(zh.cliFailed)
    expect(cliStatus(section)).toBeUndefined()
  })

  it('disables both actions when the launcher exposes no command-line capability', async () => {
    const section = await mount({})

    const buttons = cliButtons(section)
    expect(buttons).toHaveLength(2)
    expect(buttons.every(button => button.disabled)).toBe(true)
  })

  it('translates every command-line string into both locales', () => {
    const keys = [
      'cliTitle', 'cliIntro', 'cliHint', 'cliPublish', 'cliPublishing', 'cliUpdated', 'cliUpToDate',
      'cliRevoke', 'cliRevoking', 'cliRemoved', 'cliAbsent', 'cliFailed',
      'cliRevokeTitle', 'cliRevokeBody', 'cliRevokeCancel', 'cliRevokeConfirm',
    ] as const

    for (const key of keys) {
      expect(zh[key].length).toBeGreaterThan(0)
      expect(en[key].length).toBeGreaterThan(0)
      expect(en[key]).not.toBe(zh[key])
    }
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })
})
