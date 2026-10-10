/**
 * Proves the CI watchdog on the sidebar Browser step actually kills a wedged
 * command, so the failure mode it exists for cannot regress silently.
 *
 * The hazard it guards is real and specific. `verify-sidebar-browser.mjs`
 * installs its own 90-second watchdog, but that timer lives in the Electron
 * main process: when that process deadlocks, its event loop stops and the
 * timer never fires — which is exactly how run 37923686283 spent 36 minutes
 * on this step until the job's 45-minute budget killed the whole `check`.
 * Only a supervisor outside the process can end it, and CI relies on GNU
 * `timeout` from coreutils to be that supervisor.
 *
 * This runs everywhere, not just on Linux. It does not need the network, a
 * database, a build, Electron, or a display; it needs only the shell and a
 * `timeout` binary. On a machine without one the check is skipped rather than
 * failed, so a macOS development box does not become un-runnable just because
 * CI's watchdog is absent there.
 *
 * A `timeout` on PATH is not proof of GNU `timeout`: Windows ships its own,
 * with entirely different syntax (`timeout /t` pauses an interactive shell).
 * The one there would reject GNU arguments and could never supervise an
 * Electron process, so a probe runs before anything is asserted — see
 * `probeTimeout()`.
 *
 * Usage: node scripts/verify-sidebar-browser-timeout.mjs
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** GNU timeout reports a killed command as 124. */
const TIMEOUT_EXIT_CODE = 124
const SECONDS = 2

const repositoryRoot = resolve(fileURLToPath(import.meta.url), '..', '..')
const workflow = join(repositoryRoot, '.github', 'workflows', 'ci.yml')

function readSidebarBrowserStep() {
  const source = readFileSync(workflow, 'utf8')
  const step = source.split('\n').find(line => line.includes('verify:sidebar-browser'))
  assert.ok(step, `ci.yml no longer runs verify:sidebar-browser; ${workflow} changed`)
  return step.trim()
}

/**
 * Asks the `timeout` on PATH to run a command that exits immediately. Only the
 * GNU implementation reports the child's own exit status; Windows' built-in
 * rejects `0` as a duration ("Invalid syntax. Default option is not allowed
 * more than '1' time(s).") and returns non-zero. Anything that is not a
 * working GNU `timeout` disables the runtime half of this check — CI on
 * ubuntu-latest ships coreutils, so it always exercises it there.
 */
function probeTimeout() {
  const outcome = spawnSync('timeout', ['1', 'true'], { encoding: 'utf8', timeout: 60_000, shell: false })
  if (outcome.error) return { usable: false, detail: outcome.error.message }
  if (outcome.status === 0) return { usable: true, detail: 'GNU timeout' }
  return { usable: false, detail: (outcome.stderr ?? '').trim().split('\n')[0] || `exit ${outcome.status}` }
}

const step = readSidebarBrowserStep()
const guarded = /(?:^|\s)(?:\S*\/)?timeout\s+\d+\s+xvfb-run\s/.test(step)
assert.ok(
  guarded,
  `the sidebar Browser step is not wrapped in a timeout: ${step}\n` +
    'Without it a wedged Electron runs until the job budget expires and the whole check job is lost.',
)

const probe = probeTimeout()
if (!probe.usable) {
  console.log(
    `SKIPPED: the step is wrapped correctly, but the \`timeout\` on PATH is not GNU timeout ` +
      `(${probe.detail}), so the watchdog cannot be exercised here.\n` +
      `Checked: ${step}\n` +
      'CI runs on ubuntu-latest, which ships coreutils, and exercises it on every run.',
  )
  process.exit(0)
}

const directory = mkdtempSync(join(tmpdir(), 'dsh-timeout-check-'))
try {
  // A command that exits on its own: the watchdog must leave its exit status
  // alone. The 60s guard budget below is far above this command's own lifetime
  // and far below the job budget, so it only fires if `timeout` itself strands
  // the caller.
  const quick = join(directory, 'quick.sh')
  writeFileSync(quick, '#!/bin/sh\necho watchdog-left-me-alone\n', { mode: 0o755 })
  const fine = spawnSync('timeout', [String(SECONDS), quick], { encoding: 'utf8', timeout: 60_000 })
  assert.equal(fine.status, 0, `a fast command must survive the watchdog: ${fine.error ?? fine.stderr}`)
  assert.equal(fine.stdout.trim(), 'watchdog-left-me-alone')

  // A command that wedges without ever touching its event loop.
  const wedged = join(directory, 'wedged.sh')
  writeFileSync(wedged, '#!/bin/sh\nsleep 60\n', { mode: 0o755 })
  const began = Date.now()
  const killed = spawnSync('timeout', [String(SECONDS), wedged], { encoding: 'utf8' })
  const elapsed = Date.now() - began
  assert.equal(killed.status, TIMEOUT_EXIT_CODE, 'the watchdog must report a timeout as 124')
  assert.ok(elapsed < 30_000, `the watchdog took ${elapsed}ms to end a wedged command`)

  console.log(
    `Sidebar Browser timeout verified: \`${step.replace(/^run:\s*/, '')}\`.\n` +
      `A wedged command is ended after ${SECONDS}s with exit ${TIMEOUT_EXIT_CODE} (measured ${elapsed}ms); ` +
      'a fast command is left untouched.',
  )
} finally {
  rmSync(directory, { recursive: true, force: true })
}
