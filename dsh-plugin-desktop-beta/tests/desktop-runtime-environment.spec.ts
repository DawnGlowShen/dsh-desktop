import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, delimiter as pathDelimiter, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  desktopCodegraphBundleSupportsHost,
  desktopMnemonBundleSupportsHost,
  installDesktopCodegraphRuntime,
  installDesktopDshRuntime,
  installDesktopMnemonRuntime,
  installDesktopPnpmRuntime,
  publishDesktopCodegraphRuntime,
  publishDesktopMnemonRuntime,
  type DesktopPnpmRuntimeOptions,
} from '../src/desktop-runtime-environment.ts'

const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-desktop-pnpm-runtime-'))
  temporaryDirectories.push(directory)
  return directory
}

function options(
  stateDir: string,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): DesktopPnpmRuntimeOptions {
  return {
    platform,
    appExecutable: platform === 'win32'
      ? 'C:\\Program Files\\DSH 100% Desktop\\DSH Desktop.exe'
      : "/Applications/DSH O'Brien.app/Contents/MacOS/DSH Desktop",
    pnpmBinPath: platform === 'win32'
      ? 'C:\\Program Files\\DSH Desktop\\resources\\app.asar.unpacked\\node_modules\\pnpm\\bin\\pnpm.mjs'
      : "/Applications/DSH O'Brien.app/Contents/Resources/app.asar.unpacked/node_modules/pnpm/bin/pnpm.mjs",
    electronVersion: '43.4.0',
    stateDir,
    environment,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('desktop Host pnpm runtime', () => {
  it.each(['darwin', 'linux'] as const)('creates a pnpm-only public PATH on %s', (platform) => {
    const stateDir = join(temporaryDirectory(), 'runtime state')
    const environment: NodeJS.ProcessEnv = {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      KEEP: 'value',
      ELECTRON_RUN_AS_NODE: 'inherited-value',
      npm_config_runtime: 'inherited-runtime',
    }
    const original = { ...environment }

    const installation = installDesktopPnpmRuntime(options(stateDir, platform, environment))

    expect(readdirSync(installation.pathDir)).toEqual(['pnpm'])
    expect(readdirSync(installation.nodeBinDir)).toEqual(['node'])
    const generationRoot = dirname(installation.pathDir)
    const manifest = JSON.parse(readFileSync(join(generationRoot, '.generation.json'), 'utf8')) as {
      contentHash: string
    }
    expect(readdirSync(generationRoot).sort()).toEqual(['.generation.json', 'bin', 'private'])
    expect(basename(generationRoot)).toMatch(new RegExp(`^${manifest.contentHash}-`))
    if (process.platform !== 'win32') {
      expect(lstatSync(stateDir).mode & 0o777).toBe(0o700)
      expect(lstatSync(installation.pathDir).mode & 0o777).toBe(0o700)
      expect(lstatSync(installation.nodeBinDir).mode & 0o777).toBe(0o700)
      expect(lstatSync(installation.pnpmShimPath).mode & 0o777).toBe(0o700)
      expect(lstatSync(installation.nodeShimPath).mode & 0o777).toBe(0o700)
      expect(lstatSync(installation.clearEnvironmentPath).mode & 0o777).toBe(0o600)
    }

    const pnpm = readFileSync(installation.pnpmShimPath, 'utf8')
    expect(pnpm).toContain('runtime_root_dir=${runtime_public_dir%/*}')
    expect(pnpm).toContain('PATH="$runtime_node_bin_dir:${PATH:-}"')
    expect(pnpm).toContain('NODE="$runtime_node_shim"')
    expect(pnpm).toContain('ELECTRON_RUN_AS_NODE=1 npm_config_runtime=electron')
    expect(pnpm).toContain("npm_config_target='43.4.0'")
    expect(pnpm).toContain("npm_config_disturl='https://electronjs.org/headers'")
    expect(pnpm.match(/--config\.minimumReleaseAge=0/gu)).toHaveLength(1)
    expect(pnpm).toContain('--config.minimumReleaseAge=0 "$@"')
    expect(pnpm).toContain('--require "$runtime_clear_environment"')
    expect(pnpm.indexOf('--require "$runtime_clear_environment"')).toBeLessThan(pnpm.indexOf('pnpm/bin/pnpm.mjs'))
    const node = readFileSync(installation.nodeShimPath, 'utf8')
    expect(node).toContain(`ELECTRON_RUN_AS_NODE=1 exec`)
    expect(node).toContain('--require "$runtime_clear_environment" "$@"')
    expect(node).not.toContain('npm_config_')
    const clearEnvironment = readFileSync(installation.clearEnvironmentPath, 'utf8')
    expect(clearEnvironment).toContain("process.execPath = require('node:path').join(__dirname, 'node-bin', 'node')")
    expect(clearEnvironment).toContain("name.toUpperCase() === 'ELECTRON_RUN_AS_NODE'")

    expect(environment).toEqual({
      ...original,
      PATH: `${installation.pathDir}:/usr/local/bin:/usr/bin:/bin`,
    })
    if (process.platform !== 'win32') {
      expect(spawnSync('/bin/sh', ['-n', installation.pnpmShimPath]).status).toBe(0)
      expect(spawnSync('/bin/sh', ['-n', installation.nodeShimPath]).status).toBe(0)
    }

    installation.dispose()
    installation.dispose()
    expect(environment).toEqual(original)
  })

  it('keeps recovered login-shell PATH beneath the Desktop runtime PATH', () => {
    const stateDir = join(temporaryDirectory(), 'runtime')
    const recoveredPath = '/opt/homebrew/bin:/opt/homebrew/sbin:/usr/bin:/bin'
    const environment: NodeJS.ProcessEnv = {
      PATH: recoveredPath,
      KEEP: 'value',
    }
    const original = { ...environment }

    const installation = installDesktopPnpmRuntime(options(stateDir, 'linux', environment))

    expect(environment.PATH).toBe(`${installation.pathDir}:${recoveredPath}`)
    installation.dispose()
    installation.dispose()
    expect(environment).toEqual(original)
  })

  it('publishes the POSIX shim as process.execPath and clears every RunAsNode casing', () => {
    const stateDir = join(temporaryDirectory(), 'runtime')
    const installation = installDesktopPnpmRuntime(options(stateDir, 'linux', { PATH: '/usr/bin' }))
    const result = spawnSync(process.execPath, [
      '--import',
      pathToFileURL(installation.clearEnvironmentPath).href,
      '-e',
      'process.stdout.write(JSON.stringify({ execPath: process.execPath, runAsNode: Object.keys(process.env).filter(name => name.toUpperCase() === "ELECTRON_RUN_AS_NODE") }))',
    ], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        ELECTRON_RUN_AS_NODE: '1',
        electron_run_as_node: 'legacy',
      },
    })

    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      // Node resolves the preload's __dirname through symlinks (macOS /var -> /private/var).
      execPath: realpathSync(installation.nodeShimPath),
      runAsNode: [],
    })
    installation.dispose()
  })

  it('scopes Electron ABI settings to the pnpm process tree', () => {
    const root = temporaryDirectory()
    const stateDir = join(root, 'runtime')
    const captureEntry = join(root, 'capture.mjs')
    const captureOutput = join(root, 'capture.json')
    writeFileSync(captureEntry, [
      "import { writeFileSync } from 'node:fs'",
      'writeFileSync(process.argv.at(-1), JSON.stringify({',
      "  ignoresMinimumReleaseAge: process.argv.includes('--config.minimumReleaseAge=0'),",
      "  runAsNode: Object.keys(process.env).filter(name => name.toUpperCase() === 'ELECTRON_RUN_AS_NODE'),",
      '  runtime: process.env.npm_config_runtime,',
      '  target: process.env.npm_config_target,',
      '  disturl: process.env.npm_config_disturl,',
      '  node: process.env.NODE,',
      '  path: process.env.PATH,',
      '}))',
      '',
    ].join('\n'))
    const platform = process.platform === 'win32' ? 'win32' : 'linux'
    const environment: NodeJS.ProcessEnv = { PATH: process.env.PATH }
    const installation = installDesktopPnpmRuntime({
      ...options(stateDir, platform, environment),
      appExecutable: process.execPath,
      pnpmBinPath: captureEntry,
    })

    const command = process.platform === 'win32'
      ? process.env.ComSpec ?? 'cmd.exe'
      : 'pnpm'
    const args = process.platform === 'win32'
      ? ['/d', '/s', '/c', `""${installation.pnpmShimPath}" "${captureOutput}""`]
      : [captureOutput]
    const result = spawnSync(command, args, {
      encoding: 'utf8',
      env: environment,
      shell: false,
      windowsVerbatimArguments: process.platform === 'win32',
    })

    expect(result.error).toBeUndefined()
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    const capture = JSON.parse(readFileSync(captureOutput, 'utf8')) as Record<string, unknown>
    expect(capture).toMatchObject({
      ignoresMinimumReleaseAge: true,
      runAsNode: process.platform === 'win32' ? ['ELECTRON_RUN_AS_NODE'] : [],
      runtime: 'electron',
      target: '43.4.0',
      disturl: 'https://electronjs.org/headers',
    })
    expect(resolve(String(capture.node))).toBe(resolve(installation.nodeShimPath))
    const [capturedNodeBinDir, ...capturedPath] = String(capture.path).split(pathDelimiter)
    expect(resolve(capturedNodeBinDir ?? '')).toBe(resolve(installation.nodeBinDir))
    expect(capturedPath.join(pathDelimiter)).toBe(environment.PATH ?? '')
    expect(environment).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
    expect(environment).not.toHaveProperty('npm_config_runtime')
    installation.dispose()
  })

  it.runIf(process.platform === 'win32')(
    'keeps process.execPath descendants in Electron Node mode on Windows',
    () => {
      const root = temporaryDirectory()
      const childEntry = join(root, 'child.mjs')
      const parentEntry = join(root, 'parent.mjs')
      const output = join(root, 'result.json')
      const electronExecutable = createRequire(import.meta.url)('electron') as string
      writeFileSync(childEntry, [
        "process.stdout.write('child-stdout')",
        "process.stderr.write('child-stderr')",
        'process.exitCode = 23',
        '',
      ].join('\n'))
      writeFileSync(parentEntry, [
        "import { spawnSync } from 'node:child_process'",
        "import { writeFileSync } from 'node:fs'",
        'const [childEntry, output] = process.argv.slice(2)',
        "const child = spawnSync(process.execPath, [childEntry], { encoding: 'utf8', windowsHide: true })",
        'writeFileSync(output, JSON.stringify({',
        '  execPath: process.execPath,',
        "  runAsNode: Object.keys(process.env).filter(name => name.toUpperCase() === 'ELECTRON_RUN_AS_NODE'),",
        '  child: { status: child.status, stdout: child.stdout, stderr: child.stderr },',
        '}))',
        '',
      ].join('\n'))
      const installation = installDesktopPnpmRuntime({
        ...options(join(root, 'runtime'), 'win32', { Path: process.env.Path }),
        appExecutable: electronExecutable,
        pnpmBinPath: parentEntry,
      })

      const result = spawnSync(electronExecutable, [
        '--require',
        installation.clearEnvironmentPath,
        parentEntry,
        childEntry,
        output,
      ], {
        encoding: 'utf8',
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        timeout: 30_000,
        windowsHide: true,
      })

      expect(result.error).toBeUndefined()
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
      const capture = JSON.parse(readFileSync(output, 'utf8')) as Record<string, unknown>
      expect(resolve(String(capture.execPath))).toBe(resolve(electronExecutable))
      expect(capture.runAsNode).toEqual(['ELECTRON_RUN_AS_NODE'])
      expect(capture.child).toEqual({
        status: 23,
        stdout: 'child-stdout',
        stderr: 'child-stderr',
      })
      installation.dispose()
    },
  )

  it('creates Windows batch shims without publishing the private Node directory', () => {
    const stateDir = join(temporaryDirectory(), 'runtime-state')
    const environment: NodeJS.ProcessEnv = {
      Path: 'C:\\Windows\\System32;C:\\Windows',
      KEEP: 'value',
    }
    const original = { ...environment }

    const installation = installDesktopPnpmRuntime(options(stateDir, 'win32', environment))

    expect(readdirSync(installation.pathDir)).toEqual(['pnpm.cmd'])
    expect(readdirSync(installation.nodeBinDir)).toEqual(['node.cmd'])
    const pnpm = readFileSync(installation.pnpmShimPath, 'utf8')
    expect(pnpm).toContain('set "DSH_RUNTIME_ROOT=%~dp0.."')
    expect(pnpm).toContain('set "PATH=%DSH_RUNTIME_NODE_BIN%;%PATH%"')
    expect(pnpm).toContain('set "NODE=%DSH_RUNTIME_NODE_BIN%\\node.cmd"')
    expect(pnpm).toContain('set "ELECTRON_RUN_AS_NODE=1"')
    expect(pnpm).toContain('set "npm_config_runtime=electron"')
    expect(pnpm).toContain('set "npm_config_target=43.4.0"')
    expect(pnpm).toContain('--require "%DSH_RUNTIME_PRIVATE%\\clear-env.cjs"')
    expect(pnpm.indexOf('--require "%DSH_RUNTIME_PRIVATE%\\clear-env.cjs"')).toBeLessThan(
      pnpm.indexOf('pnpm\\bin\\pnpm.mjs'),
    )
    expect(pnpm.match(/--config\.minimumReleaseAge=0/gu)).toHaveLength(1)
    expect(pnpm).toContain('--config.minimumReleaseAge=0 %*')
    const node = readFileSync(installation.nodeShimPath, 'utf8')
    expect(node).toContain('set "ELECTRON_RUN_AS_NODE=1"')
    expect(node).toContain('--require "%DSH_RUNTIME_PRIVATE%\\clear-env.cjs" %*')
    expect(node).not.toContain('npm_config_')
    expect(readFileSync(installation.clearEnvironmentPath, 'utf8')).not.toContain(
      "name.toUpperCase() === 'ELECTRON_RUN_AS_NODE'",
    )

    expect(environment).toEqual({
      Path: `${installation.pathDir};C:\\Windows\\System32;C:\\Windows`,
      KEEP: 'value',
    })
    expect(environment).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
    expect(environment).not.toHaveProperty('npm_config_runtime')

    installation.dispose()
    installation.dispose()
    expect(environment).toEqual(original)
  })

  it('removes only its own PATH component when another owner changes PATH later', () => {
    const stateDir = join(temporaryDirectory(), 'runtime')
    const platform = process.platform === 'win32' ? 'win32' : 'linux'
    const originalPath = process.platform === 'win32' ? 'C:\\Windows' : '/usr/bin'
    const laterPath = process.platform === 'win32' ? 'C:\\later' : '/later/bin'
    const environment: NodeJS.ProcessEnv = { PATH: originalPath }
    const installation = installDesktopPnpmRuntime(options(stateDir, platform, environment))
    environment.PATH = `${laterPath}${pathDelimiter}${environment.PATH ?? ''}`

    installation.dispose()
    installation.dispose()

    expect(environment).toEqual({ PATH: `${laterPath}${pathDelimiter}${originalPath}` })
  })

  it('normalizes Windows separators and trailing separators when replacing legacy PATH entries', () => {
    const root = temporaryDirectory()
    const stateDir = join(root, 'runtime-commands')
    const environment: NodeJS.ProcessEnv = { Path: 'C:\\Windows' }
    const first = installDesktopPnpmRuntime(options(stateDir, 'win32', environment))
    first.dispose()
    const legacyPathDir = join(stateDir, 'bin')
    mkdirSync(legacyPathDir, { recursive: true })
    writeFileSync(join(legacyPathDir, 'bsk.exe'), 'legacy unknown command')
    const legacyVariant = `${legacyPathDir.replaceAll('/', '\\')}\\`
    const activeVariant = `${first.pathDir.replaceAll('/', '\\')}\\`
    const systemPath = 'C:/Windows/System32/'
    environment.Path = `"${legacyVariant}";"${activeVariant}";${systemPath}`

    const second = installDesktopPnpmRuntime(options(stateDir, 'win32', environment))

    expect(second.pathDir).toBe(first.pathDir)
    expect(environment.Path).toBe(`${second.pathDir};${systemPath}`)
    second.dispose()
    expect(environment.Path).toBe(`"${legacyVariant}";"${activeVariant}";${systemPath}`)
  })

  it.runIf(process.platform === 'win32')('reclaims PATH precedence from an inherited Desktop terminal shim', () => {
    const root = temporaryDirectory()
    const stateDir = join(root, 'runtime')
    const pathDir = join(stateDir, 'bin')
    const terminalShimDir = join(root, 'terminal', 'bin')
    const captureEntry = join(root, 'capture.mjs')
    const captureOutput = join(root, 'capture.txt')
    mkdirSync(terminalShimDir, { recursive: true })
    writeFileSync(join(terminalShimDir, 'pnpm.cmd'), '@echo inherited terminal shim failed\r\n@exit /b 90\r\n')
    writeFileSync(captureEntry, [
      "import { writeFileSync } from 'node:fs'",
      "writeFileSync(process.argv.at(-1), 'host runtime')",
      '',
    ].join('\n'))
    const environment: NodeJS.ProcessEnv = {
      Path: `${terminalShimDir};${pathDir};${process.env.Path ?? ''}`,
      PATHEXT: process.env.PATHEXT,
      SystemRoot: process.env.SystemRoot,
    }
    const original = { ...environment }

    const installation = installDesktopPnpmRuntime({
      ...options(stateDir, 'win32', environment),
      appExecutable: process.execPath,
      pnpmBinPath: captureEntry,
    })
    const result = spawnSync(process.env.ComSpec ?? 'cmd.exe', [
      '/d',
      '/s',
      '/c',
      `pnpm "${captureOutput}"`,
    ], {
      encoding: 'utf8',
      env: environment,
      shell: false,
      windowsVerbatimArguments: true,
    })

    expect(result.error).toBeUndefined()
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    expect(readFileSync(captureOutput, 'utf8')).toBe('host runtime')
    installation.dispose()
    expect(environment).toEqual(original)
  })

  it('reuses an exact immutable generation without rewriting it', () => {
    const stateDir = join(temporaryDirectory(), 'runtime')
    const platform = process.platform === 'win32' ? 'win32' : 'linux'
    const originalPath = process.platform === 'win32' ? 'C:\\Windows' : '/usr/bin'
    const environment: NodeJS.ProcessEnv = { PATH: originalPath }
    const first = installDesktopPnpmRuntime(options(stateDir, platform, environment))
    const firstStat = lstatSync(first.pnpmShimPath)
    first.dispose()
    environment.PATH = `${first.pathDir}${pathDelimiter}${originalPath}`

    const second = installDesktopPnpmRuntime(options(stateDir, platform, environment))

    expect(second.pathDir).toBe(first.pathDir)
    expect(lstatSync(second.pnpmShimPath).ino).toBe(firstStat.ino)
    expect(lstatSync(second.pnpmShimPath).mtimeMs).toBe(firstStat.mtimeMs)
    expect(environment.PATH).toBe(`${first.pathDir}${pathDelimiter}${originalPath}`)
    second.dispose()
    expect(environment.PATH).toBe(`${first.pathDir}${pathDelimiter}${originalPath}`)
  })

  it('rejects symlinked state directories before changing PATH', () => {
    const root = temporaryDirectory()
    const target = join(root, 'target')
    const stateDir = join(root, 'runtime')
    mkdirSync(target)
    symlinkSync(target, stateDir)
    const environment: NodeJS.ProcessEnv = { PATH: '/usr/bin' }

    expect(() => installDesktopPnpmRuntime(options(stateDir, 'linux', environment)))
      .toThrow('not a private directory')
    expect(environment).toEqual({ PATH: '/usr/bin' })
  })

  it('publishes a clean sibling instead of trusting a contaminated generation', () => {
    const root = temporaryDirectory()
    const stateDir = join(root, 'runtime')
    const environment: NodeJS.ProcessEnv = { PATH: '/usr/bin' }
    const first = installDesktopPnpmRuntime(options(stateDir, 'linux', environment))
    first.dispose()
    const target = join(root, 'outside')
    writeFileSync(target, 'outside')
    rmSync(first.pnpmShimPath)
    symlinkSync(target, first.pnpmShimPath)
    const unknownExecutable = join(first.pathDir, 'bsk.exe')
    writeFileSync(unknownExecutable, 'locked or foreign')
    environment.PATH = `${first.pathDir}:/usr/bin`

    const second = installDesktopPnpmRuntime(options(stateDir, 'linux', environment))

    expect(second.pathDir).not.toBe(first.pathDir)
    expect(readdirSync(second.pathDir)).toEqual(['pnpm'])
    expect(environment.PATH).toBe(`${second.pathDir}:/usr/bin`)
    expect(readFileSync(unknownExecutable, 'utf8')).toBe('locked or foreign')
    expect(readFileSync(target, 'utf8')).toBe('outside')
    second.dispose()
  })

  it('leaves legacy unknown files untouched and excludes their directories from PATH', () => {
    const root = temporaryDirectory()
    const stateDir = join(root, 'runtime')
    const legacyPathDir = join(stateDir, 'bin')
    const legacyNodeBinDir = join(stateDir, 'private', 'node-bin')
    mkdirSync(legacyPathDir, { recursive: true })
    mkdirSync(legacyNodeBinDir, { recursive: true })
    const publicUnknown = join(legacyPathDir, 'bsk.exe')
    const privateUnknown = join(legacyNodeBinDir, 'bsk.exe')
    writeFileSync(publicUnknown, 'locked public command')
    writeFileSync(privateUnknown, 'locked private command')
    const environment: NodeJS.ProcessEnv = {
      PATH: `${legacyPathDir}:${legacyNodeBinDir}:/usr/bin`,
    }

    const installation = installDesktopPnpmRuntime(options(stateDir, 'linux', environment))

    expect(installation.pathDir).not.toBe(legacyPathDir)
    expect(environment.PATH).toBe(`${installation.pathDir}:/usr/bin`)
    expect(readFileSync(publicUnknown, 'utf8')).toBe('locked public command')
    expect(readFileSync(privateUnknown, 'utf8')).toBe('locked private command')
    installation.dispose()
  })

  it('does not attempt to delete a published generation that could still be locked', () => {
    const root = temporaryDirectory()
    const stateDir = join(root, 'runtime')
    const environment: NodeJS.ProcessEnv = { PATH: '/usr/bin' }
    const first = installDesktopPnpmRuntime(options(stateDir, 'linux', environment))
    const firstRoot = dirname(first.pathDir)
    first.dispose()
    const originalRmSync = fs.rmSync
    const rm = vi.spyOn(fs, 'rmSync').mockImplementation((filename, rmOptions) => {
      if (filename === firstRoot) {
        throw Object.assign(new Error('locked'), { code: 'EPERM' })
      }
      return originalRmSync(filename, rmOptions)
    })
    syncBuiltinESMExports()

    let second: ReturnType<typeof installDesktopPnpmRuntime> | undefined
    try {
      second = installDesktopPnpmRuntime({
        ...options(stateDir, 'linux', environment),
        electronVersion: '44.0.0',
      })
    } finally {
      rm.mockRestore()
      syncBuiltinESMExports()
    }

    expect(second).toBeDefined()
    expect(environment.PATH).toBe(`${second?.pathDir}:/usr/bin`)
    expect(existsSync(firstRoot)).toBe(true)
    expect(rm.mock.calls.some(([filename]) => filename === firstRoot)).toBe(false)
    second?.dispose()
  })

  it('fails loud for unsupported platforms and unsafe generated values', () => {
    const root = temporaryDirectory()
    expect(() => installDesktopPnpmRuntime(options(join(root, 'runtime'), 'aix', { PATH: '/usr/bin' })))
      .toThrow('unsupported on aix')
    expect(() => installDesktopPnpmRuntime({
      ...options(join(root, 'newline-runtime'), 'linux', { PATH: '/usr/bin' }),
      electronVersion: '43.4.0\nmalicious',
    })).toThrow('must not contain NUL or newlines')
  })
})

