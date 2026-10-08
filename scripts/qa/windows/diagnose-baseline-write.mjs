// One hosted-only experiment, not a retry policy or a replacement for the baseline contract.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHermeticSandbox, hermeticEnv, mergedEnv } from '../../hermetic/sandbox-env.mjs'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const BASELINE = 'scripts/qa/windows/baseline.ps1'
const SHA = 'a'.repeat(64)
const PREFIX = 'METIS_BASELINE_DIAGNOSTIC:'
const LIMIT = 64 * 1024
const MODES = ['direct', 'instrumented', 'minimal']
const MEASURED = ['cold-start', 'settled-idle']
const ATTACHED = ['first-inference', 'active-transcription', 'post-meeting', 'post-recovery']
const MANAGED = [
  'managed-install-policy',
  'managed-edr-overhead',
  'managed-proxy-network',
  'managed-cloud-folder',
  'st-1-w-onedrive-placeholders-network-off',
  'hk-w-end-task-owned-sidecars',
  'managed-resource-census-representative',
  'managed-foreground-watcher-cost',
  'managed-edr-interaction'
]
const HANDOFF_ROWS = MANAGED.slice(4)
const UNBLOCK =
  'Mantu IT: provide one managed Windows 11 x64 laptop on the standard enterprise image with EDR as deployed and OneDrive Files On-Demand enabled, with remote access for the QA runner.'
const README = `# M2-0195 Windows 1.9.6 baseline

Content-free artifact bundle for the hosted Windows 1.9.6 baseline. The managed-laptop rows are BLOCKED_EXTERNAL until the standard enterprise Windows 11 laptop with EDR and OneDrive Files On-Demand is available.`
const LEAD_ACTION = `LEAD_ACTION: File the M2-0195 LIVE_VERIFIED and MEASURED evidence records from this bundle, then ensure every finding is a ticket or an explicit residual in the 1.9.7 release notes.

Use findings-handoff.json as the public artifact index. Do not paste private tracker paths, private finding ids, secrets, account ids, personal emails or meeting content into the public repository.`
const TYPES = new Set([
  'System.Threading.SynchronizationLockException',
  'System.ApplicationException',
  'System.IO.IOException',
  'System.UnauthorizedAccessException',
  'System.InvalidOperationException',
  'System.Management.Automation.RuntimeException',
  'System.Management.Automation.ProviderInvocationException',
  'System.Management.Automation.ActionPreferenceStopException'
])
const COMMANDS = new Set(['Set-Content', 'ConvertTo-Json', 'Write-Host', 'Write-Warning'])
const FRAME_TYPES = new Set([
  'System.Threading.Monitor',
  'System.Threading.Lock',
  'System.IO.StreamWriter',
  'System.IO.FileStream',
  'Microsoft.PowerShell.Commands.FileSystemContentReaderWriter',
  'Microsoft.PowerShell.Commands.FileSystemProvider',
  'Microsoft.PowerShell.Commands.SetContentCommand',
  'Microsoft.PowerShell.Commands.WriteContentCommandBase',
  'Microsoft.PowerShell.Commands.ContentCommandBase'
])
const FRAME_METHODS = new Set([
  'Enter',
  'Exit',
  'Wait',
  'Pulse',
  'PulseAll',
  'Write',
  'WriteLine',
  'WriteObject',
  'WriteSpan',
  'Flush',
  'FlushInternal',
  'Dispose',
  'Close',
  'CreateStreams',
  'GetContentWriter',
  'ClearContent',
  'ProcessRecord',
  'EndProcessing',
  'BeginProcessing'
])

