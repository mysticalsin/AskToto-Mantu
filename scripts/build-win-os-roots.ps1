$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($env:OS -ne 'Windows_NT') {
  throw 'The Windows OS-root helper must be built on a Windows x64 host.'
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$tempRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path -LiteralPath $vswhere -PathType Leaf)) {
  throw 'Pinned Visual Studio C++ build tools were not found.'
}
$installation = (& $vswhere -latest -version '[17.0,18.0)' -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath | Select-Object -First 1)
if (-not $installation) {
  throw 'Visual Studio C++ x64 build tools were not found.'
}
$installation = $installation.Trim()
$vcvars = Join-Path $installation 'VC\Auxiliary\Build\vcvars64.bat'
if (-not (Test-Path -LiteralPath $vcvars -PathType Leaf)) {
  throw 'Visual Studio x64 compiler setup is missing.'
}

$resourceRoot = Join-Path $repoRoot 'resources\win-os-roots'
$source = Join-Path $repoRoot 'native\win-os-roots\osroots.c'
New-Item -ItemType Directory -Force -Path $resourceRoot | Out-Null
$output = Join-Path $resourceRoot 'osroots.exe'
$object = Join-Path $tempRoot 'metis-osroots.obj'
$commandFile = Join-Path $tempRoot 'metis-build-osroots.cmd'
$command = @"
@echo off
call "$vcvars" >nul
if errorlevel 1 exit /b 1
cl /nologo /O2 /W4 /WX /MT /DUNICODE /D_UNICODE /Fo:"$object" /Fe:"$output" "$source"
if errorlevel 1 exit /b 1
dumpbin /headers "$output" | findstr /i /c:"8664 machine (x64)" >nul
if errorlevel 1 exit /b 1
"$output" --json >nul
if errorlevel 1 exit /b 1
"$output" unexpected-argument >nul
if not errorlevel 1 exit /b 1
exit /b 0
"@
Set-Content -LiteralPath $commandFile -Value $command -Encoding Ascii
$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = 'cmd.exe'
$startInfo.Arguments = '/d /s /c ""' + $commandFile + '""'
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$build = [System.Diagnostics.Process]::new()
$build.StartInfo = $startInfo
if (-not $build.Start()) { throw 'The Windows OS-root compiler process did not start.' }
if (-not $build.WaitForExit(60000)) {
  try { $build.Kill($true) } catch {}
  $build.Dispose()
  throw 'The Windows OS-root build exceeded its 60-second process deadline.'
}
$exitCode = $build.ExitCode
$build.Dispose()
if ($exitCode -ne 0 -or -not (Test-Path -LiteralPath $output -PathType Leaf)) {
  throw "The Windows OS-root helper failed its x64 build and smoke checks (exit code $exitCode)."
}

$bytes = [System.IO.File]::ReadAllBytes($output)
$sha256 = [System.Security.Cryptography.SHA256]::HashData($bytes)
$manifest = [ordered]@{
  schemaVersion = 1
  helperVersion = 1
  path = 'win-os-roots/osroots.exe'
  bytes = $bytes.Length
  sha256 = [Convert]::ToHexString($sha256).ToLowerInvariant()
}
$manifestPath = Join-Path $resourceRoot 'osroots.manifest.json'
[System.IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Compress) + "`n", [System.Text.UTF8Encoding]::new($false))
Remove-Item -LiteralPath $object, $commandFile -Force -ErrorAction SilentlyContinue
Write-Output 'Built and inventoried the unsigned x64 Windows OS-root helper.'
