param([switch]$SkipTests, [switch]$AppOnly)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Environment.ps1')
Push-Location $projectRoot
try {
    $buildArguments = @('scripts/build.mjs')
    if ($SkipTests) { $buildArguments += '--skip-tests' }
    if ($AppOnly) { $buildArguments += '--app-only' }
    & node @buildArguments
    if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
} finally { Pop-Location }
