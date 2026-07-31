@echo off
setlocal
cd /d "%~dp0"
title Personal Knowledge Workbench

echo.
echo Starting Personal Knowledge Workbench...
echo.
echo Site: http://127.0.0.1:4173
echo.
echo Keep this window open while using the workbench.
echo Close this window to stop the local workbench.
echo.

where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo ERROR: npm.cmd was not found in PATH.
  echo Please install Node.js or add npm to PATH, then run this file again.
  echo.
  pause
  exit /b 1
)

start "Open Workbench" /min "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "Start-Sleep -Seconds 5; Start-Process 'http://127.0.0.1:4173'"

call npm.cmd run workbench
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%EXIT_CODE%"=="0" (
  echo Workbench failed with exit code: %EXIT_CODE%
  echo Please send the error text above to Codex.
) else (
  echo Workbench stopped.
)
echo.
pause
exit /b %EXIT_CODE%