describe('desktop Host dsh runtime', () => {
  it('content-addresses Windows DSH shims and reuses an exact generation', () => {
    const root = temporaryDirectory()
    const stateDir = join(root, 'runtime')
    const environment: NodeJS.ProcessEnv = { Path: 'C:\\Windows' }
    const runtimeOptions = {
      platform: 'win32' as const,
      appExecutable: 'C:\\Program Files\\DSH Desktop\\DSH Desktop.exe',
      dshBootstrapPath: 'C:\\Program Files\\DSH Desktop\\resources\\app.asar\\desktop-cli.js',
      profileName: 'web',
      homeDir: 'C:\\Users\\tester\\.dsh',
      stateDir,
      environment,
    }

    const first = installDesktopDshRuntime(runtimeOptions)
    const firstRoot = dirname(first.pathDir)
    first.dispose()
    const second = installDesktopDshRuntime(runtimeOptions)

    expect(second.pathDir).toBe(first.pathDir)
    expect(readdirSync(second.pathDir)).toEqual(['dsh.cmd'])
    expect(readdirSync(firstRoot).sort()).toEqual(['.generation.json', 'bin'])
    expect(readFileSync(second.dshShimPath, 'utf8')).toContain('set "DSH_DESKTOP_DEFAULT_PROFILE=web"')
    second.dispose()
  })

  it.runIf(process.platform === 'win32')('makes the active profile available to Host plugin child processes', () => {
    const root = temporaryDirectory()
    const stateDir = join(root, 'runtime')
    const captureEntry = join(root, 'capture.mjs')
    const captureOutput = join(root, 'capture.json')
    const homeDir = join(root, 'Harness home')
    writeFileSync(captureEntry, [
      "import { writeFileSync } from 'node:fs'",
      'writeFileSync(process.argv[2], JSON.stringify({',
      '  args: process.argv.slice(3),',
      '  defaultProfile: process.env.DSH_DESKTOP_DEFAULT_PROFILE,',
      '  home: process.env.DSH_HOME,',
      '}))',
      '',
    ].join('\n'))
    const environment: NodeJS.ProcessEnv = { Path: process.env.PATH }
    const original = { ...environment }

    const installation = installDesktopDshRuntime({
      platform: 'win32',
      appExecutable: process.execPath,
      dshBootstrapPath: captureEntry,
      profileName: 'web',
      homeDir,
      stateDir,
      environment,
    })
    const result = spawnSync(process.env.ComSpec ?? 'cmd.exe', [
      '/d',
      '/s',
      '/c',
      `dsh "${captureOutput}" --probe`,
    ], {
      encoding: 'utf8',
      env: environment,
      shell: false,
      windowsVerbatimArguments: true,
    })

    expect(result.error).toBeUndefined()
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    expect(readdirSync(installation.pathDir)).toEqual(['dsh.cmd'])
    expect(JSON.parse(readFileSync(captureOutput, 'utf8'))).toEqual({
      args: ['--probe'],
      defaultProfile: 'web',
      home: homeDir,
    })
    expect(environment.Path).toBe(`${installation.pathDir};${original.Path ?? ''}`)

    installation.dispose()
    installation.dispose()
    expect(environment).toEqual(original)
  })
})

