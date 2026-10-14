$ErrorActionPreference = 'Stop'
$adapterScript = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\src-tauri\powershell\routes.ps1') -Raw -Encoding UTF8
# Console encoding setters replace the injected StringReader/StringWriter. The
# transport itself is verified separately against the real read-only snapshot.
$adapterScript = $adapterScript -replace '(?m)^\[Console\]::(?:Input|Output)Encoding = .*$', ''
$adapterScript = $adapterScript.Replace('exit 1', 'throw')
$script:Rows = @()
$script:Calls = @()
$script:RemoveBoth = $false
$guid = '11111111-1111-4111-8111-111111111111'

function Get-NetAdapter {
    [CmdletBinding()] param([switch]$IncludeHidden)
    [pscustomobject]@{ InterfaceGuid=$guid; ifIndex=7; Name='Test adapter'; Status='Up' }
}
function Get-NetIPAddress {
    [CmdletBinding()] param()
    [pscustomobject]@{ InterfaceIndex=7; AddressFamily='IPv4'; IPAddress='192.0.2.2'; PrefixLength=24 }
}
function Get-NetIPInterface {
    [CmdletBinding()] param()
    [pscustomobject]@{ InterfaceIndex=7; AddressFamily='IPv4'; InterfaceMetric=25 }
}
function Get-NetRoute {
    [CmdletBinding()] param([string]$PolicyStore)
    @($script:Rows | Where-Object PolicyStore -eq $PolicyStore)
}
function New-NetRoute {
    [CmdletBinding(SupportsShouldProcess=$true)] param(
        [string]$DestinationPrefix, [string]$NextHop, [uint32]$InterfaceIndex,
        [string]$AddressFamily, [string]$PolicyStore, [uint16]$RouteMetric=256
    )
    $script:Calls += [pscustomobject]@{ Kind='add'; PolicyStore=$PolicyStore; ExplicitStore=$PSBoundParameters.ContainsKey('PolicyStore') }
    $stores = if ($PolicyStore -eq 'ActiveStore') { @('ActiveStore') } else { @('ActiveStore','PersistentStore') }
    foreach ($store in $stores) {
        $script:Rows += [pscustomobject]@{DestinationPrefix=$DestinationPrefix;NextHop=$NextHop;InterfaceIndex=$InterfaceIndex;AddressFamily=$AddressFamily;RouteMetric=$RouteMetric;InterfaceAlias='Test adapter';Protocol='NetMgmt';PolicyStore=$store}
    }
}
function Remove-NetRoute {
    [CmdletBinding(SupportsShouldProcess=$true)] param($InputObject)
    $script:Calls += [pscustomobject]@{Kind='remove';PolicyStore=$InputObject.PolicyStore}
    $script:Rows = @($script:Rows | Where-Object { -not ($_.DestinationPrefix -eq $InputObject.DestinationPrefix -and $_.NextHop -eq $InputObject.NextHop -and ($script:RemoveBoth -or $_.PolicyStore -eq $InputObject.PolicyStore)) })
}
function Set-NetRoute {
    [CmdletBinding(SupportsShouldProcess=$true)] param($InputObject,[uint16]$RouteMetric)
    $script:Calls += [pscustomobject]@{Kind='metric';PolicyStore=$InputObject.PolicyStore}
    $InputObject.RouteMetric=$RouteMetric
}
function Assert-That($condition, [string]$message) { if (-not $condition) { throw $message } }
function Invoke-TestAdapter($request, [switch]$Worker) {
    $originalIn = [Console]::In
    $originalOut = [Console]::Out
    $payload = if ($Worker) { ($request | ForEach-Object { $_ | ConvertTo-Json -Depth 16 -Compress }) -join "`n" } else { $request | ConvertTo-Json -Depth 16 -Compress }
    $reader = New-Object IO.StringReader($payload)
    $writer = New-Object IO.StringWriter
    try {
        [Console]::SetIn($reader)
        [Console]::SetOut($writer)
        $source = if ($Worker) { '$RouteManagerWorker = $true' + "`n" + $adapterScript } else { $adapterScript }
        & ([ScriptBlock]::Create($source))
        if ($Worker) { return @($writer.ToString() -split "`r?`n" | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json }) }
        $response = $writer.ToString() | ConvertFrom-Json
        Assert-That $response.ok 'Adapter returned a failure'
        return $response.data
    } finally {
        [Console]::SetIn($originalIn)
        [Console]::SetOut($originalOut)
        $reader.Dispose()
        $writer.Dispose()
    }
}
# Prevent this contract test from accidentally reaching any real NetTCPIP command.
foreach ($name in @('Get-NetAdapter','Get-NetIPAddress','Get-NetIPInterface','Get-NetRoute','New-NetRoute','Remove-NetRoute','Set-NetRoute')) {
    Assert-That ((Get-Command $name).CommandType -eq 'Function') ('Mock not installed: ' + $name)
}
$target = @{prefix='203.0.113.0/24';gateway='192.0.2.1';interface_guid=$guid;metric=10;persistent=$true}
Invoke-TestAdapter @{action='add';target=$target} | Out-Null
Assert-That ($script:Rows.Count -eq 2) 'Persistent add must produce two records'
Assert-That (-not $script:Calls[0].ExplicitStore) 'Persistent add must omit PolicyStore'
$snapshot = Invoke-TestAdapter @{action='snapshot'}
Assert-That ($snapshot.routes.Count -eq 2) 'Both policy stores must be read'
Assert-That ($snapshot.interfaces.Count -eq 1) 'Adapter must be serialized'
Assert-That ($snapshot.routes[0].interface_guid -eq $guid) 'GUID must be normalized'

Invoke-TestAdapter @{action='metric';records=$snapshot.routes;metric=25} | Out-Null
Assert-That (@($script:Rows | Where-Object RouteMetric -ne 25).Count -eq 0) 'Metric must update each store'
$snapshot = Invoke-TestAdapter @{action='snapshot'}
$script:RemoveBoth = $true
Invoke-TestAdapter @{action='remove';records=$snapshot.routes} | Out-Null
Assert-That ($script:Rows.Count -eq 0) 'Remove should tolerate provider removing both stores at once'
$removals = @($script:Calls | Where-Object Kind -eq 'remove')
Assert-That ($removals.Count -eq 1 -and $removals[0].PolicyStore -eq 'PersistentStore') 'Remove persistent first and requery active'

$target.persistent=$false
Invoke-TestAdapter @{action='add';target=$target} | Out-Null
Assert-That ($script:Rows.Count -eq 1 -and $script:Rows[0].PolicyStore -eq 'ActiveStore') 'Temporary route must only use ActiveStore'
Assert-That $script:Calls[-1].ExplicitStore 'Temporary add must specify PolicyStore'
$responses = Invoke-TestAdapter @(@{action='snapshot'}, @{action='unsupported'}, @{action='remove';records=(Invoke-TestAdapter @{action='snapshot'}).routes}, @{action='snapshot'}) -Worker
Assert-That ($responses.Count -eq 4) 'Worker must return one envelope per request'
Assert-That ($responses[0].ok -and -not $responses[1].ok -and $responses[2].ok -and $responses[3].ok) 'Worker must recover after a command error'
Assert-That ($responses[0].data.routes.Count -eq 1 -and $responses[3].data.routes.Count -eq 0) 'Worker snapshots must read live state rather than reuse cached routes'
Write-Output 'PASS: Windows PowerShell adapter contract (snapshot, persistent add, temporary add, metric, paired removal). All NetTCPIP calls were mocked.'
