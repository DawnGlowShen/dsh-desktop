/**
 * On-demand publication of the packaged CLIs for one user's own terminal.
 *
 * Startup already generates the shims and the Windows installer already writes
 * `Path`, which together cover "a fresh install works in a new terminal". What
 * neither can cover is a moved directory: a portable copy is unpacked wherever
 * the user chose, and an installed copy can be relocated afterwards. Both leave
 * a `Path` entry that points at a directory the shims have since left, and the
 * user has no way to fix it from inside the application.
 *
 * This module is that way in: the settings entry calls {@link DesktopCliPublisher.publish}
 * to re-derive the shims from the current bundle location and re-register the
 * shim directory, or {@link DesktopCliPublisher.revoke} to drop this
 * installation's own `Path` entry again.
 *
 * Publication is deliberately independent of install kind — see `design.md`
 * 决策六 — because the relocation case is not specific to portable copies.
 *
 * Windows only: on POSIX platforms the shim directory is placed on `PATH` by a
 * marked block inside the user's shell profile, which is written at startup and
 * already follows the bundle. Rewriting that block on demand has no use case
 * here and its removal would break a working configuration, so callers do not
 * construct a publisher on those platforms and the settings route answers with
 * an honest failure instead of a no-op success.
 */

import { dirname, join } from 'node:path'
import { installDesktopCliShell, desktopCliShimDirectory, type DesktopCliLauncher } from './desktop-cli-shell.ts'
import {
  createPowerShellWindowsPathRegistry,
  registerDesktopWindowsPath,
  unregisterDesktopWindowsPath,
  type DesktopWindowsPathRegistry,
} from './desktop-windows-path.ts'

/** The published bundle directories one launcher list is derived from. */
export interface DesktopCliLauncherSources {
  /** Host platform; selects which launcher inside each bundle is addressed. */
  platform: NodeJS.Platform
  /** Published CodeGraph `bin` directory, or `undefined` when it was skipped. */
  codegraphPathDir?: string | undefined
  /** Published Mnemon `bin` directory, or `undefined` when it was skipped. */
  mnemonPathDir?: string | undefined
}

/**
 * Derive the shim targets for every CLI that was actually published.
 *
 * Both the startup integration and the settings action go through this one
 * function so the two can never disagree about where a launcher lives.
 *
 * The Windows `codegraph` target is the entry *script*, not the bundle's own
 * `bin\codegraph.cmd`: that upstream file resolves `%~dp0` when it is called,
 * which would bind a generated shim to the packaged directory and break the
 * moment the bundle moved. Naming the script instead lets the forwarder embed
 * absolute paths, and its three-level-removed location is what
 * `CODEGRAPH_SCRIPT_DIRECTORIES` verifies on the way back. A CLI whose bundle
 * was skipped is absent rather than pointing at a path that does not exist.
 */
export function desktopCliLaunchers(sources: DesktopCliLauncherSources): DesktopCliLauncher[] {
  const windows = sources.platform === 'win32'
  const launchers: DesktopCliLauncher[] = []
  if (sources.codegraphPathDir !== undefined) {
    launchers.push({
      name: 'codegraph',
      launcherPath: windows
        ? join(dirname(sources.codegraphPathDir), 'lib', 'dist', 'bin', 'codegraph.js')
        : join(sources.codegraphPathDir, 'codegraph'),
    })
  }
  if (sources.mnemonPathDir !== undefined) {
    launchers.push({
      name: 'mnemon',
      // Mnemon ships a real executable, not a batch shim.
      launcherPath: join(sources.mnemonPathDir, windows ? 'mnemon.exe' : 'mnemon'),
    })
  }
  return launchers
}

/** Outcome of one publish or revoke, shaped for the settings response. */
export interface DesktopCliPathOperationResult {
  /** Whether anything on disk or in the registry actually had to change. */
  readonly changed: boolean
  /** Whether the shim directory is registered after this call. */
  readonly registered: boolean
}

export interface DesktopCliPublicationOptions {
  /** Harness home directory; receives the generated shims under `bin/`. */
  homeDir: string
  /** User's home directory, as the launcher resolves it. */
  userHomeDir: string
  /** Host platform; only `'win32'` publishes through the registry. */
  platform: NodeJS.Platform
  /** Bundled CLIs to publish; all share one shim directory and one PATH entry. */
  launchers: readonly DesktopCliLauncher[]
  /** Login shell from `$SHELL`; unused on Windows, kept for parity. */
  shell?: string | undefined
  /**
   * Registry seam, injected so every branch is provable without a Windows host.
   * Defaults to the real PowerShell-backed registry.
   */
  createRegistry?: (() => DesktopWindowsPathRegistry) | undefined
}

/** The two reversible operations behind the settings entry. */
export interface DesktopCliPublisher {
  /** Regenerate the shims and ensure this installation's `Path` entry exists. */
  publish(): DesktopCliPathOperationResult
  /** Remove this installation's `Path` entry, keeping the generated shims. */
  revoke(): DesktopCliPathOperationResult
}

function fail(message: string): never {
  throw new Error(`dsh-plugin-desktop: ${message}`)
}

/**
 * Build the publish/revoke pair for one installation.
 *
 * Both operations re-derive the shim directory from `homeDir` on every call and
 * compare content rather than existence, so repeated invocations are cheap
 * no-ops and a relocated bundle is corrected rather than duplicated.
 */
export function createDesktopCliPublisher(options: DesktopCliPublicationOptions): DesktopCliPublisher {
  if (options.platform !== 'win32') {
    fail(`${options.platform} has no registry-backed CLI PATH entry to publish`)
  }
  const registry = (options.createRegistry ?? (() => createPowerShellWindowsPathRegistry()))()
  const shimDirectory = desktopCliShimDirectory(options.homeDir)

  return {
    publish: () => {
      // A `Path` entry pointing at a directory with no shims in it is worse
      // than no entry at all, so an installation that published nothing says so
      // rather than registering an empty directory.
      if (options.launchers.length === 0) {
        fail('no packaged CLI was published to forward, so there is nothing to register')
      }
      // Shims first: the directory is populated before it is advertised.
      const shell = installDesktopCliShell({
        homeDir: options.homeDir,
        userHomeDir: options.userHomeDir,
        launchers: options.launchers,
        shell: options.shell,
        platform: options.platform,
      })
      const path = registerDesktopWindowsPath(registry, shimDirectory)
      return { changed: shell.changed || path.changed, registered: path.registered }
    },
    revoke: () => {
      const path = unregisterDesktopWindowsPath(registry, shimDirectory)
      return { changed: path.changed, registered: path.registered }
    },
  }
}
