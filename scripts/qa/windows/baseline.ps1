<#
.SYNOPSIS
  Windows 1.9.6 baseline harness (M2-0415): measures the M2-0009 census states that a hosted runner can
  establish on the installed app and reports every row that needs Mantu IT's managed laptop as BLOCKED_EXTERNAL.

.DESCRIPTION
  Measured rows run scripts/qa/census/run.mjs against the installed Metis.exe on a synthetic profile
  (cold-start, settled-idle). Rows that need a signed-in account, downloaded models or a live meeting
  (first-inference, active-transcription, post-meeting, post-recovery) and rows that need the managed
  laptop's policy stack are never faked: each is printed and recorded BLOCKED_EXTERNAL with the exact
  unblock step.

  Writes baseline.json (content-free: states, statuses, artifact file names, unblock steps) plus the
  per-state census JSON to OutDir. -PlanOnly writes the row plan without launching the app, so the row
  contract can be checked on any machine with PowerShell. Exit code is 1 when a measured row failed,
  0 otherwise; BLOCKED_EXTERNAL rows do not fail the run.
#>
param(
  [string]$App = '',
  [string]$Profile = $env:METIS_QA_PROFILE,
  [Parameter(Mandatory = $true)][string]$OutDir,
  [int]$Seconds = 300,
  [switch]$PlanOnly
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$census = Join-Path $repoRoot 'scripts/qa/census/run.mjs'

$measuredStates = @('cold-start', 'settled-idle')
$attachStates = @('first-inference', 'active-transcription', 'post-meeting', 'post-recovery')

# Each managed-laptop row: id and the exact step that unblocks it.
$managedRows = @(
  @{ id = 'managed-install-policy'; unblock = 'On the Mantu IT managed Windows laptop, run the 1.9.6 Metis-Setup installer as the standard user and record whether SmartScreen, AppLocker or WDAC blocks or prompts.' },
  @{ id = 'managed-edr-overhead'; unblock = 'On the managed laptop with the EDR agent active, run this script with -App pointing at the installed Metis.exe and compare the census CPU and working set with the hosted run.' },
  @{ id = 'managed-proxy-network'; unblock = 'On the managed laptop behind the corporate proxy, launch Metis and record whether provider and license traffic succeeds; no credentials go into the record.' },
  @{ id = 'managed-cloud-folder'; unblock = 'On the managed laptop, point the meetings folder at the OneDrive Known Folder Move location and record the History open time with files on-demand (dataless) and hydrated.' }
)

if (-not $PlanOnly) {
  if (-not $App) { throw '-App is required unless -PlanOnly is set.' }
  if (-not $Profile) { throw '-Profile or METIS_QA_PROFILE is required: a fresh profile is not representative.' }
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$rows = @()

foreach ($state in $measuredStates) {
  $artifact = "win32-$state.json"
  if ($PlanOnly) {
    $rows += [ordered]@{ id = "census-$state"; state = $state; status = 'SUPPORTED_NOT_RUN'; artifact = $artifact }
    continue
  }
  $env:METIS_QA_PROFILE = $Profile
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
  version = '1.9.6'
  platform = 'win32'
  planOnly = [bool]$PlanOnly
  rows = $rows
} | ConvertTo-Json -Depth 5 | Set-Content -Path (Join-Path $OutDir 'baseline.json') -Encoding utf8

if ($rows | Where-Object { $_.status -eq 'FAILED' }) { exit 1 }
exit 0
