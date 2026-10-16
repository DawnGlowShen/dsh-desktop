/**
 * The CLI payload is committed, so this script's job is to refuse a payload that would
 * produce an uninstallable application. These cover the properties the installer
 * depends on: an archive with more than one top-level directory is not root-stripped
 * (every CLI then fails with "the archive contains no bin/<command>"), an artifact that
 * does not name its own command is not installable, and a manifest that drifts from the
 * tarballs it describes only fails on a user's machine.
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, describe, it } from 'node:test'

import {
  CLI_TARGETS,
  cliManifestName,
  offlineClisReady,
  parseArtifactName,
  parseTargets,
  payloadDirectory,
  prepareOfflineClis,
  readPreparedClis,
} from './prepare-offline-clis.mjs'

const roots = []

/**
 * A throwaway desktop workspace inside a repository the script will accept.
 *
 * The payload is shared by every Desktop package and lives one level above them, so the
 * repository root is created first and the payload directory inside it. A fixture that
 * made only a package root would point every test in this file at the same temporary
 * payload.
 */
function workspace() {
  const repository = mkdtempSync(join(tmpdir(), 'offline-clis-'))
  roots.push(repository)
  const directory = join(repository, 'dsh-plugin-desktop')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'dsh-plugin-desktop', version: '0.0.0' }))
  mkdirSync(payloadDirectory(directory), { recursive: true })
  return directory
}

/**
 * Author a payload artifact into a workspace.
 *
 * A real archive is built from a staging directory rather than copying fixtures, so the
 * checks under test see the same shapes an authored artifact would produce. Members are
 * given relative to the command directory (which the caller supplies as the first path
 * segment), and the archive is rooted at that directory — the single top-level entry the
 * installer requires.
 */
function authorArtifact(desktopRoot, name, members) {
  const staging = mkdtempSync(join(tmpdir(), 'offline-stage-'))
  roots.push(staging)
  for (const [member, body] of members) {
    const path = join(staging, member)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, body, { mode: 0o755 })
  }
  const out = join(payloadDirectory(desktopRoot), name)
  // Rooted at the command directory: `-C staging <command>` rather than `-C staging .`,
  // because the latter prefixes every member with `./` and leaves the archive with no
  // single top-level directory at all.
  const command = name.slice(0, name.indexOf('-'))
  execFileSync('tar', ['czf', out, '-C', staging, command], { encoding: 'utf8' })
  return out
}

after(() => {
  for (const directory of roots) rmSync(directory, { recursive: true, force: true })
})

describe('payloadDirectory', () => {
  it('resolves the payload shared one level above the package', () => {
    const desktopRoot = workspace()
    assert.equal(payloadDirectory(desktopRoot), resolve(desktopRoot, '..', 'vendor', 'offline-install'))
  })
})

describe('parseArtifactName', () => {
  it('splits at the last hyphen so a hyphenated command survives', () => {
    assert.deepEqual(parseArtifactName('git-ai-1.7.5-linux-x64.tgz', 'linux-x64'), {
      command: 'git-ai',
      version: '1.7.5',
    })
  })

  it('keeps a hyphenated version intact', () => {
    assert.deepEqual(parseArtifactName('codegraph-0.1.2-evo-linux-x64.tgz', 'linux-x64'), {
      command: 'codegraph',
      version: '0.1.2-evo',
    })
  })

  it('ignores anything that is not this target', () => {
    assert.equal(parseArtifactName('codegraph-1.6.0-win32-x64.tgz', 'linux-x64'), undefined)
    assert.equal(parseArtifactName('dsh-mnemon-0.5.24.tgz', 'linux-x64'), undefined)
  })
})

