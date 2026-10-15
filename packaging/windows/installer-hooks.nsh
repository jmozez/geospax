; GeoSpaX Windows installer hooks (Tauri NSIS bundler, packaging/windows/tauri.windows.json).
; Adds a Start-menu shortcut for the web edition next to the desktop app's own shortcut.
!macro NSIS_HOOK_POSTINSTALL
  CreateShortCut "$SMPROGRAMS\GeoSpaX Web Server.lnk" "$INSTDIR\geospax-web.cmd" "" "$INSTDIR\geospax.exe" 0 SW_SHOWMINIMIZED "" "Serve GeoSpaX to any browser at http://localhost:8080"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$SMPROGRAMS\GeoSpaX Web Server.lnk"
!macroend
