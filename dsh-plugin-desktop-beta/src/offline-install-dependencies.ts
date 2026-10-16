/**
 * Unpack the shared `node_modules` tree a plugin payload ships.
 *
 * A plugin unpacked beside the DSH home reaches its dependencies through Node's ordinary
 * upward search: from `<home>/offline/plugins/<name>/` the search walks
 * `plugins/node_modules`, then `offline/node_modules`. Putting one tree at that second
 * location therefore serves every plugin at once, with no per-plugin links and no
 * guessing about which App package can stand in for which dependency.
 *
 * The archive holds the packages themselves rather than a `node_modules` directory, so
 * unpacking lands them directly in the destination. That keeps the payload independent of
 * where it is mounted — the same archive would work if the tree ever moved.
 *
 * This is the answer for dependencies the application itself does not carry. Anything the
 * App tree does carry is still linked by {@link supplyPluginDependencies}, so the payload
 * only has to hold what the App cannot provide — and one archive holds all of it.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  offlineTarballExists,
  readOfflineTarball,
  type OfflineDependencyPayload,
  type OfflineInstallManifest,
} from './offline-install-manifest.ts'
import { DIRECTORY_MODE, STAMP_MODE } from './offline-install-store.ts'
import { unpackTree } from './offline-install-unpack.ts'

/** Directory beside the unpacked plugins that Node searches for their dependencies. */
export const DEPENDENCY_DIRECTORY = 'offline/node_modules'

/** What unpacking the dependency tree did. */
export interface DependencyOutcome {
  /** `installed` unpacked a new tree, `current` found the same version already there. */
  readonly action: 'installed' | 'current' | 'failed'
  /** Version the payload declares. */
  readonly version: string
  /** Where the tree was unpacked, when it was. */
  readonly directory?: string
  /** Why it failed, when it did. */
  readonly reason?: string
}

/**
 * Unpack the dependency tree the manifest declares.
 *
 * The version stamp sits beside the tree rather than inside it, so the tree stays exactly
 * what the archive held — a file added into `node_modules` could collide with a package
 * name and change what a plugin resolves.
 *
 * @param manifest - Validated manifest, whose directory holds the archive.
 * @param homeDir - DSH home; the tree lands under `offline/node_modules`.
 * @returns What happened, or undefined when the payload ships no dependency tree.
 */
export function installDependencyPayload(
  manifest: OfflineInstallManifest,
  homeDir: string,
): DependencyOutcome | undefined {
  const payload: OfflineDependencyPayload | undefined = manifest.dependencies
  if (payload === undefined) return undefined

  const directory = join(homeDir, DEPENDENCY_DIRECTORY)
  // The stamp lives beside the tree: `<home>/offline/node_modules.version`.
  const stampPath = join(homeDir, 'offline', 'node_modules.version')
  try {
    if (!offlineTarballExists(manifest, payload.tarball)) {
      return { action: 'failed', version: payload.version, reason: `${payload.tarball} is missing from the payload` }
    }

    const alreadyCurrent = readStamp(stampPath) === payload.version
    // Re-unpacking an identical tree would rewrite hundreds of megabytes on every launch;
    // the stamp is what makes a second start cheap.
    if (!alreadyCurrent) {
      // `unpackTree` replaces the destination atomically, so a tree that fails to unpack
      // never leaves a half-written `node_modules` behind for plugins to resolve against.
      unpackTree(readOfflineTarball(manifest, payload.tarball), directory, false)
      mkdirSync(join(homeDir, 'offline'), { recursive: true, mode: DIRECTORY_MODE })
      writeAtomic(stampPath, `${payload.version}\n`)
    }

    return {
      action: alreadyCurrent ? 'current' : 'installed',
      version: payload.version,
      directory,
    }
  } catch (cause) {
    return {
      action: 'failed',
      version: payload.version,
      reason: cause instanceof Error ? cause.message : String(cause),
    }
  }
}

/** Read the version a previous run recorded, or undefined when there is none. */
function readStamp(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8').trim()
  } catch {
    return undefined
  }
}

/** Write a file in one step, so a crash cannot leave a half-written stamp. */
function writeAtomic(path: string, contents: string): void {
  const staging = `${path}.staging-${process.pid}`
  writeFileSync(staging, contents, { mode: STAMP_MODE })
  rmSync(path, { force: true })
  renameSync(staging, path)
}
