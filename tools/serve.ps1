# tools/serve.ps1 — minimální statický souborový server (System.Net.HttpListener).
#
# Správné MIME typy (včetně .mjs → text/javascript, které Pythonův http.server
# neumí) a podpora HTTP Range pro videa (Chrome je potřebuje k převíjení).
#
# Použití:  powershell -ExecutionPolicy Bypass -File tools\serve.ps1 -Port 8137

param(
    [int]$Port = 8137
)

$ErrorActionPreference = "Stop"

# Kořen = nadřazená složka tohoto skriptu (tools\..).
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

$mime = @{
    ".html" = "text/html; charset=utf-8"
    ".htm"  = "text/html; charset=utf-8"
    ".css"  = "text/css; charset=utf-8"
    ".js"   = "text/javascript; charset=utf-8"
    ".mjs"  = "text/javascript; charset=utf-8"
    ".json" = "application/json; charset=utf-8"
    ".pdf"  = "application/pdf"
    ".mp4"  = "video/mp4"
    ".mov"  = "video/quicktime"
    ".svg"  = "image/svg+xml"
    ".png"  = "image/png"
    ".txt"  = "text/plain; charset=utf-8"
}

$listener = New-Object System.Net.HttpListener
$prefix = "http://localhost:$Port/"
$listener.Prefixes.Add($prefix)
try {
    $listener.Start()
} catch {
    Write-Error "Nepodařilo se spustit HttpListener na $prefix : $($_.Exception.Message)"
    exit 1
}
Write-Host "serve.ps1: naslouchám na $prefix (kořen: $root)"

function Get-ContentType([string]$path) {
    $ext = [System.IO.Path]::GetExtension($path).ToLowerInvariant()
    if ($mime.ContainsKey($ext)) { return $mime[$ext] }
    return "application/octet-stream"
}

while ($listener.IsListening) {
    try {
        $context = $listener.GetContext()
    } catch {
        break
    }
    $req = $context.Request
    $res = $context.Response

    try {
        # URL cesta → lokální soubor (bez query, dekódovaná, bez traversalu).
        $rel = [System.Uri]::UnescapeDataString($req.Url.AbsolutePath)

        # API neumíme (jen statický fallback server) → 501 s vysvětlením pro UI.
        if ($rel -like "/api/*") {
            $res.StatusCode = 501
            $res.ContentType = "application/json; charset=utf-8"
            $json = '{"error":"Příprava vyžaduje Python server (serve.py). Spusť start.bat na stroji s Pythonem, nebo připrav obsah ručně dle README."}'
            $jbytes = [System.Text.Encoding]::UTF8.GetBytes($json)
            $res.ContentLength64 = $jbytes.Length
            $res.OutputStream.Write($jbytes, 0, $jbytes.Length)
            $res.Close()
            continue
        }

        if ($rel -eq "/" -or $rel -eq "") { $rel = "/index.html" }
        $rel = $rel.TrimStart("/")
        $full = Join-Path $root $rel
        $fullResolved = [System.IO.Path]::GetFullPath($full)

        # Ochrana proti path traversal: musí zůstat pod kořenem.
        $rootResolved = [System.IO.Path]::GetFullPath($root)
        if (-not $fullResolved.StartsWith($rootResolved, [System.StringComparison]::OrdinalIgnoreCase)) {
            $res.StatusCode = 403
            $res.Close()
            continue
        }

        if (-not (Test-Path -LiteralPath $fullResolved -PathType Leaf)) {
            $res.StatusCode = 404
            $bytes = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found")
            $res.OutputStream.Write($bytes, 0, $bytes.Length)
            $res.Close()
            continue
        }

        $ctype = Get-ContentType $fullResolved
        $res.ContentType = $ctype
        $res.Headers["Accept-Ranges"] = "bytes"

        $fs = [System.IO.File]::OpenRead($fullResolved)
        $total = $fs.Length

        $rangeHeader = $req.Headers["Range"]
        if ($rangeHeader -and $rangeHeader -match "bytes=(\d*)-(\d*)") {
            # Podpora jednoho rozsahu: bytes=start-  nebo  bytes=start-end
            $startStr = $matches[1]
            $endStr = $matches[2]
            if ($startStr -eq "") {
                # bytes=-N (posledních N bytů)
                $len = [int64]$endStr
                if ($len -gt $total) { $len = $total }
                $start = $total - $len
                $end = $total - 1
            } else {
                $start = [int64]$startStr
                if ($endStr -eq "") { $end = $total - 1 } else { $end = [int64]$endStr }
            }
            if ($start -lt 0) { $start = 0 }
            if ($end -ge $total) { $end = $total - 1 }

            if ($start -gt $end) {
                $res.StatusCode = 416
                $res.Headers["Content-Range"] = "bytes */$total"
                $fs.Close()
                $res.Close()
                continue
            }

            $chunk = $end - $start + 1
            $res.StatusCode = 206
            $res.Headers["Content-Range"] = "bytes $start-$end/$total"
            $res.ContentLength64 = $chunk

            $fs.Seek($start, [System.IO.SeekOrigin]::Begin) | Out-Null
            $buffer = New-Object byte[] 65536
            $remaining = $chunk
            while ($remaining -gt 0) {
                $toRead = [Math]::Min($buffer.Length, $remaining)
                $read = $fs.Read($buffer, 0, $toRead)
                if ($read -le 0) { break }
                $res.OutputStream.Write($buffer, 0, $read)
                $remaining -= $read
            }
        } else {
            $res.StatusCode = 200
            $res.ContentLength64 = $total
            $buffer = New-Object byte[] 65536
            while ($true) {
                $read = $fs.Read($buffer, 0, $buffer.Length)
                if ($read -le 0) { break }
                $res.OutputStream.Write($buffer, 0, $read)
            }
        }
        $fs.Close()
        $res.Close()
    } catch {
        try { $res.StatusCode = 500; $res.Close() } catch {}
    }
}

$listener.Stop()
