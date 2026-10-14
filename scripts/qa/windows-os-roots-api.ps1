$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class MetisWindowsDirectoryApi {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "GetSystemWindowsDirectoryW")]
  private static extern uint GetSystemWindowsDirectory(StringBuilder buffer, uint size);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "GetSystemDirectoryW")]
  private static extern uint GetSystemDirectory(StringBuilder buffer, uint size);
  public static string WindowsRoot() { var b = new StringBuilder(260); var n = GetSystemWindowsDirectory(b, (uint)b.Capacity); if (n == 0 || n >= (uint)b.Capacity) throw new InvalidOperationException("OS_DIRECTORY_QUERY_FAILED"); return b.ToString(); }
  public static string SystemRoot() { var b = new StringBuilder(260); var n = GetSystemDirectory(b, (uint)b.Capacity); if (n == 0 || n >= (uint)b.Capacity) throw new InvalidOperationException("OS_DIRECTORY_QUERY_FAILED"); return b.ToString(); }
}
'@

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$helper = Join-Path $repoRoot 'resources\win-os-roots\osroots.exe'
$expectedWindowsRoot = [MetisWindowsDirectoryApi]::WindowsRoot()
$expectedSystemRoot = [MetisWindowsDirectoryApi]::SystemRoot()
$poison = 'Z:\metis-caller-controlled'

foreach ($environment in @('poisoned', 'absent')) {
  $start = [System.Diagnostics.ProcessStartInfo]::new($helper, '--json')
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $start.Environment.Clear()
  $start.Environment['PATH'] = ''
  if ($environment -eq 'poisoned') {
    $start.Environment['SystemRoot'] = $poison
    $start.Environment['SYSTEMROOT'] = $poison
    $start.Environment['windir'] = $poison
    $start.Environment['WINDIR'] = $poison
  }
  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $start
  if (-not $process.Start()) { throw 'The app-owned Windows OS-root helper did not start.' }
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  if (-not $process.WaitForExit(3000)) {
    $process.Kill($true)
    throw 'The app-owned Windows OS-root helper exceeded its bounded response deadline.'
  }
  $stdout = $stdoutTask.GetAwaiter().GetResult()
  $stderr = $stderrTask.GetAwaiter().GetResult()
  $process.Dispose()
  if ($stdout.Length -gt 2048 -or $stderr.Length -ne 0) { throw 'The app-owned Windows OS-root helper response was not bounded and content-free.' }
  $lines = $stdout.Split("`n")
  if ($lines.Length -ne 2 -or $lines[1] -ne '') { throw 'The app-owned Windows OS-root helper did not emit exactly one JSON line.' }
  $report = $lines[0] | ConvertFrom-Json
  $properties = @($report.PSObject.Properties.Name | Sort-Object) -join ','
  if ($properties -ne 'systemRoot,version,windowsRoot' -or $report.version -ne 1 -or
      $report.windowsRoot -cne $expectedWindowsRoot -or $report.systemRoot -cne $expectedSystemRoot) {
    throw 'The app-owned helper response did not match the Windows API answers.'
  }
}
Write-Output 'Windows OS-root helper matched both kernel directory APIs with poisoned and absent SystemRoot/PATH.'
