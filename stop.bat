@echo off
rem stop.bat - zastavi lokalni server spusteny pres start.bat (PID v .server.pid).
setlocal EnableExtensions
cd /d "%~dp0"

if not exist ".server.pid" (
  echo Soubor .server.pid nenalezen - server nejspis nebezi.
  exit /b 0
)

set /p PID=<".server.pid"
taskkill /PID %PID% /T /F >nul 2>nul
if errorlevel 1 (
  echo Proces %PID% uz nebezel.
) else (
  echo Server zastaven ^(PID %PID%^).
)
del ".server.pid" >nul 2>nul
endlocal
