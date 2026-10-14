$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$executable = Join-Path $projectRoot 'artifacts\app\RouteManager.exe'
if (-not (Test-Path -LiteralPath $executable)) { throw 'Build the application first.' }
$shell = New-Object -ComObject WScript.Shell
# U+8DEF U+7531 U+7BA1 U+7406 U+5668: localized shortcut name, ASCII script works with PowerShell 5.1.
$shortcutName = -join @([char]0x8def,[char]0x7531,[char]0x7ba1,[char]0x7406,[char]0x5668)
$shortcut = $shell.CreateShortcut((Join-Path $projectRoot ($shortcutName + '.lnk')))
$shortcut.TargetPath = $executable
$shortcut.Arguments = '--data-dir "' + (Join-Path $projectRoot 'data') + '"'
$shortcut.WorkingDirectory = $projectRoot
$shortcut.IconLocation = $executable + ',0'
$shortcut.Description = 'Route Manager - local IPv4 routing table management'
$shortcut.Save()
Write-Host 'Shortcut updated.'
