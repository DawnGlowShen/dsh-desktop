// @vitest-environment jsdom
/**
 * The settings surface for the offline restore action.
 *
 * The behaviour worth pinning is what the page says afterwards. "Nothing needed doing"
 * and "everything failed" both end in a quiet-looking panel if the copy is wrong, and the
 * user's next move differs completely between them.
 */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesktopSettingsSection, type DesktopSettingsSectionProps } from '../src/client/DesktopSettingsSection.tsx'
import { zh } from '../src/client/desktop-settings-locales.ts'
import type { DesktopOfflineRestoreOutcome } from '../src/client/desktop-settings-api.ts'

let root: Root | undefined
let container: HTMLDivElement | undefined

function scope(value: unknown) {
  const snapshot = { status: 'ready', writable: true, value }
  return { getSnapshot: () => snapshot, subscribe: () => () => {} }
}

async function mount(restoreOfflinePayloads: () => Promise<DesktopOfflineRestoreOutcome>): Promise<HTMLDivElement> {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  const props = {
    t: (key: keyof typeof zh) => zh[key],
    api: {
      read: async () => ({ current: 'desktop', profiles: [],
        aa: { requested: false, effective: false },
        market: { requested: 'disabled', effective: 'disabled', legacyDefaulted: false },
        web: { localUrl: '', lanUrls: [], lanState: 'inactive', lanError: null, lanCaFingerprint: null, lanCaUrls: [] },
      }),
      restoreOfflinePayloads,
    },
    platform: 'darwin', version: '2.0.3', initialMode: 'compatibility', setMode: async () => {},
    desktopSettings: scope({ mode: 'compatibility', openBrowser: false, networkExposure: 'loopback', macosMaterial: 'off', windowsMaterial: 'off' }),
    notificationSettings: scope({ enabled: false }),
  } as unknown as DesktopSettingsSectionProps
  await act(async () => { root!.render(createElement(DesktopSettingsSection, props)) })
  return container
}

function offlineSection(node: HTMLElement): HTMLElement | null {
  return node.querySelector<HTMLElement>('[aria-labelledby="dsh-desktop-offline-title"]')
}

function restoreButton(section: HTMLElement): HTMLButtonElement {
  return section.querySelector<HTMLButtonElement>('button')!
}

/** Press the button and let the resolved promise settle into state. */
async function press(section: HTMLElement): Promise<void> {
  await act(async () => {
    restoreButton(section).dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

afterEach(async () => {
  await act(async () => { root?.unmount() })
  root = undefined
  container?.remove()
  vi.unstubAllGlobals()
})

describe('Desktop settings offline restore', () => {
  it('renders the section with its own action', async () => {
    const node = await mount(async () => ({ installed: [], skipped: [], failed: [] }))
    const section = offlineSection(node)
    expect(section).not.toBeNull()
    expect(section!.textContent).toContain(zh.offlineTitle)
    expect(restoreButton(section!).textContent).toBe(zh.offlineRestore)
  })

  it('reports what it installed', async () => {
    const restore = vi.fn(async () => ({ installed: ['dsh-mnemon', 'dsh-codegraph'], skipped: [], failed: [] }))
    const node = await mount(restore)
    await press(offlineSection(node)!)
    expect(restore).toHaveBeenCalledTimes(1)
    const section = offlineSection(node)!
    expect(section.textContent).toContain(`${zh.offlineRestored} 2`)
  })

  it('says nothing needed doing when everything was already current', async () => {
    // The distinction that matters: a second press must not look like the first.
    const node = await mount(async () => ({ installed: [], skipped: ['dsh-mnemon'], failed: [] }))
    await press(offlineSection(node)!)
    const section = offlineSection(node)!
    expect(section.textContent).toContain(zh.offlineNothing)
    expect(section.textContent).not.toContain(zh.offlineRestored)
  })

  it('names the payloads that failed rather than only counting them', async () => {
    const node = await mount(async () => ({ installed: [], skipped: [], failed: ['broken-plugin'] }))
    await press(offlineSection(node)!)
    const section = offlineSection(node)!
    expect(section.textContent).toContain(zh.offlineFailed)
    // The name is what tells the user which package to look at.
    expect(section.textContent).toContain('broken-plugin')
  })

  it('reports a rejected request as a failure', async () => {
    const node = await mount(async () => { throw new Error('boom') })
    await press(offlineSection(node)!)
    const section = offlineSection(node)!
    expect(section.textContent).toContain(zh.offlineRestoreError)
    // A failed run must not claim success in the same breath.
    expect(section.textContent).not.toContain(zh.offlineNothing)
  })

  it('disables the button while a restore is running', async () => {
    let release: (() => void) | undefined
    const node = await mount(() => new Promise<DesktopOfflineRestoreOutcome>((resolve) => {
      release = () => { resolve({ installed: [], skipped: [], failed: [] }) }
    }))
    const section = offlineSection(node)!
    await act(async () => {
      restoreButton(section).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    // Pressing twice must not start two installs over the same directories.
    expect(restoreButton(offlineSection(node)!).disabled).toBe(true)
    await act(async () => { release!() })
    expect(restoreButton(offlineSection(node)!).disabled).toBe(false)
  })

  it('keeps the result visible after the run finishes', async () => {
    // Clearing back to idle would erase the answer the user just asked for.
    const node = await mount(async () => ({ installed: ['a'], skipped: [], failed: [] }))
    await press(offlineSection(node)!)
    expect(offlineSection(node)!.textContent).toContain(zh.offlineRestored)
  })
})
