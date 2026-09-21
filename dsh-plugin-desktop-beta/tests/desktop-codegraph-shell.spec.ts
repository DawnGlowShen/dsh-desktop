import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  desktopCodegraphProfileName,
  installDesktopCodegraphShell,
  uninstallDesktopCodegraphShell,
} from '../src/desktop-codegraph-shell.ts'

const roots: string[] = []

function makeRoot(): { home: string; userHome: string; launcher: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-codegraph-shell-'))
  roots.push(root)
  // Real layout: the harness home lives inside the user's home directory.
  const userHome = join(root, 'user')
  const home = join(userHome, '.dsh')
  mkdirSync(userHome, { recursive: true })
  const launcher = join(root, 'app', 'Contents', 'Resources', 'codegraph', 'bin', 'codegraph')
  return { home, userHome, launcher }
}

function shellPath(home: string): string {
  return join(home, 'bin', 'codegraph')
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true })
})

describe('desktopCodegraphProfileName', () => {
  it('selects the profile matching the login shell', () => {
    expect(desktopCodegraphProfileName('/bin/zsh')).toBe('.zshrc')
    expect(desktopCodegraphProfileName('/bin/bash')).toBe('.bash_profile')
    // macOS Terminal opens a login shell; zsh has been the default since Catalina.
    expect(desktopCodegraphProfileName(undefined)).toBe('.zshrc')
    expect(desktopCodegraphProfileName('')).toBe('.zshrc')
  })
})

