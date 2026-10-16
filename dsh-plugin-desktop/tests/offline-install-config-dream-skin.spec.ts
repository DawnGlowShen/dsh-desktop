import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  configureDreamSkin,
  dreamSkinConfiguration,
  seedDesktopDreamSkin,
} from '../src/offline-install-config-dream-skin.ts'
import { applyPayloadConfigurations, type ConfigureContext } from '../src/offline-install-configure.ts'

const roots: string[] = []

function makeRoot(): { home: string; snapshotPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-dream-skin-'))
  roots.push(root)
  return { home: join(root, 'dsh'), snapshotPath: join(root, 'dream-skin-default.json') }
}

function writeSnapshot(path: string, state: unknown): void {
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true })
})

describe('seedDesktopDreamSkin', () => {
  it('writes the packaged appearance when no state file exists', () => {
    const { home, snapshotPath } = makeRoot()
    const state = { 'dsh-dream-skin:skin': 'mist', 'dsh-dream-skin:accent': '#4f83f2' }
    writeSnapshot(snapshotPath, state)

    const result = seedDesktopDreamSkin({ homeDir: home, snapshotPath })

    expect(result.seeded).toBe(true)
    expect(result.statePath).toBe(join(home, 'dream-skin.json'))
    expect(JSON.parse(readFileSync(result.statePath, 'utf8'))).toEqual(state)
  })

  it('keeps the state owner-only, matching the plugin write', () => {
    const { home, snapshotPath } = makeRoot()
    writeSnapshot(snapshotPath, { 'dsh-dream-skin:skin': 'mist' })

    const result = seedDesktopDreamSkin({ homeDir: home, snapshotPath })

    if (process.platform !== 'win32') {
      expect(statSync(result.statePath).mode & 0o777).toBe(0o600)
    }
  })

  it('never overwrites an existing state file', () => {
    const { home, snapshotPath } = makeRoot()
    writeSnapshot(snapshotPath, { 'dsh-dream-skin:skin': 'mist' })
    mkdirSync(home, { recursive: true })
    const existing = { 'dsh-dream-skin:skin': 'user-chosen' }
    writeFileSync(join(home, 'dream-skin.json'), JSON.stringify(existing), 'utf8')

    const result = seedDesktopDreamSkin({ homeDir: home, snapshotPath })

    expect(result.seeded).toBe(false)
    expect(JSON.parse(readFileSync(result.statePath, 'utf8'))).toEqual(existing)
  })

  it('does nothing when the packaged snapshot is absent', () => {
    const { home, snapshotPath } = makeRoot()

    const result = seedDesktopDreamSkin({ homeDir: home, snapshotPath })

    expect(result.seeded).toBe(false)
    expect(existsSync(result.statePath)).toBe(false)
  })

  it('rejects a snapshot that is not a JSON object instead of seeding it', () => {
    const { home, snapshotPath } = makeRoot()
    mkdirSync(join(home, '..'), { recursive: true })

    writeFileSync(snapshotPath, 'not json', 'utf8')
    expect(() => seedDesktopDreamSkin({ homeDir: home, snapshotPath })).toThrow()

    writeSnapshot(snapshotPath, ['a', 'b'])
    expect(() => seedDesktopDreamSkin({ homeDir: home, snapshotPath })).toThrow(/JSON object/u)

    expect(existsSync(join(home, 'dream-skin.json'))).toBe(false)
  })

  it('writes compact JSON so the file matches the plugin own output', () => {
    const { home, snapshotPath } = makeRoot()
    writeFileSync(snapshotPath, '{\n  "dsh-dream-skin:skin": "mist"\n}\n', 'utf8')

    const result = seedDesktopDreamSkin({ homeDir: home, snapshotPath })

    expect(readFileSync(result.statePath, 'utf8')).toBe('{"dsh-dream-skin:skin":"mist"}')
  })
})

/**
 * The wiring the registry consumes. The seeding itself is covered above, so these cases
 * pin only what a port can get wrong: where the snapshot is looked for, and whether an
 * absent one is reported as a skip rather than as a fault.
 */
