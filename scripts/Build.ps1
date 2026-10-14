param([switch]$SkipTests)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Environment.ps1')
Push-Location $projectRoot
try {
    foreach ($tool in @('node','pnpm','cargo','cl')) {
        if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "Missing build prerequisite: $tool. See README.md." }
    }
    if (-not $env:WindowsSdkDir) { throw 'Windows SDK is missing or its installation is incomplete.' }
    $webViewRoot = Join-Path ([Environment]::GetEnvironmentVariable('ProgramFiles(x86)')) 'Microsoft\EdgeWebView\Application'
    if (-not (Test-Path -Path (Join-Path $webViewRoot '*\msedgewebview2.exe'))) {
        Write-Warning 'WebView2 Runtime was not found in its usual location. Install WebView2 before running the application.'
    }
    & pnpm install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
    if (-not $SkipTests) {
        & pnpm test
        if ($LASTEXITCODE -ne 0) { throw 'Frontend tests failed.' }
        & "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File tests/windows-adapter.ps1
        if ($LASTEXITCODE -ne 0) { throw 'PowerShell adapter contract tests failed.' }
        & cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --locked
        if ($LASTEXITCODE -ne 0) { throw 'Backend tests failed.' }
    }
    & pnpm tauri build --no-bundle
    if ($LASTEXITCODE -ne 0) { throw 'Tauri build failed.' }
    $publishDir = Join-Path $projectRoot 'artifacts\app'
    New-Item -ItemType Directory -Path $publishDir -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $env:CARGO_TARGET_DIR 'release\RouteManager.exe') -Destination (Join-Path $publishDir 'RouteManager.exe') -Force
    foreach ($folder in @('data','data\backups','data\exports')) {
        New-Item -ItemType Directory -Path (Join-Path $projectRoot $folder) -Force | Out-Null
    }
    & (Join-Path $PSScriptRoot 'Create-Shortcut.ps1')
    Write-Host "Built: $publishDir\RouteManager.exe"
} finally { Pop-Location }
