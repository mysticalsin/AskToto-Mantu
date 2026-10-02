<#
.SYNOPSIS
  Windows 1.9.6 baseline harness (M2-0195): measures the hosted-runner rows that can be established
  against the installed app and reports every managed-laptop row as BLOCKED_EXTERNAL.

.DESCRIPTION
  Measured rows run scripts/qa/census/run.mjs against the installed Metis.exe on a synthetic profile
  (cold-start, settled-idle). Rows that need a signed-in account, downloaded models or a live meeting
  (first-inference, active-transcription, post-meeting, post-recovery) and rows that need the managed
  laptop's policy stack are never faked: each is printed and recorded BLOCKED_EXTERNAL with the exact
  unblock step.

  Writes a content-free evidence bundle to OutDir: environment.json, baseline.json, external-blockers.json,
  findings-handoff.json, M2-0195.lead-action.md and the per-state census JSON. -PlanOnly writes the row
  plan without launching the app, so the row contract can be checked on any machine with PowerShell. Exit
  code is 1 when a measured row failed, 0 otherwise; BLOCKED_EXTERNAL rows do not fail the run.
#>
param(
  [string]$Artifact = '',
  [string]$App = '',
  [string]$QaProfile = $env:METIS_QA_PROFILE,
  [string]$OutDir = '',
  [int]$Seconds = 300,
  [switch]$PlanOnly
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$census = Join-Path $repoRoot 'scripts/qa/census/run.mjs'
if (-not $OutDir) { $OutDir = Join-Path $repoRoot 'out/windows-baseline' }

$measuredStates = @('cold-start', 'settled-idle')
$attachStates = @('first-inference', 'active-transcription', 'post-meeting', 'post-recovery')
$managedLaptopUnblock = 'Mantu IT: provide one managed Windows 11 x64 laptop on the standard enterprise image with EDR as deployed and OneDrive Files On-Demand enabled, with remote access for the QA runner.'

# Each managed-laptop row: id and the exact step that unblocks it.
$managedRows = @(
  @{ id = 'managed-install-policy'; unblock = 'On the Mantu IT managed Windows laptop, run the 1.9.6 Metis-Setup installer as the standard user and record whether SmartScreen, AppLocker or WDAC blocks or prompts.' },
  @{ id = 'managed-edr-overhead'; unblock = 'On the managed laptop with the EDR agent active, run this script with -App pointing at the installed Metis.exe and compare the census CPU and working set with the hosted run.' },
  @{ id = 'managed-proxy-network'; unblock = 'On the managed laptop behind the corporate proxy, launch Metis and record whether provider and license traffic succeeds; no credentials go into the record.' },
  @{ id = 'managed-cloud-folder'; unblock = 'On the managed laptop, point the meetings folder at the OneDrive Known Folder Move location and record the History open time with files on-demand (dataless) and hydrated.' },
  @{ id = 'st-1-w-onedrive-placeholders-network-off'; unblock = 'On the managed laptop, point the synthetic meetings folder at OneDrive Files On-Demand placeholders, disable the network, run ST-1-W, and record placeholder hydration, freeze and history-open behavior.' },
  @{ id = 'hk-w-end-task-owned-sidecars'; unblock = 'On the managed laptop under EDR, run HK-W by ending only the main Metis.exe task, then record the census of owned sidecars and Electron utilityProcess hosts.' },
  @{ id = 'managed-resource-census-representative'; unblock = 'On the managed laptop under EDR and OneDrive Files On-Demand, run the representative resource census and record working set, private bytes and CPU-time deltas.' },
  @{ id = 'managed-foreground-watcher-cost'; unblock = 'On the managed laptop, measure the PowerShell foreground-watcher process working set, private bytes and CPU-time deltas while Metis 1.9.6 is running.' },
  @{ id = 'managed-edr-interaction'; unblock = 'On the managed laptop, record any EDR prompt, quarantine, process block, slowdown or audit interaction observed while installing and running the 1.9.6 baseline.' }
)

if ($Artifact -and ($Artifact -cnotmatch '^[0-9a-f]{64}$')) { throw '-Artifact must be the lowercase 64-character sha256 of the 1.9.6 Windows installer.' }

if (-not $PlanOnly) {
  if (-not $Artifact) { throw '-Artifact is required unless -PlanOnly is set.' }
  if (-not $App) { throw '-App is required unless -PlanOnly is set.' }
  if (-not $QaProfile) { throw '-QaProfile or METIS_QA_PROFILE is required: a fresh profile is not representative.' }
  if (-not (Test-Path (Join-Path $QaProfile 'resource-census-profile.json'))) { throw "resource-census-profile.json is missing from ${QaProfile}: measure only a representative profile." }
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$rows = @()

foreach ($state in $measuredStates) {
  $artifact = "win32-$state.json"
  if ($PlanOnly) {
    $rows += [ordered]@{ id = "census-$state"; state = $state; status = 'SUPPORTED_NOT_RUN'; artifact = $artifact }
    continue
  }
  $env:METIS_QA_PROFILE = $QaProfile
  & node $census --state $state --seconds $Seconds --app $App --output (Join-Path $OutDir $artifact)
  $ok = ($LASTEXITCODE -eq 0) -and (Test-Path (Join-Path $OutDir $artifact))
  $status = if ($ok) { 'MEASURED' } else { 'FAILED' }
  $rows += [ordered]@{ id = "census-$state"; state = $state; status = $status; artifact = $artifact }
}

foreach ($state in $attachStates) {
  $rows += [ordered]@{
    id = "census-$state"
    state = $state
    status = 'BLOCKED_EXTERNAL'
    unblock = "Start the installed 1.9.6 app on the representative QA profile with a signed-in account and local models, establish $state, then run node scripts/qa/census/run.mjs --state $state --main-pid <pid> --install-root <dir> --precondition-evidence <text>."
  }
}

foreach ($row in $managedRows) {
  $rows += [ordered]@{ id = $row.id; status = 'BLOCKED_EXTERNAL'; unblock = $row.unblock }
}

foreach ($row in $rows) {
  if ($row.status -eq 'BLOCKED_EXTERNAL') { Write-Host "$($row.id): BLOCKED_EXTERNAL - $($row.unblock)" }
  else { Write-Host "$($row.id): $($row.status)" }
}

[ordered]@{
  ticket = 'M2-0195'
  version = '1.9.6'
  platform = 'win32'
  planOnly = [bool]$PlanOnly
  rows = $rows
} | ConvertTo-Json -Depth 5 | Set-Content -Path (Join-Path $OutDir 'baseline.json') -Encoding utf8

[ordered]@{
  ticket = 'M2-0195'
  version = '1.9.6'
  platform = 'win32'
  mode = if ($PlanOnly) { 'plan-only' } else { 'hosted-live' }
  host = @{ label = 'windows-latest' }
  artifact_sha256 = if ($Artifact) { $Artifact } else { $null }
} | ConvertTo-Json -Depth 5 | Set-Content -Path (Join-Path $OutDir 'environment.json') -Encoding utf8

[ordered]@{
  ticket = 'M2-0195'
  blockers = @(
    [ordered]@{
      status = 'BLOCKED_EXTERNAL'
      unblock_step = $managedLaptopUnblock
    }
  )
} | ConvertTo-Json -Depth 5 | Set-Content -Path (Join-Path $OutDir 'external-blockers.json') -Encoding utf8

$handoffRows = @(
  'st-1-w-onedrive-placeholders-network-off',
  'hk-w-end-task-owned-sidecars',
  'managed-resource-census-representative',
  'managed-foreground-watcher-cost',
  'managed-edr-interaction'
) | ForEach-Object { [ordered]@{ row = $_; disposition = 'ticket-or-release-residual' } }

[ordered]@{
  ticket = 'M2-0195'
  release = '1.9.7'
  rule = 'Every finding becomes a ticket or an explicit residual in the 1.9.7 release notes.'
  rows = @($handoffRows)
} | ConvertTo-Json -Depth 5 | Set-Content -Path (Join-Path $OutDir 'findings-handoff.json') -Encoding utf8

@"
# M2-0195 Windows 1.9.6 baseline

Content-free artifact bundle for the hosted Windows 1.9.6 baseline. The managed-laptop rows are BLOCKED_EXTERNAL until the standard enterprise Windows 11 laptop with EDR and OneDrive Files On-Demand is available.
"@ | Set-Content -Path (Join-Path $OutDir 'README.md') -Encoding utf8

@"
LEAD_ACTION: File the M2-0195 LIVE_VERIFIED and MEASURED evidence records from this bundle, then ensure every finding is a ticket or explicit residual in the 1.9.7 release notes.

Use findings-handoff.json as the public artifact index. Do not paste private tracker paths, private finding ids, secrets, account ids, personal emails or meeting content into the public repository.
"@ | Set-Content -Path (Join-Path $OutDir 'M2-0195.lead-action.md') -Encoding utf8

if ($Artifact -and -not (Test-Path (Join-Path $OutDir 'SHA256SUMS.txt'))) {
  "$Artifact  Metis-Setup-1.9.6.exe" | Set-Content -Path (Join-Path $OutDir 'SHA256SUMS.txt') -Encoding utf8
}

if ($rows | Where-Object { $_.status -eq 'FAILED' }) { exit 1 }
exit 0
