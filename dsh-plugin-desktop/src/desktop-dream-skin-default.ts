/**
 * Seed the first-run appearance of the bundled dream-skin plugin.
 *
 * `dsh-dream-skin` keeps its authoritative state in `$DSH_HOME/dream-skin.json`
 * and falls back to its own built-in factory look only when that file is
 * absent. The plugin's host half deliberately exposes no configuration for
 * those built-ins, so shipping a state file here is what lets a fresh
 * installation open with the prepared skin and wallpaper.
 *
 * An existing file is never touched: it belongs to the user, and the plugin
 * rewrites it on every preference change.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** State file name inside the DSH home directory, owned by the plugin. */
const STATE_FILENAME = 'dream-skin.json'
/** Owner-only: the state carries the user's wallpaper data URLs. */
const STATE_FILE_MODE = 0o600

/** Inputs required to seed the packaged dream-skin appearance. */
export interface DesktopDreamSkinSeedOptions {
  /** Harness home directory that owns the state file. */
  homeDir: string
  /** Packaged snapshot; seeding is skipped when it is absent. */
  snapshotPath: string
}

/** Outcome of one seeding attempt. */
export interface DesktopDreamSkinSeedResult {
  /** State file the plugin reads, whether or not this run wrote it. */
  statePath: string
  /** True only when this run created the state file. */
  seeded: boolean
}

/**
 * Write the packaged appearance when no state file exists yet.
 *
 * @param options - harness home directory and the packaged snapshot path.
 * @returns the plugin's state path and whether this run created it.
 */
export function seedDesktopDreamSkin(
  options: DesktopDreamSkinSeedOptions,
): DesktopDreamSkinSeedResult {
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
