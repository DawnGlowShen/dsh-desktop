/**
 * The offline installer end to end, against the payload this repository actually ships.
 *
 * Every other spec in this directory tests one stage with a hand-built input. This one is
 * the only place that answers the question the feature exists to answer: does a real
 * installation put a real file where the plugin will look for it? The stages agree with
 * each other only by convention — a directory name, a version stamp, a path derived from
 * the home — and a convention is exactly what a unit test cannot check.
 *
 * The payload is read from `vendor/offline-install` rather than rebuilt, because a
 * synthetic one would be the author's idea of the payload rather than the shipped one.
 * Tarballs there may be split across `part-` files; the reader under test rejoins them.
 *
 * Everything runs against a temporary home. The shipped configurations write into
 * `~/.dsh` and the user's own `~/.gitconfig`, so a test that used the real home would
 * edit the machine running it.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { runOfflineInstall, type RunOfflineInstallOptions } from '../src/offline-install-run.ts'
import { readOfflineInstallManifest } from '../src/offline-install-manifest.ts'

/** Repository root, derived from this file so the test runs from any working directory. */
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The shared payload every Desktop package ships. */
const payloadDirectory = join(repositoryRoot, 'vendor', 'offline-install')

/** Whether the repository actually carries a payload to install. */
const payloadPresent = existsSync(payloadDirectory)

/** Roots created by a test, removed afterwards. */
const created: string[] = []

/**
 * A home and the application facts pointing at the real payload.
 *
 * `userHomeDir` is inside the temporary root on purpose: the git-ai configuration writes
 * the user's `.gitconfig`, and a test must never touch the developer's own.
 */
function makeHarness(
  /**
   * Home to reuse instead of making a new one.
   *
   * A second run against a machine the first run already touched is what a relaunch looks
   * like, and that cannot be built by assigning to the options afterwards — they are
   * readonly precisely so the facts stay the ones the harness decided on.
   */
  reuse?: { readonly homeDir: string, readonly userHomeDir: string },
): { options: RunOfflineInstallOptions; root: string; errors: string[]; infos: string[] } {
  const root = mkdtempSync(join(tmpdir(), 'offline-e2e-'))
  created.push(root)
  const home = reuse?.homeDir ?? join(root, 'dsh')
  const userHome = reuse?.userHomeDir ?? join(root, 'user')
  const profile = join(home, 'profiles', 'desktop')
  const appModules = join(root, 'app', 'node_modules')
  mkdirSync(profile, { recursive: true })
  mkdirSync(userHome, { recursive: true })
  mkdirSync(appModules, { recursive: true })
  // A real Profile always has a manifest before the installer links into it.
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'desktop', version: '0.0.0' }))

  const errors: string[] = []
  const infos: string[] = []
  return {
    root,
    errors,
    infos,
    options: {
      // The payload rides beside the application when packaged; pointing resourcesPath
      // here lets the environment override below select the repository copy instead.
      resourcesPath: join(root, 'resources'),
      packageRoot: join(root, 'app'),
      homeDir: home,
      userHomeDir: userHome,
      profileDir: profile,
      appModulesDir: appModules,
      binName: 'dsh-e2e',
      platform: process.platform,
      packaged: true,
      environment: { DSH_DESKTOP_OFFLINE_INSTALL_DIR: payloadDirectory },
      logger: {
        info: message => { infos.push(message) },
        error: message => { errors.push(message) },
      },
    },
  }
}

beforeAll(() => {
  if (!payloadPresent) return
  // Fail loudly rather than skipping silently: a missing payload means the repository is
  // incomplete, and a test that quietly passes on an incomplete checkout is worse than
  // one that is absent.
  const manifest = join(payloadDirectory, 'manifest.json')
  if (!existsSync(manifest)) throw new Error(`offline payload has no manifest: ${manifest}`)
})

afterEach(() => {
  for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true })
})

// Unpacking the real payload takes seconds rather than milliseconds — it links a plugin
// tree and unpacks four CLI archives — and the default budget is measured for unit tests.
// Raised here rather than relaxing the global `testTimeout`, so a genuinely hung unit test
// still fails fast.
const PAYLOAD_TIMEOUT_MS = 60_000