describe('desktop Host codegraph runtime', () => {
  /** Build a stand-in bundle shaped like the vendored per-platform package. */
  function bundledCodegraph(platform: NodeJS.Platform, manifest: Record<string, unknown> = {}): string {
    const bundleDir = join(temporaryDirectory(), 'codegraph')
    const binDir = join(bundleDir, 'bin')
    mkdirSync(binDir, { recursive: true })
    writeFileSync(
      join(binDir, platform === 'win32' ? 'codegraph.cmd' : 'codegraph'),
      '#!/bin/sh\n',
      { mode: 0o755 },
    )
    writeFileSync(join(bundleDir, 'package.json'), JSON.stringify({ name: 'codegraph-fixture', ...manifest }))
    return bundleDir
  }

  it('prepends the packaged bin directory and restores PATH on dispose', () => {
    const bundleDir = bundledCodegraph('darwin')
    const binDir = join(bundleDir, 'bin')
    const environment: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' }

    const installation = installDesktopCodegraphRuntime({ platform: 'darwin', bundleDir, environment })

    expect(installation.pathDir).toBe(binDir)
    expect(environment.PATH).toBe(`${binDir}:/usr/bin:/bin`)

    installation.dispose()
    installation.dispose()
    expect(environment.PATH).toBe('/usr/bin:/bin')
  })

  it('publishes the Windows launcher with the platform delimiter', () => {
    const bundleDir = bundledCodegraph('win32')
    const environment: NodeJS.ProcessEnv = { Path: 'C:\\Windows' }

    const installation = installDesktopCodegraphRuntime({ platform: 'win32', bundleDir, environment })

    expect(environment.Path).toBe(`${join(bundleDir, 'bin')};C:\\Windows`)
    installation.dispose()
    expect(environment.Path).toBe('C:\\Windows')
  })

  it('keeps an existing PATH entry for another owner beneath its own', () => {
    const bundleDir = bundledCodegraph('darwin')
    const environment: NodeJS.ProcessEnv = { PATH: '/opt/other/bin:/usr/bin' }

    installDesktopCodegraphRuntime({ platform: 'darwin', bundleDir, environment })

    expect(environment.PATH).toBe(`${join(bundleDir, 'bin')}:/opt/other/bin:/usr/bin`)
  })

  it('fails loud for an unsupported platform, a relative path, and a missing launcher', () => {
    expect(() => installDesktopCodegraphRuntime({
      platform: 'linux',
      bundleDir: temporaryDirectory(),
      environment: {},
    })).toThrow(/unsupported on linux/u)

    expect(() => installDesktopCodegraphRuntime({
      platform: 'darwin',
      bundleDir: 'relative/codegraph',
      environment: {},
    })).toThrow(/must be absolute/u)

    // A bundle without its launcher must not silently reach the Host PATH.
    expect(() => installDesktopCodegraphRuntime({
      platform: 'darwin',
      bundleDir: temporaryDirectory(),
      environment: {},
    })).toThrow(/launcher is missing/u)
  })
})

