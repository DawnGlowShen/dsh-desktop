#!/usr/bin/env node
/**
 * Regenerate the packaged dream-skin appearance from a tuned state file.
 *
 * `dsh-dream-skin` keeps its authoritative state in `$DSH_HOME/dream-skin.json`.
 * A fresh installation only opens with that look because the desktop client
 * ships a copy and seeds it when the file is absent, so the shipped copy has to
 * be refreshed whenever the tuned appearance changes.
 *
 * The wallpaper-history key is dropped: it is a JSON array of every wallpaper
 * the user has ever tried (hundreds of KB, and growing), not part of the look.
 *
 * Usage:
 *   node scripts/prepare-dream-skin-default.mjs
 *   node scripts/prepare-dream-skin-default.mjs --from /path/to/dream-skin.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Recents list owned by the plugin; deliberately not shipped. */
const HISTORY_KEY = 'dsh-dream-skin:wallpaper-history'
/** Both editions seed the same appearance; only release identity differs. */
const VARIANTS = ['dsh-plugin-desktop', 'dsh-plugin-desktop-beta']
/** Target file name inside each variant's build resources. */
const TARGET_NAME = 'dream-skin-default.json'
/** Keys that must be present for the snapshot to reproduce a look at all. */
const REQUIRED_KEYS = ['dsh-dream-skin:skin', 'dsh-dream-skin:wallpaper']

const root = resolve(import.meta.dirname, '..')

/** Default source: the state file of the harness home that owns it. */
function defaultSource() {
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'dream-skin.json')
}

const fromIndex = process.argv.indexOf('--from')
if (fromIndex !== -1 && process.argv[fromIndex + 1] === undefined) {
  process.stderr.write('prepare-dream-skin-default: --from needs a path\n')
  process.exit(2)
}
const source = fromIndex === -1 ? defaultSource() : resolve(process.argv[fromIndex + 1])

if (!existsSync(source)) {
  process.stderr.write(`prepare-dream-skin-default: no state file at ${source}\n`)
  process.exit(1)
}

const state = JSON.parse(readFileSync(source, 'utf8'))
if (state === null || typeof state !== 'object' || Array.isArray(state)) {
  process.stderr.write('prepare-dream-skin-default: state file must be a JSON object\n')
  process.exit(1)
}

for (const key of REQUIRED_KEYS) {
  if (state[key] === undefined || state[key] === null) {
    process.stderr.write(`prepare-dream-skin-default: state file is missing ${key}\n`)
    process.exit(1)
  }
}

// Sorted keys keep the snapshot diffable across regenerations; the plugin reads
// the object by key, so order carries no meaning.
const keys = Object.keys(state).filter((key) => key !== HISTORY_KEY).sort()
const snapshot = Object.fromEntries(keys.map((key) => [key, state[key]]))
const body = JSON.stringify(snapshot)

const dropped = Object.hasOwn(state, HISTORY_KEY) ? `, dropped ${HISTORY_KEY}` : ''
process.stdout.write(`prepare-dream-skin-default: ${source}\n`)
process.stdout.write(`  ${String(keys.length)} keys, ${String(body.length)} bytes${dropped}\n`)

for (const variant of VARIANTS) {
  const target = join(root, variant, 'build', TARGET_NAME)
  mkdirSync(join(root, variant, 'build'), { recursive: true })
  writeFileSync(target, body, 'utf8')
  process.stdout.write(`  wrote ${variant}/build/${TARGET_NAME}\n`)
}

// Surface the values that are invisible in a diff yet define the look.
for (const key of keys) {
  if (key.endsWith('-opacity')) process.stdout.write(`  ${key} = ${JSON.stringify(state[key])}\n`)
}