// All data-bearing error properties remain in the child. No Message, TargetObject, source text,
// file names or raw stack traces enter the record. Node applies a second, closed output projection.
const WRAPPER = String.raw`param([string]$Target, [string]$OutDir, [string]$Kind)
$ErrorActionPreference = 'Stop'
$runtime = @{
  kind = 'runtime'
  powershell = $PSVersionTable.PSVersion.ToString()
  framework = [Runtime.InteropServices.RuntimeInformation]::FrameworkDescription
  architecture = [Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString()
}
[Console]::Out.WriteLine('METIS_BASELINE_DIAGNOSTIC:' + ($runtime | ConvertTo-Json -Compress))
try {
  if ($Kind -eq 'minimal') {
    [ordered]@{ diagnostic = 'baseline-write'; planOnly = $true } | ConvertTo-Json -Depth 5 | Set-Content -Path (Join-Path $OutDir 'control.json') -Encoding utf8
  } else {
    & $Target -OutDir $OutDir -PlanOnly -Artifact ('a' * 64)
    exit $LASTEXITCODE
  }
} catch {
  $record = $_
  $chain = @()
  $symbols = @()
  $errorObject = $record.Exception
  while ($null -ne $errorObject -and $chain.Count -lt 4) {
    $chain += @{ type = $errorObject.GetType().FullName; hresult = $errorObject.HResult }
    $frames = [Diagnostics.StackTrace]::new($errorObject, $false).GetFrames()
    foreach ($frame in $frames) {
      if ($symbols.Count -ge 12) { break }
      $method = $frame.GetMethod()
      if ($null -ne $method -and $null -ne $method.DeclaringType) {
        $symbols += @{ type = $method.DeclaringType.FullName; method = $method.Name }
      }
    }
    $errorObject = $errorObject.InnerException
  }
  $failure = @{
    kind = 'exception'
    chain = $chain
    frames = $symbols
    category = [int]$record.CategoryInfo.Category
    command = $record.InvocationInfo.MyCommand.Name
    line = $record.InvocationInfo.ScriptLineNumber
  }
  [Console]::Out.WriteLine('METIS_BASELINE_DIAGNOSTIC:' + ($failure | ConvertTo-Json -Depth 6 -Compress))
  exit 1
}
`

export function requireHostedWindows(env = process.env, platform = process.platform) {
  if (
    platform !== 'win32' ||
    env.GITHUB_ACTIONS !== 'true' ||
    env.RUNNER_OS !== 'Windows' ||
    env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
    env.GITHUB_REPOSITORY !== 'mysticalsin/AskToto-Mantu'
  ) {
    throw new Error('HOSTED_WINDOWS_REQUIRED')
  }
}

function integer(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max
}

function instrumentation(stdout, status) {
  const records = stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith(PREFIX))
    .map((line) => JSON.parse(line.slice(PREFIX.length)))
  const runtime = records[0]
  if (
    !runtime ||
    runtime.kind !== 'runtime' ||
    records.length > 2 ||
    typeof runtime.powershell !== 'string' ||
    !/^\d{1,3}\.\d{1,3}\.\d{1,5}(?:\.\d{1,5})?$/.test(runtime.powershell) ||
    typeof runtime.framework !== 'string' ||
    !/^\.NET(?: Core| Framework)? \d{1,3}(?:\.\d{1,5}){1,3}$/.test(runtime.framework) ||
    !['X64', 'X86', 'Arm64', 'Arm'].includes(runtime.architecture)
  ) {
    throw new Error('INSTRUMENTATION_INVALID')
  }
  const exception = records[1]
  if (records.length === 2 && (!exception || typeof exception !== 'object')) {
    throw new Error('INSTRUMENTATION_INVALID')
  }
  let safeException = null
  if (exception) {
    if (
      exception.kind !== 'exception' ||
      status === 0 ||
      !Array.isArray(exception.chain) ||
      exception.chain.length < 1 ||
      exception.chain.length > 4 ||
      !Array.isArray(exception.frames) ||
      exception.frames.length > 12 ||
      !integer(exception.category, 0, 100) ||
      !integer(exception.line, 0, 100_000)
    ) {
      throw new Error('INSTRUMENTATION_INVALID')
    }
    safeException = {
      category: exception.category,
      command: COMMANDS.has(exception.command) ? exception.command : 'OTHER',
      line: exception.line,
      chain: exception.chain.map((item) => {
        if (!item || !integer(item.hresult, -2147483648, 2147483647)) throw new Error('INSTRUMENTATION_INVALID')
        return { type: TYPES.has(item.type) ? item.type : 'OTHER', hresult: item.hresult }
      }),
      frames: exception.frames.map((frame) => {
        if (frame?.type === 'System.Threading.Mutex' && frame?.method === 'ReleaseMutex') {
          return 'System.Threading.Mutex.ReleaseMutex'
        }
        return FRAME_TYPES.has(frame?.type) && FRAME_METHODS.has(frame?.method)
          ? `${frame.type}.${frame.method}`
          : 'OTHER'
      })
    }
  }
  return {
    runtime: { powershell: runtime.powershell, framework: runtime.framework, architecture: runtime.architecture },
    exception: safeException
  }
}

function boundedRead(path) {
  const stat = statSync(path)
  if (!stat.isFile() || stat.size > LIMIT) throw new Error('OUTPUT_INVALID')
  return readFileSync(path, 'utf8')
}

