$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$api = 'C:\Program Files\Siemens\Automation\Portal V20\PublicAPI\V20\Siemens.Engineering.dll'
$src = Join-Path $root 'bridge\TiaBridge.cs'
$out = Join-Path $root 'bridge\TiaBridge.exe'

if (-not (Test-Path $csc)) { throw "C# compiler not found: $csc" }
if (-not (Test-Path $api)) { throw "Siemens.Engineering.dll not found: $api" }

Write-Host "Building TiaBridge.exe (x64 .NET Framework 4.8)..."
& $csc /nologo /platform:x64 /optimize+ /target:exe `
    "/out:$out" `
    "/reference:$api" `
    /reference:System.Web.Extensions.dll `
    /reference:System.Core.dll `
    "$src"

if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host "Built successfully: $out"
