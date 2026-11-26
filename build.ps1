param([ValidateSet('16', '20')][string]$PortalVersion = $(if ($env:TIA_PORTAL_VERSION) { $env:TIA_PORTAL_VERSION } else { '20' }))

$ErrorActionPreference = 'Stop'
if ($PortalVersion -notin @('16', '20')) { throw 'TIA_PORTAL_VERSION must be 16 or 20.' }
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$api = if ($env:TIA_PUBLIC_API_DIR) { Join-Path $env:TIA_PUBLIC_API_DIR 'Siemens.Engineering.dll' } else { "C:\Program Files\Siemens\Automation\Portal V$PortalVersion\PublicAPI\V$PortalVersion\Siemens.Engineering.dll" }
$simDir = if ($env:TIA_PLCSIM_RUNTIME_DIR) { $env:TIA_PLCSIM_RUNTIME_DIR } else { 'C:\Program Files\Siemens\Automation\PLCSIM_V20\resources\bin\wwwroot\assets\lib\runtime' }
$simApi = Join-Path $simDir 'Siemens.Simatic.Simulation.Runtime.Api.x64.dll'

$sources = @(
    (Join-Path $root 'bridge\TiaBridge.cs'),
    (Join-Path $root 'bridge\TiaBridge.WatchAndScl.cs'),
    (Join-Path $root 'bridge\TiaBridge.HardwareAndNet.cs'),
    (Join-Path $root 'bridge\TiaBridge.PlcsimAndEscape.cs')
)
$binaryName = if ($PortalVersion -eq '16') { 'TiaBridge.V16' } else { 'TiaBridge' }
$out = Join-Path $root "bridge\$binaryName.exe"

if (-not (Test-Path $csc)) { throw "C# compiler not found: $csc" }
if (-not (Test-Path -LiteralPath $api -PathType Leaf)) { throw "Openness V$PortalVersion assembly not found: $api" }
$assembly = [Reflection.AssemblyName]::GetAssemblyName($api)
if ($assembly.Name -ne "Siemens.Engineering" -or $assembly.Version.Major -ne [int]$PortalVersion) {
    throw "Expected Siemens.Engineering V$PortalVersion, found $($assembly.FullName) in $api"
}

# Clean up any old unlocked hot-swap binaries
Get-ChildItem -Path (Join-Path $root 'bridge') -Filter "$binaryName.old_*.exe" -ErrorAction SilentlyContinue | ForEach-Object {
    try { Remove-Item $_.FullName -Force -ErrorAction Stop } catch { }
}

# Zero-downtime hot-swap: if TiaBridge.exe is currently locked by a running MCP host, rename it without killing the process!
if (Test-Path $out) {
    try {
        Remove-Item $out -Force -ErrorAction Stop
    } catch {
        $oldName = "$binaryName.old_$([DateTime]::UtcNow.Ticks).exe"
        Rename-Item -Path $out -NewName $oldName -Force
        Write-Host "Hot-swapped running $binaryName.exe -> $oldName"
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
    '/reference:System.Core.dll',
    '/reference:System.Xml.dll'
)

if ($PortalVersion -eq '16') {
    $cscArgs += '/define:TIA_V16'
} elseif (Test-Path $simApi) {
    Write-Host "Found PLCSIM V20 Runtime API: enabling WITH_PLCSIM_API..."
    $cscArgs += '/define:WITH_PLCSIM_API'
    $cscArgs += "/reference:$simApi"
}

$cscArgs += $sources

Write-Host "Building $binaryName.exe for TIA Portal V$PortalVersion (x64)..."
& $csc @cscArgs

if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host "Built successfully: $out"
