#!/usr/bin/env node
// Hosted macOS idle soak (M2-0492). Launches the installed promotable app on the representative Hide
// profile, keeps the display awake, proves the parked overlay, streams the long-run census, re-checks park
// coverage every 10 minutes, and judges the stream with IDLE-GROWTH-1.
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { totalmem } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { createCdpParkChecker, summarizeParkChecks } from '../census/park.mjs'
import { movePointerOffTopEdge, validateParkedIdleProfile } from '../census/run.mjs'
import { resolveInstallTarget, resolveProductVersion } from '../census/lib.mjs'
import { rulesSha256 } from './growth-rule.mjs'

export const RULE_ID = 'IDLE-GROWTH-1'
export const DEFAULT_HOURS = 5.5
export const DEFAULT_SAMPLE_INTERVAL_MS = 30_000
export const PARK_RECHECK_INTERVAL_MS = 10 * 60_000
export const MIN_PARKED_COVERAGE = 0.95
export const UPLOAD_RESERVE_MINUTES = 10
export const CDP_READY_TIMEOUT_MS = 30_000
export const CDP_READY_POLL_MS = 500
export const EXIT_CODES = Object.freeze({ PASS: 0, FAIL_OR_INCOMPLETE: 1, PRECONDITION: 2 })

const SECRET_ENV = /(_API_KEY|TOKEN|SECRET|PASSWORD|KEY)$/i

export function jobSafeDeadlineEpochMs({ jobStartedAtMs, timeoutMinutes, reserveMinutes = UPLOAD_RESERVE_MINUTES }) {
  if (!(timeoutMinutes > reserveMinutes)) throw new Error('timeoutMinutes must be greater than reserveMinutes')
  return jobStartedAtMs + (timeoutMinutes - reserveMinutes) * 60_000
}

/**
 * @param {{ hours: number, nowMs?: number, deadlineEpochMs?: number }} options
 */
export function soakSeconds({ hours, nowMs = Date.now(), deadlineEpochMs = undefined }) {
  if (!(hours > 0 && hours <= DEFAULT_HOURS)) throw new Error(`--hours must be > 0 and at most ${DEFAULT_HOURS}`)
  const requested = Math.floor(hours * 3600)
  if (deadlineEpochMs === undefined) return requested
  const remaining = Math.floor((deadlineEpochMs - nowMs) / 1000)
  return Math.max(0, Math.min(requested, remaining))
}

export function exitCodeForOutcome({ launchPrecondition = false, parkPrecondition = false, growthOutcome, parkedCoverage }) {
  if (launchPrecondition || parkPrecondition) return EXIT_CODES.PRECONDITION
  if (parkedCoverage < MIN_PARKED_COVERAGE) return EXIT_CODES.FAIL_OR_INCOMPLETE
  return growthOutcome === 'PASS' ? EXIT_CODES.PASS : EXIT_CODES.FAIL_OR_INCOMPLETE
}

export function classifySoakResult({ censusExit, growthOutcome, parkedCoverage }) {
  if (censusExit?.code === EXIT_CODES.PRECONDITION) {
    return { outcome: 'PRECONDITION', exitCode: EXIT_CODES.PRECONDITION, detail: null }
  }
  if (censusExit?.code !== 0) {
    const detail = censusExit?.signal
      ? `census terminated by ${censusExit.signal}`
      : `census exited ${censusExit?.code ?? 'unknown'}`
    return { outcome: 'INCOMPLETE', exitCode: EXIT_CODES.FAIL_OR_INCOMPLETE, detail }
  }
  if (parkedCoverage < MIN_PARKED_COVERAGE) {
    return {
      outcome: 'INCOMPLETE',
      exitCode: EXIT_CODES.FAIL_OR_INCOMPLETE,
      detail: `parked coverage ${parkedCoverage} is below ${MIN_PARKED_COVERAGE}`
    }
  }
  return {
    outcome: growthOutcome === 'PASS' ? 'PASS' : growthOutcome,
    exitCode: exitCodeForOutcome({ growthOutcome, parkedCoverage }),
    detail: null
  }
}