describe('desktopCodegraphBundleSupportsHost', () => {
  function bundleWith(manifest: Record<string, unknown>): string {
    const bundleDir = join(temporaryDirectory(), 'codegraph')
    mkdirSync(bundleDir, { recursive: true })
    writeFileSync(join(bundleDir, 'package.json'), JSON.stringify({ name: 'codegraph-fixture', ...manifest }))
    return bundleDir
  }

  it('matches the declared platform and architecture', () => {
    const bundleDir = bundleWith({ os: ['darwin'], cpu: ['arm64'] })

    expect(desktopCodegraphBundleSupportsHost(bundleDir, 'darwin', 'arm64')).toBe(true)
    // A universal installer carries the arm64 bundle in the x64 slice too, where
    // its bundled runtime cannot execute.
    expect(desktopCodegraphBundleSupportsHost(bundleDir, 'darwin', 'x64')).toBe(false)
    expect(desktopCodegraphBundleSupportsHost(bundleDir, 'win32', 'arm64')).toBe(false)
  })

  it('accepts a bundle that declares no restriction', () => {
    expect(desktopCodegraphBundleSupportsHost(bundleWith({}), 'darwin', 'x64')).toBe(true)
  })

  it('rejects a missing or malformed manifest instead of publishing it', () => {
    expect(desktopCodegraphBundleSupportsHost(join(temporaryDirectory(), 'absent'), 'darwin', 'arm64')).toBe(false)

    const malformed = temporaryDirectory()
    writeFileSync(join(malformed, 'package.json'), 'not json')
    expect(desktopCodegraphBundleSupportsHost(malformed, 'darwin', 'arm64')).toBe(false)
  })
})

