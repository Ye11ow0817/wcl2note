@echo off
setlocal
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" goto install
call npm ls --depth=0 >nul 2>&1
if errorlevel 1 goto install
goto package

:install
call npm ci
if errorlevel 1 goto install_failed

:package
call npm run package:win
if errorlevel 1 goto failed

echo Output: %~dp0release
pause
exit /b 0

:install_failed
echo Dependency installation failed. If the error is EPERM, close this project's dev server or app and try again.
goto failed

:failed
echo Windows packaging failed. See the error above.
pause
exit /b 1
