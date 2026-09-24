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

  it('publishes one shim directory to the per-user PATH and nothing machine-wide', () => {
    const script = readScript()
    const writes = script.match(/WriteRegExpandStr HKCU "Environment" "Path"/gu) ?? []

    expect(script).toContain('!macro customInstall')
    expect(script).toContain('!macro customUnInstall')
    // One write for install and one for uninstall. The two per-CLI entries that
    // used to point at the installation directory are gone: both CLIs are now
    // reached through the same `<home dir>\.dsh\bin` shim directory.
    expect(writes).toHaveLength(2)
    // The target is the user's shim directory, never the installation
    // directory, which an upgrade renames away and then deletes.
    expect(script).toContain('StrCpy $0 "$PROFILE\\${DSH_SHIM_DIR}"')
    expect(script).toContain('StrCpy $0 "$0;$PROFILE\\${DSH_SHIM_DIR}"')
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

  it('never registers an installation subdirectory as a PATH entry', () => {
    const script = readScript()
    const install = script.slice(script.indexOf('!macro customInstall'), script.indexOf('!macro customUnInstall'))

    // The old target was `<install dir>\resources\codegraph\bin`. A directory
    // under $INSTDIR must never reach PATH again: an upgrade wipes it, a
    // `C:\Program Files` install cannot be written by the non-elevated process
    // that generates the shims, and uninstalling would leave a dead entry.
    //
    // $INSTDIR may appear only in the existence check that decides whether
    // there is a command worth publishing. Any other occurrence would mean the
    // installation directory is being used as a value.
    expect(install.match(/\$INSTDIR/gu) ?? []).toHaveLength(1)
    expect(install).toContain('${if} ${FileExists} "$INSTDIR\\${DSH_CODEGRAPH_BIN}\\codegraph.cmd"')
    // Mnemon has no branch of its own left: both CLIs ship in the same
    // extraResources block and are reached through the same shim directory.
    expect(script).not.toContain('DSH_MNEMON_BIN')
  })

  it('survives reinstalling and never rewrites a PATH the user reordered', () => {
    const script = readScript()

    // An upgrade runs customInstall again over the same directory.
    expect(script).toContain('${StrContains} $1 "${DSH_SHIM_DIR}" "$0"')
    // Removal only fires when the entry is still the last one.
    expect(script).toContain('StrCpy $4 "$0" $3 -$3')
    expect(script).toContain('${if} $4 == ";$PROFILE\\${DSH_SHIM_DIR}"')
  })

  it('backs up the pristine PATH exactly once, at the single write point', () => {
    const script = readScript()
    const install = script.indexOf('!macro customInstall')
    const uninstall = script.indexOf('!macro customUnInstall')
    const guard = script.indexOf('${if} $1 == ""', install)
    const backup = script.indexOf('"PathBackup" "$0"', install)

    // With one write point there is no second branch that could overwrite the
    // backup with an already-modified PATH, so the `$6` re-read that guarded
    // the two-branch version is gone rather than merely unused.
    expect(script).not.toContain('ReadRegStr $6 HKCU')
    expect(guard).toBeGreaterThan(install)
    expect(backup).toBeGreaterThan(guard)
    expect(backup).toBeLessThan(uninstall)
  })

  it('publishes the shim directory only when the packaged CLI actually shipped', () => {
    const script = readScript()

    // Only when the CLI really shipped is there a command worth publishing.
    // CodeGraph and Mnemon come from the same extraResources block, so one
    // check covers both.
    expect(script).toContain('${if} ${FileExists} "$INSTDIR\\${DSH_CODEGRAPH_BIN}\\codegraph.cmd"')
    // ${StrContains} reaches the macro through assistedInstaller.nsh, which a
    // oneClick installer does not pull in; the dependency is recorded in a
    // comment because the include is processed before that file is read.
    expect(script).toContain('${StrContains} $1 "${DSH_SHIM_DIR}" "$0"')
  })

  it('leaves the shim files in the user data directory on uninstall', () => {
    const script = readScript()
    const uninstall = script.slice(script.indexOf('!macro customUnInstall'))

    // The shim directory belongs to the user's data, not to this installation,
    // and another edition may be using the same directory. Uninstalling removes
    // the PATH entry only.
    expect(uninstall).not.toContain('RMDir')
    expect(uninstall).not.toContain('Delete')
    expect(uninstall).not.toContain('$PROFILE\\${DSH_SHIM_DIR}\\')
  })
})