describe('desktop Host mnemon runtime', () => {
  /** Build a stand-in bundle shaped like the vendored per-platform package. */
  function bundledMnemon(platform: NodeJS.Platform, manifest: Record<string, unknown> = {}): string {
    const bundleDir = join(temporaryDirectory(), 'mnemon')
    const binDir = join(bundleDir, 'bin')
    mkdirSync(binDir, { recursive: true })
    writeFileSync(
      join(binDir, platform === 'win32' ? 'mnemon.exe' : 'mnemon'),
      '#!/bin/sh\n',
      { mode: 0o755 },
    )
    // The vendored archive reuses the main package name and puts the platform in
    // the version, unlike CodeGraph whose platform packages are suffixed.
    writeFileSync(
      join(bundleDir, 'package.json'),
      JSON.stringify({ name: '@mnemon-dev/mnemon', version: '0.2.9-darwin-arm64', ...manifest }),
    )
    return bundleDir
  }

  it('prepends the packaged bin directory and restores PATH on dispose', () => {
    const bundleDir = bundledMnemon('darwin')
    const binDir = join(bundleDir, 'bin')
    const environment: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' }

    const installation = installDesktopMnemonRuntime({ platform: 'darwin', bundleDir, environment })

    expect(installation.pathDir).toBe(binDir)
    expect(environment.PATH).toBe(`${binDir}:/usr/bin:/bin`)

    installation.dispose()
    installation.dispose()
    expect(environment.PATH).toBe('/usr/bin:/bin')
  })

  it('publishes the Windows launcher with the platform delimiter', () => {
    const bundleDir = bundledMnemon('win32')
    const environment: NodeJS.ProcessEnv = { Path: 'C:\\Windows' }

    const installation = installDesktopMnemonRuntime({ platform: 'win32', bundleDir, environment })

    expect(environment.Path).toBe(`${join(bundleDir, 'bin')};C:\\Windows`)
    installation.dispose()
    expect(environment.Path).toBe('C:\\Windows')
  })

  it('fails loud for an unsupported platform, a relative path, and a missing launcher', () => {
    expect(() => installDesktopMnemonRuntime({
      platform: 'linux',
      bundleDir: temporaryDirectory(),
      environment: {},
    })).toThrow(/mnemon runtime is unsupported on linux/u)

    expect(() => installDesktopMnemonRuntime({
      platform: 'darwin',
      bundleDir: 'relative/mnemon',
      environment: {},
    })).toThrow(/mnemon bundle directory must be absolute/u)

    // A bundle without its launcher must not silently reach the Host PATH.
    expect(() => installDesktopMnemonRuntime({
      platform: 'darwin',
      bundleDir: temporaryDirectory(),
      environment: {},
    })).toThrow(/packaged mnemon launcher is missing/u)
  })

  it('resolves the packaged CLI through PATH for a spawned process', () => {
    const bundleDir = bundledMnemon('darwin')
    const binDir = join(bundleDir, 'bin')
    // A real launcher proves the published directory actually makes the command
    // resolvable, which is the whole point of prepending it to PATH.
    writeFileSync(join(binDir, 'mnemon'), '#!/bin/sh\nprintf "mnemon version 0.2.9\\n"\n', { mode: 0o755 })
    const environment: NodeJS.ProcessEnv = { PATH: process.env.PATH, DSH_HOME: temporaryDirectory() }

    const installation = installDesktopMnemonRuntime({ platform: 'darwin', bundleDir, environment })
    try {
      const result = spawnSync('mnemon', ['--version'], { env: environment, encoding: 'utf8' })
      expect(result.stdout.trim()).toBe('mnemon version 0.2.9')
    } finally {
      installation.dispose()
    }
  })
})