describe('archiveMembers', () => {
  it('names members exactly, with no trailing carriage return', async () => {
    // Exercised through a stub `tar` that writes CRLF, the way GNU tar on Windows does.
    // Splitting on `\n` alone then yields `codegraph/bin/codegraph.cmd\r`, which compares
    // unequal to the name the archive holds — the first Windows CI run rejected the
    // payload this way:
    //   codegraph win32-x64 has none of codegraph/bin/codegraph.cmd;
    //   found codegraph/bin/, codegraph/bin/codegraph.cmd
    // A real Windows host is the only other way to produce that listing, and a committed
    // payload on macOS cannot: bsdtar writes `\n`, so the bug is invisible here.
    const { archiveMembers } = await import('./prepare-offline-clis.mjs')
    const { mkdtempSync, writeFileSync, chmodSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const stubDir = mkdtempSync(join(tmpdir(), 'crlf-tar-'))
    const stub = join(stubDir, 'tar')
    writeFileSync(stub, "#!/bin/sh\nprintf 'codegraph/bin/\\r\\ncodegraph/bin/codegraph.cmd\\r\\n'\n")
    chmodSync(stub, 0o755)
    const previous = process.env.PATH
    process.env.PATH = `${stubDir}:${previous}`
    try {
      const names = archiveMembers('irrelevant.tgz')
      assert.deepEqual(names, ['codegraph/bin/', 'codegraph/bin/codegraph.cmd'])
      assert.ok(
        names.includes('codegraph/bin/codegraph.cmd'),
        'the Windows entry point must compare equal to the name the archive holds',
      )
    } finally {
      process.env.PATH = previous
    }
  })
})

describe('parseTargets', () => {
  it('reads --all', () => {
    assert.deepEqual(parseTargets(['--all']), CLI_TARGETS)
  })

  it('reads --target and refuses a missing value', () => {
    assert.deepEqual(parseTargets(['--target', 'linux-x64']), ['linux-x64'])
    assert.throws(() => parseTargets(['--target']), /--target requires a value/)
  })
})

describe('prepareOfflineClis', () => {
  it('refuses a target it cannot serve', () => {
    assert.throws(() => prepareOfflineClis(workspace(), 'darwin-x64'), /unknown target darwin-x64/)
  })

  it('refuses a payload with no artifacts for the target', () => {
    assert.throws(() => prepareOfflineClis(workspace(), 'linux-x64'), /no CLI artifacts for linux-x64/)
  })

  it('accepts an archive the installer can root-strip', () => {
    const desktopRoot = workspace()
    authorArtifact(desktopRoot, 'mnemon-0.2.9-linux-x64.tgz', [['mnemon/bin/mnemon', '#!/bin/sh\n']])
    const manifest = prepareOfflineClis(desktopRoot, 'linux-x64')
    assert.deepEqual(manifest.clis, [
      { name: 'mnemon', version: '0.2.9', tarball: 'mnemon-0.2.9-linux-x64.tgz', executable: 'bin/mnemon' },
    ])
  })

  it('refuses an archive whose command is not its only top-level entry', () => {
    // The installer strips a single top-level directory, so a second one leaves the
    // command nested and every install fails with "the archive contains no bin/<command>".
    // Two ways to get there: an archive rooted one level too deep (both entries inside
    // `mnemon/`-like wrapper), or a macOS AppleDouble `._<command>` sibling — which
    // cannot be constructed here because bsdtar filters those out of its own output.
    const desktopRoot = workspace()
    const staging = mkdtempSync(join(tmpdir(), 'offline-stage-'))
    roots.push(staging)
    mkdirSync(join(staging, 'mnemon', 'bin'), { recursive: true })
    writeFileSync(join(staging, 'mnemon', 'bin', 'mnemon'), '#!/bin/sh\n', { mode: 0o755 })
    mkdirSync(join(staging, 'wrapper', 'mnemon', 'bin'), { recursive: true })
    writeFileSync(join(staging, 'wrapper', 'mnemon', 'bin', 'mnemon'), '#!/bin/sh\n', { mode: 0o755 })
    execFileSync('tar', [
      'czf', join(payloadDirectory(desktopRoot), 'mnemon-0.2.9-linux-x64.tgz'),
      '-C', staging, 'mnemon', 'wrapper',
    ], { encoding: 'utf8' })
    assert.throws(() => prepareOfflineClis(desktopRoot, 'linux-x64'), /expected only mnemon/)
  })

  it('refuses an archive that does not carry a bin/ entry point', () => {
    const desktopRoot = workspace()
    authorArtifact(desktopRoot, 'mnemon-0.2.9-linux-x64.tgz', [['mnemon/lib/data', 'x']])
    assert.throws(() => prepareOfflineClis(desktopRoot, 'linux-x64'), /no mnemon\/bin\/ entry point/)
  })

  it('picks the Windows entry point by extension', () => {
    const desktopRoot = workspace()
    authorArtifact(desktopRoot, 'mnemon-0.2.9-win32-x64.tgz', [['mnemon/bin/mnemon.exe', 'MZ']])
    const manifest = prepareOfflineClis(desktopRoot, 'win32-x64')
    assert.equal(manifest.clis[0].executable, 'bin/mnemon.exe')
  })

  it('refuses two artifacts for one command', () => {
    // Otherwise which version installs is decided by directory order, and the answer is
    // usually the stale one.
    const desktopRoot = workspace()
    authorArtifact(desktopRoot, 'mnemon-0.2.9-linux-x64.tgz', [['mnemon/bin/mnemon', 'a']])
    authorArtifact(desktopRoot, 'mnemon-0.3.0-linux-x64.tgz', [['mnemon/bin/mnemon', 'b']])
    assert.throws(() => prepareOfflineClis(desktopRoot, 'linux-x64'), /more than one artifact/)
  })

  it('leaves another target alone', () => {
    const desktopRoot = workspace()
    authorArtifact(desktopRoot, 'mnemon-0.2.9-win32-x64.tgz', [['mnemon/bin/mnemon.exe', 'MZ']])
    assert.equal(readPreparedClis(desktopRoot, 'win32-x64'), undefined)
    prepareOfflineClis(desktopRoot, 'win32-x64')
    assert.equal(readPreparedClis(desktopRoot, 'linux-x64'), undefined)
  })
})

describe('offlineClisReady', () => {
  it('is false before anything is verified', () => {
    assert.equal(offlineClisReady(workspace(), 'linux-x64'), false)
  })

  it('is true once a target is verified', () => {
    const desktopRoot = workspace()
    authorArtifact(desktopRoot, 'mnemon-0.2.9-linux-x64.tgz', [['mnemon/bin/mnemon', '#!/bin/sh\n']])
    prepareOfflineClis(desktopRoot, 'linux-x64')
    assert.equal(offlineClisReady(desktopRoot, 'linux-x64'), true)
    assert.equal(offlineClisReady(desktopRoot, 'win32-x64'), false)
  })
})

describe('the committed payload', () => {
  it('verifies for every target', () => {
    // The real payload, not a fixture: this is what the application actually ships, and
    // a mistake in it is only otherwise found by installing on a user's machine.
    for (const variant of ['dsh-plugin-desktop', 'dsh-plugin-desktop-beta']) {
      const desktopRoot = join(new URL('..', import.meta.url).pathname, variant)
      for (const target of CLI_TARGETS) {
        const manifest = prepareOfflineClis(desktopRoot, target)
        assert.equal(manifest.clis.length, 3, `${variant} ${target} should carry three CLIs`)
        assert.deepEqual(
          manifest.clis.map(entry => entry.name).sort(),
          ['codegraph', 'git-ai', 'mnemon'],
          `${variant} ${target} carries unexpected commands`,
        )
      }
    }
  })

  it('publishes a manifest that matches the committed artifacts', () => {
    // Derived from the tarballs, so a hand-edit that no longer reflects them shows up
    // here rather than at install time.
    const desktopRoot = join(new URL('..', import.meta.url).pathname, 'dsh-plugin-desktop')
    for (const target of CLI_TARGETS) {
      const computed = prepareOfflineClis(desktopRoot, target)
      const onDisk = JSON.parse(readFileSync(join(payloadDirectory(desktopRoot), cliManifestName(target)), 'utf8'))
      assert.deepEqual(onDisk, computed, `${target} manifest is stale`)
    }
  })
})