describe('configureDreamSkin', () => {
  /**
   * A context whose DSH home and resources both hang under one temporary root.
   *
   * @param home - DSH home from {@link makeRoot}, whose parent is the root to build in.
   * @param snapshot - appearance to ship, or undefined to ship none.
   */
  function makeContext(home: string, snapshot: unknown | undefined): ConfigureContext {
    const root = dirname(home)
    const resourcesPath = join(root, 'resources')
    mkdirSync(resourcesPath, { recursive: true })
    if (snapshot !== undefined) {
      writeFileSync(join(resourcesPath, 'dream-skin-default.json'), JSON.stringify(snapshot))
    }
    return {
      homeDir: join(root, 'dsh'),
      userHomeDir: join(root, 'user'),
      platform: 'darwin',
      resourcesPath,
      binName: 'dsh-test',
      logger: { error: () => {} },
    }
  }

  it('seeds the state file from the packaged snapshot beside the application', () => {
    const { home } = makeRoot()
    const context = makeContext(home, { 'dsh-dream-skin:skin': 'mist' })

    const outcome = configureDreamSkin(context)

    expect(outcome).toEqual({ name: 'dream-skin', action: 'configured' })
    expect(JSON.parse(readFileSync(join(context.homeDir, 'dream-skin.json'), 'utf8')))
      .toEqual({ 'dsh-dream-skin:skin': 'mist' })
  })

  it('skips rather than fails when the build ships no prepared appearance', () => {
    const { home } = makeRoot()
    const context = makeContext(home, undefined)

    const outcome = configureDreamSkin(context)

    // A build without a snapshot is a normal build. Reporting this as a failure would
    // send an operator looking for a problem that does not exist.
    expect(outcome.action).toBe('skipped')
    expect(outcome.reason).toContain('dream-skin-default.json')
  })

  it('leaves an existing appearance alone and says so', () => {
    const { home } = makeRoot()
    const context = makeContext(home, { 'dsh-dream-skin:skin': 'mist' })
    mkdirSync(context.homeDir, { recursive: true })
    const chosen = { 'dsh-dream-skin:skin': 'user-chosen' }
    writeFileSync(join(context.homeDir, 'dream-skin.json'), JSON.stringify(chosen), 'utf8')

    const outcome = configureDreamSkin(context)

    expect(outcome.action).toBe('current')
    expect(JSON.parse(readFileSync(join(context.homeDir, 'dream-skin.json'), 'utf8'))).toEqual(chosen)
  })

  it('propagates a malformed snapshot as a failure instead of writing it', () => {
    const { home } = makeRoot()
    const context = makeContext(home, undefined)
    writeFileSync(join(context.resourcesPath, 'dream-skin-default.json'), 'not json', 'utf8')

    // The executor turns this into a `failed` outcome; what matters here is that it is
    // raised rather than swallowed, so a shipped-but-broken file is visible.
    expect(() => configureDreamSkin(context)).toThrow()
    expect(existsSync(join(context.homeDir, 'dream-skin.json'))).toBe(false)
  })

  it('produces no error-level log line when it skips', () => {
    // The spec calls the missing-resource case a silent skip, and "silent" is the part a
    // reader of the log depends on: an error line sends an operator looking for a fault
    // that does not exist. The outcome alone cannot show this, so the logger is captured
    // through the executor, which is what decides the level.
    const { home } = makeRoot()
    const errors: string[] = []
    const infos: string[] = []
    const context: ConfigureContext = {
      homeDir: home,
      userHomeDir: join(dirname(home), 'user'),
      platform: 'darwin',
      resourcesPath: join(dirname(home), 'resources-with-nothing'),
      binName: 'dsh-test',
      logger: {
        info: message => { infos.push(message) },
        error: message => { errors.push(message) },
      },
    }

    const outcomes = applyPayloadConfigurations(context, [dreamSkinConfiguration])
    for (const outcome of outcomes) {
      if (outcome.action === 'failed') context.logger.error(`${outcome.name}: ${outcome.reason ?? ''}`)
      else context.logger.info?.(`${outcome.name}: ${outcome.action}`)
    }

    expect(outcomes[0]?.action).toBe('skipped')
    expect(errors).toEqual([])
    expect(infos.join('\n')).toContain('dream-skin')
  })

  it('declares seed, so the user appearance is never overwritten', () => {
    expect(dreamSkinConfiguration.mode).toBe('seed')
  })
})

/**
 * The packaged appearance, seeded for real.
 *
 * The cases above build their own snapshots, which proves the seeding logic but not that
 * it agrees with the file this repository actually ships. The two can drift — a
 * regeneration that writes a different shape, or a snapshot edited by hand — and nothing
 * else in the suite would notice, because every other case supplies its own input.
 *
 * Skipped when the snapshot is absent: a checkout that has not run
 * `scripts/prepare-dream-skin-default.mjs` is a normal state, and demanding a regenerated
 * file would make the suite fail for a reason unrelated to the code under test.
 */
const shippedSnapshot = join(dirname(fileURLToPath(import.meta.url)), '..', 'build', 'dream-skin-default.json')

describe.skipIf(!existsSync(shippedSnapshot))('the shipped dream-skin appearance', () => {
  it('seeds a fresh home from the file this repository commits', () => {
    const { home } = makeRoot()
    const context: ConfigureContext = {
      homeDir: home,
      userHomeDir: join(dirname(home), 'user'),
      platform: process.platform,
      resourcesPath: dirname(shippedSnapshot),
      binName: 'dsh-test',
      logger: { error: () => {} },
    }

    const outcome = configureDreamSkin(context)

    expect(outcome.action).toBe('configured')
    const statePath = join(home, 'dream-skin.json')
    // Byte-for-byte equal: the plugin reads this file, and anything the seeding added or
    // dropped would be a difference the user sees rather than one the tests do.
    expect(JSON.parse(readFileSync(statePath, 'utf8')))
      .toEqual(JSON.parse(readFileSync(shippedSnapshot, 'utf8')))
    // A wallpaper must actually be present, or a fresh installation opens to the plugin's
    // factory look and the whole feature has done nothing.
    expect(JSON.parse(readFileSync(statePath, 'utf8'))['dsh-dream-skin:wallpaper'])
      .toMatch(/^data:image\//u)

    // Second run leaves it alone, which is what `seed` promises.
    expect(configureDreamSkin(context).action).toBe('current')
  })
})
