import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  desktopCliProfileName,
  installDesktopCliShell,
  uninstallDesktopCliShell,
} from '../src/desktop-cli-shell.ts'

const roots: string[] = []

const MARKER_BEGIN = '# >>> dsh-desktop codegraph >>>'

function makeRoot(): { home: string; userHome: string; launcher: string; mnemon: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cli-shell-'))
  roots.push(root)
  // Real layout: the harness home lives inside the user's home directory.
  const userHome = join(root, 'user')
  const home = join(userHome, '.dsh')
  mkdirSync(userHome, { recursive: true })
  const launcher = join(root, 'app', 'Contents', 'Resources', 'codegraph', 'bin', 'codegraph')
  const mnemon = join(root, 'app', 'Contents', 'Resources', 'mnemon', 'bin', 'mnemon')
  return { home, userHome, launcher, mnemon }
}

function shellPath(home: string, name = 'codegraph'): string {
  return join(home, 'bin', name)
}

/** The bundled CLI set under test. */
function cli(options: { home: string; userHome: string; launcher: string; mnemon: string }): Parameters<typeof installDesktopCliShell>[0] {
  return {
    homeDir: options.home,
    userHomeDir: options.userHome,
    launchers: [
      { name: 'codegraph', launcherPath: options.launcher },
      { name: 'mnemon', launcherPath: options.mnemon },
    ],
  }
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true })
})

describe('desktopCliProfileName', () => {
  it('selects the profile matching the login shell', () => {
    expect(desktopCliProfileName('/bin/zsh')).toBe('.zshrc')
    expect(desktopCliProfileName('/bin/bash')).toBe('.bash_profile')
    // macOS Terminal opens a login shell; zsh has been the default since Catalina.
    expect(desktopCliProfileName(undefined)).toBe('.zshrc')
    expect(desktopCliProfileName('')).toBe('.zshrc')
  })
})

