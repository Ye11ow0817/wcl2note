@echo off
setlocal
cd /d "%~dp0"
if not exist node_modules\electron\dist\electron.exe (
  call npm ci
  if errorlevel 1 goto failed
)
call npm run dev
if errorlevel 1 goto failed
exit /b 0
:failed
pause
exit /b 1
