import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  existsSync
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { hermeticEnv, mergedEnv } from '../../hermetic/sandbox-env.mjs'
import { observeAttempt, runMatrix, requireHostedWindows } from './diagnose-baseline-write.mjs'

const MARKER = 'PRIVATE_DIAGNOSTIC_MARKER'
const workflow = readFileSync(
  new URL('../../../.github/workflows/windows-baseline-diagnostic.yml', import.meta.url),
  'utf8'
)
requireHostedWindows()

function fixture(body) {
  const home = mkdtempSync(join(tmpdir(), 'baseline-diagnostic-test-'))
  const tmp = join(home, 'tmp')
  mkdirSync(tmp)
  const script = join(home, 'fixture.ps1')
  writeFileSync(script, `param([string]$OutDir, [switch]$PlanOnly, [string]$Artifact)\n${body}\n`)
  return {
    home,
    tmp,
    script,
    env: mergedEnv(hermeticEnv({ home, tmp })),
    run(mode = 'instrumented', timeoutMs = 60_000) {
      const outDir = mkdtempSync(join(tmp, 'attempt-'))
      return { outDir, result: observeAttempt({ mode, round: 1, script, outDir, env: this.env, timeoutMs }) }
    },
    cleanup() {
      rmSync(home, { recursive: true, force: true })
      assert.equal(existsSync(home), false)
    }
  }
}

// Independent complete producer-shaped fixture: do not import the diagnostic's expected-row table.
function bundleFixture(change = () => {}) {
  const rows = ['cold-start', 'settled-idle'].map((state) => ({
    id: `census-${state}`,
    state,
    status: 'SUPPORTED_NOT_RUN',
    artifact: `win32-${state}.json`
  }))
  const unblock = 'Establish this synthetic precondition before collecting the corresponding evidence.'
  for (const state of ['first-inference', 'active-transcription', 'post-meeting', 'post-recovery']) {
    rows.push({ id: `census-${state}`, state, status: 'BLOCKED_EXTERNAL', unblock })
  }
  for (const id of [
    'managed-install-policy',
    'managed-edr-overhead',
    'managed-proxy-network',
    'managed-cloud-folder',
    'st-1-w-onedrive-placeholders-network-off',
    'hk-w-end-task-owned-sidecars',
    'managed-resource-census-representative',
    'managed-foreground-watcher-cost',
    'managed-edr-interaction'
  ]) {
    rows.push({ id, status: 'BLOCKED_EXTERNAL', unblock })
  }
  const handoffRows = [
    'st-1-w-onedrive-placeholders-network-off',
    'hk-w-end-task-owned-sidecars',
    'managed-resource-census-representative',
    'managed-foreground-watcher-cost',
    'managed-edr-interaction'
  ].map((row) => ({ row, disposition: 'ticket-or-release-residual' }))
  const files = {
    'baseline.json': JSON.stringify({ ticket: 'M2-0195', version: '1.9.6', platform: 'win32', planOnly: true, rows }),
    'environment.json': JSON.stringify({
      ticket: 'M2-0195',
      version: '1.9.6',
      platform: 'win32',
      mode: 'plan-only',
      host: { label: 'windows-latest' },
      artifact_sha256: 'a'.repeat(64)
    }),
    'external-blockers.json': JSON.stringify({
      ticket: 'M2-0195',
      blockers: [
        {
          status: 'BLOCKED_EXTERNAL',
          unblock_step:
            'Mantu IT: provide one managed Windows 11 x64 laptop on the standard enterprise image with EDR as deployed and OneDrive Files On-Demand enabled, with remote access for the QA runner.'
        }
      ]
    }),
    'findings-handoff.json': JSON.stringify({
      ticket: 'M2-0195',
      release: '1.9.7',
      rule: 'Every finding becomes a ticket or an explicit residual in the 1.9.7 release notes.',
      rows: handoffRows
    }),
    'README.md':
      '# M2-0195 Windows 1.9.6 baseline\n\nContent-free artifact bundle for the hosted Windows 1.9.6 baseline. The managed-laptop rows are BLOCKED_EXTERNAL until the standard enterprise Windows 11 laptop with EDR and OneDrive Files On-Demand is available.',
    'M2-0195.lead-action.md':
      'LEAD_ACTION: File the M2-0195 LIVE_VERIFIED and MEASURED evidence records from this bundle, then ensure every finding is a ticket or an explicit residual in the 1.9.7 release notes.\n\nUse findings-handoff.json as the public artifact index. Do not paste private tracker paths, private finding ids, secrets, account ids, personal emails or meeting content into the public repository.',
    'SHA256SUMS.txt': `${'a'.repeat(64)}  Metis-Setup-1.9.6.exe`
  }
  change(files)
  const encoded = Buffer.from(JSON.stringify(files)).toString('base64')
  const f = fixture(`
$files = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json -AsHashtable
foreach ($name in $files.Keys) { [IO.File]::WriteAllText((Join-Path $OutDir $name), $files[$name]) }
exit 0`)
  return { ...f, files }
}

