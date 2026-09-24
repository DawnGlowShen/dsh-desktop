import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDesktopCliPublisher, desktopCliLaunchers } from '../src/desktop-cli-publication.ts'
import { desktopCliShimDirectory } from '../src/desktop-cli-shell.ts'
import type { DesktopWindowsPathRegistry, DesktopWindowsPathValue } from '../src/desktop-windows-path.ts'

const roots: string[] = []

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true })
})

/** Recording PATH registry; the real one needs a Windows host. */
function fakeRegistry(current?: DesktopWindowsPathValue): {
  registry: DesktopWindowsPathRegistry
  writes: string[]
  broadcasts: number
} {
  const writes: string[] = []
  const state = { broadcasts: 0, value: current }
  return {
    writes,
    get broadcasts() { return state.broadcasts },
    registry: {
      read: () => state.value,
      write: (value: string) => {
        writes.push(value)
        state.value = { value, kind: 'ExpandString' }
      },
      broadcast: () => { state.broadcasts += 1 },
    },
  }
}

/**
 * A Windows-shaped bundle tree laid out the way the packaged product is.
 *
 * `codegraph` publishes `bin\codegraph.cmd` beside `node.exe`; the entry script
 * the shim actually names lives three directories further down under
 * `lib\dist\bin`. `mnemon` ships a real executable.
 */
function makeBundle(): { home: string; codegraph: string; mnemon: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cli-publication-'))
  roots.push(root)
  const home = join(root, 'user', '.dsh')
  const codegraph = join(root, 'app', 'resources', 'codegraph', 'bin')
  mkdirSync(join(root, 'app', 'resources', 'codegraph', 'lib', 'dist', 'bin'), { recursive: true })
  mkdirSync(join(root, 'app', 'resources', 'mnemon', 'bin'), { recursive: true })
  return { home, codegraph, mnemon: join(root, 'app', 'resources', 'mnemon', 'bin') }
}

function publisher(options: {
  home: string
  codegraph?: string
  mnemon?: string
}): { publisher: ReturnType<typeof createDesktopCliPublisher>; writes: string[] } {
  const fake = fakeRegistry({ value: 'C:\\Windows', kind: 'ExpandString' })
  return {
    writes: fake.writes,
    publisher: createDesktopCliPublisher({
      homeDir: options.home,
      userHomeDir: join(options.home, '..'),
      platform: 'win32',
      launchers: desktopCliLaunchers({
        platform: 'win32',
        codegraphPathDir: options.codegraph,
        mnemonPathDir: options.mnemon,
      }),
      createRegistry: () => fake.registry,
    }),
  }
}

describe('desktopCliLaunchers', () => {
  it('names the codegraph entry script rather than the batch shim beside node.exe', () => {
    const { codegraph, mnemon } = makeBundle()

    const launchers = desktopCliLaunchers({
      platform: 'win32',
      codegraphPathDir: codegraph,
      mnemonPathDir: mnemon,
    })

    // Pointing at `bin\codegraph.cmd` would import its call-time `%~dp0`, which
    // breaks as soon as the bundle moves; the entry script keeps the shim's
    // embedded paths absolute.
    expect(launchers).toEqual([
      { name: 'codegraph', launcherPath: join(codegraph, '..', 'lib', 'dist', 'bin', 'codegraph.js') },
      { name: 'mnemon', launcherPath: join(mnemon, 'mnemon.exe') },
    ])
  })

  it('uses the POSIX launcher names away from Windows', () => {
    const { codegraph, mnemon } = makeBundle()

    const launchers = desktopCliLaunchers({
      platform: 'darwin',
      codegraphPathDir: codegraph,
      mnemonPathDir: mnemon,
    })

    expect(launchers).toEqual([
      { name: 'codegraph', launcherPath: join(codegraph, 'codegraph') },
      { name: 'mnemon', launcherPath: join(mnemon, 'mnemon') },
    ])
  })

  it('omits a CLI whose bundle was never published', () => {
    const { mnemon } = makeBundle()

    // A skipped bundle must not yield a shim aimed at a path that is not there.
    expect(desktopCliLaunchers({ platform: 'win32', mnemonPathDir: mnemon }))
      .toEqual([{ name: 'mnemon', launcherPath: join(mnemon, 'mnemon.exe') }])
    expect(desktopCliLaunchers({ platform: 'win32' })).toEqual([])
  })
})