export function launchEnv(baseEnv, profile, { hostFloorOverride = true } = {}) {
  const env = {}
  for (const [key, value] of Object.entries(baseEnv)) {
    if (!SECRET_ENV.test(key)) env[key] = value
  }
  env.ASKTOTO_USERDATA = profile
  if (hostFloorOverride) env.METIS_QA_HOST_FLOOR_OVERRIDE = '1'
  else delete env.METIS_QA_HOST_FLOOR_OVERRIDE
  return env
}

export function summarizeModelStateFromStream(text) {
  let llamaServerRan = false
  let sidecarSupervisorRan = false
  let sampleCount = 0
  let firstT = null
  let lastT = null
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (record?.record !== 'sample') continue
    sampleCount += 1
    if (firstT === null) firstT = record.tMs
    lastT = record.tMs
    for (const process of record.processes ?? []) {
      if (process?.kind === 'llama-server') llamaServerRan = true
      if (process?.kind === 'sidecar-supervisor') sidecarSupervisorRan = true
    }
  }
  return {
    llamaServerRan,
    sidecarSupervisorRan,
    sampleCount,
    hoursMeasured: firstT === null || lastT === null ? 0 : Math.max(0, (lastT - firstT) / 3_600_000)
  }
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function flags(argv) {
  const values = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) throw new Error(`unknown argument: ${arg}`)
    values[arg.slice(2)] = argv[++i] ?? ''
  }
  return values
}

function required(values, name) {
  const value = values[name]
  if (value === undefined || value === '') throw new Error(`--${name} is required.`)
  return value
}

async function freeLoopbackPort() {
  const server = createServer()
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = server.address()
  await new Promise((resolvePromise) => server.close(resolvePromise))
  if (!address || typeof address === 'string') throw new Error('could not allocate a loopback port')
  return address.port
}

export function preconditionError(message) {
  return Object.assign(new Error(message), { exitCode: EXIT_CODES.PRECONDITION })
}

export function initialParkPreconditionError(error) {
  const message = error?.exitCode === EXIT_CODES.PRECONDITION
    ? error.message
    : `the park could not be proven at start: ${error?.message ?? error}`
  return preconditionError(message)
}

export async function waitForCdpVersion(
  cdpUrl,
  { timeoutMs = CDP_READY_TIMEOUT_MS, pollMs = CDP_READY_POLL_MS, fetchFn = globalThis.fetch, now = Date.now, sleepFn = sleep } = {}
) {
  const deadline = now() + timeoutMs
  let lastError = null
  while (now() < deadline) {
    try {
      const response = await fetchFn(`${cdpUrl}/json/version`)
      if (response?.ok) return true
      lastError = new Error(`HTTP ${response?.status ?? 'unknown'}`)
    } catch (error) {
      lastError = error
    }
    await sleepFn(Math.max(0, Math.min(pollMs, deadline - now())))
  }
  throw preconditionError(`the app did not expose Chromium DevTools at ${cdpUrl}/json/version: ${lastError?.message ?? 'timed out'}`)
}

function startCaffeinate(platform = process.platform) {
  if (platform !== 'darwin') return { recorded: false, command: 'caffeinate -d', reason: `unsupported platform ${platform}` }
  const child = spawn('/usr/bin/caffeinate', ['-d'], { stdio: 'ignore' })
  child.once('error', () => {})
  return { recorded: true, command: 'caffeinate -d', pid: child.pid ?? null, child }
}

function stopChild(child, signal = 'SIGTERM') {
  if (child && !child.killed) child.kill(signal)
}

function captureSpawnError(child) {
  let spawnError = null
  child.once('error', (error) => {
    spawnError = error
  })
  return () => spawnError
}

async function monitorPark({ checker, startedChecks, stopWhen, intervalMs = PARK_RECHECK_INTERVAL_MS }) {
  const checks = [...startedChecks]
  let next = Date.now() + intervalMs
  while (!stopWhen()) {
    const delay = Math.max(0, Math.min(next - Date.now(), 5_000))
    if (delay > 0) await sleep(delay)
    if (Date.now() < next || stopWhen()) continue
    checks.push(await checker.check())
    next += intervalMs
  }
  checks.push(await checker.check())
  return checks
}

