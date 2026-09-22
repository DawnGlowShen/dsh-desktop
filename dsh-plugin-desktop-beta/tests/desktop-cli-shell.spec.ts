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
