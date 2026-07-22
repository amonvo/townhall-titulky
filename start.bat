@echo off
rem start.bat - spusti lokalni server na portu 8137 a otevre Chrome.
rem Poznamky:
rem  - Cesta k repu obsahuje mezery -> vsechny cesty jsou v uvozovkach.
rem  - Misto holeho "python -m http.server" se pouziva tools\serve.py:
rem    holy http.server serviruje .mjs jako text/plain (Chrome pak odmitne
rem    ES moduly) a neumi HTTP Range (nefunguje prevyjeni videa). Viz README.
rem  - Poradi: py -3 serve.py -> python serve.py -> powershell serve.ps1.
setlocal EnableExtensions
cd /d "%~dp0"
set "PORT=8137"
set "URL=http://localhost:%PORT%/"

rem -- Uz server bezi? (port odpovida) -> jen otevrit prohlizec
powershell -NoProfile -Command "$c=New-Object Net.Sockets.TcpClient; try { $c.Connect('127.0.0.1',%PORT%); exit 0 } catch { exit 1 } finally { $c.Close() }" >nul 2>nul
if not errorlevel 1 (
  echo Server uz bezi na portu %PORT%.
  goto :open
)

rem -- 1) py -3 tools\serve.py
where py >nul 2>nul
if not errorlevel 1 (
  echo Spoustim server: py -3 tools\serve.py %PORT%
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$p = Start-Process -FilePath 'py' -ArgumentList '-3','tools\serve.py','%PORT%' -WorkingDirectory '%CD%' -WindowStyle Hidden -PassThru; Set-Content -LiteralPath '.server.pid' -Value $p.Id -Encoding ascii"
  goto :wait
)

rem -- 2) python tools\serve.py
where python >nul 2>nul
if not errorlevel 1 (
  echo Spoustim server: python tools\serve.py %PORT%
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$p = Start-Process -FilePath 'python' -ArgumentList 'tools\serve.py','%PORT%' -WorkingDirectory '%CD%' -WindowStyle Hidden -PassThru; Set-Content -LiteralPath '.server.pid' -Value $p.Id -Encoding ascii"
  goto :wait
)

rem -- 3) fallback: PowerShell server (bez Pythonu)
echo Python nenalezen, spoustim tools\serve.ps1 ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p = Start-Process -FilePath 'powershell' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','tools\serve.ps1','-Port','%PORT%' -WorkingDirectory '%CD%' -WindowStyle Hidden -PassThru; Set-Content -LiteralPath '.server.pid' -Value $p.Id -Encoding ascii"

:wait
echo Cekam, az server odpovi na portu %PORT% ...
powershell -NoProfile -Command "for ($i=0; $i -lt 60; $i++) { $c=New-Object Net.Sockets.TcpClient; try { $c.Connect('127.0.0.1',%PORT%); exit 0 } catch { Start-Sleep -Milliseconds 250 } finally { $c.Close() } }; exit 1" >nul 2>nul
if errorlevel 1 (
  echo CHYBA: server na portu %PORT% neodpovida.
  echo Zkus rucne:  py -3 "tools\serve.py" %PORT%
  echo nebo:        powershell -ExecutionPolicy Bypass -File "tools\serve.ps1" -Port %PORT%
  exit /b 1
)

:open
set "CHROME="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe"

if defined CHROME (
  start "" "%CHROME%" "%URL%"
) else (
  rem Chrome nenalezen na obvyklych cestach -> vychozi prohlizec
  start "" "%URL%"
)

echo Hotovo. Aplikace bezi na %URL%
echo Server zastavis pres stop.bat
endlocal
