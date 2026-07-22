# tools/export-pdf.ps1 — převod PPTX → PDF přes lokálně nainstalovaný PowerPoint
# (COM automatizace; enum hodnoty jako čísla, aby nebyly potřeba Office assembly).
#
# Použití:
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\export-pdf.ps1 `
#     -Pptx "C:\...\content\source.pptx" -Pdf "C:\...\content\slides.tmp.pdf"
#
# Exit 0 = PDF vytvořeno; exit 1 = selhání (text chyby na stderr).

param(
    [Parameter(Mandatory)][string]$Pptx,
    [Parameter(Mandatory)][string]$Pdf
)

$pp = $null; $pres = $null
try {
    if (-not (Test-Path -LiteralPath $Pptx -PathType Leaf)) {
        throw "PPTX neexistuje: $Pptx"
    }
    # COM vyžaduje absolutní cesty
    $pptxAbs = (Resolve-Path -LiteralPath $Pptx).Path
    $pdfAbs  = [System.IO.Path]::GetFullPath($Pdf)

    $pp = New-Object -ComObject PowerPoint.Application
    $pp.DisplayAlerts = 1              # ppAlertsNone
    # Open(FileName, ReadOnly=msoTrue(-1), Untitled=msoFalse(0), WithWindow=msoFalse(0))
    $pres = $pp.Presentations.Open($pptxAbs, -1, 0, 0)
    $pres.SaveAs($pdfAbs, 32)          # ppSaveAsPDF
    if (-not (Test-Path -LiteralPath $pdfAbs -PathType Leaf)) {
        throw "SaveAs proběhlo, ale PDF nevzniklo: $pdfAbs"
    }
    exit 0
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
} finally {
    if ($pres) { try { $pres.Close() } catch {} }
    if ($pp)   { try { $pp.Quit() } catch {} }
    [System.GC]::Collect(); [System.GC]::WaitForPendingFinalizers()
}
