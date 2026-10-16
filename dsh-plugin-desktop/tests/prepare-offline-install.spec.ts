/**
 * The payload assembler is the only thing standing between an authored manifest and a
 * signed application, so these cover the refusals rather than the happy path alone: a
 * manifest that names a file the package does not carry would fail on a user's machine,
 * long after the build that shipped it.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  offlineCliManifest,
  offlineInstallBuildPaths,
  parsePayloadManifest,
  prepareOfflineInstallPayload,
  verifyPreparedOfflineInstall,
} from '../scripts/prepare-offline-install.ts'

const roots: string[] = []

/**
 * A Desktop package root inside a throwaway repository.
 *
 * The payload is shared by every Desktop package and lives one level above them, at
 * `<repo>/vendor/offline-install`. A fixture that made only a package root would point
 * every test in this file at the same temporary payload directory, so the repository
 * root is created first and tracked for cleanup instead.
 */
function desktopRoot(manifest?: unknown, tarballs: readonly string[] = []): string {
  const root = packageRoot()
  const source = offlineInstallBuildPaths(root).source
  mkdirSync(source, { recursive: true })
  if (manifest !== undefined) {
    writeFileSync(join(source, 'manifest.json'), JSON.stringify(manifest))
    for (const name of tarballs) writeFileSync(join(source, name), `contents of ${name}`)
  }
  return root
}

/** A Desktop package root whose shared payload directory is absent. */
function packageRoot(): string {
  const repository = mkdtempSync(join(tmpdir(), 'offline-prepare-'))
  roots.push(repository)
  const root = join(repository, 'dsh-plugin-desktop')
  mkdirSync(root, { recursive: true })
  return root
}

/**
 * Author one platform's CLI payload.
 *
 * CLIs are native binaries, so they live under `cli/<target>/` rather than in the
 * shared manifest; a build merges exactly one target in.
 */
function authorClis(
  root: string,
  target: string,
  clis: readonly Record<string, unknown>[],
  tarballs: readonly string[] = [],
): void {
  const directory = offlineInstallBuildPaths(root).source
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, offlineCliManifest(target)), JSON.stringify({ version: 1, target, clis }))
  for (const name of tarballs) writeFileSync(join(directory, name), `contents of ${name}`)
}

/** An empty but valid manifest. */
const EMPTY = { version: 1, plugins: [], clis: [] }

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('offlineInstallBuildPaths', () => {
  it('reads the shared payload one level above the package and prepares inside it', () => {
    const root = packageRoot()
    const paths = offlineInstallBuildPaths(root)
    expect(paths.source).toBe(resolve(root, '..', 'vendor', 'offline-install'))
    expect(paths.prepared).toBe(join(root, '.desktop-build', 'offline-install'))
  })
})

