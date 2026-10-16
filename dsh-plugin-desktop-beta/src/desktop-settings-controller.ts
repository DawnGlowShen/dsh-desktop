/** Launcher-backed controller for the private Desktop settings API. */

import type {
  DesktopMarketProvider,
  DesktopMarketSnapshot,
} from './desktop-market.ts'
import type { DesktopProfileSummary } from './profile-manager.ts'
import type { DesktopProfiles } from './profile-service.ts'
import type {
  DesktopMarketSelectResponse,
  DesktopDeveloperToolsToggleResponse,
  DesktopDiagnosticsExportResponse,
  DesktopOfflineRestoreResponse,
  DesktopProfileCreateResponse,
  DesktopProfileDeleteResponse,
  DesktopProfileSelectResponse,
  DesktopRestartResponse,
  DesktopRecoveryRestartResponse,
  DesktopRendererReloadResponse,
  DesktopSettingsMarketView,
  DesktopSettingsProfileView,
  DesktopSettingsResponse,
  DesktopSettingsWebView,
  DesktopTerminalOpenResponse,
} from './desktop-settings-contract.ts'

/**
 * What one offline restore changed, as the launcher observed it.
 *
 * Names rather than counts: the page says which payloads were added and which could not
 * be, and a count could not be turned back into those names.
 */
export interface DesktopOfflineRestoreReport {
  /** Payloads installed by this run. */
  readonly installed: readonly string[]
  /** Payloads already at the shipped version, left untouched. */
  readonly skipped: readonly string[]
  /** Payloads that could not be installed. */
  readonly failed: readonly string[]
  /**
   * Configurations this run wrote.
   *
   * Separate from `installed` because the two answer different questions: a payload can be
   * installed while its configuration was already current, and — the case that matters — a
   * configuration can be written by a run that installed nothing at all. Folding them into
   * one list would make the second press of the button report work it did not do.
   */
  readonly configured: readonly string[]
  /** Configurations already in their wanted state, left untouched. */
  readonly configurationSkipped: readonly string[]
  /** Configurations that could not be applied. */
  readonly configurationFailed: readonly string[]
}

/** Launcher capabilities used without exposing their filesystem roots. */
export interface DesktopSettingsControllerBootstrap {
  /** Generation-scoped profile service. */
  readonly profiles: Pick<DesktopProfiles, 'current' | 'list' | 'create' | 'prepareSelection'>
    & Partial<Pick<DesktopProfiles, 'canDelete' | 'delete'>>
  /** Read the latest persisted request and the startup-effective provider. */
  readAa?(): { readonly requested: boolean; readonly effective: boolean }
  selectAa?(enabled: boolean): Promise<void>
  readMarket(): DesktopMarketSnapshot
  /** Persist an explicit provider request. */
  selectMarket(provider: DesktopMarketProvider): Promise<DesktopMarketSnapshot>
  /** Read marker-free URLs from the generation's actual WebServer and LAN snapshot. */
  readWeb(): DesktopSettingsWebView
  /** Queue an orderly restart after a response confirms persisted selection. */
  scheduleRestart(): void
  /** Queue an orderly restart into the pre-Host recovery assistant. */
  scheduleRecoveryRestart(): void
  /** Open the launcher-owned DSH terminal. */
  openTerminal(): void
  /** Reload the mounted renderer after its HTTP acknowledgement is delivered. */
  reloadRenderer(): void
  /** Toggle Developer Tools for the mounted renderer. */
  toggleDeveloperTools(): void
  /** Export diagnostics through the launcher-owned privacy flow. */
  exportDiagnostics(): void | Promise<void>
  /**
   * Install whatever the shipped offline manifest lists and this machine lacks.
   *
   * Additive: it must not delete, downgrade or overwrite anything already present, so a
   * plugin the user upgraded through the market survives. Optional because only a build
   * carrying the installer can answer it.
   */
  restoreOfflinePayloads?(): Promise<DesktopOfflineRestoreReport>
}

/** A persisted response plus work that must run only after `res.end()`. */
export interface DesktopSettingsPostResponse<T extends object> {
  readonly response: T
  readonly afterResponse?: () => void | Promise<void>
}

/** Remove paths, bundle identities, and parser diagnostics from a profile. */
export function projectDesktopSettingsProfile(
  profile: DesktopProfileSummary,
  deletable = false,
): DesktopSettingsProfileView {
  return Object.freeze({
    name: profile.name,
    exists: profile.exists,
    webCapable: profile.webCapable,
    selectable: profile.exists && profile.webCapable && profile.problem === undefined,
    deletable,
  })
}

function projectMarket(
  value: DesktopMarketSnapshot,
  effective: DesktopMarketProvider,
): DesktopSettingsMarketView {
  return Object.freeze({
    requested: value.requested,
    effective,
    legacyDefaulted: value.legacyDefaulted,
  })
}

/**
 * Generation-scoped controller for Profile and Market preferences.
 *
 * The provider composed at startup remains `effective` for this controller's
 * lifetime. Persisting another provider changes only `requested` until the
 * queued restart creates a new Host generation.
 */
export class DesktopSettingsController {
  private readonly effectiveMarket: DesktopMarketProvider

  constructor(private readonly bootstrap: DesktopSettingsControllerBootstrap) {
    this.effectiveMarket = bootstrap.readMarket().effective
  }

