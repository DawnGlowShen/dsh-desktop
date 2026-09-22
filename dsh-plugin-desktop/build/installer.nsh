; Shorten the default install location: the bundled default is
; %LOCALAPPDATA%\Programs\<product name>, two levels deeper than the user
; profile. preInit runs in .onInit before initMultiUser reads InstallLocation,
; so seeding the value here changes the directory the wizard pre-fills.
;
; Only seed it when no installation is recorded. The installer writes this same
; value back after a successful install, so an unconditional write would move an
; existing installation on the next upgrade and leave two copies on the machine.
; Upgrades and reinstalls therefore stay exactly where they are.
!macro preInit
  ReadRegStr $R0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${if} $R0 == ""
    ReadRegStr $R0 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${if} $R0 == ""
      WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$PROFILE\${PRODUCT_NAME}"
    ${endIf}
  ${endIf}
!macroend

; Check the exact app process before launching the quit handoff. This preserves
; the #469 fix: unrelated helpers under $INSTDIR must never block an upgrade.
Var pid

!macro customCheckAppRunning
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
  ${if} $R0 != 0
    Goto dsh_installer_app_stopped
  ${endIf}

  IfFileExists "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 dsh_installer_scoped_fallback
    ; Newer versions receive this through Electron's single-instance channel.
    ; 2.0.2 ignores it, so the scoped builder fallback remains necessary for
    ; the first upgrade to a version that supports orderly shutdown.
    ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --dsh-installer-quit'
    StrCpy $R1 0

  dsh_installer_wait_for_exit:
    !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
    ${if} $R0 != 0
      Goto dsh_installer_app_stopped
    ${endIf}
    IntOp $R1 $R1 + 1
    ; Slow disks, antivirus hooks, and a large physical runtime can keep the
    ; process alive after Cordis disposal begins. Give the orderly handoff a
    ; full 30 seconds before escalating to the scoped forced-close path.
    ${if} $R1 < 60
      Sleep 500
      Goto dsh_installer_wait_for_exit
    ${endIf}

  dsh_installer_scoped_fallback:
    ; The patched builder macros match DSH Desktop.exe, not every executable
    ; below $INSTDIR. They handle pre-handoff releases and stubborn processes.
    MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK dsh_installer_stop_app
    Quit

  dsh_installer_stop_app:
    DetailPrint "$(appClosing)"
    ; KILL_PROCESS's tasklist fallback excludes $pid. The installer never has
    ; the application executable name, so zero is a safe sentinel here.
    StrCpy $pid 0
    !insertmacro KILL_PROCESS "${APP_EXECUTABLE_FILENAME}" 0
    Sleep 500
    StrCpy $R1 0

  dsh_installer_wait_for_fallback:
    !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
    ${if} $R0 != 0
      Goto dsh_installer_app_stopped
    ${endIf}
    IntOp $R1 $R1 + 1
    ${if} $R1 > 1
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY dsh_installer_wait_for_fallback
      Quit
    ${endIf}
    Sleep 1000
    !insertmacro KILL_PROCESS "${APP_EXECUTABLE_FILENAME}" 1
    Sleep 500
    Goto dsh_installer_wait_for_fallback

  dsh_installer_app_stopped:
!macroend

; Publish the packaged CodeGraph CLI to the user's own terminal.
;
; The CLI ships in <install dir>\resources\codegraph\bin, where codegraph.cmd
; sits next to its own node.exe. The application prepends that directory to the
; PATH of the Host process it starts, but a terminal the user opens is not that
; process, so the only way `codegraph` resolves there is a PATH entry written at
; install time.
;
; perMachine is false, so this targets HKCU rather than HKLM: no administrator
; rights needed, and other accounts on the same machine stay untouched.

; WinMessages.nsh is not pulled in by this template, so spell the two constants
; out rather than add another include dependency.
!define DSH_HWND_BROADCAST 0xFFFF
!define DSH_WM_WININICHANGE 0x001A

!define DSH_CODEGRAPH_BIN "resources\codegraph\bin"
!define DSH_MNEMON_BIN "resources\mnemon\bin"

