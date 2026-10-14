$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding

function Get-Adapters {
    return @(Get-NetAdapter -IncludeHidden -ErrorAction Stop)
}
function Get-Guid($adapter) {
    if ($null -eq $adapter) { return '' }
    return ([string]$adapter.InterfaceGuid).Trim('{}').ToLowerInvariant()
}
function Get-Snapshot {
    $adapters = Get-Adapters
    $addresses = @(Get-NetIPAddress -ErrorAction Stop)
    $ipInterfaces = @(Get-NetIPInterface -ErrorAction Stop)
    $adapterByIndex = @{}
    foreach ($adapter in $adapters) { $adapterByIndex[[string]$adapter.ifIndex] = $adapter }
    $ipByIndexAndFamily = @{}
    foreach ($ip in $ipInterfaces) { $ipByIndexAndFamily["$($ip.InterfaceIndex)|$($ip.AddressFamily)"] = $ip }
    $interfaces = @($adapters | ForEach-Object {
        $adapter = $_
        [ordered]@{
            guid = Get-Guid $adapter
            index = [uint32]$adapter.ifIndex
            alias = [string]$adapter.Name
            status = [string]$adapter.Status
            addresses = @($addresses | Where-Object { $_.InterfaceIndex -eq $adapter.ifIndex -and $_.AddressFamily -eq 'IPv4' } | ForEach-Object { "$($_.IPAddress)/$($_.PrefixLength)" })
        }
    })
    $records = @(
        foreach ($store in @('ActiveStore','PersistentStore')) {
            foreach ($route in @(Get-NetRoute -PolicyStore $store -ErrorAction Stop)) {
                $adapter = $adapterByIndex[[string]$route.InterfaceIndex]
                $ipInterface = $ipByIndexAndFamily["$($route.InterfaceIndex)|$($route.AddressFamily)"]
                [ordered]@{
                    family = [string]$route.AddressFamily
                    prefix = [string]$route.DestinationPrefix
                    gateway = [string]$route.NextHop
                    interface_index = [uint32]$route.InterfaceIndex
                    interface_guid = Get-Guid $adapter
                    interface_alias = [string]$route.InterfaceAlias
                    route_metric = [uint16]$route.RouteMetric
                    interface_metric = [uint32]$ipInterface.InterfaceMetric
                    protocol = [string]$route.Protocol
                    rollback_safe = ([string]$route.Protocol -eq 'NetMgmt' -and [string]$route.Publish -eq 'No' -and $route.ValidLifetime -eq [TimeSpan]::MaxValue -and $route.PreferredLifetime -eq [TimeSpan]::MaxValue)
                    store = $store
                }
            }
        }
    )
    return @{ routes = @($records); interfaces = @($interfaces) }
}
function Assert-IPv4($prefix, $gateway) {
    if ([string]$prefix -match ':' -or [string]$gateway -match ':') { throw 'IPv6 is read-only' }
    $parts = ([string]$prefix).Split('/')
    if ($parts.Count -ne 2 -or [int]$parts[1] -lt 0 -or [int]$parts[1] -gt 32) { throw 'Invalid IPv4 prefix' }
    if ([System.Net.IPAddress]::Parse($parts[0]).AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) { throw 'IPv4 required' }
    if ([System.Net.IPAddress]::Parse([string]$gateway).AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) { throw 'IPv4 gateway required' }
}
function Get-ExactRoute($record) {
    Assert-IPv4 $record.prefix $record.gateway
    if ($record.store -notin @('ActiveStore','PersistentStore')) { throw 'Invalid policy store' }
    if ($record.interface_guid) {
        $adapter = @(Get-Adapters | Where-Object { (Get-Guid $_) -eq $record.interface_guid })
        if ($adapter.Count -ne 1 -or $adapter[0].ifIndex -ne $record.interface_index) { throw 'Interface changed; refresh required' }
    }
    return @(Get-NetRoute -PolicyStore $record.store -ErrorAction Stop | Where-Object {
        $_.AddressFamily -eq 'IPv4' -and $_.DestinationPrefix -eq $record.prefix -and
        $_.NextHop -eq $record.gateway -and $_.InterfaceIndex -eq $record.interface_index
    })
}
function Invoke-RouteRequest($request) {
    $result = $null
    switch ($request.action) {
        'snapshot' { $result = Get-Snapshot }
        'add' {
            $target = $request.target
            Assert-IPv4 $target.prefix $target.gateway
            $adapter = @(Get-Adapters | Where-Object { (Get-Guid $_) -eq $target.interface_guid })
            if ($adapter.Count -ne 1 -or [string]$adapter[0].Status -ne 'Up') { throw 'Target interface unavailable; refresh required' }
            $parameters = @{
                DestinationPrefix = [string]$target.prefix
                NextHop = [string]$target.gateway
                InterfaceIndex = [uint32]$adapter[0].ifIndex
                AddressFamily = 'IPv4'
                ErrorAction = 'Stop'
            }
            if ($null -ne $target.metric) { $parameters.RouteMetric = [uint16]$target.metric }
            # Omitting PolicyStore creates both stores; PersistentStore is not supported for New-NetRoute.
            if (-not $target.persistent) { $parameters.PolicyStore = 'ActiveStore' }
            New-NetRoute @parameters -Confirm:$false | Out-Null
        }
        'remove' {
            # Persistent first; then requery active because a provider may remove both records.
            $records = @($request.records | Sort-Object @{Expression={if ($_.store -eq 'PersistentStore') {0} else {1}}})
            foreach ($record in $records) {
                $current = @(Get-ExactRoute $record)
                foreach ($route in $current) {
                    if ($route.RouteMetric -ne $record.route_metric -or [string]$route.Protocol -ne [string]$record.protocol) { throw 'Route changed; refresh required' }
                    Remove-NetRoute -InputObject $route -Confirm:$false -ErrorAction Stop
                }
            }
        }
        'metric' {
            foreach ($record in @($request.records)) {
                $current = @(Get-ExactRoute $record)
                if ($current.Count -ne 1) { throw 'Route disappeared; refresh required' }
                if ($current[0].RouteMetric -ne $record.route_metric -and $current[0].RouteMetric -ne $request.metric) { throw 'Route changed; refresh required' }
                Set-NetRoute -InputObject $current[0] -RouteMetric ([uint16]$request.metric) -Confirm:$false -ErrorAction Stop
            }
        }
        default { throw 'Unsupported route operation' }
    }
    return $result
}
# The desktop keeps a private pipe open. Each request still queries live CIM state.
# Without the flag, retain the one-shot protocol used by diagnostics and contract tests.
do {
    if ($RouteManagerWorker) { $inputJson = [Console]::In.ReadLine() }
    else { $inputJson = [Console]::In.ReadToEnd() }
    if ($null -eq $inputJson) { break }
    try {
        $request = $inputJson | ConvertFrom-Json
        $result = Invoke-RouteRequest $request
        $response = @{ok=$true;data=$result} | ConvertTo-Json -Depth 16 -Compress
    } catch {
        $response = @{ok=$false;error=$_.Exception.Message} | ConvertTo-Json -Depth 4 -Compress
        [Console]::Out.WriteLine($response)
        [Console]::Out.Flush()
        if (-not $RouteManagerWorker) { exit 1 }
        continue
    }
    [Console]::Out.WriteLine($response)
    [Console]::Out.Flush()
} while ($RouteManagerWorker)
