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
$stdoutLog = Join-Path $tempRoot 'metis-osroots-build-stdout.log'
$stderrLog = Join-Path $tempRoot 'metis-osroots-build-stderr.log'
$command = @"
@echo off
call "$vcvars" >nul
if errorlevel 1 exit /b 11
cl /nologo /O2 /W4 /WX /MT /DUNICODE /D_UNICODE /Fo:"$object" /Fe:"$output" "$source"
if errorlevel 1 exit /b 12
dumpbin /headers "$output" | findstr /i /c:"8664 machine (x64)" >nul
if errorlevel 1 exit /b 13
"$output" --json >nul
if errorlevel 1 exit /b 14
"$output" unexpected-argument >nul
if not errorlevel 1 exit /b 15
exit /b 0
"@
Set-Content -LiteralPath $commandFile -Value $command -Encoding Ascii

$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = 'cmd.exe'
$startInfo.Arguments = '/d /s /c ""' + $commandFile + '""'
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
$build = [System.Diagnostics.Process]::new()
$build.StartInfo = $startInfo
if (-not $build.Start()) { throw 'The Windows OS-root compiler process did not start.' }
$maxLogCharacters = 65536
$stdoutCapture = [System.Text.StringBuilder]::new()
$stderrCapture = [System.Text.StringBuilder]::new()
$stdoutBuffer = [char[]]::new(4096)
$stderrBuffer = [char[]]::new(4096)
$stdoutTask = $build.StandardOutput.ReadAsync($stdoutBuffer, 0, $stdoutBuffer.Length)
$stderrTask = $build.StandardError.ReadAsync($stderrBuffer, 0, $stderrBuffer.Length)
$processExitTask = $build.WaitForExitAsync()
$buildClock = [System.Diagnostics.Stopwatch]::StartNew()
$drainClock = $null
$timedOut = $false
while ($true) {
  if ($processExitTask.IsCompleted -and $null -eq $drainClock) {
    $drainClock = [System.Diagnostics.Stopwatch]::StartNew()
  }
  if (-not $processExitTask.IsCompleted -and -not $timedOut -and $buildClock.ElapsedMilliseconds -ge 60000) {
    $timedOut = $true
    $drainClock = [System.Diagnostics.Stopwatch]::StartNew()
    try { $build.Kill($true) } catch {}
  }
  if ($processExitTask.IsCompleted -and $null -eq $stdoutTask -and $null -eq $stderrTask) { break }
  if ($null -ne $drainClock -and $drainClock.ElapsedMilliseconds -ge 5000) { break }

  $pendingTasks = [System.Collections.Generic.List[System.Threading.Tasks.Task]]::new()
  if ($null -ne $stdoutTask) { [void]$pendingTasks.Add($stdoutTask) }
  if ($null -ne $stderrTask) { [void]$pendingTasks.Add($stderrTask) }
  if (-not $processExitTask.IsCompleted) { [void]$pendingTasks.Add($processExitTask) }
  [void]$pendingTasks.Add([System.Threading.Tasks.Task]::Delay(50))
  $waitTask = [System.Threading.Tasks.Task]::WhenAny($pendingTasks.ToArray())
  $null = $waitTask.GetAwaiter().GetResult()

  if ($null -ne $stdoutTask -and $stdoutTask.IsCompleted) {
    try { $readCount = $stdoutTask.GetAwaiter().GetResult() } catch { $readCount = 0 }
    if ($readCount -eq 0) {
      $stdoutTask = $null
    } else {
      $remaining = $maxLogCharacters - $stdoutCapture.Length
      if ($remaining -gt 0) { [void]$stdoutCapture.Append($stdoutBuffer, 0, [Math]::Min($readCount, $remaining)) }
      $stdoutTask = $build.StandardOutput.ReadAsync($stdoutBuffer, 0, $stdoutBuffer.Length)
    }
  }
  if ($null -ne $stderrTask -and $stderrTask.IsCompleted) {
    try { $readCount = $stderrTask.GetAwaiter().GetResult() } catch { $readCount = 0 }
    if ($readCount -eq 0) {
      $stderrTask = $null
    } else {
      $remaining = $maxLogCharacters - $stderrCapture.Length
      if ($remaining -gt 0) { [void]$stderrCapture.Append($stderrBuffer, 0, [Math]::Min($readCount, $remaining)) }
      $stderrTask = $build.StandardError.ReadAsync($stderrBuffer, 0, $stderrBuffer.Length)
    }
  }
}
$build.StandardOutput.Close()
$build.StandardError.Close()
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText($stdoutLog, $stdoutCapture.ToString(), $utf8NoBom)
[System.IO.File]::WriteAllText($stderrLog, $stderrCapture.ToString(), $utf8NoBom)
$exitCode = if ($processExitTask.IsCompleted) { $build.ExitCode } else { 1 }
$build.Dispose()
if ($timedOut) { throw 'WIN_OSROOT_BUILD_TIMEOUT_60S' }
if ($exitCode -ne 0 -or -not (Test-Path -LiteralPath $output -PathType Leaf)) {
  $failureStage = if (-not (Test-Path -LiteralPath $output -PathType Leaf) -and $exitCode -eq 0) { 'OUTPUT' } else {
    switch ($exitCode) {
      11 { 'VCVARS' }
      12 { 'COMPILE' }
      13 { 'ARCH' }
      14 { 'POSITIVE' }
      15 { 'NEGATIVE' }
      default { 'PROCESS' }
    }
  }
  $capturedOutput = $stdoutCapture.ToString() + "`n" + $stderrCapture.ToString()
  $compilerCodes = [System.Collections.Generic.List[string]]::new()
  foreach ($match in [regex]::Matches($capturedOutput, '(?im)\b(?:fatal\s+error|error|warning)\s+(C\d{4}|LNK\d{4})\b')) {
    $compilerCode = $match.Groups[1].Value.ToUpperInvariant()
    if (-not $compilerCodes.Contains($compilerCode)) { [void]$compilerCodes.Add($compilerCode) }
    if ($compilerCodes.Count -ge 8) { break }
  }
  $codeSummary = if ($compilerCodes.Count -gt 0) { $compilerCodes -join '_' } else { 'NONE' }
  throw "WIN_OSROOT_BUILD_FAILED_STAGE_${failureStage}_CODES_${codeSummary}"
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
Remove-Item -LiteralPath $object, $commandFile, $stdoutLog, $stderrLog -Force -ErrorAction SilentlyContinue
Write-Output 'Built and inventoried the unsigned x64 Windows OS-root helper.'
