import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DESKTOP_INSTALLER_QUIT_FLAG } from '../src/desktop-installer-quit.ts'

describe('Windows NSIS running-app handoff', () => {
  it('checks for the exact app before requesting orderly shutdown', () => {
    const script = readFileSync(join(process.cwd(), 'build', 'installer.nsh'), 'utf8')
    const firstDetection = script.indexOf('!insertmacro FIND_PROCESS')
    const request = script.indexOf(DESKTOP_INSTALLER_QUIT_FLAG)
    const wait = script.indexOf('dsh_installer_wait_for_exit:')
    const fallback = script.indexOf('dsh_installer_scoped_fallback:')

    expect(script).toContain('!macro customCheckAppRunning')
    expect(script).toContain('Var pid')
    expect(script).toContain('ExecWait')
    expect(script).toContain('$INSTDIR\\${APP_EXECUTABLE_FILENAME}')
    expect(script).toContain('!insertmacro IS_POWERSHELL_AVAILABLE')
    expect(firstDetection).toBeGreaterThanOrEqual(0)
    expect(request).toBeGreaterThan(firstDetection)
    expect(wait).toBeGreaterThan(request)
    expect(fallback).toBeGreaterThan(wait)
  })

  it('waits for graceful disposal before using the scoped builder fallback', () => {
    const script = readFileSync(join(process.cwd(), 'build', 'installer.nsh'), 'utf8')

    expect(script).toContain('$R1 < 60')
    expect(script).toContain('Sleep 500')
    expect(script).toContain('!insertmacro KILL_PROCESS "${APP_EXECUTABLE_FILENAME}" 0')
    expect(script).toContain('!insertmacro KILL_PROCESS "${APP_EXECUTABLE_FILENAME}" 1')
    expect(script).not.toContain('taskkill')
    expect(script).not.toContain('nsProcess::KillProcess')
    expect(script).not.toContain('getProcessInfo.nsh')
  })
})

describe('Windows NSIS bundled-CLI PATH integration', () => {
  const readScript = (): string => readFileSync(join(process.cwd(), 'build', 'installer.nsh'), 'utf8')

  it('publishes each CLI to the per-user PATH and nothing machine-wide', () => {
    const script = readScript()
    const writes = script.match(/WriteRegExpandStr HKCU "Environment" "Path"/gu) ?? []

    expect(script).toContain('!macro customInstall')
    expect(script).toContain('!macro customUnInstall')
    // Two writes each for install and uninstall — one CodeGraph, one Mnemon;
    // both target the user hive, which needs no administrator rights and leaves
    // other accounts alone.
    expect(writes).toHaveLength(4)
    // REG_EXPAND_SZ is what Windows expects of PATH. Writing it as a plain
    // string would freeze any %VAR% the user had in there.
    expect(script).not.toContain('WriteRegStr HKCU "Environment"')
    // setx truncates PATH at 1024 characters; never use it for this.
    expect(script).not.toContain('setx')
    // Whatever PATH held before the change stays recoverable.
    expect(script).toContain('WriteRegExpandStr HKCU "Software\\${PRODUCT_NAME}" "PathBackup"')
    // An already open terminal cannot pick the value up, but Explorer and
    // anything started later can, once the change is broadcast.
    expect(script).toContain('${DSH_HWND_BROADCAST} ${DSH_WM_WININICHANGE}')
  })

  it('survives reinstalling and never rewrites a PATH the user reordered', () => {
    const script = readScript()

    // An upgrade runs customInstall again over the same directory.
    expect(script).toContain('${StrContains} $1 "${DSH_CODEGRAPH_BIN}" "$0"')
    expect(script).toContain('${StrContains} $1 "${DSH_MNEMON_BIN}" "$0"')
    // Removal only fires when the entry is still the last one.
    expect(script).toContain('StrCpy $4 "$0" $3 -$3')
    expect(script).toContain('${if} $4 == ";$INSTDIR\\${DSH_CODEGRAPH_BIN}"')
    expect(script).toContain('${if} $4 == ";$INSTDIR\\${DSH_MNEMON_BIN}"')
  })

  it('peels the two entries off in the reverse of the order they were added', () => {
    const script = readScript()
    const install = script.indexOf('${DSH_CODEGRAPH_BIN}\\codegraph.cmd')
    const installMnemon = script.indexOf('${DSH_MNEMON_BIN}\\mnemon.exe')
    const uninstallStart = script.indexOf('!macro customUnInstall')
    const uninstallMnemon = script.indexOf('${DSH_MNEMON_BIN}', uninstallStart)
    const uninstallCodegraph = script.indexOf('${DSH_CODEGRAPH_BIN}', uninstallStart)

    // Install appends CodeGraph then Mnemon, so uninstall must remove Mnemon
    // first: each entry is only removed when it is still last.
    expect(install).toBeGreaterThan(-1)
    expect(installMnemon).toBeGreaterThan(install)
    expect(uninstallMnemon).toBeGreaterThan(uninstallStart)
    expect(uninstallCodegraph).toBeGreaterThan(uninstallMnemon)
  })

  it('keeps the pristine PATH recoverable no matter which branch writes first', () => {
    const script = readScript()

    // Both branches run on the same install, so the second one must not
    // overwrite the backup with an already-modified PATH.
    expect(script).toContain('ReadRegStr $6 HKCU "Software\\${PRODUCT_NAME}" "PathBackup"')
  })

  it('publishes the CLI only when it actually shipped in the package', () => {
    const script = readScript()

    // Only when the CLI really shipped is there a command worth publishing.
    expect(script).toContain('${if} ${FileExists} "$INSTDIR\\${DSH_CODEGRAPH_BIN}\\codegraph.cmd"')
    // Mnemon ships a real executable rather than a .cmd shim.
    expect(script).toContain('${if} ${FileExists} "$INSTDIR\\${DSH_MNEMON_BIN}\\mnemon.exe"')
    // ${StrContains} reaches the macro through assistedInstaller.nsh, which a
    // oneClick installer does not pull in; the dependency is recorded in a
    // comment because the include is processed before that file is read.
    expect(script).toContain('${StrContains} $1 "${DSH_CODEGRAPH_BIN}" "$0"')
  })
})
