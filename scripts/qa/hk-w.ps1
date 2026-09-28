<#
.SYNOPSIS
  HK-W (M2-0029): does hard-killing only Metis.exe leave any of its descendants alive on Windows?

.DESCRIPTION
  For each cycle: launch the installed app on a fresh profile, wait for the renderer, optionally prewarm
  the local LLM so llama-server.exe exists, snapshot the owned descendants (main plus its transitive
  children, following a child only when its start time is at or after its parent's, the same rule as
  scripts/qa/owned-processes.mjs), kill ONLY the main pid with Stop-Process -Id, wait SettleSeconds, and
  record which snapshot identities (pid + GetProcessTimes start) are still alive or which new processes
  are resident under the install root. Survivors are then killed by identity so cycles stay independent.
  Nothing is selected or killed by process name.

  The same run verifies the start-time path the sidecar registry and boot reaper rely on: GetProcessTimes
  against the process table, and against the osStartTime the app wrote to run/sidecars-*.json.

  Writes hk-w.json (raw record, content-free: pids, start times, roles, counts) to OutDir. Feed it to
  scripts/qa/hk-w-report.mjs for the verdict. Always exits 0 once the cycles ran; the verdict decides.
#>
param(
  [Parameter(Mandatory = $true)][string]$App,
  [Parameter(Mandatory = $true)][string]$OutDir,
  [int]$Cycles = 20,
  [int]$SettleSeconds = 5,
  # Optional node script that takes the CDP port and prewarms the local LLM (scripts/qa/hk-w-prewarm.mjs).
  [string]$PrewarmScript = '',
  [int]$ReadyTimeoutSeconds = 150,
  [int]$LlamaTimeoutSeconds = 120
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class HkWNative {
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr h, out long creation, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(IntPtr h, IntPtr job, out bool result);
  // Returns the FILETIME creation time (100 ns ticks since 1601) or -1 when the process is gone or unreadable.
  public static long CreationFileTime(int pid) {
    IntPtr h = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
    if (h == IntPtr.Zero) return -1;
    try {
      long c, e, k, u;
      return GetProcessTimes(h, out c, out e, out k, out u) ? c : -1;
    } finally { CloseHandle(h); }
  }
  // 1 when the process is in any job, 0 when in none, -1 when unreadable.
  public static int InAnyJob(int pid) {
    IntPtr h = OpenProcess(0x1000, false, pid);
    if (h == IntPtr.Zero) return -1;
    try {
      bool r;
      return IsProcessInJob(h, IntPtr.Zero, out r) ? (r ? 1 : 0) : -1;
    } finally { CloseHandle(h); }
  }
}
'@

function ConvertTo-UnixMs([long]$fileTime) { [long](($fileTime - 116444736000000000L) / 10000) }

function Get-ProcessTable {
  $rows = @()
  foreach ($p in Get-CimInstance Win32_Process) {
    $ft = [HkWNative]::CreationFileTime([int]$p.ProcessId)
    $cim = if ($p.CreationDate) { [DateTimeOffset]::new($p.CreationDate).ToUnixTimeMilliseconds() } else { 0 }
    $role = if ($p.ExecutablePath) { [IO.Path]::GetFileName($p.ExecutablePath) } else { [string]$p.Name }
    if ($p.CommandLine -match '--type=(\S+)') { $role += " ($($Matches[1]))" }
    $rows += [pscustomobject]@{
      pid = [int]$p.ProcessId; ppid = [int]$p.ParentProcessId
      startedMs = if ($ft -ge 0) { ConvertTo-UnixMs $ft } else { $cim }
      cimMs = $cim; hasTimes = ($ft -ge 0); fileTime = $ft
      exe = $p.ExecutablePath; role = $role
    }
  }
  $rows
}

function Test-Inside([string]$root, [string]$candidate) {
  if (-not $candidate) { return $false }
  $r = $root.TrimEnd('\') + '\'
  $candidate.StartsWith($r, [StringComparison]::OrdinalIgnoreCase)
}

function Get-Owned($table, [int]$mainPid, [string]$installRoot) {
  $owned = @{}
  $main = $table | Where-Object { $_.pid -eq $mainPid } | Select-Object -First 1
  if ($main) {
    $owned["$($main.pid):$($main.startedMs)"] = $main
    $queue = [System.Collections.Generic.Queue[object]]::new()
    $queue.Enqueue($main)
    while ($queue.Count -gt 0) {
      $parent = $queue.Dequeue()
      foreach ($child in ($table | Where-Object { $_.ppid -eq $parent.pid })) {
        if ($child.startedMs -lt $parent.startedMs) { continue }
        $key = "$($child.pid):$($child.startedMs)"
        if ($owned.ContainsKey($key)) { continue }
        $owned[$key] = $child
        $queue.Enqueue($child)
      }
    }
  }
  foreach ($entry in $table) {
    if (Test-Inside $installRoot $entry.exe) { $owned["$($entry.pid):$($entry.startedMs)"] = $entry }
  }
  $owned.Values
}

function Get-FreePort {
  $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
  $listener.Start()
  $port = $listener.LocalEndpoint.Port
  $listener.Stop()
  $port
}

function Wait-Until([scriptblock]$predicate, [int]$timeoutSeconds, [int]$intervalMs = 500) {
  $deadline = [DateTime]::UtcNow.AddSeconds($timeoutSeconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    $value = & $predicate
    if ($value) { return $value }
    Start-Sleep -Milliseconds $intervalMs
  }
  $null
}

$appPath = (Resolve-Path $App).Path
$installRoot = Split-Path -Parent $appPath
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$startTime = @{ checked = 0; mismatches = 0; registryChecked = 0; registryMismatches = 0 }
$records = @()

for ($n = 1; $n -le $Cycles; $n++) {
  $profile = Join-Path ([IO.Path]::GetTempPath()) "hk-w-profile-$n-$([Guid]::NewGuid().ToString('N'))"
  New-Item -ItemType Directory -Force -Path $profile | Out-Null
  $settings = @{ localLlm = @{ enabled = $true; modelId = 'qwen3.5-0.8b'; useFor = @{ suggest = $true; summary = $false; vision = $false }; fallback = $true } }
  $settings | ConvertTo-Json -Depth 5 | Set-Content -Path (Join-Path $profile 'settings.json') -Encoding UTF8

  $port = Get-FreePort
  $env:ASKTOTO_USERDATA = $profile
  $env:METIS_DISABLE_APPLE_FM = '1'
  Get-ChildItem Env: | Where-Object { $_.Name -match '_API_KEY$' } | ForEach-Object { Remove-Item "Env:$($_.Name)" }

  $record = [ordered]@{ cycle = $n; killed = $false; prewarmOk = $null; llamaObserved = $false; descendants = @(); survivors = @(); inJob = @() }
  $mainProc = Start-Process -FilePath $appPath -ArgumentList "--remote-debugging-port=$port" -PassThru
  $mainPid = $mainProc.Id

  $auditLog = Join-Path $profile 'logs\audit.log'
  $ready = Wait-Until { (Test-Path $auditLog) -and (Select-String -Path $auditLog -Pattern 'app.renderer.ready' -Quiet) } $ReadyTimeoutSeconds
  if ($ready) {
    if ($PrewarmScript) {
      try { & node $PrewarmScript $port | Out-Null; $record.prewarmOk = ($LASTEXITCODE -eq 0) } catch { $record.prewarmOk = $false }
      if (-not $record.prewarmOk) { Write-Host "cycle ${n}: prewarm failed" }
      $llama = Wait-Until {
        Get-Owned (Get-ProcessTable) $mainPid $installRoot | Where-Object { $_.role -eq 'llama-server.exe' } | Select-Object -First 1
      } $LlamaTimeoutSeconds
      $record.llamaObserved = [bool]$llama
    }
    Start-Sleep -Seconds 2

    $table = Get-ProcessTable
    $owned = @(Get-Owned $table $mainPid $installRoot)
    $descendants = @($owned | Where-Object { $_.pid -ne $mainPid })

    foreach ($entry in $owned) {
      if (-not $entry.hasTimes) { continue }
      $startTime.checked++
      if ([Math]::Abs($entry.startedMs - $entry.cimMs) -gt 1000) { $startTime.mismatches++ }
    }
    # Registry osStartTime is written by the app through the same GetProcessTimes call; compare the
    # recorded ISO string with a fresh read for every still-live spawned record.
    $runDir = Join-Path $profile 'run'
    if (Test-Path $runDir) {
      foreach ($file in Get-ChildItem $runDir -Filter 'sidecars-*.json') {
        foreach ($line in Get-Content $file.FullName) {
          try { $rec = $line | ConvertFrom-Json } catch { continue }
          if ($rec.kind -ne 'spawned' -or -not $rec.pid) { continue }
          $ft = [HkWNative]::CreationFileTime([int]$rec.pid)
          if ($ft -lt 0) { continue }
          $startTime.registryChecked++
          $fresh = [DateTime]::FromFileTimeUtc($ft).ToString('o')
          $recorded = ([DateTime]$rec.osStartTime).ToUniversalTime().ToString('o')
          if ($fresh -ne $recorded) { $startTime.registryMismatches++ }
        }
      }
    }

    $record.descendants = @($descendants | ForEach-Object { [ordered]@{ pid = $_.pid; startedMs = $_.startedMs; role = $_.role } })
    $record.inJob = @($owned | ForEach-Object { [ordered]@{ pid = $_.pid; role = $_.role; inAnyJob = [HkWNative]::InAnyJob($_.pid) } })

    Stop-Process -Id $mainPid -Force
    $record.killed = $true
    Start-Sleep -Seconds $SettleSeconds

    $after = Get-ProcessTable
    $afterKeys = @{}
    foreach ($entry in $after) { $afterKeys["$($entry.pid):$($entry.startedMs)"] = $entry }
    $survivors = @($descendants | Where-Object { $afterKeys.ContainsKey("$($_.pid):$($_.startedMs)") })
    $survivorPids = @($survivors | ForEach-Object { $_.pid })
    $residents = @($after | Where-Object { (Test-Inside $installRoot $_.exe) -and ($survivorPids -notcontains $_.pid) })
    # A resident under the install root that was not in the snapshot is a survivor too (a respawn after the kill).
    $left = @($survivors) + @($residents)
    $record.survivors = @($left | ForEach-Object { [ordered]@{ pid = $_.pid; startedMs = $_.startedMs; role = $_.role } })
    foreach ($s in $left) { Stop-Process -Id $s.pid -Force -ErrorAction SilentlyContinue }
  } else {
    Stop-Process -Id $mainPid -Force -ErrorAction SilentlyContinue
    $record.notReady = $true
  }

  Remove-Item -Recurse -Force -Path $profile -ErrorAction SilentlyContinue
  $records += [pscustomobject]$record
  Write-Host ("cycle {0}: descendants={1} survivors={2} llama={3}" -f $n, @($record.descendants).Count, @($record.survivors).Count, $record.llamaObserved)
}

[ordered]@{
  requestedCycles = $Cycles
  settleSeconds = $SettleSeconds
  cycles = $records
  startTime = $startTime
} | ConvertTo-Json -Depth 8 | Set-Content -Path (Join-Path $OutDir 'hk-w.json') -Encoding UTF8