function runNode(argv, env = process.env) {
  return spawnSync(process.execPath, argv, { env, stdio: ['ignore', 'inherit', 'pipe'], encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

function readJsonIfExists(path) {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function writeReport(path, report) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
}

function removeScenarioOwnedProfile(profile, outDir) {
  const owned = resolve(outDir, 'profile')
  if (resolve(profile) === owned) rmSync(owned, { recursive: true, force: true })
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const values = flags(argv)
  const app = required(values, 'app')
  const profile = required(values, 'profile')
  const outDir = required(values, 'out')
  const hours = Number(required(values, 'hours'))
  const deadlineEpochMs = values['deadline-epoch-ms'] ? Number(values['deadline-epoch-ms']) : undefined
  const seconds = soakSeconds({ hours, deadlineEpochMs })
  if (seconds <= 0) throw new Error('deadline leaves no time to sample')
  validateParkedIdleProfile(profile)
  const target = resolveInstallTarget(app, 'darwin')
  const productVersion = resolveProductVersion({ installRoot: target.installRoot, executable: target.executable, platform: 'darwin' })
  const output = {
    samples: join(outDir, 'idle-soak.ndjson'),
    auditCounts: join(outDir, 'audit-counts.json'),
    verdict: join(outDir, 'growth-verdict.json'),
    report: join(outDir, 'idle-soak.json')
  }
  mkdirSync(outDir, { recursive: true })

  const displayAwake = startCaffeinate('darwin')
  let appChild = null
  let checker = null
  let census = null
  let parkChecks = []
  let precondition = null
  try {
    const pointer = movePointerOffTopEdge('darwin')
    const port = await freeLoopbackPort()
    const cdpUrl = `http://127.0.0.1:${port}`
    appChild = spawn(target.executable, [`--remote-debugging-port=${port}`], {
      env: launchEnv(env, resolve(profile), { hostFloorOverride: true }),
      stdio: 'ignore'
    })
    const appSpawnError = captureSpawnError(appChild)
    await sleep(0)
    if (appSpawnError()) {
      precondition = `the app did not launch: ${appSpawnError().message}`
      throw preconditionError(precondition)
    }
    const mainPid = appChild.pid ?? null
    if (!mainPid) {
      precondition = 'the app did not launch'
      throw preconditionError(precondition)
    }

    let firstCheck
    try {
      await waitForCdpVersion(cdpUrl)
      checker = await createCdpParkChecker(cdpUrl)
      firstCheck = await checker.check()
    } catch (error) {
      const parkError = initialParkPreconditionError(error)
      precondition = parkError.message
      throw parkError
    }
    parkChecks.push(firstCheck)
    if (!firstCheck.parked) {
      precondition = 'the park could not be proven at start'
      throw preconditionError(precondition)
    }

    let censusDone = false
    const monitor = monitorPark({ checker, startedChecks: parkChecks, stopWhen: () => censusDone })
    census = spawn(
      process.execPath,
      [
        'scripts/qa/census/run.mjs',
        '--state', 'parked-idle',
        '--main-pid', String(mainPid),
        '--install-root', target.installRoot,
        '--cdp-url', cdpUrl,
        '--profile', profile,
        '--seconds', String(seconds),
        '--interval-ms', String(DEFAULT_SAMPLE_INTERVAL_MS),
        '--ndjson', output.samples,
        '--audit-counts', output.auditCounts,
        '--checkpoint-minutes', '10'
      ],
      { stdio: ['ignore', 'inherit', 'pipe'], env }
    )
    let censusStderr = ''
    census.once('error', (error) => {
      censusStderr += `${error.message}\n`
    })
    census.stderr.on('data', (chunk) => {
      censusStderr += chunk.toString()
      process.stderr.write(chunk)
    })
    const censusExit = await new Promise((resolvePromise) => census.on('exit', (code, signal) => resolvePromise({ code, signal })))
    censusDone = true
    parkChecks = await monitor

    const growth = runNode([
      'scripts/qa/soak/growth.mjs',
      '--samples', output.samples,
      '--audit-counts', output.auditCounts,
      '--rule', RULE_ID,
      '--out', output.verdict
    ])
    process.stderr.write(growth.stderr ?? '')

    const verdict = readJsonIfExists(output.verdict)
    const streamText = existsSync(output.samples) ? readFileSync(output.samples, 'utf8') : ''
    const modelState = summarizeModelStateFromStream(streamText)
    const parkSummary = summarizeParkChecks(parkChecks)
    const parkedCoverage = parkSummary.parkedCoverage
    const growthOutcome = verdict?.outcome ?? 'INCOMPLETE'
    const result = classifySoakResult({ censusExit, growthOutcome, parkedCoverage })
    writeReport(output.report, {
      schema: 'idle-soak/1',
      scenario: 'idle-soak',
      rule: { id: RULE_ID, rulesSha256: rulesSha256() },
      outcome: result.outcome,
      productVersion,
      requestedHours: hours,
      secondsPlanned: seconds,
      hoursMeasured: modelState.hoursMeasured,
      parkedCoverage,
      park: {
        pointerMovedOffTopEdge: pointer,
        checks: parkChecks,
        summary: parkSummary
      },
      displayAwake: { recorded: displayAwake.recorded, command: displayAwake.command, pid: displayAwake.pid ?? null },
      hostFloorOverride: true,
      hostMemory: { totalBytes: totalmem() },
      modelState: {
        llamaServerRan: modelState.llamaServerRan,
        sidecarSupervisorRan: modelState.sidecarSupervisorRan,
        note: modelState.llamaServerRan ? 'llama-server ran during the leg' : 'llama-server never ran during the leg; the growth rule was still judged'
      },
      artifacts: {
        samples: existsSync(output.samples) ? { file: basename(output.samples), sha256: sha256File(output.samples) } : null,
        auditCounts: existsSync(output.auditCounts) ? { file: basename(output.auditCounts), sha256: sha256File(output.auditCounts) } : null,
        verdict: existsSync(output.verdict) ? { file: basename(output.verdict), sha256: sha256File(output.verdict) } : null
      },
      censusExit,
      growthExit: { code: growth.status, signal: growth.signal },
      detail: result.outcome === 'PASS'
        ? null
        : precondition ?? result.detail ?? verdict?.failed?.join(', ') ?? censusStderr.trim().split(/\r?\n/).at(-1) ?? null
    })
    removeScenarioOwnedProfile(profile, outDir)
    return result.exitCode
  } catch (error) {
    const exitCode = error?.exitCode === EXIT_CODES.PRECONDITION ? EXIT_CODES.PRECONDITION : EXIT_CODES.FAIL_OR_INCOMPLETE
    writeReport(output.report, {
      schema: 'idle-soak/1',
      scenario: 'idle-soak',
      rule: { id: RULE_ID, rulesSha256: rulesSha256() },
      outcome: exitCode === EXIT_CODES.PRECONDITION ? 'PRECONDITION' : 'INCOMPLETE',
      requestedHours: hours,
      secondsPlanned: seconds,
      hoursMeasured: 0,
      parkedCoverage: summarizeParkChecks(parkChecks).parkedCoverage,
      displayAwake: { recorded: displayAwake.recorded, command: displayAwake.command, pid: displayAwake.pid ?? null },
      hostFloorOverride: true,
      hostMemory: { totalBytes: totalmem() },
      modelState: { llamaServerRan: false, sidecarSupervisorRan: false, note: 'llama-server never ran during the leg; the growth rule was still judged if samples existed' },
      detail: error?.message ?? String(error)
    })
    return exitCode
  } finally {
    stopChild(census, 'SIGTERM')
    await checker?.close()
    stopChild(appChild, 'SIGTERM')
    stopChild(displayAwake.child, 'SIGTERM')
    removeScenarioOwnedProfile(values.profile, values.out)
  }
}

export { main }

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then((code) => {
    process.exitCode = code
  }).catch((error) => {
    console.error(`[idle-soak] ${error?.message ?? error}`)
    process.exitCode = EXIT_CODES.FAIL_OR_INCOMPLETE
  })
}
