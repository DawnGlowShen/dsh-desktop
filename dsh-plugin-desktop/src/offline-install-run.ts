/**
 * Run the offline installer against the manifest shipped inside the application.
 *
 * This is the seam `main.ts` calls: it reads the manifest, installs whatever it lists,
 * and reports what happened. Everything below it — locating the manifest, unpacking,
 * linking, registering — is implemented in the sibling modules; this file only decides
 * the order and what a failure means.
 *
 * The whole run is best-effort by design. A machine whose manifest names a package that
 * cannot be installed must still start, so nothing here throws: a missing manifest is a
 * quiet no-op, and every other problem becomes an outcome the caller can log.
 */

import { join } from 'node:path'
import { installManifestClis, type CliOutcome } from './offline-install-cli.ts'
import { applyPayloadConfigurations, type ConfigureOutcome } from './offline-install-configure.ts'
import {
  readOfflineInstallManifest,
  type OfflineInstallLogger,
  type OfflineInstallManifest,
} from './offline-install-manifest.ts'
import { DEPENDENCY_DIRECTORY, installDependencyPayload, type DependencyOutcome } from './offline-install-dependencies.ts'
import { installManifestPlugins, type PluginOutcome } from './offline-install-plugins.ts'

/** Where the installer keeps what it unpacked, relative to the DSH home. */
const CLI_DIRECTORY = 'offline/cli'

/** Where the installer keeps unpacked plugins, relative to the DSH home. */
const PLUGIN_DIRECTORY = 'offline/plugins'

/** Directory whose generated commands are exposed on the user's PATH. */
const SHIM_DIRECTORY = 'bin'

/** What one run of the installer did. */
export interface OfflineInstallReport {
  /** Whether a manifest was found at all; false means the run was a no-op. */
  readonly ran: boolean
  /** One entry per CLI the manifest named. */
  readonly clis: readonly CliOutcome[]
  /** One entry per plugin the manifest named. */
  readonly plugins: readonly PluginOutcome[]
  /** What happened to the shared dependency tree, when the payload ships one. */
  readonly dependencies?: DependencyOutcome
  /**
   * One entry per registered payload configuration.
   *
   * Always present, including when the registry is empty: a caller reporting this stage
   * should not have to distinguish "nothing registered" from "the field is missing".
   */
  readonly configurations: readonly ConfigureOutcome[]
}

/** Everything the installer needs from the running application. */
export interface RunOfflineInstallOptions {
  /** Directory holding the application's own resources, e.g. `process.resourcesPath`. */
  readonly resourcesPath: string
  /** Application package root, used to locate a manifest during development. */
  readonly packageRoot: string
  /** DSH home, e.g. `~/.dsh`. */
  readonly homeDir: string
  /** User's home directory, for configuration targeting files outside the DSH home. */
  readonly userHomeDir: string
  /** Profile directory whose `node_modules` receives the plugin links. */
  readonly profileDir: string
  /** Application's own `node_modules`, the source of plugin dependencies. */
  readonly appModulesDir: string
  /** Diagnostic prefix for messages, e.g. `dsh-plugin-desktop`. */
  readonly binName: string
  /** Host platform. */
  readonly platform: NodeJS.Platform
  /** Whether this is a packaged build; decides where the manifest is looked for. */
  readonly packaged: boolean
  /** Optional environment override for the manifest directory. */
  readonly environment?: NodeJS.ProcessEnv
  /** Logger; `info` is optional because the desktop logger has no info channel. */
  readonly logger: OfflineInstallLogger
}

/**
 * Describe one outcome the way a reader scanning a log wants to see it.
 *
 * A successful install is worth stating plainly, but the interesting cases are the
 * others: they carry a reason, and dropping it would leave a log line saying only that
 * something did not happen.
 */
function describe(name: string, action: string, reason?: string): string {
  return reason === undefined ? `${name}: ${action}` : `${name}: ${action} (${reason})`
}

/**
 * Install everything the shipped manifest lists.
 *
 * A missing manifest returns `{ ran: false }` without logging an error: running from
 * source has no manifest, and that is not a fault. Anything the manifest does name is
 * installed even when a sibling failed — one broken package should not withhold the
 * others — and every failure is reported rather than thrown.
 *
 * @param options - Application facts the installer needs.
 * @returns What was installed, and whether a manifest was found.
 */