!macro customInstall
  ; customInstall runs after installApplicationFiles, so the CLI can be checked
  ; for here. Without it there is no command worth publishing.
  ${if} ${FileExists} "$INSTDIR\${DSH_CODEGRAPH_BIN}\codegraph.cmd"
    ReadRegStr $0 HKCU "Environment" "Path"
    ; An upgrade installs over the same directory and runs this again, so an
    ; entry that is already present must not be appended twice.
    ;
    ; ${StrContains} reaches this macro through assistedInstaller.nsh, which a
    ; oneClick installer does not pull in. Switching to oneClick would break the
    ; line below at compile time, which is how it should fail.
    ${StrContains} $1 "${DSH_CODEGRAPH_BIN}" "$0"
    ${if} $1 == ""
      ; Keep the value about to be replaced. Because the dedupe above runs
      ; first, this only fires when PATH actually changes, so an upgrade never
      ; overwrites the backup with an already-modified value.
      WriteRegExpandStr HKCU "Software\${PRODUCT_NAME}" "PathBackup" "$0"
      ${if} $0 == ""
        StrCpy $0 "$INSTDIR\${DSH_CODEGRAPH_BIN}"
      ${else}
        StrCpy $0 "$0;$INSTDIR\${DSH_CODEGRAPH_BIN}"
      ${endIf}
      ; Expand-string keeps PATH a REG_EXPAND_SZ, which is what Windows expects
      ; of it; a plain string would freeze any %VAR% a user put in there.
      WriteRegExpandStr HKCU "Environment" "Path" "$0"
      ; Running processes keep the block they started with. This tells Explorer
      ; and anything launched afterwards to pick the new value up; an already
      ; open terminal still has to be reopened.
      SendMessage ${DSH_HWND_BROADCAST} ${DSH_WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000
    ${endIf}
  ${endIf}

  ; The packaged Mnemon CLI ships the same way and is published the same way.
  ; This branch is deliberately a mirror of the one above rather than a
  ; parameterized loop: NSIS macros are textual, so a shared body would need
  ; every define and register name passed in, which reads worse than the
  ; duplication it removes.
  ;
  ; It runs second so the uninstall below can peel the entries off in reverse
  ; order, each one still last when its turn comes.
  ${if} ${FileExists} "$INSTDIR\${DSH_MNEMON_BIN}\mnemon.exe"
    ReadRegStr $0 HKCU "Environment" "Path"
    ${StrContains} $1 "${DSH_MNEMON_BIN}" "$0"
    ${if} $1 == ""
      ; The CodeGraph branch above may already have replaced the backup with an
      ; already-modified PATH. Only the first writer keeps the pristine value.
      ReadRegStr $6 HKCU "Software\${PRODUCT_NAME}" "PathBackup"
      ${if} $6 == ""
        WriteRegExpandStr HKCU "Software\${PRODUCT_NAME}" "PathBackup" "$0"
      ${endIf}
      ${if} $0 == ""
        StrCpy $0 "$INSTDIR\${DSH_MNEMON_BIN}"
      ${else}
        StrCpy $0 "$0;$INSTDIR\${DSH_MNEMON_BIN}"
      ${endIf}
      WriteRegExpandStr HKCU "Environment" "Path" "$0"
      SendMessage ${DSH_HWND_BROADCAST} ${DSH_WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000
    ${endIf}
  ${endIf}
!macroend

!macro customUnInstall
  ; Mnemon was appended last, so it is peeled off first; the CodeGraph branch
  ; below then finds its own entry last and can remove it in turn. The mirror of
  ; the install order is what makes both checks succeed.
  ReadRegStr $0 HKCU "Environment" "Path"
  StrLen $2 "$0"
  StrLen $3 ";$INSTDIR\${DSH_MNEMON_BIN}"
  ${if} $2 > $3
    StrCpy $4 "$0" $3 -$3
    ${if} $4 == ";$INSTDIR\${DSH_MNEMON_BIN}"
      IntOp $5 $2 - $3
      StrCpy $0 "$0" $5
      WriteRegExpandStr HKCU "Environment" "Path" "$0"
      SendMessage ${DSH_HWND_BROADCAST} ${DSH_WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000
    ${endIf}
  ${endIf}

  ; The installer appends to the end, so the entry is only removed when it is
  ; still last. A user who reordered PATH keeps their arrangement, and the cost
  ; of leaving a stale directory behind is that Windows skips a name that no
  ; longer resolves — never a mangled PATH.
  ReadRegStr $0 HKCU "Environment" "Path"
  StrLen $2 "$0"
  StrLen $3 ";$INSTDIR\${DSH_CODEGRAPH_BIN}"
  ${if} $2 > $3
    ; Last $3 characters, to confirm the entry really is last.
    StrCpy $4 "$0" $3 -$3
    ${if} $4 == ";$INSTDIR\${DSH_CODEGRAPH_BIN}"
      IntOp $5 $2 - $3
      StrCpy $0 "$0" $5
      WriteRegExpandStr HKCU "Environment" "Path" "$0"
      SendMessage ${DSH_HWND_BROADCAST} ${DSH_WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000
    ${endIf}
  ${endIf}
!macroend
