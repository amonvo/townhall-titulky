# scripts/build-exe.ps1 — sestaví publish/TownhallTitulky.exe (PyInstaller onefile).
#
# Použití:  powershell -ExecutionPolicy Bypass -File scripts\build-exe.ps1
#
# Build-time závislosti (pyinstaller, pillow) se instalují zde — NEJSOU
# runtime požadavkem aplikace. Výstup jde do publish/ (gitignorováno).

$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Write-Host "== Townhall Titulky: build exe ==" -ForegroundColor Cyan
Write-Host "repo: $repo"

# 1) Build závislosti
Write-Host "`n[1/6] pip install pyinstaller pillow..." -ForegroundColor Cyan
py -3 -m pip install --upgrade --quiet pyinstaller pillow
if ($LASTEXITCODE -ne 0) { throw "pip install selhal" }

# 2) Ikona (přeskočí se, pokud existuje)
Write-Host "`n[2/6] ikona..." -ForegroundColor Cyan
py -3 "$repo\scripts\make-icon.py"
if ($LASTEXITCODE -ne 0) { throw "make-icon.py selhal" }

# 3) Version resource (build číslo = počet commitů)
Write-Host "`n[3/6] version-info.txt..." -ForegroundColor Cyan
$build = (git -C "$repo" rev-list --count HEAD).Trim()
if (-not $build) { $build = "0" }
$versionFile = "$repo\scripts\version-info.txt"
$versionText = @"
# Generováno build skriptem — needitovat, negitovat.
VSVersionInfo(
  ffi=FixedFileInfo(
    filevers=(1, 0, 0, $build),
    prodvers=(1, 0, 0, $build),
    mask=0x3f, flags=0x0, OS=0x40004, fileType=0x1, subtype=0x0, date=(0, 0)
  ),
  kids=[
    StringFileInfo([StringTable('040904B0', [
      StringStruct('CompanyName', 'Townhall Titulky'),
      StringStruct('FileDescription', 'Townhall Titulky'),
      StringStruct('FileVersion', '1.0.0.$build'),
      StringStruct('InternalName', 'TownhallTitulky'),
      StringStruct('OriginalFilename', 'TownhallTitulky.exe'),
      StringStruct('ProductName', 'Townhall Titulky'),
      StringStruct('ProductVersion', '1.0.0.$build')])]),
    VarFileInfo([VarStruct('Translation', [1033, 1200])])
  ]
)
"@
[System.IO.File]::WriteAllText($versionFile, $versionText, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "FileVersion 1.0.0.$build"

# 4) PyInstaller
Write-Host "`n[4/6] PyInstaller..." -ForegroundColor Cyan
py -3 -m PyInstaller --noconfirm --clean --onefile --noconsole `
  --name TownhallTitulky `
  --icon "$repo\assets\icon.ico" `
  --version-file "$versionFile" `
  --add-data "$repo\index.html;." `
  --add-data "$repo\app;app" `
  --add-data "$repo\vendor;vendor" `
  --add-data "$repo\tools\export-pdf.ps1;tools" `
  --paths "$repo\tools" `
  --hidden-import prep `
  --distpath "$repo\publish" `
  --workpath "$repo\publish\build" `
  --specpath "$repo\publish" `
  "$repo\tools\serve.py"
if ($LASTEXITCODE -ne 0) { throw "PyInstaller selhal" }

$exe = "$repo\publish\TownhallTitulky.exe"
if (-not (Test-Path $exe)) { throw "exe nevzniklo: $exe" }
$sizeMB = [Math]::Round((Get-Item $exe).Length / 1MB, 1)
Write-Host "exe: $exe ($sizeMB MB)"

# 5) Balíček pro distribuci
Write-Host "`n[5/6] publish\balik..." -ForegroundColor Cyan
$balik = "$repo\publish\balik"
if (Test-Path $balik) { Remove-Item $balik -Recurse -Force }
New-Item -ItemType Directory -Path $balik | Out-Null
Copy-Item $exe "$balik\TownhallTitulky.exe"
$readme = @"
TOWNHALL TITULKY
================

Spuštění:
  Dvojklik na TownhallTitulky.exe. Otevře se okno aplikace.
  (Při prvním spuštění může Windows SmartScreen varovat:
   klikni na „Více informací" -> „Přesto spustit".)

Požadavky:
  - Google Chrome (doporučeno; funguje i Microsoft Edge)
  - internet (překlad titulků běží přes něj)
  - pro automatický převod prezentace nainstalovaný PowerPoint

Data:
  Nahrané prezentace se ukládají do složky „content" vedle tohoto
  souboru. Složku nemazat — prezentace v ní přežije další spuštění.

Ukončení:
  Stačí zavřít okno aplikace — vše ostatní se ukončí samo
  (do cca 1 minuty).
"@
[System.IO.File]::WriteAllText("$balik\README-uzivatel.txt", $readme, (New-Object System.Text.UTF8Encoding($true)))

# 6) Smoke test sestaveneho exe
Write-Host "`n[6/6] smoke test exe..." -ForegroundColor Cyan
$p = Start-Process -FilePath $exe -ArgumentList "--no-browser", "--smoke", "--port", "8199" -Wait -PassThru -WindowStyle Hidden
if ($p.ExitCode -ne 0) { throw "SMOKE TEST SELHAL (exit $($p.ExitCode))" }
Write-Host "smoke test OK"

Write-Host "`nHOTOVO: $exe" -ForegroundColor Green
Write-Host "Distribuce: zazipuj slozku publish\balik (binarky nikdy do gitu)."