test('runs exactly three rounds and cannot erase an earlier failure', () => {
  const calls = []
  const report = runMatrix((mode, round) => {
    calls.push([mode, round])
    return { mode, round, ok: calls.length !== 2 }
  })
  assert.deepEqual(calls, [
    ['direct', 1],
    ['instrumented', 1],
    ['minimal', 1],
    ['direct', 2],
    ['instrumented', 2],
    ['minimal', 2],
    ['direct', 3],
    ['instrumented', 3],
    ['minimal', 3]
  ])
  assert.equal(report.attempts.length, 9)
  assert.equal(report.ok, false)
  assert.equal(report.stop, 'NONE')
  assert.equal(runMatrix((mode, round) => ({ mode, round, ok: true })).ok, true)
})

test('the aggregate deadline stops unscheduled attempts without a success verdict', () => {
  let time = 0
  const report = runMatrix(
    (mode, round) => {
      time = 600_001
      return { mode, round, ok: true }
    },
    () => time
  )
  assert.equal(report.attempts.length, 1)
  assert.equal(report.stop, 'DEADLINE')
  assert.equal(report.ok, false)
})

test('a harness exception retains completed observations and is not printed', () => {
  let calls = 0
  const report = runMatrix((mode, round) => {
    if (++calls === 2) throw new Error(MARKER)
    return { mode, round, ok: false }
  })
  assert.equal(report.attempts.length, 1)
  assert.equal(report.stop, 'HARNESS_FAILURE')
  assert.equal(report.ok, false)
  assert.equal(JSON.stringify(report).includes(MARKER), false)
})

test('runtime admission rejects non-hosted, wrong-repository and non-Windows execution', () => {
  const env = {
    GITHUB_ACTIONS: 'true',
    RUNNER_ENVIRONMENT: 'github-hosted',
    RUNNER_OS: 'Windows',
    GITHUB_REPOSITORY: 'mysticalsin/AskToto-Mantu'
  }
  assert.doesNotThrow(() => requireHostedWindows(env, 'win32'))
  for (const key of Object.keys(env)) {
    assert.throws(() => requireHostedWindows({ ...env, [key]: MARKER }, 'win32'), /HOSTED_WINDOWS_REQUIRED/)
  }
  assert.throws(() => requireHostedWindows(env, 'darwin'), /HOSTED_WINDOWS_REQUIRED/)
})

test('real PowerShell exception preserves type and HRESULT but not private output', () => {
  const f = fixture(`
[IO.File]::WriteAllText((Join-Path $OutDir 'started'), 'yes')
Write-Host '${MARKER}'
Write-Warning '${MARKER}'
[Console]::Error.WriteLine('${MARKER}')
throw [System.Threading.SynchronizationLockException]::new('${MARKER}')`)
  try {
    const { outDir, result } = f.run()
    assert.equal(readFileSync(join(outDir, 'started'), 'utf8'), 'yes')
    assert.equal(result.ok, false)
    assert.equal(result.status, 1)
    assert.equal(result.instrumentation, 'CAPTURED')
    assert.ok(
      result.exception.chain.some(
        (item) => item.type === 'System.Threading.SynchronizationLockException' && item.hresult === -2146233064
      )
    )
    assert.ok(result.runtime.powershell.match(/^\d+\.\d+/))
    const publicJson = JSON.stringify(result)
    assert.equal(publicJson.includes(MARKER), false)
    assert.equal(publicJson.includes(f.home), false)
    assert.equal(publicJson.includes('fixture.ps1'), false)
  } finally {
    f.cleanup()
  }
})

