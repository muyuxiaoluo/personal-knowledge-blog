@echo off
setlocal

cd /d "%~dp0"
title Life Strategy Library - Development

echo ========================================
echo   Life Strategy Library - Dev Mode
echo ========================================
echo.
echo Keep this window open while testing.
echo Frontend changes will refresh automatically.
echo Press Ctrl+C to stop the development app.
echo.

where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm was not found. Install Node.js 22 or later first.
  echo.
  pause
  exit /b 1
)

if not exist "sites-app\package.json" (
  echo [ERROR] sites-app\package.json was not found.
  echo Keep this file in the project root and try again.
  echo.
  pause
  exit /b 1
)

if not exist "sites-app\node_modules" (
  echo First run: installing project dependencies...
  echo.
  call npm.cmd --prefix sites-app ci
  if errorlevel 1 (
    echo.
    echo [ERROR] Dependency installation failed. See the output above.
    pause
    exit /b 1
  )
  echo.
)

call npm.cmd --prefix sites-app run tauri -- dev --config src-tauri/tauri.dev.conf.json
set "DEV_EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%DEV_EXIT_CODE%"=="0" (
  echo [ERROR] Dev mode exited with code %DEV_EXIT_CODE%.
) else (
  echo Dev mode has stopped.
)
echo Review the output above for details.
pause
exit /b %DEV_EXIT_CODE%
