$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$installation = (& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath | Select-Object -First 1)
if (-not $installation) { throw 'Visual Studio C++ x64 build tools were not found.' }
$installation = $installation.Trim()
$vcvars = Join-Path $installation 'VC\Auxiliary\Build\vcvars64.bat'
$output = Join-Path $env:RUNNER_TEMP 'metis-win-os-roots-shutdown'
New-Item -ItemType Directory -Force -Path $output | Out-Null
$supervisor = Join-Path $output 'supervise.exe'
$fixture = Join-Path $output 'job-tree-fixture.exe'
$commandFile = Join-Path $output 'build-fixture.cmd'
$superviseSource = Join-Path $repoRoot 'native\win-supervise\supervise.c'
$fixtureSource = Join-Path $repoRoot 'native\win-supervise\tests\job-tree-fixture.c'
$command = @"
@echo off
call "$vcvars" >nul
if errorlevel 1 exit /b 1
cl /nologo /O2 /W4 /MT /DUNICODE /D_UNICODE /Fe:"$supervisor" "$superviseSource"
if errorlevel 1 exit /b 1
cl /nologo /O2 /W4 /WX /MT /DUNICODE /D_UNICODE /Fe:"$fixture" "$fixtureSource"
if errorlevel 1 exit /b 1
exit /b 0
"@
Set-Content -LiteralPath $commandFile -Value $command -Encoding Ascii
$compileInfo = [System.Diagnostics.ProcessStartInfo]::new()
$compileInfo.FileName = 'cmd.exe'
$compileInfo.Arguments = '/d /s /c ""' + $commandFile + '""'
$compileInfo.UseShellExecute = $false
$compileInfo.CreateNoWindow = $true
$compile = [System.Diagnostics.Process]::new()
$compile.StartInfo = $compileInfo
if (-not $compile.Start()) { throw 'The owned-process shutdown fixture compiler did not start.' }
if (-not $compile.WaitForExit(60000)) {
  try { $compile.Kill($true) } catch {}
  $compile.Dispose()
  throw 'The owned-process shutdown fixture build exceeded its 60-second process deadline.'
}
$compileExitCode = $compile.ExitCode
$compile.Dispose()
if ($compileExitCode -ne 0) { throw 'The owned-process shutdown proof fixtures did not compile.' }

$runDirectory = Join-Path $output 'run'
New-Item -ItemType Directory -Path $runDirectory | Out-Null
$arguments = "-- `"$fixture`" root `"$runDirectory`""
$owner = Start-Process -FilePath $supervisor -ArgumentList $arguments -PassThru -WindowStyle Hidden
$deadline = [DateTime]::UtcNow.AddSeconds(15)
$rootMarker = Join-Path $runDirectory 'root.pid'
$childMarker = Join-Path $runDirectory 'child.pid'
while ([DateTime]::UtcNow -lt $deadline -and (-not (Test-Path $rootMarker) -or -not (Test-Path $childMarker))) {
  if ($owner.HasExited) { throw 'The native Job Object owner exited before its process tree was ready.' }
  Start-Sleep -Milliseconds 50
}
if (-not (Test-Path $rootMarker) -or -not (Test-Path $childMarker)) {
  Stop-Process -Id $owner.Id -Force -ErrorAction SilentlyContinue
  throw 'The native Job Object process tree did not become ready.'
}
$rootId = [int](Get-Content -LiteralPath $rootMarker -Raw).Trim()
$childId = [int](Get-Content -LiteralPath $childMarker -Raw).Trim()
Stop-Process -Id $owner.Id -Force
try { Wait-Process -Id $owner.Id -Timeout 10 -ErrorAction SilentlyContinue } catch {}

function Test-ProcessExited([int] $processId) {
  try {
    $process = Get-Process -Id $processId -ErrorAction Stop
    $process.Dispose()
    return $false
  } catch {
    return $true
  }
}

$deadline = [DateTime]::UtcNow.AddSeconds(10)
while ([DateTime]::UtcNow -lt $deadline -and (-not (Test-ProcessExited $rootId) -or -not (Test-ProcessExited $childId))) {
  Start-Sleep -Milliseconds 50
}
if (-not (Test-ProcessExited $rootId) -or -not (Test-ProcessExited $childId)) {
  throw 'Closing the native Job Object owner did not terminate its owned root and descendant.'
}
Write-Output 'Native Job Object shutdown proof passed for the owned root and descendant.'