function validateOutput(mode, outDir) {
  // This is the finite PlanOnly bundle, not a reusable schema or archive validator.
  const check = (name, predicate) => {
    try {
      return predicate(boundedRead(join(outDir, name))) === true
    } catch {
      return false // No data-bearing read or parse errors enter the public record.
    }
  }
  if (mode === 'minimal') {
    return {
      control: check('control.json', (text) => {
        const data = JSON.parse(text)
        return data.diagnostic === 'baseline-write' && data.planOnly === true && Object.keys(data).length === 2
      })
    }
  }
  return {
    baseline: check('baseline.json', (text) => {
      const data = JSON.parse(text)
      if (
        data.ticket !== 'M2-0195' ||
        data.version !== '1.9.6' ||
        data.platform !== 'win32' ||
        data.planOnly !== true ||
        !Array.isArray(data.rows) ||
        data.rows.length !== 15
      ) {
        return false
      }
      const rows = new Map(data.rows.map((row) => [row.id, row]))
      if (rows.size !== 15) return false
      const expected = [
        ...MEASURED.map((state) => ({
          id: `census-${state}`,
          state,
          artifact: `win32-${state}.json`,
          status: 'SUPPORTED_NOT_RUN'
        })),
        ...ATTACHED.map((state) => ({ id: `census-${state}`, state, status: 'BLOCKED_EXTERNAL' })),
        ...MANAGED.map((id) => ({ id, status: 'BLOCKED_EXTERNAL' }))
      ]
      return expected.every((item) => {
        const row = rows.get(item.id)
        return (
          row?.status === item.status &&
          row.state === item.state &&
          row.artifact === item.artifact &&
          (item.status === 'SUPPORTED_NOT_RUN'
            ? row.unblock === undefined
            : typeof row.unblock === 'string' && row.unblock.length > 20)
        )
      })
    }),
    environment: check('environment.json', (text) => {
      const data = JSON.parse(text)
      return (
        data.ticket === 'M2-0195' &&
        data.version === '1.9.6' &&
        data.platform === 'win32' &&
        data.artifact_sha256 === SHA &&
        data.host?.label === 'windows-latest' &&
        data.mode === 'plan-only'
      )
    }),
    externalBlockers: check('external-blockers.json', (text) => {
      const data = JSON.parse(text)
      return (
        data.ticket === 'M2-0195' &&
        Array.isArray(data.blockers) &&
        data.blockers.length === 1 &&
        data.blockers[0]?.status === 'BLOCKED_EXTERNAL' &&
        data.blockers[0]?.unblock_step === UNBLOCK
      )
    }),
    findingsHandoff: check('findings-handoff.json', (text) => {
      const data = JSON.parse(text)
      return (
        data.ticket === 'M2-0195' &&
        data.release === '1.9.7' &&
        data.rule === 'Every finding becomes a ticket or an explicit residual in the 1.9.7 release notes.' &&
        Array.isArray(data.rows) &&
        data.rows.length === 5 &&
        new Set(data.rows.map((row) => row.row)).size === 5 &&
        data.rows.every((row) => HANDOFF_ROWS.includes(row.row) && row.disposition === 'ticket-or-release-residual')
      )
    }),
    readme: check('README.md', (text) => text.replace(/\r\n/g, '\n').trimEnd() === README),
    handoff: check('M2-0195.lead-action.md', (text) => text.replace(/\r\n/g, '\n').trimEnd() === LEAD_ACTION),
    sha256sums: check('SHA256SUMS.txt', (text) => text.trimEnd() === `${SHA}  Metis-Setup-1.9.6.exe`)
  }
}

// The executable/timeout parameters exist for real missing-process and timeout tests only.
// The CLI supplies neither: it always uses pwsh and the original contract's 60-second budget.
export function observeAttempt({ mode, round, script, outDir, env, timeoutMs = 60_000, executable = 'pwsh' }) {
  if (!MODES.includes(mode) || !integer(round, 1, 3) || !integer(timeoutMs, 1, 60_000)) {
    throw new Error('ATTEMPT_INVALID')
  }
  let args = ['-NoProfile', '-File', script, '-OutDir', outDir, '-PlanOnly', '-Artifact', SHA]
  if (mode !== 'direct') {
    const wrapper = join(outDir, 'capture.ps1')
    writeFileSync(wrapper, WRAPPER, { flag: 'wx' })
    args = ['-NoProfile', '-File', wrapper, '-Target', resolve(ROOT, script), '-OutDir', outDir, '-Kind', mode]
  }
  const start = performance.now()
  const child = spawnSync(executable, args, { cwd: ROOT, env, encoding: 'utf8', timeout: timeoutMs, maxBuffer: LIMIT })
  const result = {
    mode,
    round,
    status: Number.isInteger(child.status) ? child.status : null,
    elapsedMs: Math.round(performance.now() - start),
    failure: 'NONE',
    instrumentation: mode === 'direct' ? 'NOT_CAPTURED' : 'INVALID',
    runtime: null,
    exception: null,
    outputs: validateOutput(mode, outDir),
    ok: false
  }
  if (child.error?.code === 'ETIMEDOUT') {
    result.failure = 'TIMEOUT'
  } else if (
    child.error?.code === 'ENOBUFS' ||
    Buffer.byteLength(child.stdout || '') > LIMIT ||
    Buffer.byteLength(child.stderr || '') > LIMIT
  ) {
    result.failure = 'OUTPUT_LIMIT'
  } else if (child.error || child.signal || child.status === null) {
    result.failure = 'SPAWN_ERROR'
  }
  if (mode !== 'direct' && result.failure === 'NONE') {
    try {
      Object.assign(result, instrumentation(child.stdout || '', child.status))
      result.instrumentation = 'CAPTURED'
    } catch {
      result.failure = 'INSTRUMENTATION_INVALID'
    }
  }
  if (result.failure === 'NONE' && child.status !== 0) result.failure = 'CHILD_EXIT'
  if (result.failure === 'NONE' && !Object.values(result.outputs).every(Boolean)) result.failure = 'OUTPUT_INVALID'
  result.ok = result.failure === 'NONE'
  return result
}