test('explicit PowerShell exit stays a nonexception failure; direct output stays private', () => {
  const f = fixture(`[IO.File]::WriteAllText((Join-Path $OutDir 'started'), 'yes')\nWrite-Host '${MARKER}'\nexit 7`)
  try {
    for (const mode of ['direct', 'instrumented']) {
      const { outDir, result } = f.run(mode)
      assert.equal(readFileSync(join(outDir, 'started'), 'utf8'), 'yes')
      assert.equal(result.status, 7)
      assert.equal(result.ok, false)
      assert.equal(result.exception, null)
      assert.equal(JSON.stringify(result).includes(MARKER), false)
      assert.equal(result.instrumentation, mode === 'direct' ? 'NOT_CAPTURED' : 'CAPTURED')
    }
  } finally {
    f.cleanup()
  }
})

test('a real ApplicationException remains distinguishable without printing its message', () => {
  const f = fixture(`throw [System.ApplicationException]::new('${MARKER}')`)
  try {
    const { result } = f.run()
    assert.equal(result.status, 1)
    assert.equal(result.instrumentation, 'CAPTURED')
    assert.ok(result.exception.chain.some((item) => item.type === 'System.ApplicationException'))
    assert.equal(JSON.stringify(result).includes(MARKER), false)
  } finally {
    f.cleanup()
  }
})

test('a real timed-out PowerShell process is gone before its owned fixture is cleaned', () => {
  const f = fixture(`
[IO.File]::WriteAllText((Join-Path $OutDir 'pid'), [string]$PID)
Start-Sleep -Seconds 30
[IO.File]::WriteAllText((Join-Path $OutDir 'finished'), 'unexpected')`)
  try {
    const { outDir, result } = f.run('instrumented', 5_000)
    const pid = Number(readFileSync(join(outDir, 'pid'), 'utf8'))
    assert.ok(Number.isInteger(pid) && pid > 0)
    assert.equal(result.failure, 'TIMEOUT')
    assert.equal(result.ok, false)
    assert.equal(existsSync(join(outDir, 'finished')), false)
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  } finally {
    f.cleanup()
  }
})

test('real output overflow is bounded and never copied into the public result', () => {
  const f = fixture(`
$payload = '${MARKER}' * 20000
$bytes = [Text.Encoding]::UTF8.GetByteCount($payload)
[IO.File]::WriteAllText((Join-Path $OutDir 'payload-bytes'), [string]$bytes)
[Console]::Out.Write($payload)
exit 0`)
  try {
    const { outDir, result } = f.run()
    const payloadBytes = Number(readFileSync(join(outDir, 'payload-bytes'), 'utf8'))
    assert.equal(payloadBytes, Buffer.byteLength(MARKER.repeat(20_000)))
    assert.equal(result.failure, 'OUTPUT_LIMIT')
    assert.equal(result.ok, false)
    assert.equal(JSON.stringify(result).includes(MARKER), false)
  } finally {
    f.cleanup()
  }
})

test('a missing executable is classified without exposing its path', () => {
  const f = fixture('exit 0')
  try {
    const outDir = mkdtempSync(join(f.home, 'attempt-'))
    const result = observeAttempt({
      mode: 'direct',
      round: 1,
      script: f.script,
      outDir,
      env: f.env,
      executable: join(f.home, MARKER)
    })
    assert.equal(result.failure, 'SPAWN_ERROR')
    assert.equal(result.ok, false)
    assert.equal(JSON.stringify(result).includes(MARKER), false)
  } finally {
    f.cleanup()
  }
})

test('a real minimal write produces valid JSON; an empty successful baseline does not pass', () => {
  const f = fixture('exit 0')
  try {
    const minimal = f.run('minimal')
    assert.deepEqual(JSON.parse(readFileSync(join(minimal.outDir, 'control.json'), 'utf8')), {
      diagnostic: 'baseline-write',
      planOnly: true
    })
    assert.equal(minimal.result.ok, true)
    const empty = f.run()
    assert.equal(empty.result.status, 0)
    assert.equal(empty.result.ok, false)
    assert.equal(empty.result.failure, 'OUTPUT_INVALID')
  } finally {
    f.cleanup()
  }
})

test('corrupt baseline JSON fails despite valid runtime instrumentation and a zero exit', () => {
  const f = bundleFixture((files) => {
    files['baseline.json'] = MARKER
  })
  try {
    const { outDir, result } = f.run()
    assert.equal(readFileSync(join(outDir, 'baseline.json'), 'utf8'), MARKER)
    assert.equal(result.status, 0)
    assert.equal(result.instrumentation, 'CAPTURED')
    assert.equal(result.failure, 'OUTPUT_INVALID')
    assert.equal(result.outputs.baseline, false)
    assert.equal(Object.values(result.outputs).filter((valid) => !valid).length, 1)
    assert.equal(JSON.stringify(result).includes(MARKER), false)
  } finally {
    f.cleanup()
  }
})