describe('desktopMnemonBundleSupportsHost', () => {
  function bundleWith(manifest: Record<string, unknown>): string {
    const bundleDir = join(temporaryDirectory(), 'mnemon')
    mkdirSync(bundleDir, { recursive: true })
    writeFileSync(
      join(bundleDir, 'package.json'),
      JSON.stringify({ name: '@mnemon-dev/mnemon', ...manifest }),
    )
    return bundleDir
  }

  it('matches the declared platform and architecture', () => {
    const bundleDir = bundleWith({ os: ['darwin'], cpu: ['arm64'] })

    expect(desktopMnemonBundleSupportsHost(bundleDir, 'darwin', 'arm64')).toBe(true)
    // A universal installer carries the arm64 bundle in the x64 slice too, where
    // its bundled runtime cannot execute.
    expect(desktopMnemonBundleSupportsHost(bundleDir, 'darwin', 'x64')).toBe(false)
    expect(desktopMnemonBundleSupportsHost(bundleDir, 'win32', 'x64')).toBe(false)
  })

  it('accepts a bundle that declares no restriction', () => {
    expect(desktopMnemonBundleSupportsHost(bundleWith({}), 'darwin', 'x64')).toBe(true)
  })

  it('rejects a missing or malformed manifest instead of publishing it', () => {
    expect(desktopMnemonBundleSupportsHost(join(temporaryDirectory(), 'absent'), 'darwin', 'arm64')).toBe(false)

    const malformed = temporaryDirectory()
    writeFileSync(join(malformed, 'package.json'), 'not json')
    expect(desktopMnemonBundleSupportsHost(malformed, 'darwin', 'arm64')).toBe(false)
  })
})