describe('parsePayloadManifest', () => {
  it('accepts an empty payload with no plugins and no CLIs', () => {
    expect(parsePayloadManifest(EMPTY)).toEqual({ version: 1, plugins: [], clis: [] })
  })

  it('reads a plugin entry down to its tarball', () => {
    const parsed = parsePayloadManifest({
      version: 1,
      plugins: [{ name: 'dsh-mnemon', version: '0.5.24', tarball: 'dsh-mnemon-0.5.24.tgz' }],
      clis: [],
    })
    expect(parsed.plugins).toEqual([{ name: 'dsh-mnemon', version: '0.5.24', tarball: 'dsh-mnemon-0.5.24.tgz' }])
  })

  it('reads a CLI entry down to its executable', () => {
    const parsed = parsePayloadManifest({
      version: 1,
      plugins: [],
      clis: [{ name: 'codegraph', version: '1.6.0', tarball: 'codegraph.tgz', executable: 'bin/codegraph' }],
    })
    expect(parsed.clis).toEqual([
      { name: 'codegraph', version: '1.6.0', tarball: 'codegraph.tgz', executable: 'bin/codegraph' },
    ])
  })

  it('treats absent lists as empty rather than refusing the manifest', () => {
    expect(parsePayloadManifest({ version: 1 })).toEqual({ version: 1, plugins: [], clis: [] })
  })

  it('refuses a manifest whose version this build cannot read', () => {
    expect(() => parsePayloadManifest({ version: 99, plugins: [], clis: [] }))
      .toThrow('manifest version 99 is not 1')
  })

  it('refuses a manifest that is not an object', () => {
    expect(() => parsePayloadManifest([])).toThrow('manifest is not an object')
    expect(() => parsePayloadManifest(null)).toThrow('manifest is not an object')
  })

  it('refuses a plugin entry with no name', () => {
    expect(() => parsePayloadManifest({ version: 1, plugins: [{ version: '1', tarball: 'a.tgz' }], clis: [] }))
      .toThrow('plugin #1 has no name')
  })

  it('refuses a plugin entry with no version', () => {
    expect(() => parsePayloadManifest({ version: 1, plugins: [{ name: 'a', tarball: 'a.tgz' }], clis: [] }))
      .toThrow('a has no version')
  })

  it('refuses a CLI entry with no executable', () => {
    expect(() => parsePayloadManifest({ version: 1, plugins: [], clis: [{ name: 'c', version: '1', tarball: 'c.tgz' }] }))
      .toThrow('c has no executable')
  })

  it('refuses a list that is not a list', () => {
    expect(() => parsePayloadManifest({ version: 1, plugins: {}, clis: [] })).toThrow('plugins is not a list')
    expect(() => parsePayloadManifest({ version: 1, plugins: [], clis: {} })).toThrow('clis is not a list')
  })

  it('refuses a tarball that would escape the payload', () => {
    // Judged by path segments: `resolve` is relative to the working directory, so it would
    // turn `../../evil.tgz` into an absolute path that looks contained.
    for (const tarball of ['../../evil.tgz', '/etc/passwd', 'a/../../evil.tgz']) {
      expect(() => parsePayloadManifest({ version: 1, plugins: [{ name: 'a', version: '1', tarball }], clis: [] }))
        .toThrow('outside the payload')
    }
  })

  it('refuses an executable that would escape the payload', () => {
    const entry = (executable: string) => ({ version: 1, plugins: [], clis: [{ name: 'c', version: '1', tarball: 'c.tgz', executable }] })
    expect(() => parsePayloadManifest(entry('../bin/c'))).toThrow('outside the payload')
    expect(() => parsePayloadManifest(entry('/usr/bin/c'))).toThrow('outside the payload')
  })
})

/** Occupy the shared payload path with a plain file. */
function payloadPathAsFile(root: string): void {
  const source = offlineInstallBuildPaths(root).source
  mkdirSync(dirname(source), { recursive: true })
  writeFileSync(source, 'not a directory')
}