test('valid synthetic baseline outputs pass independently of the real baseline script', () => {
  const f = bundleFixture()
  try {
    const { outDir, result } = f.run()
    for (const [name, content] of Object.entries(f.files)) {
      assert.equal(readFileSync(join(outDir, name), 'utf8') === content, true)
    }
    assert.equal(JSON.parse(readFileSync(join(outDir, 'baseline.json'), 'utf8')).rows.length, 15)
    assert.equal(JSON.parse(readFileSync(join(outDir, 'environment.json'), 'utf8')).artifact_sha256, 'a'.repeat(64))
    assert.deepEqual(result.outputs, {
      baseline: true,
      environment: true,
      externalBlockers: true,
      findingsHandoff: true,
      readme: true,
      handoff: true,
      sha256sums: true
    })
    assert.equal(result.ok, true)
  } finally {
    f.cleanup()
  }
})

test('each independently missing bundle file fails after a successful instrumented child', () => {
  for (const name of [
    'baseline.json',
    'environment.json',
    'external-blockers.json',
    'findings-handoff.json',
    'README.md',
    'M2-0195.lead-action.md',
    'SHA256SUMS.txt'
  ]) {
    const f = bundleFixture((files) => {
      delete files[name]
    })
    try {
      const { outDir, result } = f.run()
      assert.equal(existsSync(join(outDir, name)), false)
      assert.equal(result.status, 0)
      assert.equal(result.instrumentation, 'CAPTURED')
      assert.equal(result.failure, 'OUTPUT_INVALID')
      assert.equal(Object.values(result.outputs).filter((valid) => !valid).length, 1)
    } finally {
      f.cleanup()
    }
  }
})

test('duplicate IDs and wrong state, artifact or status cannot masquerade as fifteen valid rows', () => {
  for (const [field, value] of [
    ['id', 'census-settled-idle'],
    ['state', 'settled-idle'],
    ['artifact', 'wrong.json'],
    ['status', 'BLOCKED_EXTERNAL']
  ]) {
    const f = bundleFixture((files) => {
      const data = JSON.parse(files['baseline.json'])
      data.rows[0][field] = value
      files['baseline.json'] = JSON.stringify(data)
    })
    try {
      const { outDir, result } = f.run()
      assert.equal(JSON.parse(readFileSync(join(outDir, 'baseline.json'), 'utf8')).rows[0][field], value)
      assert.equal(result.status, 0)
      assert.equal(result.instrumentation, 'CAPTURED')
      assert.equal(result.failure, 'OUTPUT_INVALID')
      assert.equal(Object.values(result.outputs).filter((valid) => !valid).length, 1)
    } finally {
      f.cleanup()
    }
  }
})

test('wrong environment version, platform or artifact hash fails independently of valid row data', () => {
  for (const field of ['version', 'platform', 'artifact_sha256']) {
    const f = bundleFixture((files) => {
      const data = JSON.parse(files['environment.json'])
      data[field] = MARKER
      files['environment.json'] = JSON.stringify(data)
    })
    try {
      const { outDir, result } = f.run()
      assert.equal(JSON.parse(readFileSync(join(outDir, 'environment.json'), 'utf8'))[field], MARKER)
      assert.equal(result.status, 0)
      assert.equal(result.instrumentation, 'CAPTURED')
      assert.equal(result.failure, 'OUTPUT_INVALID')
      assert.equal(result.outputs.environment, false)
      assert.equal(Object.values(result.outputs).filter((valid) => !valid).length, 1)
      assert.equal(JSON.stringify(result).includes(MARKER), false)
    } finally {
      f.cleanup()
    }
  }
})

test('incorrect blocker, duplicated handoff row and wrong SHA text each invalidate only that bundle member', () => {
  for (const name of ['external-blockers.json', 'findings-handoff.json', 'SHA256SUMS.txt']) {
    const f = bundleFixture((files) => {
      if (name === 'SHA256SUMS.txt') files[name] = `${'b'.repeat(64)}  Metis-Setup-1.9.6.exe`
      else {
        const data = JSON.parse(files[name])
        if (name === 'external-blockers.json') data.blockers[0].status = 'MEASURED'
        else data.rows[0] = data.rows[1]
        files[name] = JSON.stringify(data)
      }
    })
    try {
      const { outDir, result } = f.run()
      assert.equal(readFileSync(join(outDir, name), 'utf8') === f.files[name], true)
      assert.equal(result.status, 0)
      assert.equal(result.instrumentation, 'CAPTURED')
      assert.equal(result.failure, 'OUTPUT_INVALID')
      assert.equal(Object.values(result.outputs).filter((valid) => !valid).length, 1)
    } finally {
      f.cleanup()
    }
  }
})