describe('publishDesktopMnemonRuntime', () => {
  /** Build a bundle directory without creating any launcher. */
  function manifestOnlyBundle(
    cpu: readonly string[] | undefined,
  ): string {
    const bundleDir = join(temporaryDirectory(), 'mnemon')
    mkdirSync(join(bundleDir, 'bin'), { recursive: true })
    writeFileSync(
      join(bundleDir, 'package.json'),
      JSON.stringify({ name: '@mnemon-dev/mnemon', ...(cpu === undefined ? {} : { os: ['darwin'], cpu }) }),
    )
    return bundleDir
  }

  it('publishes the CLI and reports no failure when the bundle matches the host', () => {
    const bundleDir = manifestOnlyBundle(undefined)
    writeFileSync(join(bundleDir, 'bin', 'mnemon'), '#!/bin/sh\n', { mode: 0o755 })
    const environment: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' }

    const publication = publishDesktopMnemonRuntime(bundleDir, 'darwin', 'arm64', environment)

    expect(publication.failure).toBeUndefined()
    expect(publication.installation?.pathDir).toBe(join(bundleDir, 'bin'))
    expect(environment.PATH).toBe(`${join(bundleDir, 'bin')}:/usr/bin:/bin`)
    publication.installation?.dispose()
    expect(environment.PATH).toBe('/usr/bin:/bin')
  })

  it('reports a failure instead of throwing when the launcher is missing', () => {
    // Startup ends in a failure screen if this escapes, so the publication helper
    // has to absorb the installer's throw and hand back a loggable reason.
    const bundleDir = manifestOnlyBundle(undefined)
    const environment: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' }

    const publication = publishDesktopMnemonRuntime(bundleDir, 'darwin', 'arm64', environment)

    expect(publication.installation).toBeUndefined()
    expect(publication.failure).toMatch(/mnemon CLI runtime unavailable/u)
    expect(publication.failure).toMatch(/packaged mnemon launcher is missing/u)
    expect(environment.PATH).toBe('/usr/bin:/bin')
  })

  it('stays silent when the bundle cannot run on this host', () => {
    // A universal installer carries one slice's bundle in the other slice, where
    // the mismatch is expected rather than something worth logging every launch.
    const bundleDir = manifestOnlyBundle(['arm64'])
    writeFileSync(join(bundleDir, 'bin', 'mnemon'), '#!/bin/sh\n', { mode: 0o755 })
    const environment: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' }

    const publication = publishDesktopMnemonRuntime(bundleDir, 'darwin', 'x64', environment)

    expect(publication.installation).toBeUndefined()
    expect(publication.failure).toBeUndefined()
    expect(environment.PATH).toBe('/usr/bin:/bin')
  })

  it('stays silent for an unreadable manifest, which counts as unsupported', () => {
    // `bundleSupportsHost` already turns a malformed manifest into "unsupported",
    // so this path is a quiet skip rather than a failure worth logging.
    const bundleDir = temporaryDirectory()
    writeFileSync(join(bundleDir, 'package.json'), 'not json')
    const environment: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' }

    const publication = publishDesktopMnemonRuntime(bundleDir, 'darwin', 'arm64', environment)

    expect(publication.installation).toBeUndefined()
    expect(publication.failure).toBeUndefined()
    expect(environment.PATH).toBe('/usr/bin:/bin')
  })
})

