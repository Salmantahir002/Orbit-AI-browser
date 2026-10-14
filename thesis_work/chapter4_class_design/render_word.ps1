param([string]$DocumentPath, [string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$word = $null
$document = $null
try {
    $word = New-Object -ComObject Word.Application
    $word.Visible = $false
    $word.DisplayAlerts = 0
    $document = $word.Documents.Open($DocumentPath, $false, $true)
    $document.Repaginate()
    $pageCount = $document.ComputeStatistics(2)
    $pdfPath = Join-Path $OutputDirectory 'word-preview.pdf'
    $document.ExportAsFixedFormat($pdfPath, 17)
    Write-Output "Word pages: $pageCount"
    Write-Output "Preview: $pdfPath"
} finally {
    if ($document) { $document.Close(0); [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($document) }
    if ($word) { $word.Quit(); [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($word) }
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
}