describe('prepareOfflineInstallPayload', () => {
  it('reports nothing to package when no manifest is authored', () => {
    const prepared = prepareOfflineInstallPayload(desktopRoot())
    expect(prepared).toBeUndefined()
  })

  it('refuses to prepare when the shared payload directory is absent', () => {
    // A package whose payload moved or never arrived would otherwise be assembled into an
    // application that preinstalls nothing, reported in the log as a deliberate choice.
    const root = packageRoot()
    expect(() => prepareOfflineInstallPayload(root)).toThrow(/no payload directory at .*offline-install/u)
  })

  it('refuses to prepare when the shared payload path is a file', () => {
    // `existsSync` is true for a file too, so a path that is not a directory has to be
    // rejected on what it is rather than on whether something is there: the manifest
    // inside it cannot exist, and the run would otherwise be logged as "packaging none".
    const root = packageRoot()
    payloadPathAsFile(root)
    expect(() => prepareOfflineInstallPayload(root)).toThrow(/no payload directory at .*offline-install/u)
  })

  it('prepares an empty payload that carries only the manifest', () => {
    const root = desktopRoot(EMPTY)
    const prepared = prepareOfflineInstallPayload(root)
    expect(prepared?.tarballs).toEqual([])
    expect(JSON.parse(readFileSync(join(offlineInstallBuildPaths(root).prepared, 'manifest.json'), 'utf8')))
      .toEqual(EMPTY)
  })

  it('copies each tarball the manifest names', () => {
    const root = desktopRoot(
      { version: 1, plugins: [{ name: 'p', version: '1', tarball: 'p.tgz' }], clis: [] },
      ['p.tgz'],
    )
    const prepared = prepareOfflineInstallPayload(root)
    expect(prepared?.tarballs).toEqual(['p.tgz'])
    expect(readFileSync(join(prepared?.directory ?? '', 'p.tgz'), 'utf8')).toBe('contents of p.tgz')
  })

  it('refuses a manifest naming a tarball the package does not carry', () => {
    const root = desktopRoot({ version: 1, plugins: [{ name: 'p', version: '1', tarball: 'missing.tgz' }], clis: [] })
    expect(() => prepareOfflineInstallPayload(root)).toThrow('manifest names missing.tgz')
  })

  it('refuses a tarball present in the payload that no manifest entry names', () => {
    // Otherwise the build ships dead weight nobody can explain.
    const root = desktopRoot(EMPTY, ['orphan.tgz'])
    expect(() => prepareOfflineInstallPayload(root)).toThrow('orphan.tgz is in')
  })

  it('replaces a previous preparation rather than merging with it', () => {
    const root = desktopRoot(EMPTY, ['stale.tgz'])
    expect(() => prepareOfflineInstallPayload(root)).toThrow('no manifest entry names it')

    // The next build authors a clean payload; the stale file must not survive it.
    rmSync(join(offlineInstallBuildPaths(root).source, 'stale.tgz'))
    prepareOfflineInstallPayload(root)
    expect(() => verifyPreparedOfflineInstall(root)).not.toThrow()
  })

  it('reports what it prepared', () => {
    const root = desktopRoot(
      { version: 1, plugins: [{ name: 'p', version: '1', tarball: 'p.tgz' }], clis: [] },
      ['p.tgz'],
    )
    authorClis(root, 'linux-x64', [{ name: 'c', version: '1', tarball: 'c-linux-x64.tgz', executable: 'bin/c' }], ['c-linux-x64.tgz'])
    const messages: string[] = []
    prepareOfflineInstallPayload(root, message => messages.push(message), 'linux-x64')
    expect(messages).toEqual(['offline install: prepared 1 plugin(s) and 1 CLI(s) for linux-x64 and no dependency tree from 2 tarball(s)'])
  })

  it('merges one platform CLI section into the shipped manifest', () => {
    const root = desktopRoot(EMPTY)
    authorClis(root, 'linux-x64', [{ name: 'c', version: '1', tarball: 'c-linux-x64.tgz', executable: 'bin/c' }], ['c-linux-x64.tgz'])
    const prepared = prepareOfflineInstallPayload(root, () => {}, 'linux-x64')
    const shipped = JSON.parse(readFileSync(join(prepared?.directory ?? '', 'manifest.json'), 'utf8'))
    expect(shipped.clis).toEqual([
      { name: 'c', version: '1', tarball: 'c-linux-x64.tgz', executable: 'bin/c' },
    ])
    // The artifact ships beside the plugins, under the name the CLI manifest gave it.
    expect(readFileSync(join(prepared?.directory ?? '', 'c-linux-x64.tgz'), 'utf8')).toBe('contents of c-linux-x64.tgz')
  })

  it('ships no CLI when no target is named', () => {
    // A payload built without a target serves plugins only; shipping another
    // platform's binaries would be worse than shipping none.
    const root = desktopRoot(EMPTY)
    authorClis(root, 'linux-x64', [{ name: 'c', version: '1', tarball: 'c-linux-x64.tgz', executable: 'bin/c' }], ['c-linux-x64.tgz'])
    const prepared = prepareOfflineInstallPayload(root)
    const shipped = JSON.parse(readFileSync(join(prepared?.directory ?? '', 'manifest.json'), 'utf8'))
    expect(shipped.clis).toEqual([])
    expect(prepared?.tarballs).toEqual([])
  })

  it('ignores macOS metadata instead of reporting it as payload', () => {
    // `.DS_Store` lives in the authored tree on any machine where the directory has
    // been browsed in Finder. It is git-ignored and never meant to ship, so failing
    // the build over it would let an unrelated Finder window break a release.
    const root = desktopRoot(EMPTY)
    const source = offlineInstallBuildPaths(root).source
    writeFileSync(join(source, '.DS_Store'), 'finder noise')
    writeFileSync(join(source, '._p.tgz'), 'apple double')
    expect(() => prepareOfflineInstallPayload(root)).not.toThrow()
    // Skipped rather than copied: it is not payload, so it must reach neither the
    // orphan check nor the packaged application.
    expect(existsSync(join(offlineInstallBuildPaths(root).prepared, '.DS_Store'))).toBe(false)
  })

  it('refuses a target that authors no CLI payload', () => {
    const root = desktopRoot(EMPTY)
    expect(() => prepareOfflineInstallPayload(root, () => {}, 'win32-x64')).toThrow('no CLI payload authored at')
  })

  it('refuses CLIs declared in the shared manifest', () => {
    // They are platform-specific by nature, so a shared entry would ship to every
    // platform; the author must move it under cli/<target>/.
    const root = desktopRoot(
      { version: 1, plugins: [], clis: [{ name: 'c', version: '1', tarball: 'c.tgz', executable: 'bin/c' }] },
      ['c.tgz'],
    )
    expect(() => prepareOfflineInstallPayload(root)).toThrow('CLIs are platform-specific')
  })


  it('does not treat another target\'s split CLI artifacts as orphans', () => {
    // The bug the first two Windows runs hit: only `darwin-universal` exceeds the split
    // threshold, so a Windows build sees `codegraph-…-darwin-universal.tgz.part-aa` in
    // the payload while its manifest lists only `win32-x64`. The part does not end with
    // a target suffix, so recognizing artifacts by their whole name alone left it
    // looking like an unaccounted-for file —
    //   codegraph-1.6.0-darwin-universal.tgz.part-aa is in … but no manifest entry names it
    const root = desktopRoot(EMPTY)
    authorClis(root, 'win32-x64', [], [])
    const source = offlineInstallBuildPaths(root).source
    writeFileSync(join(source, 'codegraph-1.6.0-darwin-universal.tgz.part-aa'), 'part one')
    writeFileSync(join(source, 'codegraph-1.6.0-darwin-universal.tgz.part-ab'), 'part two')
    expect(() => prepareOfflineInstallPayload(root, () => {}, 'win32-x64')).not.toThrow()
  })

  it('still reports a genuinely unknown tarball as an orphan', () => {
    // The exemption must not swallow the check it exists beside.
    const root = desktopRoot(EMPTY)
    authorClis(root, 'win32-x64', [], [])
    writeFileSync(join(offlineInstallBuildPaths(root).source, 'mystery-9.9.9.tgz.part-aa'), 'unknown')
    expect(() => prepareOfflineInstallPayload(root, () => {}, 'win32-x64'))
      .toThrow('no manifest entry names it')
  })

  it('does not treat another target\'s CLI artifacts as orphans', () => {
    // Every target is authored into the same tracked directory, so the artifacts this
    // build is not packaging must not fail the orphan check.
    const root = desktopRoot(EMPTY)
    authorClis(root, 'linux-x64', [], [])
    authorClis(root, 'win32-x64', [], [])
    writeFileSync(join(offlineInstallBuildPaths(root).source, 'c-win32-x64.tgz'), 'other target')
    expect(() => prepareOfflineInstallPayload(root, () => {}, 'linux-x64')).not.toThrow()
  })
})

