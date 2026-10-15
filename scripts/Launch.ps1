$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$executable = Join-Path $projectRoot 'artifacts\app\RouteManager.exe'
if (-not (Test-Path -LiteralPath $executable)) {
    Write-Host 'RouteManager.exe has not been built. Run: pwsh -File scripts/Build.ps1'
    Read-Host 'Press Enter to close'
    exit 1
}
try {
    Start-Process -FilePath $executable -WorkingDirectory $projectRoot
} catch {
    if ($_.Exception.NativeErrorCode -eq 1223) { Write-Host 'Administrator permission was cancelled. No routes were changed.'; exit 0 }
    throw
}
