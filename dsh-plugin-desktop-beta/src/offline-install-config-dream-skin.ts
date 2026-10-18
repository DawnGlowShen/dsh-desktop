/**
 * Seed the first-run appearance of the bundled dream-skin plugin.
 *
 * `dsh-dream-skin` keeps its authoritative state in `$DSH_HOME/dream-skin.json` and falls
 * back to its own built-in factory look only when that file is absent. The plugin's host
 * half deliberately exposes no configuration for those built-ins, so shipping a state file
 * here is what lets a fresh installation open with the prepared skin and wallpaper.
 *
 * ## Why this is `seed` and not `converge`
 *
 * The file belongs to the user. Once they have picked a skin or a wallpaper, the plugin
 * rewrites `dream-skin.json` on every change — so by the time this runs again the contents
 * are their choice, not ours. Overwriting would silently undo their work on the next
 * launch, and a restore button would become a "reset my appearance" button, which is not
 * what it says.
 *
 * The file is therefore written only when it does not exist, and a missing packaged
 * snapshot is a quiet skip rather than a failure: a build that ships no prepared
 * appearance is a normal build, not a broken one.
 *
 * ## Snapshot provenance
 *
 * `dream-skin-default.json` rides beside the application as an extra resource. It is
 * generated from a tuned state file by `scripts/prepare-dream-skin-default.mjs`, which
 * drops the wallpaper-history key — a growing record of everything the user has tried,
 * not part of the look.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ConfigureContext, ConfigureOutcome, PayloadConfiguration } from './offline-install-configure.ts'

/** Registry name of the dream-skin configuration. */
export const DREAM_SKIN_CONFIGURATION_NAME = 'dream-skin'

/** State file name inside the DSH home directory, owned by the plugin. */
const STATE_FILENAME = 'dream-skin.json'

/** File name of the packaged appearance inside Electron's resources directory. */
const SNAPSHOT_FILENAME = 'dream-skin-default.json'

/** Owner-only: the state carries the user's wallpaper data URLs. */
const STATE_FILE_MODE = 0o600

/** Inputs required to seed the packaged dream-skin appearance. */
export interface DreamSkinSeedOptions {
  /** Harness home directory that owns the state file. */
  readonly homeDir: string
  /** Packaged snapshot; seeding is skipped when it is absent. */
  readonly snapshotPath: string
}

/** Outcome of one seeding attempt. */
export interface DreamSkinSeedResult {
  /** State file the plugin reads, whether or not this run wrote it. */
  readonly statePath: string
  /** True only when this run created the state file. */
  readonly seeded: boolean
}

/**
 * Write the packaged appearance when no state file exists yet.
 *
 * @param options - harness home directory and the packaged snapshot path.
 * @returns the plugin's state path and whether this run created it.
 */
export function seedDesktopDreamSkin(options: DreamSkinSeedOptions): DreamSkinSeedResult {
  const statePath = join(options.homeDir, STATE_FILENAME)
  const unchanged = { statePath, seeded: false }
  if (existsSync(statePath)) return unchanged
  if (!existsSync(options.snapshotPath)) return unchanged

  // Re-parse before writing: a corrupt snapshot must fail here rather than
  // leave the plugin with a file it silently discards.
  const snapshot: unknown = JSON.parse(readFileSync(options.snapshotPath, 'utf8'))
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new Error('dsh-plugin-desktop: dream-skin snapshot must be a JSON object')
  }

  mkdirSync(dirname(statePath), { recursive: true })
  // Match the plugin's own atomic write so a concurrent read never observes a
  // partial object, including its direct-write fallback for Windows renames.
  const body = JSON.stringify(snapshot)
  const temporary = `${statePath}.tmp`
  writeFileSync(temporary, body, { encoding: 'utf8', mode: STATE_FILE_MODE })
  try {
    renameSync(temporary, statePath)
  } catch {
    writeFileSync(statePath, body, { encoding: 'utf8', mode: STATE_FILE_MODE })
    rmSync(temporary, { force: true })
  }
  return { statePath, seeded: true }
}

/**
 * Seed the dream-skin appearance as the registry consumes it.
 *
 * A missing snapshot is reported as `skipped`, not `failed`: the packaged appearance is
 * an optional extra, and a build without it must not look like a build with a problem.
 * An unreadable or malformed snapshot does throw — that one is worth reporting, because
 * it means a file was shipped and is wrong.
 *
 * @param context - Application facts, including the resources directory.
 * @returns what this run did, in the executor's terms.
 */
export function configureDreamSkin(context: ConfigureContext): ConfigureOutcome {
  const name = DREAM_SKIN_CONFIGURATION_NAME
  const snapshotPath = join(context.resourcesPath, SNAPSHOT_FILENAME)

  if (!existsSync(snapshotPath)) {
    return { name, action: 'skipped', reason: `no packaged appearance at ${snapshotPath}` }
  }

  const result = seedDesktopDreamSkin({ homeDir: context.homeDir, snapshotPath })
  return {
    name,
    action: result.seeded ? 'configured' : 'current',
    // The reason is dropped on a real write, where the action already says what happened.
    ...(result.seeded ? {} : { reason: `${result.statePath} already exists` }),
  }
}

/**
 * The dream-skin configuration as the registry consumes it.
 *
 * `seed`: see the module header — the target is the user's own appearance, and this
 * exists to give a fresh installation a starting point rather than to keep enforcing one.
 */
export const dreamSkinConfiguration: PayloadConfiguration = {
  name: DREAM_SKIN_CONFIGURATION_NAME,
  mode: 'seed',
  apply: configureDreamSkin,
}
