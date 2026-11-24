$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$api = if ($env:TIA_PUBLIC_API_DIR) { Join-Path $env:TIA_PUBLIC_API_DIR 'Siemens.Engineering.dll' } else { 'C:\Program Files\Siemens\Automation\Portal V20\PublicAPI\V20\Siemens.Engineering.dll' }
$simApi = 'C:\Program Files\Siemens\Automation\PLCSIM_V20\resources\bin\wwwroot\assets\lib\runtime\Siemens.Simatic.Simulation.Runtime.Api.x64.dll'

$sources = @(
    (Join-Path $root 'bridge\TiaBridge.cs'),
    (Join-Path $root 'bridge\TiaBridge.WatchAndScl.cs'),
    (Join-Path $root 'bridge\TiaBridge.HardwareAndNet.cs'),
    (Join-Path $root 'bridge\TiaBridge.PlcsimAndEscape.cs')
)
$out = Join-Path $root 'bridge\TiaBridge.exe'

if (-not (Test-Path $csc)) { throw "C# compiler not found: $csc" }
if (-not (Test-Path $api)) { throw "Siemens.Engineering.dll not found: $api" }

# Clean up any old unlocked hot-swap binaries
Get-ChildItem -Path (Join-Path $root 'bridge') -Filter 'TiaBridge.old_*.exe' -ErrorAction SilentlyContinue | ForEach-Object {
    try { Remove-Item $_.FullName -Force -ErrorAction Stop } catch { }
}

# Zero-downtime hot-swap: if TiaBridge.exe is currently locked by a running MCP host, rename it without killing the process!
if (Test-Path $out) {
    try {
        Remove-Item $out -Force -ErrorAction Stop
    } catch {
        $oldName = "TiaBridge.old_$([DateTime]::UtcNow.Ticks).exe"
        Rename-Item -Path $out -NewName $oldName -Force
        Write-Host "Hot-swapped running TiaBridge.exe -> $oldName"
    }
}

$cscArgs = @(
    '/nologo',
    '/platform:x64',
    '/optimize+',
    '/target:exe',
    "/out:$out",
    "/reference:$api",
    '/reference:System.Web.Extensions.dll',
    '/reference:System.Core.dll'
)

if (Test-Path $simApi) {
    Write-Host "Found PLCSIM V20 Runtime API: enabling WITH_PLCSIM_API..."
    $cscArgs += '/define:WITH_PLCSIM_API'
    $cscArgs += "/reference:$simApi"
}

$cscArgs += $sources

Write-Host "Building TiaBridge.exe (x64 .NET Framework 4.8)..."
& $csc @cscArgs

if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host "Built successfully: $out"