describe('installDesktopCodegraphShell', () => {
  it('writes an executable shim that forwards to the packaged launcher', () => {
    const { home, userHome, launcher } = makeRoot()
    const installation = installDesktopCodegraphShell({ homeDir: home, userHomeDir: userHome, launcherPath: launcher })

    expect(installation.changed).toBe(true)
    expect(installation.shimPath).toBe(shellPath(home))
    expect(statSync(installation.shimPath).mode & 0o111).not.toBe(0)
    const shim = readFileSync(installation.shimPath, 'utf8')
    expect(shim.startsWith('#!/bin/sh\n')).toBe(true)
    expect(shim).toContain(`exec '${launcher}' "$@"`)
  })

  it('adds one marked PATH block expressed relative to $HOME', () => {
    const { home, userHome, launcher } = makeRoot()
    installDesktopCodegraphShell({ homeDir: home, userHomeDir: userHome, launcherPath: launcher })

    const profile = readFileSync(join(userHome, '.zshrc'), 'utf8')
    expect(profile).toBe(
      '# >>> dsh-desktop codegraph >>>\n'
      + `export PATH="$HOME/${join('.dsh', 'bin')}:$PATH"\n`
      + '# <<< dsh-desktop codegraph <<<\n',
    )
  })

  it('preserves existing profile content and appends after it', () => {
    const { home, userHome, launcher } = makeRoot()
    const profilePath = join(userHome, '.zshrc')
    writeFileSync(profilePath, 'export EDITOR=vim\n', 'utf8')

    installDesktopCodegraphShell({ homeDir: home, userHomeDir: userHome, launcherPath: launcher })

    const profile = readFileSync(profilePath, 'utf8')
    expect(profile.startsWith('export EDITOR=vim\n')).toBe(true)
    expect(profile.match(/# >>> dsh-desktop codegraph >>>/gu)).toHaveLength(1)
  })

  it('keeps a profile without a trailing newline readable', () => {
    const { home, userHome, launcher } = makeRoot()
    const profilePath = join(userHome, '.zshrc')
    writeFileSync(profilePath, 'export EDITOR=vim', 'utf8')

    installDesktopCodegraphShell({ homeDir: home, userHomeDir: userHome, launcherPath: launcher })

    // The last hand-written line must stay its own line rather than swallow the marker.
    expect(readFileSync(profilePath, 'utf8').startsWith('export EDITOR=vim\n\n# >>> dsh-desktop codegraph >>>'))
      .toBe(true)
  })

  it('is idempotent and only backs up when the profile actually changes', () => {
    const { home, userHome, launcher } = makeRoot()
    const profilePath = join(userHome, '.zshrc')
    writeFileSync(profilePath, 'export EDITOR=vim\n', 'utf8')

    const first = installDesktopCodegraphShell({ homeDir: home, userHomeDir: userHome, launcherPath: launcher })
    const afterFirst = readFileSync(profilePath, 'utf8')
    const second = installDesktopCodegraphShell({ homeDir: home, userHomeDir: userHome, launcherPath: launcher })

    expect(first.changed).toBe(true)
    expect(second.changed).toBe(false)
    expect(readFileSync(profilePath, 'utf8')).toBe(afterFirst)
  })

  it('creates exactly one backup containing the pre-existing profile', () => {
    const { home, userHome, launcher } = makeRoot()
    const profilePath = join(userHome, '.zshrc')
    writeFileSync(profilePath, 'export EDITOR=vim\n', 'utf8')

    installDesktopCodegraphShell({
      homeDir: home,
      userHomeDir: userHome,
      launcherPath: launcher,
      now: () => new Date('2026-01-02T03:04:05.678Z'),
    })
    installDesktopCodegraphShell({ homeDir: home, userHomeDir: userHome, launcherPath: launcher })

    const backup = `${profilePath}.dsh-backup-2026-01-02T03-04-05-678Z`
    expect(existsSync(backup)).toBe(true)
    expect(readFileSync(backup, 'utf8')).toBe('export EDITOR=vim\n')
  })

  it('rewrites the block in place when the shim directory moves', () => {
    const { home, userHome, launcher } = makeRoot()
    const profilePath = join(userHome, '.zshrc')
    installDesktopCodegraphShell({ homeDir: home, userHomeDir: userHome, launcherPath: launcher })

    const otherHome = `${home}-moved`
    installDesktopCodegraphShell({ homeDir: otherHome, userHomeDir: userHome, launcherPath: launcher })

    const profile = readFileSync(profilePath, 'utf8')
    expect(profile.match(/# >>> dsh-desktop codegraph >>>/gu)).toHaveLength(1)
    expect(profile).toContain(`$HOME/${otherHome.split('/').slice(-1)[0]}/bin`)
  })

  it('keeps an absolute path when the shim directory is outside $HOME', () => {
    const { userHome, launcher } = makeRoot()
    const outside = mkdtempSync(join(tmpdir(), 'dsh-codegraph-outside-'))
    roots.push(outside)

    installDesktopCodegraphShell({ homeDir: outside, userHomeDir: userHome, launcherPath: launcher })

    expect(readFileSync(join(userHome, '.zshrc'), 'utf8')).toContain(`export PATH="${join(outside, 'bin')}:$PATH"`)
  })

  it('targets .bash_profile for bash and survives an awkward launcher path', () => {
    const { home, userHome } = makeRoot()
    const launcherDirectory = join(home, "an app's dir")
    mkdirSync(launcherDirectory, { recursive: true })
    const launcher = join(launcherDirectory, 'codegraph')
    // A real launcher proves the generated quoting instead of its spelling.
    writeFileSync(launcher, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 })

    installDesktopCodegraphShell({
      homeDir: home,
      userHomeDir: userHome,
      launcherPath: launcher,
      shell: '/bin/bash',
    })

    expect(existsSync(join(userHome, '.zshrc'))).toBe(false)
    expect(readFileSync(join(userHome, '.bash_profile'), 'utf8')).toContain('dsh-desktop codegraph')
    // Spaces and a single quote must reach the launcher as whole arguments.
    expect(execFileSync(shellPath(home), ['hello world', "it's fine"], { encoding: 'utf8' }))
      .toBe("hello world\nit's fine\n")
  })
})

describe('uninstallDesktopCodegraphShell', () => {
  it('removes the shim and the block while leaving the rest byte-identical', () => {
    const { home, userHome, launcher } = makeRoot()
    const profilePath = join(userHome, '.zshrc')
    const original = 'export EDITOR=vim\nexport PAGER=less\n'
    writeFileSync(profilePath, original, 'utf8')

    installDesktopCodegraphShell({ homeDir: home, userHomeDir: userHome, launcherPath: launcher })
    const result = uninstallDesktopCodegraphShell({ homeDir: home, userHomeDir: userHome, launcherPath: launcher })

    expect(result.changed).toBe(true)
    expect(existsSync(shellPath(home))).toBe(false)
    expect(readFileSync(profilePath, 'utf8')).toBe(original)
  })

  it('is a no-op when nothing was installed', () => {
    const { home, userHome, launcher } = makeRoot()
    const profilePath = join(userHome, '.zshrc')
    writeFileSync(profilePath, 'export EDITOR=vim\n', 'utf8')

    const result = uninstallDesktopCodegraphShell({ homeDir: home, userHomeDir: userHome, launcherPath: launcher })

    expect(result.changed).toBe(false)
    expect(readFileSync(profilePath, 'utf8')).toBe('export EDITOR=vim\n')
  })

  it('leaves a profile that never had the block untouched', () => {
    const { home, userHome, launcher } = makeRoot()
    const result = uninstallDesktopCodegraphShell({ homeDir: home, userHomeDir: userHome, launcherPath: launcher })

    expect(result.changed).toBe(false)
    expect(existsSync(join(userHome, '.zshrc'))).toBe(false)
  })
})
