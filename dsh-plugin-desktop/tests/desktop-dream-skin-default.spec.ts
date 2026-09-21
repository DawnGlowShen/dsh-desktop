import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { seedDesktopDreamSkin } from '../src/desktop-dream-skin-default.ts'

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