describe('installDesktopCliShell', () => {
  it('writes one executable shim per launcher forwarding to its packaged launcher', () => {
    const { home, userHome, launcher, mnemon } = makeRoot()
    const installation = installDesktopCliShell(cli({ home, userHome, launcher, mnemon }))

    expect(installation.changed).toBe(true)
    expect(installation.shimPaths).toEqual([shellPath(home), shellPath(home, 'mnemon')])
    for (const [shimPath, target] of [[shellPath(home), launcher], [shellPath(home, 'mnemon'), mnemon]] as const) {
      expect(statSync(shimPath).mode & 0o111).not.toBe(0)
      const shim = readFileSync(shimPath, 'utf8')
      expect(shim.startsWith('#!/bin/sh\n')).toBe(true)
      expect(shim).toContain(`exec '${target}' "$@"`)
    }
  })

  it('adds exactly one marked PATH block no matter how many launchers share it', () => {
    const { home, userHome, launcher, mnemon } = makeRoot()
    installDesktopCliShell(cli({ home, userHome, launcher, mnemon }))

    const profile = readFileSync(join(userHome, '.zshrc'), 'utf8')
    expect(profile.match(/# >>> dsh-desktop codegraph >>>/gu)).toHaveLength(1)
    expect(profile.match(/# <<< dsh-desktop codegraph <<</gu)).toHaveLength(1)
    expect(profile).toBe(
      `${MARKER_BEGIN}\n`
      + `export PATH="$HOME/${join('.dsh', 'bin')}:$PATH"\n`
      + '# <<< dsh-desktop codegraph <<<\n',
    )
  })

  it('preserves existing profile content and appends after it', () => {
    const { home, userHome, launcher, mnemon } = makeRoot()
    const profilePath = join(userHome, '.zshrc')
    writeFileSync(profilePath, 'export EDITOR=vim\n', 'utf8')

    installDesktopCliShell(cli({ home, userHome, launcher, mnemon }))

    const profile = readFileSync(profilePath, 'utf8')
    expect(profile.startsWith('export EDITOR=vim\n')).toBe(true)
    expect(profile.match(/# >>> dsh-desktop codegraph >>>/gu)).toHaveLength(1)
  })

  it('keeps a profile without a trailing newline readable', () => {
    const { home, userHome, launcher, mnemon } = makeRoot()
    const profilePath = join(userHome, '.zshrc')
    writeFileSync(profilePath, 'export EDITOR=vim', 'utf8')

    installDesktopCliShell(cli({ home, userHome, launcher, mnemon }))

    // The last hand-written line must stay its own line rather than swallow the marker.
    expect(readFileSync(profilePath, 'utf8').startsWith('export EDITOR=vim\n\n# >>> dsh-desktop codegraph >>>'))
      .toBe(true)
  })

  it('is idempotent and only backs up when the profile actually changes', () => {
    const { home, userHome, launcher, mnemon } = makeRoot()
    const profilePath = join(userHome, '.zshrc')
    writeFileSync(profilePath, 'export EDITOR=vim\n', 'utf8')

    const options = cli({ home, userHome, launcher, mnemon })
    const first = installDesktopCliShell(options)
    const afterFirst = readFileSync(profilePath, 'utf8')
    const second = installDesktopCliShell(options)

    expect(first.changed).toBe(true)
    expect(second.changed).toBe(false)
    expect(readFileSync(profilePath, 'utf8')).toBe(afterFirst)
  })

  it('creates exactly one backup containing the pre-existing profile', () => {
    const { home, userHome, launcher, mnemon } = makeRoot()
    const profilePath = join(userHome, '.zshrc')
    writeFileSync(profilePath, 'export EDITOR=vim\n', 'utf8')

    installDesktopCliShell({
      ...cli({ home, userHome, launcher, mnemon }),
      now: () => new Date('2026-01-02T03:04:05.678Z'),
    })
    installDesktopCliShell(cli({ home, userHome, launcher, mnemon }))

    const backup = `${profilePath}.dsh-backup-2026-01-02T03-04-05-678Z`
    expect(existsSync(backup)).toBe(true)
    expect(readFileSync(backup, 'utf8')).toBe('export EDITOR=vim\n')
  })

  it('adds a second launcher without duplicating the block', () => {
    const { home, userHome, launcher, mnemon } = makeRoot()
    const profilePath = join(userHome, '.zshrc')
    writeFileSync(profilePath, 'export EDITOR=vim\n', 'utf8')

    // The pre-existing shape: CodeGraph was published alone before Mnemon existed.
    installDesktopCliShell({
      homeDir: home,
      userHomeDir: userHome,
      launchers: [{ name: 'codegraph', launcherPath: launcher }],
    })
    const afterFirst = readFileSync(profilePath, 'utf8')
    expect(afterFirst.match(/# >>> dsh-desktop codegraph >>>/gu)).toHaveLength(1)

    const merged = installDesktopCliShell(cli({ home, userHome, launcher, mnemon }))

    expect(merged.changed).toBe(true)
    expect(readFileSync(profilePath, 'utf8')).toBe(afterFirst)
    expect(readFileSync(profilePath, 'utf8').match(/# >>> dsh-desktop codegraph >>>/gu)).toHaveLength(1)
    expect(readFileSync(shellPath(home, 'mnemon'), 'utf8')).toContain(`exec '${mnemon}' "$@"`)
  })

  it('rewrites the block in place when the shim directory moves', () => {
    const { home, userHome, launcher, mnemon } = makeRoot()
    const profilePath = join(userHome, '.zshrc')
    installDesktopCliShell(cli({ home, userHome, launcher, mnemon }))

    const otherHome = `${home}-moved`
    installDesktopCliShell(cli({ home: otherHome, userHome, launcher, mnemon }))

    const profile = readFileSync(profilePath, 'utf8')
    expect(profile.match(/# >>> dsh-desktop codegraph >>>/gu)).toHaveLength(1)
    expect(profile).toContain(`$HOME/${otherHome.split('/').slice(-1)[0]}/bin`)
  })

  it('keeps an absolute path when the shim directory is outside $HOME', () => {
    const { userHome, launcher, mnemon } = makeRoot()
    const outside = mkdtempSync(join(tmpdir(), 'dsh-cli-outside-'))
    roots.push(outside)

    installDesktopCliShell(cli({ home: outside, userHome, launcher, mnemon }))

    expect(readFileSync(join(userHome, '.zshrc'), 'utf8')).toContain(`export PATH="${join(outside, 'bin')}:$PATH"`)
  })

  it('targets .bash_profile for bash and survives an awkward launcher path', () => {
    const { home, userHome } = makeRoot()
    const launcherDirectory = join(home, "an app's dir")
    mkdirSync(launcherDirectory, { recursive: true })
    const launcher = join(launcherDirectory, 'codegraph')
    // A real launcher proves the generated quoting instead of its spelling.
    writeFileSync(launcher, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 })

    installDesktopCliShell({
      homeDir: home,
      userHomeDir: userHome,
      launchers: [{ name: 'codegraph', launcherPath: launcher }],
      shell: '/bin/bash',
    })

    expect(existsSync(join(userHome, '.zshrc'))).toBe(false)
    expect(readFileSync(join(userHome, '.bash_profile'), 'utf8')).toContain('dsh-desktop codegraph')
    // Spaces and a single quote must reach the launcher as whole arguments.
    expect(execFileSync(shellPath(home), ['hello world', "it's fine"], { encoding: 'utf8' }))
      .toBe("hello world\nit's fine\n")
  })

  it('rejects an empty launcher set and a name that escapes the shim directory', () => {
    const { home, userHome, launcher } = makeRoot()

    expect(() => installDesktopCliShell({ homeDir: home, userHomeDir: userHome, launchers: [] }))
      .toThrow(/at least one launcher/u)
    for (const name of ['../escape', 'bin/../../escape', '', 'has space']) {
      expect(() => installDesktopCliShell({
        homeDir: home,
        userHomeDir: userHome,
        launchers: [{ name, launcherPath: launcher }],
      })).toThrow(/launcher name/u)
    }
    expect(() => installDesktopCliShell({
      homeDir: home,
      userHomeDir: userHome,
      launchers: [{ name: 'codegraph', launcherPath: '' }],
    })).toThrow(/launcher path/u)
  })
})

describe('installDesktopCliShell on Windows', () => {
  /**
   * Windows paths inside the generated content, host paths for the filesystem.
   *
   * The shim text must be Windows-shaped because that is what cmd.exe resolves,
   * but the files still have to be written to a real temporary directory on
   * whatever host runs the suite — `yarn check` runs it on Linux too. Only the
   * launcher paths are therefore spelled with backslashes, and the win32 branch
   * must derive the bundle root with `win32` semantics rather than the host's.
   */
  const BUNDLE = 'C:\\app\\resources\\codegraph'

  function windowsRoot(): { home: string; userHome: string } {
    const root = mkdtempSync(join(tmpdir(), 'dsh-cli-win-'))
    roots.push(root)
    const userHome = join(root, 'user')
    return { home: join(userHome, '.dsh'), userHome }
  }

  function windowsCli(options: { home: string; userHome: string; bundle?: string }): Parameters<typeof installDesktopCliShell>[0] {
    return {
      platform: 'win32',
      homeDir: options.home,
      userHomeDir: options.userHome,
      launchers: [
        { name: 'codegraph', launcherPath: `${options.bundle ?? BUNDLE}\\lib\\dist\\bin\\codegraph.js` },
        { name: 'mnemon', launcherPath: `${options.bundle ?? BUNDLE}\\mnemon\\bin\\mnemon.exe` },
      ],
    }
  }

  function shim(home: string, name: string): string {
    return join(home, 'bin', `${name}.cmd`)
  }

  it('generates a .cmd forwarder per launcher instead of copying the binary', () => {
    const { home, userHome } = windowsRoot()
    const installation = installDesktopCliShell(windowsCli({ home, userHome }))

    expect(installation.changed).toBe(true)
    expect(installation.shimPaths).toEqual([shim(home, 'codegraph'), shim(home, 'mnemon')])

    const mnemon = readFileSync(shim(home, 'mnemon'), 'utf8')
    expect(mnemon).toContain(`${BUNDLE}\\mnemon\\bin\\mnemon.exe`)
    expect(mnemon).toMatch(/^@echo off\r\n/u)
    expect(mnemon.endsWith(' %*\r\n')).toBe(true)

    const codegraph = readFileSync(shim(home, 'codegraph'), 'utf8')
    // The interpreter sits at the flat bundle root while the entry script is
    // nested three levels down, so the root has to be re-derived.
    expect(codegraph).toContain(`${BUNDLE}\\node.exe`)
    expect(codegraph).toContain(`${BUNDLE}\\lib\\dist\\bin\\codegraph.js`)
    expect(codegraph).toContain('--liftoff-only')
    expect(codegraph).toContain('--disable-warning=ExperimentalWarning')
    expect(codegraph).toMatch(/^@echo off\r\n/u)
    expect(codegraph.endsWith(' %*\r\n')).toBe(true)
  })

  it('never references %~dp0 and is not a copy of the upstream shim', () => {
    const { home, userHome } = windowsRoot()
    installDesktopCliShell(windowsCli({ home, userHome }))

    const codegraph = readFileSync(shim(home, 'codegraph'), 'utf8')
    // %~dp0 resolves at call time, so a copied upstream shim would point at the
    // shim directory instead of the bundle and break immediately.
    expect(codegraph).not.toContain('%~dp0')
    expect(codegraph).not.toContain('%~dpn0')
    // A forwarder is a few dozen bytes; a copy would carry the launcher's bytes.
    expect(codegraph.length).toBeLessThan(400)
  })

  it('rejects a CodeGraph path that is not in the packaged layout', () => {
    const { home, userHome } = windowsRoot()

    expect(() => installDesktopCliShell({
      platform: 'win32',
      homeDir: home,
      userHomeDir: userHome,
      launchers: [{ name: 'codegraph', launcherPath: 'C:\\elsewhere\\codegraph.js' }],
    })).toThrow(/codegraph launcher path/u)
  })

  it('writes no shell profile at all on Windows', () => {
    const { home, userHome } = windowsRoot()
    const installation = installDesktopCliShell(windowsCli({ home, userHome }))

    expect(installation.pathDir).toBe(join(home, 'bin'))
    // Windows has no shell profile; its PATH entry belongs to the registry.
    expect(installation.profilePath).toBe('')
    expect(existsSync(join(userHome, '.zshrc'))).toBe(false)
    expect(existsSync(join(userHome, '.bash_profile'))).toBe(false)
  })

  it('is idempotent on content rather than on existence', () => {
    const { home, userHome } = windowsRoot()
    const options = windowsCli({ home, userHome })

    const first = installDesktopCliShell(options)
    const afterFirst = readFileSync(shim(home, 'codegraph'), 'utf8')
    const second = installDesktopCliShell(options)

    expect(first.changed).toBe(true)
    expect(second.changed).toBe(false)
    expect(readFileSync(shim(home, 'codegraph'), 'utf8')).toBe(afterFirst)
  })

  it('rewrites a shim that points at a previous bundle location', () => {
    const { home, userHome } = windowsRoot()
    const moved = 'C:\\relocated\\codegraph'
    installDesktopCliShell(windowsCli({ home, userHome }))

    const result = installDesktopCliShell(windowsCli({ home, userHome, bundle: moved }))

    expect(result.changed).toBe(true)
    const codegraph = readFileSync(shim(home, 'codegraph'), 'utf8')
    expect(codegraph).toContain(`${moved}\\node.exe`)
    expect(codegraph).not.toContain(BUNDLE)
  })

  it('overwrites an empty or stale shim instead of skipping it', () => {
    const { home, userHome } = windowsRoot()
    mkdirSync(join(home, 'bin'), { recursive: true })
    writeFileSync(shim(home, 'mnemon'), '', 'utf8')
    writeFileSync(shim(home, 'codegraph'), '@echo off\r\ncodegraph %*\r\n', 'utf8')

    const result = installDesktopCliShell(windowsCli({ home, userHome }))

    expect(result.changed).toBe(true)
    expect(readFileSync(shim(home, 'mnemon'), 'utf8')).toContain('mnemon.exe')
    expect(readFileSync(shim(home, 'codegraph'), 'utf8')).toContain('codegraph.js')
  })

  it('doubles percent signs so a literal path cannot expand as a variable', () => {
    const { home, userHome } = windowsRoot()
    const bundle = 'C:\\tools\\%TEMP%\\codegraph'

    installDesktopCliShell(windowsCli({ home, userHome, bundle }))

    const mnemon = readFileSync(shim(home, 'mnemon'), 'utf8')
    // cmd.exe expands %VAR% even inside quotes, so the literal must be doubled.
    // Asserted exactly: "%%TEMP%%" still *contains* "%TEMP%" as a substring, so
    // a `not.toContain('%TEMP%')` guard would prove nothing.
    expect(mnemon).toBe('@echo off\r\n"C:\\tools\\%%TEMP%%\\codegraph\\mnemon\\bin\\mnemon.exe" %*\r\n')
  })

  it('rejects a launcher name that would escape the shim directory', () => {
    const { home, userHome } = windowsRoot()

    for (const name of ['..', '.', '../escape', '..\\escape', 'a/b', 'has space', '']) {
      expect(() => installDesktopCliShell({
        platform: 'win32',
        homeDir: home,
        userHomeDir: userHome,
        launchers: [{ name, launcherPath: 'C:\\app\\resources\\codegraph\\mnemon.exe' }],
      })).toThrow(/launcher name/u)
    }
    // Nothing may be written when a name is rejected.
    expect(existsSync(join(home, 'bin'))).toBe(false)
  })

  it('leaves macOS artifacts untouched when the platform is darwin', () => {
    const { home, userHome, launcher, mnemon } = makeRoot()
    installDesktopCliShell(cli({ home, userHome, launcher, mnemon }))

    expect(existsSync(shellPath(home))).toBe(true)
    expect(existsSync(join(home, 'bin', 'codegraph.cmd'))).toBe(false)
    expect(readFileSync(shellPath(home), 'utf8').startsWith('#!/bin/sh\n')).toBe(true)
    expect(readFileSync(join(userHome, '.zshrc'), 'utf8')).toContain(MARKER_BEGIN)
  })
})

describe('uninstallDesktopCliShell on Windows', () => {
  it('removes the .cmd shims and touches no profile', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-cli-win-un-'))
    roots.push(root)
    const userHome = join(root, 'user')
    const home = join(userHome, '.dsh')
    const options = {
      platform: 'win32' as const,
      homeDir: home,
      userHomeDir: userHome,
      launchers: [
        { name: 'codegraph', launcherPath: 'C:\\app\\resources\\codegraph\\lib\\dist\\bin\\codegraph.js' },
        { name: 'mnemon', launcherPath: 'C:\\app\\resources\\codegraph\\mnemon\\bin\\mnemon.exe' },
      ],
    }

    installDesktopCliShell(options)
    const result = uninstallDesktopCliShell(options)

    expect(result.changed).toBe(true)
    expect(result.profilePath).toBe('')
    expect(existsSync(join(home, 'bin', 'codegraph.cmd'))).toBe(false)
    expect(existsSync(join(home, 'bin', 'mnemon.cmd'))).toBe(false)
    expect(existsSync(join(userHome, '.zshrc'))).toBe(false)
  })
})


describe('uninstallDesktopCliShell', () => {
  it('removes every shim and the block while leaving the rest byte-identical', () => {
    const { home, userHome, launcher, mnemon } = makeRoot()
    const profilePath = join(userHome, '.zshrc')
    const original = 'export EDITOR=vim\nexport PAGER=less\n'
    writeFileSync(profilePath, original, 'utf8')

    installDesktopCliShell(cli({ home, userHome, launcher, mnemon }))
    const result = uninstallDesktopCliShell(cli({ home, userHome, launcher, mnemon }))

    expect(result.changed).toBe(true)
    expect(existsSync(shellPath(home))).toBe(false)
    expect(existsSync(shellPath(home, 'mnemon'))).toBe(false)
    expect(readFileSync(profilePath, 'utf8')).toBe(original)
  })

  it('is a no-op when nothing was installed', () => {
    const { home, userHome, launcher, mnemon } = makeRoot()
    const profilePath = join(userHome, '.zshrc')
    writeFileSync(profilePath, 'export EDITOR=vim\n', 'utf8')

    const result = uninstallDesktopCliShell(cli({ home, userHome, launcher, mnemon }))

    expect(result.changed).toBe(false)
    expect(readFileSync(profilePath, 'utf8')).toBe('export EDITOR=vim\n')
  })

  it('leaves a profile that never had the block untouched', () => {
    const { home, userHome, launcher, mnemon } = makeRoot()
    const result = uninstallDesktopCliShell(cli({ home, userHome, launcher, mnemon }))

    expect(result.changed).toBe(false)
    expect(existsSync(join(userHome, '.zshrc'))).toBe(false)
  })
})
