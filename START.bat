@echo off
setlocal
cd /d "%~dp0"
echo.
echo ==^> Running one-button start (PowerShell)
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0START.ps1"
endlocal