describe('createDesktopCliPublisher', () => {
  it('registers on a POSIX host is refused rather than faked', () => {
    const { home } = makeBundle()

    // macOS and Linux have no registry: the caller must not construct one, and
    // doing so anyway has to fail loudly instead of reporting a no-op success.
    expect(() => createDesktopCliPublisher({
      homeDir: home,
      userHomeDir: home,
      platform: 'darwin',
      launchers: [],
    })).toThrow(/no registry-backed CLI PATH entry/u)
  })

  it('generates the shims and registers their directory in one publish', () => {
    const { home, codegraph, mnemon } = makeBundle()
    const { publisher: cli, writes } = publisher({ home, codegraph, mnemon })

    const result = cli.publish()

    expect(result).toEqual({ changed: true, registered: true })
    const shim = readFileSync(join(home, 'bin', 'codegraph.cmd'), 'utf8')
    expect(shim).toContain(join(codegraph, '..', 'lib', 'dist', 'bin', 'codegraph.js'))
    expect(shim).toContain('node.exe')
    expect(shim).not.toContain('%~dp0')
    expect(existsSync(join(home, 'bin', 'mnemon.cmd'))).toBe(true)
    // The registered entry is exactly the directory the shims went into, host
    // spelling and all: one derivation serves both, so they cannot drift.
    expect(writes).toEqual([`C:\\Windows;${desktopCliShimDirectory(home)}`])
  })

  it('is a no-op on the second publish, reporting the unchanged state', () => {
    const { home, codegraph, mnemon } = makeBundle()
    const { publisher: cli, writes } = publisher({ home, codegraph, mnemon })

    cli.publish()
    const second = cli.publish()

    // Content comparison, not existence: the same inputs must not rewrite the
    // registry or the shims on every launch.
    expect(second).toEqual({ changed: false, registered: true })
    expect(writes).toHaveLength(1)
  })

  it('follows the bundle when it moves, instead of leaving a stale shim', () => {
    const first = makeBundle()
    const second = makeBundle()
    const { home } = first
    const { publisher: cli, writes } = publisher({ home, codegraph: first.codegraph, mnemon: first.mnemon })
    cli.publish()

    // A relocated portable copy re-derives the absolute launcher path each run;
    // the shim it rewrites is what makes the moved directory work again.
    const moved = publisher({ home, codegraph: second.codegraph, mnemon: second.mnemon })
    const result = moved.publisher.publish()

    expect(result.changed).toBe(true)
    // The rewrite is what makes a relocated copy work again: the shim now
    // embeds the new bundle's entry script.
    expect(readFileSync(join(home, 'bin', 'codegraph.cmd'), 'utf8'))
      .toContain(join(second.codegraph, '..', 'lib', 'dist', 'bin', 'codegraph.js'))
    expect(writes).toHaveLength(1)
  })

  it('refuses to advertise a shim directory when nothing was published', () => {
    const { home } = makeBundle()
    const { publisher: cli, writes } = publisher({ home })

    // Registering an empty directory would put a PATH entry in front of the
    // user's real commands that resolves nothing.
    expect(() => cli.publish()).toThrow(/nothing to register/u)
    expect(writes).toEqual([])
    expect(existsSync(join(home, 'bin'))).toBe(false)
  })

  it('revokes only this installation entry and keeps the shim files', () => {
    const { home, codegraph, mnemon } = makeBundle()
    // Seed the entry in exactly the spelling `publish` writes, so the removal
    // has to match its own earlier write rather than a look-alike.
    const entry = desktopCliShimDirectory(home)
    const fake = fakeRegistry({ value: `C:\\Windows;${entry};D:\\Other`, kind: 'ExpandString' })
    const cli = createDesktopCliPublisher({
      homeDir: home,
      userHomeDir: home,
      platform: 'win32',
      launchers: desktopCliLaunchers({ platform: 'win32', codegraphPathDir: codegraph, mnemonPathDir: mnemon }),
      createRegistry: () => fake.registry,
    })
    cli.publish()
    fake.writes.length = 0

    const result = cli.revoke()

    expect(result).toEqual({ changed: true, registered: false })
    // Every other entry survives byte for byte; the generated shims are left
    // alone so a re-publish does not have to rebuild them.
    expect(fake.writes).toEqual(['C:\\Windows;D:\\Other'])
    expect(existsSync(join(home, 'bin', 'codegraph.cmd'))).toBe(true)
  })

  it('reports an already-absent entry as unchanged', () => {
    const { home, codegraph, mnemon } = makeBundle()
    const { publisher: cli, writes } = publisher({ home, codegraph, mnemon })

    expect(cli.revoke()).toEqual({ changed: false, registered: false })
    expect(writes).toEqual([])
  })
})