  /** Read a fresh, renderer-safe settings projection. */
  read(): DesktopSettingsResponse {
    const web = this.bootstrap.readWeb()
    return Object.freeze({
      current: this.bootstrap.profiles.current.name,
      profiles: Object.freeze(
        this.bootstrap.profiles.list().map(profile => projectDesktopSettingsProfile(
          profile,
          this.bootstrap.profiles.canDelete?.(profile.name) ?? false,
        )),
      ),
      aa: Object.freeze(this.bootstrap.readAa?.() ?? { requested: false, effective: false }),
      market: projectMarket(this.bootstrap.readMarket(), this.effectiveMarket),
      web: Object.freeze({
        localUrl: web.localUrl,
        lanUrls: Object.freeze([...web.lanUrls]),
        lanState: web.lanState,
        lanError: web.lanError,
        lanCaFingerprint: web.lanCaFingerprint,
        lanCaUrls: Object.freeze([...web.lanCaUrls]),
      }),
    })
  }

  /** Create one safe profile without selecting it or requesting restart. */
  createProfile(name: string): DesktopProfileCreateResponse {
    this.bootstrap.profiles.create(name)
    return this.read()
  }

  /** Delete one inactive user profile and return the fresh settings state. */
  async deleteProfile(name: string): Promise<DesktopProfileDeleteResponse> {
    if (this.bootstrap.profiles.delete === undefined) {
      throw new Error('dsh-plugin-desktop: profile deletion is unavailable')
    }
    await this.bootstrap.profiles.delete(name)
    return this.read()
  }

  /** Persist a fresh compatible profile, deferring restart until after response. */
  async selectProfile(
    name: string,
  ): Promise<DesktopSettingsPostResponse<DesktopProfileSelectResponse>> {
    const selection = await this.bootstrap.profiles.prepareSelection(name)
    return Object.freeze({
      response: Object.freeze({ accepted: true, restartRequired: selection.restartRequired }),
      ...(selection.restartRequired ? { afterResponse: () => selection.restart() } : {}),
    })
  }

  /** Persist a provider and defer restart until after the response is ended. */
  async selectMarket(
    provider: DesktopMarketProvider,
  ): Promise<DesktopSettingsPostResponse<DesktopMarketSelectResponse>> {
    await this.bootstrap.selectMarket(provider)
    const restartRequired = provider !== this.effectiveMarket
    return Object.freeze({
      response: Object.freeze({ accepted: true, restartRequired }),
      ...(restartRequired ? { afterResponse: () => { this.bootstrap.scheduleRestart() } } : {}),
    })
  }

  async selectAa(enabled: boolean): Promise<DesktopSettingsPostResponse<DesktopMarketSelectResponse>> {
    if (!this.bootstrap.selectAa || !this.bootstrap.readAa) throw new Error('AA selection is unavailable')
    await this.bootstrap.selectAa(enabled)
    const restartRequired = enabled !== this.bootstrap.readAa().effective
    return Object.freeze({
      response: Object.freeze({ accepted: true, restartRequired }),
      ...(restartRequired ? { afterResponse: () => { this.bootstrap.scheduleRestart() } } : {}),
    })
  }

  /** Open the native terminal through the launcher-owned action. */
  openTerminal(): DesktopTerminalOpenResponse {
    this.bootstrap.openTerminal()
    return Object.freeze({ accepted: true })
  }

  /** Acknowledge the renderer before queueing an orderly Desktop relaunch. */
  restart(): DesktopSettingsPostResponse<DesktopRestartResponse> {
    return Object.freeze({
      response: Object.freeze({ accepted: true }),
      afterResponse: () => { this.bootstrap.scheduleRestart() },
    })
  }

  /** Acknowledge the renderer before queueing a recovery-mode relaunch. */
  restartToRecovery(): DesktopSettingsPostResponse<DesktopRecoveryRestartResponse> {
    return Object.freeze({
      response: Object.freeze({ accepted: true }),
      afterResponse: () => { this.bootstrap.scheduleRecoveryRestart() },
    })
  }

  /** Acknowledge the renderer before replacing its current document. */
  reloadRenderer(): DesktopSettingsPostResponse<DesktopRendererReloadResponse> {
    return Object.freeze({
      response: Object.freeze({ accepted: true }),
      afterResponse: () => { this.bootstrap.reloadRenderer() },
    })
  }

  /** Toggle Developer Tools without exposing an Electron bridge to the page. */
  toggleDeveloperTools(): DesktopDeveloperToolsToggleResponse {
    this.bootstrap.toggleDeveloperTools()
    return Object.freeze({ accepted: true })
  }

  /** Export diagnostics through the native confirmation and reveal flow. */
  async exportDiagnostics(): Promise<DesktopDiagnosticsExportResponse> {
    await this.bootstrap.exportDiagnostics()
    return Object.freeze({ accepted: true })
  }

  /**
   * Re-apply the offline payloads this build shipped.
   *
   * The bootstrap does the work and reports what it found; this only shapes it for the
   * page. A payload that is already current is counted as skipped rather than installed,
   * so pressing the button twice tells the truth about the second press.
   */
  async restoreOfflinePayloads(): Promise<DesktopOfflineRestoreResponse> {
    // A build without the installer cannot answer this. Reporting empty success would
    // claim nothing needed doing, which is a different statement from "cannot tell".
    if (this.bootstrap.restoreOfflinePayloads === undefined) {
      throw new Error('dsh-plugin-desktop: this build has no offline installer')
    }
    const report = await this.bootstrap.restoreOfflinePayloads()
    return Object.freeze({
      accepted: true,
      installed: Object.freeze(report.installed),
      skipped: Object.freeze(report.skipped),
      failed: Object.freeze(report.failed),
      configured: Object.freeze(report.configured),
      configurationSkipped: Object.freeze(report.configurationSkipped),
      configurationFailed: Object.freeze(report.configurationFailed),
    })
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Launcher-owned controller behind the private loopback settings API. */
    desktopSettingsController: DesktopSettingsController
  }
}

export default DesktopSettingsController