describe('verifyPreparedOfflineInstall', () => {
  it('accepts a prepared payload that still holds every tarball', () => {
    const root = desktopRoot({ version: 1, plugins: [{ name: 'p', version: '1', tarball: 'p.tgz' }], clis: [] }, ['p.tgz'])
    prepareOfflineInstallPayload(root)
    expect(verifyPreparedOfflineInstall(root)).toEqual(['p.tgz'])
  })

  it('reports nothing when no payload was authored at all', () => {
    expect(verifyPreparedOfflineInstall(desktopRoot())).toEqual([])
  })

  it('refuses to verify when the shared payload directory is absent', () => {
    const root = packageRoot()
    expect(() => verifyPreparedOfflineInstall(root)).toThrow(/no payload directory at .*offline-install/u)
  })

  it('refuses to verify when the shared payload path is a file', () => {
    const root = packageRoot()
    payloadPathAsFile(root)
    expect(() => verifyPreparedOfflineInstall(root)).toThrow(/no payload directory at .*offline-install/u)
  })

  it('refuses when a manifest was authored but never prepared', () => {
    // A gate that failed between preparing and packaging would otherwise pass unnoticed.
    expect(() => verifyPreparedOfflineInstall(desktopRoot(EMPTY))).toThrow('has a manifest but')
  })

  it('refuses when a prepared tarball went missing', () => {
    const root = desktopRoot({ version: 1, plugins: [{ name: 'p', version: '1', tarball: 'p.tgz' }], clis: [] }, ['p.tgz'])
    prepareOfflineInstallPayload(root)
    rmSync(join(offlineInstallBuildPaths(root).prepared, 'p.tgz'))
    expect(() => verifyPreparedOfflineInstall(root)).toThrow('prepared payload is missing p.tgz')
  })

  it('lists each tarball once when two entries share it', () => {
    const root = desktopRoot(
      { version: 1, plugins: [{ name: 'p', version: '1', tarball: 'shared.tgz' }], clis: [] },
      ['shared.tgz'],
    )
    // A distinct name per section: the same authored name under `cli/` is the same
    // file, which the prepared payload must list once even though two entries name it.
    authorClis(root, 'linux-x64', [], [])
    prepareOfflineInstallPayload(root, () => {}, 'linux-x64')
    expect(verifyPreparedOfflineInstall(root)).toEqual(['shared.tgz'])
  })
})