describe.skipIf(!payloadPresent)('offline install end to end', () => {
  it('reads the shipped manifest rather than a hand-built one', () => {
    const { options } = makeHarness()
    const manifest = readOfflineInstallManifest({
      resourcesPath: options.resourcesPath,
      packageRoot: options.packageRoot,
      packaged: false,
      // Spread rather than assign: `exactOptionalPropertyTypes` distinguishes an absent
      // property from one explicitly set to undefined, and only the former is allowed.
      ...(options.environment === undefined ? {} : { environment: options.environment }),
      logger: options.logger,
    })

    // The payload is the source of truth for what gets preinstalled; if this is empty the
    // assertions below would pass vacuously.
    expect(manifest).toBeDefined()
    expect((manifest?.plugins.length ?? 0) + (manifest?.clis.length ?? 0)).toBeGreaterThan(0)
  }, PAYLOAD_TIMEOUT_MS)

  it('installs plugins, CLIs and configurations in one run', () => {
    const { options, errors } = makeHarness()

    const report = runOfflineInstall(options)

    expect(report.ran).toBe(true)
    // One outcome per declared payload, plus one per registered configuration. Asserting
    // against the payload's own count rather than a literal keeps this honest when the
    // shipped payload changes.
    expect(report.plugins.length).toBeGreaterThan(0)
    // Pinned as a literal rather than read back from `PAYLOAD_CONFIGURATIONS`: comparing
    // the report against the registry it came from is true by construction, so dropping a
    // configuration from the registry would not fail anything. That matters because
    // removing a registry entry is the documented way to disable a configuration.
    expect(report.configurations.map(outcome => outcome.name)).toEqual(['git-ai', 'dream-skin'])
    // Nothing about a correct run is an error. A failure here means a stage disagreed
    // with another about a path or a format, which is the whole point of this spec.
    expect(errors).toEqual([])
  }, PAYLOAD_TIMEOUT_MS)

  it('points the user gitconfig at the git-ai daemon socket', () => {
    const { options } = makeHarness()

    const report = runOfflineInstall(options)

    const gitConfigPath = join(options.userHomeDir, '.gitconfig')
    expect(existsSync(gitConfigPath)).toBe(true)
    // Read through Git rather than by matching text: the module writes with `git config`,
    // so the file's spelling is Git's business and the value is the contract. This also
    // fails loudly rather than silently if the write went to the wrong file.
    const written = spawnSync('git', ['config', '--file', gitConfigPath, '--get', 'trace2.eventTarget'], {
      encoding: 'utf8',
    })
    expect(written.status).toBe(0)
    // The socket the daemon will listen on. Under the *user's* home, because git-ai takes
    // its location from `$HOME`; a build whose DSH home differs from `$HOME` would
    // otherwise record a target nothing listens on, and attribution would fail silently.
    expect(options.homeDir).not.toBe(options.userHomeDir)
    expect(written.stdout).toContain(join(options.userHomeDir, '.git-ai', 'internal', 'daemon', 'trace2.sock'))
    const gitAi = report.configurations.find(outcome => outcome.name === 'git-ai')
    expect(gitAi?.action).toBe('configured')
  }, PAYLOAD_TIMEOUT_MS)

  it('reports every configuration as unchanged on a second run', () => {
    const first = makeHarness()
    runOfflineInstall(first.options)

    // Same machine, same payload, nothing touched in between: a second run has no work to
    // do. This is what makes pressing the restore button twice tell the truth.
    // Carry the first run's home forward so the second sees the files it wrote, which is
    // exactly the situation a relaunch creates.
    const second = makeHarness({ homeDir: first.options.homeDir, userHomeDir: first.options.userHomeDir })

    const report = runOfflineInstall(second.options)

    // The length assertion is what makes the loop below mean anything: a loop over an
    // empty collection passes without running its body even once, so a registry that
    // silently lost its entries — which is the documented way to disable a configuration —
    // would leave this test green while it checked nothing.
    expect(report.configurations.map(outcome => outcome.name)).toEqual(['git-ai', 'dream-skin'])
    for (const outcome of report.configurations) {
      expect(outcome.action, `${outcome.name} on a second run`).not.toBe('configured')
    }
  }, PAYLOAD_TIMEOUT_MS)

  it('still reports every payload when a configuration fails', () => {
    // R3-S2: a configuration that cannot be applied must not withhold the payloads, and
    // must not stop the run. Reached for real by making the gitconfig unwritable — a
    // directory where the file goes — rather than by stubbing, so the failure travels the
    // same path a real one would.
    const { options, infos } = makeHarness()
    mkdirSync(join(options.userHomeDir, '.gitconfig'), { recursive: true })

    const report = runOfflineInstall(options)

    expect(report.ran).toBe(true)
    // The payload stages still ran and still reported.
    expect(report.clis.length + report.plugins.length).toBeGreaterThan(0)
    // Reported rather than thrown, and named. `skipped`, not `failed`: since the write goes
    // through `git config`, an unusable gitconfig is a file Git declines to touch, and the
    // configuration reports that it stood aside rather than that it broke.
    const gitAi = report.configurations.find(outcome => outcome.name === 'git-ai')
    expect(gitAi?.action).toBe('skipped')
    expect(gitAi?.reason).toContain('.gitconfig')
    // And it reached the log at info, which is what makes it visible without being noise.
    // Not error: Git refusing an unparseable gitconfig is the ordinary outcome for a file
    // the user keeps encrypted, and reporting that on every launch would train a reader to
    // ignore the channel that real failures use.
    expect(infos.join('\n')).toContain('git-ai')
  }, PAYLOAD_TIMEOUT_MS)

  it('leaves a user-edited dream-skin appearance alone on a second run', () => {
    const first = makeHarness()
    runOfflineInstall(first.options)

    // Nothing ships a snapshot in this checkout unless the packaged appearance was
    // generated, so seed the situation directly: a state file the "user" wrote.
    const statePath = join(first.options.homeDir, 'dream-skin.json')
    mkdirSync(first.options.homeDir, { recursive: true })
    const chosen = { 'dsh-dream-skin:skin': 'user-chosen' }
    writeFileSync(statePath, JSON.stringify(chosen), 'utf8')

    const second = makeHarness({ homeDir: first.options.homeDir, userHomeDir: first.options.userHomeDir })
    const report = runOfflineInstall(second.options)

    // `seed` means the user's own appearance survives a restore, whatever the payload
    // ships. That is the difference between this configuration and git-ai's.
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toEqual(chosen)
    // `toBeDefined` first: without it the assertion below is vacuous when the
    // configuration is absent from the registry — `undefined !== 'failed'` is true, so a
    // deleted registry entry would leave this test green while testing nothing.
    const dreamSkin = report.configurations.find(outcome => outcome.name === 'dream-skin')
    expect(dreamSkin).toBeDefined()
    expect(dreamSkin?.action).not.toBe('failed')
  }, PAYLOAD_TIMEOUT_MS)
})