describe('publishDesktopCodegraphRuntime', () => {
  it('publishes the CLI and reports no failure when the bundle matches the host', () => {
    const bundleDir = join(temporaryDirectory(), 'codegraph')
    mkdirSync(join(bundleDir, 'bin'), { recursive: true })
    writeFileSync(join(bundleDir, 'package.json'), JSON.stringify({ name: '@hyzyn/dsh-codegraph' }))
    writeFileSync(join(bundleDir, 'bin', 'codegraph'), '#!/bin/sh\n', { mode: 0o755 })
    const environment: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' }

    const publication = publishDesktopCodegraphRuntime(bundleDir, 'darwin', 'arm64', environment)

    expect(publication.failure).toBeUndefined()
    expect(publication.installation?.pathDir).toBe(join(bundleDir, 'bin'))
    publication.installation?.dispose()
    expect(environment.PATH).toBe('/usr/bin:/bin')
  })

  it('reports a failure instead of throwing when the launcher is missing', () => {
    const bundleDir = join(temporaryDirectory(), 'codegraph')
    mkdirSync(join(bundleDir, 'bin'), { recursive: true })
    writeFileSync(join(bundleDir, 'package.json'), JSON.stringify({ name: '@hyzyn/dsh-codegraph' }))
    const environment: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' }

    const publication = publishDesktopCodegraphRuntime(bundleDir, 'darwin', 'arm64', environment)

    expect(publication.installation).toBeUndefined()
    expect(publication.failure).toMatch(/codegraph CLI runtime unavailable/u)
    expect(publication.failure).toMatch(/packaged codegraph launcher is missing/u)
    expect(environment.PATH).toBe('/usr/bin:/bin')
  })
})
