$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (Test-Path -LiteralPath (Join-Path $projectRoot '.tools\cargo\bin\cargo.exe')) {
    $env:CARGO_HOME = Join-Path $projectRoot '.tools\cargo'
    $env:RUSTUP_HOME = Join-Path $projectRoot '.tools\rustup'
    $env:PATH = (Join-Path $env:CARGO_HOME 'bin') + ';' + $env:PATH
}
$env:CARGO_TARGET_DIR = Join-Path $projectRoot 'artifacts\cargo'
$env:CARGO_HTTP_MULTIPLEXING = 'false'
$env:CARGO_HTTP_TIMEOUT = '120'
$vsRoot = Join-Path $projectRoot '.tools\msvc'
if (-not (Test-Path -LiteralPath (Join-Path $vsRoot 'VC\Tools\MSVC'))) {
    $vswherePath = Join-Path ([Environment]::GetEnvironmentVariable('ProgramFiles(x86)')) 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (Test-Path -LiteralPath $vswherePath) {
        $vsRoot = & $vswherePath -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    }
}
# Avoid DevShell's cmd.exe decoding: Chinese project paths must remain Unicode.
if ($vsRoot -and (Test-Path -LiteralPath (Join-Path $vsRoot 'VC\Tools\MSVC'))) {
    $vcTools = Get-ChildItem -LiteralPath (Join-Path $vsRoot 'VC\Tools\MSVC') -Directory | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
    $env:VCINSTALLDIR = (Join-Path $vsRoot 'VC') + '\'
    $env:VCToolsInstallDir = $vcTools.FullName + '\'
    $env:PATH = (Join-Path $vcTools.FullName 'bin\Hostx64\x64') + ';' + $env:PATH
    $env:INCLUDE = Join-Path $vcTools.FullName 'include'
    $env:LIB = Join-Path $vcTools.FullName 'lib\x64'
    $env:CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER = Join-Path $vcTools.FullName 'bin\Hostx64\x64\link.exe'
}
$sdkRoot = Join-Path ([Environment]::GetEnvironmentVariable('ProgramFiles(x86)')) 'Windows Kits\10'
$sdkRegistry = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows Kits\Installed Roots' -ErrorAction SilentlyContinue
if ($sdkRegistry -and $sdkRegistry.KitsRoot10) { $sdkRoot = $sdkRegistry.KitsRoot10 }
if (Test-Path -LiteralPath (Join-Path $sdkRoot 'Lib')) {
    $sdkVersion = Get-ChildItem -LiteralPath (Join-Path $sdkRoot 'Lib') -Directory | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'um\x64\kernel32.lib') } | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
    if ($sdkVersion) {
        $env:WindowsSdkDir = $sdkRoot
        $env:WindowsSDKVersion = $sdkVersion.Name + '\'
        $env:PATH = (Join-Path $sdkRoot ('bin\' + $sdkVersion.Name + '\x64')) + ';' + $env:PATH
        foreach ($part in @('ucrt','um','shared','winrt')) { $env:INCLUDE += ';' + (Join-Path $sdkRoot ('Include\' + $sdkVersion.Name + '\' + $part)) }
        foreach ($part in @('ucrt','um')) { $env:LIB += ';' + (Join-Path $sdkRoot ('Lib\' + $sdkVersion.Name + '\' + $part + '\x64')) }
    }
}
