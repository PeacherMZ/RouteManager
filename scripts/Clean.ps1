param([switch]$AllBuildArtifacts)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$artifactsRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot 'artifacts'))
$targets = if ($AllBuildArtifacts) { @($artifactsRoot) } else { @((Join-Path $artifactsRoot 'frontend'), (Join-Path $artifactsRoot 'cargo')) }
foreach ($candidate in $targets) {
    $resolved = [IO.Path]::GetFullPath($candidate)
    if (-not $resolved.StartsWith($projectRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe cleanup path.' }
    if ($resolved -ne $artifactsRoot -and -not $resolved.StartsWith($artifactsRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Cleanup is restricted to artifacts.' }
    if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
Write-Host 'Build artifacts cleaned. Application data and legacy files were preserved.'