export function runMatrix(attempt, now = () => performance.now()) {
  const start = now()
  const report = { ok: true, stop: 'NONE', attempts: [] }
  for (let round = 1; round <= 3; round++) {
    for (const mode of MODES) {
      const remaining = 600_000 - (now() - start)
      if (remaining < 1) return { ...report, ok: false, stop: 'DEADLINE' }
      let result
      try {
        result = attempt(mode, round, Math.min(60_000, Math.floor(remaining)))
      } catch {
        return { ...report, ok: false, stop: 'HARNESS_FAILURE' }
      }
      report.attempts.push(result)
      report.ok = report.ok && result.ok
      if (now() - start >= 600_000) return { ...report, ok: false, stop: 'DEADLINE' }
    }
  }
  return report
}

function workflowIdentity(env) {
  if (
    !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA || '') ||
    !/^[1-9]\d{0,19}$/.test(env.GITHUB_RUN_ID || '') ||
    !/^[1-9]\d{0,5}$/.test(env.GITHUB_RUN_ATTEMPT || '')
  ) {
    throw new Error('WORKFLOW_IDENTITY_INVALID')
  }
  return {
    commit: env.GITHUB_SHA,
    run: env.GITHUB_RUN_ID,
    attempt: env.GITHUB_RUN_ATTEMPT,
    image: /^[a-z0-9-]{1,64}$/.test(env.ImageOS || '') ? env.ImageOS : 'OTHER',
    imageVersion: /^\d{8}\.\d{1,4}\.\d{1,4}$/.test(env.ImageVersion || '') ? env.ImageVersion : 'OTHER'
  }
}

function main() {
  let sandbox
  const report = {
    schema: 1,
    outcome: 'HARNESS_FAILURE',
    cleanup: 'NOT_CREATED',
    fullSuiteConcurrency: 'NOT_REPRODUCED',
    ok: false
  }
  try {
    requireHostedWindows()
    if (process.argv.length !== 2) throw new Error('NO_ARGUMENTS_ALLOWED')
    report.workflow = workflowIdentity(process.env)
    report.baselineSha256 = createHash('sha256').update(readFileSync(join(ROOT, BASELINE))).digest('hex')
    sandbox = createHermeticSandbox()
    const env = mergedEnv(hermeticEnv(sandbox))
    const matrix = runMatrix((mode, round, timeoutMs) => {
      const outDir = mkdtempSync(join(sandbox.tmp, 'baseline-attempt-'))
      return observeAttempt({ mode, round, script: BASELINE, outDir, env, timeoutMs })
    })
    Object.assign(report, matrix)
    report.outcome = matrix.ok ? 'NOT_REPRODUCED_IN_NINE_ATTEMPTS' : 'DIAGNOSTIC_FAILED'
  } catch {
    report.outcome = 'HARNESS_FAILURE'
    report.ok = false
  } finally {
    if (sandbox) {
      try {
        rmSync(sandbox.home, { recursive: true, force: true })
        report.cleanup = 'REMOVED'
      } catch {
        report.cleanup = 'FAILED'
        report.outcome = 'HARNESS_FAILURE'
        report.ok = false
      }
    }
  }
  const output = JSON.stringify(report)
  if (Buffer.byteLength(output) > 32 * 1024) {
    console.log('{"schema":1,"outcome":"REPORT_LIMIT"}')
    process.exitCode = 1
    return
  }
  console.log(output)
  process.exitCode = report.outcome === 'NOT_REPRODUCED_IN_NINE_ATTEMPTS' ? 0 : 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