export function runOfflineInstall(options: RunOfflineInstallOptions): OfflineInstallReport {
  const manifest = readOfflineInstallManifest({
    resourcesPath: options.resourcesPath,
    packageRoot: options.packageRoot,
    packaged: options.packaged,
    // Spread rather than assign: `exactOptionalPropertyTypes` distinguishes an absent
    // property from one explicitly set to undefined, and only the former is allowed here.
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    logger: options.logger,
  })
  if (manifest === undefined) return { ran: false, clis: [], plugins: [], configurations: [] }

  return installOfflineManifest(manifest, options)
}

/**
 * Install one already-parsed manifest.
 *
 * Split from {@link runOfflineInstall} so a caller that holds a manifest — the settings
 * action, or a test — reaches the same installation path rather than reimplementing it.
 *
 * @param manifest - The manifest to install.
 * @param options - Application facts the installer needs.
 * @returns What was installed.
 */
export function installOfflineManifest(
  manifest: OfflineInstallManifest,
  options: RunOfflineInstallOptions,
): OfflineInstallReport {
  const clis = installManifestClis(manifest, {
    installRoot: join(options.homeDir, CLI_DIRECTORY),
    shimRoot: join(options.homeDir, SHIM_DIRECTORY),
    platform: options.platform,
  })
  for (const outcome of clis) {
    if (outcome.action === 'failed') {
      options.logger.error(`${options.binName}: offline CLI ${describe(outcome.name, outcome.action, outcome.reason)}`)
    } else {
      options.logger.info?.(`${options.binName}: offline CLI ${describe(outcome.name, outcome.action)}`)
    }
  }

  // The tree is unpacked before any plugin, because a plugin's dependencies have to
  // resolve at the moment it is linked — inspecting them first would report every
  // payload-provided dependency as missing.
  const dependencies = installDependencyPayload(manifest, options.homeDir)
  if (dependencies !== undefined) {
    if (dependencies.action === 'failed') {
      options.logger.error(
        `${options.binName}: offline dependencies ${describe('dependencies', dependencies.action, dependencies.reason)}`,
      )
    } else {
      options.logger.info?.(`${options.binName}: offline dependencies ${describe('dependencies', dependencies.action)}`)
    }
  }

  const plugins = installManifestPlugins(manifest, {
    installRoot: join(options.homeDir, PLUGIN_DIRECTORY),
    profileDir: options.profileDir,
    appModulesDir: options.appModulesDir,
    // Named only when the payload actually unpacked one: an absent directory would make
    // every plugin's dependency inspection walk a path that cannot exist.
    ...(dependencies?.action === 'failed' || dependencies === undefined
      ? {}
      : { offlineModulesDir: join(options.homeDir, DEPENDENCY_DIRECTORY) }),
    binName: options.binName,
    platform: options.platform,
  })
  for (const outcome of plugins) {
    if (outcome.action === 'failed') {
      options.logger.error(`${options.binName}: offline plugin ${describe(outcome.name, outcome.action, outcome.reason)}`)
    } else {
      options.logger.info?.(`${options.binName}: offline plugin ${describe(outcome.name, outcome.action)}`)
    }
  }

  // Last, and independent of everything above: a configuration states what the machine
  // needs, not what the payload provides, so it runs even when every tarball failed. That
  // ordering also lets a configuration read a payload that has already been unpacked,
  // which the reverse order could not.
  const configurations = applyPayloadConfigurations({
    homeDir: options.homeDir,
    userHomeDir: options.userHomeDir,
    platform: options.platform,
    resourcesPath: options.resourcesPath,
    binName: options.binName,
    logger: options.logger,
  })
  for (const outcome of configurations) {
    // `failed` is the only action worth an error line: `skipped` is a deliberate decision
    // (an absent resource, a target the user owns), and reporting it as a fault would send
    // an operator looking for a problem that is not there.
    if (outcome.action === 'failed') {
      options.logger.error(
        `${options.binName}: offline configuration ${describe(outcome.name, outcome.action, outcome.reason)}`,
      )
    } else {
      options.logger.info?.(`${options.binName}: offline configuration ${describe(outcome.name, outcome.action)}`)
    }
  }

  return { ran: true, clis, plugins, configurations, ...(dependencies === undefined ? {} : { dependencies }) }
}
