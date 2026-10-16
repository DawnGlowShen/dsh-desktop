/**
 * Shared on-disk conventions for the offline installer.
 *
 * The plugin and CLI installers lay out their payloads the same way — one directory per
 * item plus a version stamp beside it — so both need the same modes and stamp name. They
 * live here rather than being repeated in each installer, where a change to one copy
 * would silently leave the other writing a directory the first would not recognise.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Mode for the payload and shim directories this installer creates. */
export const DIRECTORY_MODE = 0o755

/** Mode for a stamp recording which version was installed. */
export const STAMP_MODE = 0o644

/** File, beside a payload, recording the version that produced it. */
export const VERSION_STAMP = '.dsh-offline-version'

/**
 * Read the version a previously installed payload recorded.
 *
 * A missing or unreadable stamp reads as "unknown version", which callers treat as
 * needing installation — the safe direction, since reinstalling an identical payload is
 * harmless while skipping a stale one leaves the old files in place.
 *
 * @param root - Directory holding the payload and its stamp.
 * @returns The recorded version, or undefined when none can be read.
 */
export function installedVersion(root: string): string | undefined {
  const stamp = join(root, VERSION_STAMP)
  if (!existsSync(stamp)) return undefined
  try {
    return readFileSync(stamp, 'utf8').trim()
  } catch {
    return undefined
  }
}