test('malformed and missing instrumentation fail closed without exposing raw child output', () => {
  const f = fixture(`
[Console]::Out.WriteLine('METIS_BASELINE_DIAGNOSTIC:{broken-${MARKER}')
exit 0`)
  try {
    const { result } = f.run()
    assert.equal(result.ok, false)
    assert.equal(result.failure, 'INSTRUMENTATION_INVALID')
    assert.equal(JSON.stringify(result).includes(MARKER), false)
    const missing = observeAttempt({
      mode: 'instrumented',
      round: 1,
      script: f.script,
      outDir: mkdtempSync(join(f.tmp, 'missing-')),
      env: f.env,
      executable: process.execPath // Real process: rejects the PowerShell arguments before any wrapper record.
    })
    assert.equal(missing.ok, false)
    assert.equal(missing.failure, 'INSTRUMENTATION_INVALID')
    assert.equal(JSON.stringify(missing).includes(f.home), false)
  } finally {
    f.cleanup()
  }
})

test('the real CLI retains six synthetic failures, reports nine attempts and removes its own sandbox', () => {
  const f = fixture(`Write-Host '${MARKER}'\nexit 7`)
  try {
    const scripts = join(f.home, 'repository', 'scripts')
    const windows = join(scripts, 'qa', 'windows')
    const helpers = join(scripts, 'hermetic')
    mkdirSync(windows, { recursive: true })
    mkdirSync(helpers)
    const cli = join(windows, 'diagnose-baseline-write.mjs')
    copyFileSync(new URL('./diagnose-baseline-write.mjs', import.meta.url), cli)
    copyFileSync(new URL('../../hermetic/sandbox-env.mjs', import.meta.url), join(helpers, 'sandbox-env.mjs'))
    copyFileSync(f.script, join(windows, 'baseline.ps1'))
    const child = spawnSync(process.execPath, [cli], {
      env: f.env,
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 64 * 1024
    })
    assert.equal(child.error === undefined, true)
    assert.equal(child.status, 1)
    assert.equal(child.stderr === '', true)
    assert.equal(child.stdout.includes(MARKER), false)
    assert.equal(child.stdout.includes(f.home), false)
    const report = JSON.parse(child.stdout)
    assert.equal(report.outcome, 'DIAGNOSTIC_FAILED')
    assert.equal(report.attempts.length, 9)
    assert.equal(report.attempts.filter((attempt) => attempt.ok).length, 3)
    assert.equal(report.attempts.filter((attempt) => attempt.status === 7).length, 6)
    assert.equal(report.cleanup, 'REMOVED')
    assert.deepEqual(readdirSync(f.tmp), [])
  } finally {
    f.cleanup()
  }
})

test('workflow is one branch-only, credential-free hosted diagnostic job', () => {
  assert.match(workflow, /\non:\n  push:\n    branches: \[fix\/windows-baseline-diagnostic-20261008\]\n\npermissions:/)
  assert.equal([...workflow.slice(workflow.indexOf('\njobs:')).matchAll(/^ {2}[\w-]+:$/gm)].length, 1)
  assert.match(workflow, /runs-on: windows-latest/)
  assert.match(workflow, /timeout-minutes: 15/)
  assert.match(workflow, /contents: read/)
  assert.match(workflow, /persist-credentials: false/)
  assert.match(workflow, /actions\/checkout@11d5960a326750d5838078e36cf38b85af677262/)
  assert.match(workflow, /actions\/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020/)
  assert.match(workflow, /node-version: 22\.22\.3/)
  assert.match(workflow, /node --test scripts\/qa\/windows\/diagnose-baseline-write\.test\.mjs/)
  assert.match(workflow, /node scripts\/qa\/windows\/diagnose-baseline-write\.mjs/)
  assert.doesNotMatch(
    workflow,
    /workflow_dispatch:|pull_request:|self-hosted|secrets\.|upload-artifact|continue-on-error|npm /
  )
})
