; GeoSpaX Windows installer hooks (Tauri NSIS bundler, packaging/windows/tauri.windows.json).
; Included at the top of Tauri's installer.nsi, before its pages, so the defines below take effect.

; ---- Upgrades from older installs -------------------------------------------------------------------
; Tauri finds the previous install through two per-user registry keys:
;   Software\Microsoft\Windows\CurrentVersion\Uninstall\GeoSpaX   (Apps & features: version, uninstaller)
;   Software\<publisher>\GeoSpaX                                   (default value: the install folder)
; and runs the old uninstaller as `uninstall.exe _?=<install folder>`. The publisher was "GeoSpaX contributors"
; up to 3.0.2 and is "in4metrix" since 3.0.3, so for an older install the folder came back empty, the old
; uninstaller removed nothing and the installer stopped with "unable to uninstall". Before the first page,
; GeoSpaXUpgradeFixups records the old install folder under the current publisher (from the old publisher's
; key, the Apps & features entry or the uninstaller's own folder), and forgets an Apps & features entry whose
; uninstaller is gone (a folder deleted by hand), so the new version installs over it instead of failing.
!define GEOSPAX_PRODUCTKEY "Software\in4metrix\GeoSpaX"
!define GEOSPAX_UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\GeoSpaX"
!define GEOSPAX_OLD_PUBLISHER_KEY "Software\GeoSpaX contributors"
!define MUI_CUSTOMFUNCTION_GUIINIT GeoSpaXUpgradeFixups

Function GeoSpaXUpgradeFixups
  Push $0
  Push $1
  Push $2
  ReadRegStr $0 SHCTX "${GEOSPAX_UNINSTKEY}" "UninstallString"
  ${If} $0 != ""
    ${WordReplace} $0 '"' "" "+" $0                       ; "C:\...\uninstall.exe" -> C:\...\uninstall.exe
    ReadRegStr $1 SHCTX "${GEOSPAX_PRODUCTKEY}" ""
    ${If} $1 == ""
      ReadRegStr $1 SHCTX "${GEOSPAX_OLD_PUBLISHER_KEY}\GeoSpaX" ""
      ${If} $1 == ""
        ReadRegStr $1 SHCTX "${GEOSPAX_UNINSTKEY}" "InstallLocation"
        ${WordReplace} $1 '"' "" "+" $1
      ${EndIf}
      ${If} $1 == ""
        ${GetParent} $0 $1
      ${EndIf}
      ${If} $1 != ""
        WriteRegStr SHCTX "${GEOSPAX_PRODUCTKEY}" "" $1
        StrCpy $INSTDIR $1                                  ; what RestorePreviousInstallLocation would have found
      ${EndIf}
    ${EndIf}
    ${IfNot} ${FileExists} $0
      ; no uninstaller left to run: drop the stale entry, the files (if any) are replaced by this install
      DeleteRegKey SHCTX "${GEOSPAX_UNINSTKEY}"
    ${EndIf}
  ${EndIf}
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

!macro NSIS_HOOK_PREINSTALL
  ; the web edition (geospax-server.exe) keeps its DLLs open; the bundler only checks for geospax.exe
  !insertmacro CheckIfAppIsRunning "$INSTDIR\geospax-server.exe" "GeoSpaX Web Server"
!macroend

; Adds a Start-menu shortcut for the web edition next to the desktop app's own shortcut.
!macro NSIS_HOOK_POSTINSTALL
  CreateShortCut "$SMPROGRAMS\GeoSpaX Web Server.lnk" "$INSTDIR\geospax-web.cmd" "" "$INSTDIR\geospax.exe" 0 SW_SHOWMINIMIZED "" "Serve GeoSpaX to any browser at http://localhost:8080"
  ; the install folder is recorded under the current publisher now; drop the pre-3.0.3 key
  DeleteRegKey SHCTX "${GEOSPAX_OLD_PUBLISHER_KEY}\GeoSpaX"
  DeleteRegKey /ifempty SHCTX "${GEOSPAX_OLD_PUBLISHER_KEY}"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro CheckIfAppIsRunning "$INSTDIR\geospax-server.exe" "GeoSpaX Web Server"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$SMPROGRAMS\GeoSpaX Web Server.lnk"
  DeleteRegKey SHCTX "${GEOSPAX_OLD_PUBLISHER_KEY}\GeoSpaX"
  DeleteRegKey /ifempty SHCTX "${GEOSPAX_OLD_PUBLISHER_KEY}"
!macroend
