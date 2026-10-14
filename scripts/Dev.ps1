$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Environment.ps1')
Push-Location $projectRoot
try {
    & pnpm tauri dev
    if ($LASTEXITCODE -ne 0) { throw 'Tauri development process failed.' }
} finally { Pop-Location }
