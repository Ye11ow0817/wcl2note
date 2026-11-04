; NSIS uses the last InstallDir component as the suffix for Browse selections.
; electron-builder still sets the actual initial path in initMultiUser.
InstallDir "$LOCALAPPDATA\Programs\${APP_FILENAME}"
