#!/usr/bin/env node
/**
 * Candidate Windows proof for M2-0559. Runs an installed promotable Metis.exe on a fresh
 * ASKTOTO_USERDATA profile with background screen context enabled, proves the app reports ready while
 * capture works, then induces capture failure by locking the Windows workstation. The induction is OS
 * state only: no app hook, no src/ change, and no settings write after induction.
 *
 * Method: windows-lock-workstation (user32!LockWorkStation). The probe records only success/failure and
 * never writes or uploads a frame.
 *
 * Usage:
 *   node scripts/qa/capture-gate.mjs <installed Metis.exe> <report.json> --max-bg-failures <n>
 *
 * Exit 0 PASS · 1 FAIL · 2 PRECONDITION.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { CAPTURE_BACKOFF_CONSTANTS, MAX_BG_FAILURES, readCaptureBackoffConstants } from './lib/capture-backoff-constants.mjs'
import { LOCAL_LLM_SETTINGS } from './lib/local-llm-settings.mjs'
import { attach, findPage, freeLoopbackPort, waitForChildExit } from './lib/app-driver.mjs'
import { launchEnv } from './sidecar-boot-reaper.mjs'

export { CAPTURE_BACKOFF_CONSTANTS, MAX_BG_FAILURES, readCaptureBackoffConstants }

export const INDUCTION_METHOD = 'windows-lock-workstation'
export const PARK_MS = 30 * 60_000
export const FINAL_TAIL_MS = 15 * 60_000
export const READY_TIMEOUT_MS = 180_000
export const PROBE_SETTLE_MS = 2_000
export const POLL_MS = 1_000
export const REPORT_SCHEMA = 1

const FIXED_PRECONDITION_REASONS = Object.freeze(['readiness_unproven', 'failing_state_unproven', 'candidate_liveness_unproven', 'audit_unproven'])
const FIXED_FAILURE_REASONS = Object.freeze(['bg_screen_failed_total', 'bg_screen_failed_final_tail', 'candidate_exited'])
const CAPTURE_OK = 'METIS_CAPTURE_OK'
const CAPTURE_UNAVAILABLE = 'METIS_CAPTURE_UNAVAILABLE'
const CAPTURE_UNAVAILABLE_EXIT = 10

class Precondition extends Error {}
class Failure extends Error {}

export function exitCodeForOutcome(outcome) {
  if (outcome === 'PASS') return 0
  if (outcome === 'PRECONDITION') return 2
  return 1
}

function parseArgs(argv) {
  const args = { maxBgFailures: null }
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--max-bg-failures') args.maxBgFailures = Number(argv[++i])
    else if (arg.startsWith('--')) throw new Precondition(`Unknown argument: ${arg}`)
    else positional.push(arg)
  }
  if (positional.length !== 2 || !Number.isInteger(args.maxBgFailures) || args.maxBgFailures < 0) {
    throw new Precondition('Usage: capture-gate.mjs <installed Metis.exe> <report.json> --max-bg-failures <n>')
  }
  args.app = positional[0]
  args.report = positional[1]
  return args
}

function iso(ms) {
  return new Date(ms).toISOString()
}

function recordMs(record) {
  const ms = Date.parse(String(record?.ts ?? ''))
  return Number.isFinite(ms) ? ms : null
}

export function bgScreenCaptureFailed(records) {
  return records.filter((record) => record?.event === 'capture.failed' && record?.phase === 'bg-screen')
}

function suspendedSummary(records) {
  const rows = records.filter((record) => record?.event === 'screen.preprocess.suspended')
  return {
    count: rows.length,
    latched: rows.some((record) => record?.latched === true),
    reasons: [...new Set(rows.map((record) => (record?.reason === 'permission' || record?.reason === 'error' ? record.reason : 'other')))].sort()
  }
}

function proofReady(proof) {
  return proof?.observed === true && proof?.backgroundScreenReady === true && proof?.localReady === true
}

function failingStateProved(proof) {
  return (
    proof?.method === INDUCTION_METHOD &&
    proof?.inductionStarted === true &&
    proof?.beforeInduction?.captureWorks === true &&
    proof?.beforeInduction?.category === 'ok' &&
    proof?.afterInduction?.captureWorks === false &&
    proof?.afterInduction?.category === 'capture_unavailable' &&
    proof?.afterPark?.captureWorks === false &&
    proof?.afterPark?.category === 'capture_unavailable'
  )
}

function candidateParkProved(proof, parkMs) {
  return (
    proof?.observed === true &&
    proof?.aliveAtInduction === true &&
    proof?.aliveAfterPark === true &&
    proof?.exitObserved === false &&
    proof?.exitedBeforeParkComplete === false &&
    proof?.processErrorObserved === false &&
    Number.isFinite(proof?.parkElapsedMs) &&
    proof.parkElapsedMs >= Math.max(PARK_MS, parkMs)
  )
}

function auditMetadataValid(record) {
  const atMs = recordMs(record)
  return record !== null && typeof record === 'object' && !Array.isArray(record) &&
    typeof record.event === 'string' && record.event.length > 0 && typeof record.ts === 'string' &&
    atMs !== null && new Date(atMs).toISOString() === record.ts
}

function auditMeasurementProved(proof, records) {
  const flags = ['observed', 'baselineComplete', 'baselineValid', 'finalComplete', 'finalValid', 'freshProfile',
    'startupAnchored', 'readinessAnchored', 'baselineRetained', 'lengthNondecreasing', 'parkCovered']
  return flags.every((key) => proof?.[key] === true) &&
    Number.isSafeInteger(proof?.baselineRecordCount) && proof.baselineRecordCount >= 2 &&
    Number.isSafeInteger(proof?.finalRecordCount) && proof.finalRecordCount >= proof.baselineRecordCount &&
    proof.finalRecordCount === records.length && records.every(auditMetadataValid)
}

function unmeasuredVerdict(records, reason, outcome = 'PRECONDITION') {
  return {
    outcome,
    reasons: [reason],
    bgScreenCaptureFailedTotal: 0,
    bgScreenCaptureFailedFinal15Minutes: 0,
    screenPreprocessSuspended: suspendedSummary(records)
  }
}

export function captureGateVerdict({
  records,
  inductionAtMs,
  readinessProof,
  failingStateProof,
  maxBgFailures,
  parkMs = PARK_MS,
  finalTailMs = FINAL_TAIL_MS
}) {
  if (!proofReady(readinessProof)) return unmeasuredVerdict(records, 'readiness_unproven')
  const candidateProof = failingStateProof?.candidateLivenessProof
  if (candidateProof?.exitObserved === true) return unmeasuredVerdict(records, 'candidate_exited', 'FAIL')
  if (!failingStateProved(failingStateProof)) {
    return unmeasuredVerdict(records, 'failing_state_unproven')
  }
  if (!candidateParkProved(candidateProof, parkMs)) {
    return unmeasuredVerdict(records, 'candidate_liveness_unproven')
  }
  if (!auditMeasurementProved(failingStateProof?.auditProof, records)) {
    return unmeasuredVerdict(records, 'audit_unproven')
  }

  const finalTailStartMs = inductionAtMs + parkMs - finalTailMs
  const bgFailures = bgScreenCaptureFailed(records).filter((record) => {
    const ms = recordMs(record)
    return ms !== null && ms >= inductionAtMs
  })
  const finalTail = bgFailures.filter((record) => {
    const ms = recordMs(record)
    return ms !== null && ms >= finalTailStartMs
  })
  const reasons = []
  if (bgFailures.length > maxBgFailures) reasons.push('bg_screen_failed_total')
  if (finalTail.length > 0) reasons.push('bg_screen_failed_final_tail')
  return {
    outcome: reasons.length ? 'FAIL' : 'PASS',
    reasons,
    bgScreenCaptureFailedTotal: bgFailures.length,
    bgScreenCaptureFailedFinal15Minutes: finalTail.length,
    screenPreprocessSuspended: suspendedSummary(records)
  }
}

export function buildReport({
  records = [],
  readinessProof,
  failingStateProof,
  inductionAtMs,
  maxBgFailures,
  backgroundScreenReadyAfterPark = null,
  parkMs = PARK_MS,
  finalTailMs = FINAL_TAIL_MS
}) {
  const judged = captureGateVerdict({ records, inductionAtMs, readinessProof, failingStateProof, maxBgFailures, parkMs, finalTailMs })
  const reasonAllowlist = judged.outcome === 'PRECONDITION' ? FIXED_PRECONDITION_REASONS : FIXED_FAILURE_REASONS
  const reasons = judged.reasons.filter((reason) => reasonAllowlist.includes(reason))
  return {
    schema: REPORT_SCHEMA,
    ticket: 'M2-0559',
    outcome: judged.outcome,
    reasons,
    inductionMethod: INDUCTION_METHOD,
    maxBgScreenCaptureFailed: maxBgFailures,
    parkMs,
    finalTailMs,
    inductionAt: iso(inductionAtMs),
    readinessProof,
    failingStateProof,
    candidateLivenessProof: failingStateProof?.candidateLivenessProof ?? null,
    bgScreenCaptureFailedTotal: judged.bgScreenCaptureFailedTotal,
    bgScreenCaptureFailedFinal15Minutes: judged.bgScreenCaptureFailedFinal15Minutes,
    screenPreprocessSuspended: judged.screenPreprocessSuspended,
    backgroundScreenReadyAfterPark
  }
}

function seedProfile(profile) {
  mkdirSync(profile, { recursive: true, mode: 0o700 })
  const settings = {
    ...LOCAL_LLM_SETTINGS,
    onboardingDone: true,
    onboardingDoneAt: Date.now(),
    overlayLayout: 'bar',
    autoHideOverlay: false,
    backgroundScreenContext: true
  }
  writeFileSync(join(profile, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
}

export function runPowerShell(script, timeoutMs = 20_000, spawnProcess = spawnSync, captureResult = false) {
  const child = spawnProcess('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  if (child.error) return { ok: false, category: child.error.code === 'ETIMEDOUT' ? 'timeout' : 'process_error' }
  if (child.signal || !Number.isInteger(child.status)) return { ok: false, category: 'process_error' }
  if (captureResult) {
    // Only the completed CopyFromScreen branch emits this status/result pair; setup errors are unknown.
    const result = typeof child.stdout === 'string' ? child.stdout.trim() : null
    if (child.status === 0 && result === CAPTURE_OK) return { ok: true, category: 'ok' }
    if (child.status === CAPTURE_UNAVAILABLE_EXIT && result === CAPTURE_UNAVAILABLE) {
      return { ok: false, category: 'capture_unavailable' }
    }
    return { ok: false, category: 'process_error' }
  }
  return { ok: child.status === 0, category: child.status === 0 ? 'ok' : 'process_error' }
}

export function captureProbe(spawnProcess = spawnSync) {
  return runPowerShell(`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bitmap = New-Object System.Drawing.Bitmap 1, 1
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$size = New-Object System.Drawing.Size 1, 1
$result = '${CAPTURE_OK}'
$exitCode = 0
try {
  $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $size)
} catch {
  $result = '${CAPTURE_UNAVAILABLE}'
  $exitCode = ${CAPTURE_UNAVAILABLE_EXIT}
} finally {
  $graphics.Dispose()
  $bitmap.Dispose()
}
[Console]::Out.WriteLine($result)
exit $exitCode
`, 20_000, spawnProcess, true)
}

function lockWorkstation() {
  return runPowerShell(`
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class NativeSession {
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool LockWorkStation();
}
"@
if ([NativeSession]::LockWorkStation()) { exit 0 }
exit 1
`)
}

export function readCaptureAudit(profile, readBytes = (path) => readFileSync(path)) {
  let bytes = null
  let text = ''
  let complete = false
  try {
    bytes = Buffer.from(readBytes(join(profile, 'logs', 'audit.log')))
    complete = bytes.length > 0 && bytes[bytes.length - 1] === 10
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    if (!complete) return { readable: true, complete, valid: false, bytes, text, records: [] }
    const records = []
    let previous = 'GENESIS'
    let previousAtMs = Number.NEGATIVE_INFINITY
    for (const raw of text.split('\n').slice(0, -1)) {
      const line = raw.replace(/\r$/, '')
      const record = JSON.parse(line)
      const atMs = recordMs(record)
      if (!auditMetadataValid(record) || record.seq !== records.length + 1 || record.prev !== previous || atMs < previousAtMs) {
        return { readable: true, complete, valid: false, bytes, text, records: [] }
      }
      records.push(record)
      previous = createHash('sha256').update(line, 'utf8').digest('hex')
      previousAtMs = atMs
    }
    return { readable: true, complete, valid: records.length > 0, bytes, text, records }
  } catch {
    return { readable: bytes !== null, complete, valid: false, bytes, text, records: [] }
  }
}

function readRecords(profile) {
  return readCaptureAudit(profile).records
}

function auditAnchors(snapshot, launchAtMs, observedAtMs) {
  const records = snapshot?.valid === true ? snapshot.records : []
  const started = records.findIndex((record) => record.event === 'app.started')
  const ready = records.findIndex((record, index) => index > started && record.event === 'app.renderer.ready')
  const freshProfile = Number.isFinite(launchAtMs) && Number.isFinite(observedAtMs) && observedAtMs >= launchAtMs &&
    records.length > 0 && records.every((record) => recordMs(record) >= launchAtMs && recordMs(record) <= observedAtMs) &&
    records.filter((record) => record.event === 'app.started').length === 1
  return { freshProfile, startupAnchored: freshProfile && started >= 0, readinessAnchored: freshProfile && started >= 0 && ready > started }
}

function auditCoverageProof(baseline, final, anchors, {
  launchAtMs, inductionAtMs, finalAtMs, baselineAtMonotonicMs, inductionAtMonotonicMs, finalAtMonotonicMs, parkStartedAtMs, candidateLivenessProof, progress
}) {
  const baselineRetained = Buffer.isBuffer(baseline?.bytes) && Buffer.isBuffer(final?.bytes) &&
    final.bytes.length >= baseline.bytes.length && final.bytes.subarray(0, baseline.bytes.length).equals(baseline.bytes)
  const lengthNondecreasing = Buffer.isBuffer(baseline?.bytes) && Buffer.isBuffer(final?.bytes) && final.bytes.length >= baseline.bytes.length
  const finalAnchors = auditAnchors(final, launchAtMs, finalAtMs)
  const failureTimeline = bgScreenCaptureFailed(final?.records?.slice(baseline?.records?.length ?? 0) ?? [])
    .every((record) => recordMs(record) >= inductionAtMs)
  return {
    observed: progress.readable && baseline?.readable === true && final?.readable === true,
    baselineComplete: baseline?.complete === true,
    baselineValid: baseline?.valid === true,
    finalComplete: final?.complete === true,
    finalValid: progress.valid && final?.valid === true && finalAnchors.freshProfile && failureTimeline,
    freshProfile: anchors.freshProfile,
    startupAnchored: anchors.startupAnchored,
    readinessAnchored: anchors.readinessAnchored,
    baselineRetained: progress.retained && baselineRetained,
    lengthNondecreasing: progress.nondecreasing && lengthNondecreasing,
    parkCovered: [baselineAtMonotonicMs, inductionAtMonotonicMs, finalAtMonotonicMs, parkStartedAtMs].every(Number.isFinite) &&
      baselineAtMonotonicMs <= inductionAtMonotonicMs && finalAtMonotonicMs >= parkStartedAtMs + PARK_MS &&
      candidateParkProved(candidateLivenessProof, PARK_MS),
    baselineRecordCount: baseline?.records?.length ?? 0,
    finalRecordCount: final?.records?.length ?? 0
  }
}

function auditProgress(baseline) {
  let previous = baseline
  const proof = { readable: baseline?.readable === true, valid: baseline?.valid === true && baseline?.complete === true, retained: true, nondecreasing: true }
  return {
    proof,
    observe: (snapshot) => {
      proof.readable &&= snapshot?.readable === true
      proof.valid &&= snapshot?.valid === true && snapshot?.complete === true
      const comparable = Buffer.isBuffer(previous?.bytes) && Buffer.isBuffer(snapshot?.bytes)
      proof.nondecreasing &&= comparable && snapshot.bytes.length >= previous.bytes.length
      proof.retained &&= comparable && snapshot.bytes.length >= previous.bytes.length &&
        snapshot.bytes.subarray(0, previous.bytes.length).equals(previous.bytes)
      previous = snapshot
    }
  }
}

async function waitForTotoPage(port) {
  const browser = await attach(`http://127.0.0.1:${port}`, 45_000)
  const page = await findPage(
    browser,
    (candidate) => candidate.evaluate(() => typeof window.toto !== 'undefined').catch(() => false),
    'No page exposing window.toto was found over CDP.',
    READY_TIMEOUT_MS,
    500
  )
  return { browser, page }
}

async function readSettings(page) {
  return page.evaluate(() => window.toto.getSettings())
}

async function readinessProof(page) {
  try {
    await page.evaluate(() => window.toto.localPrewarm('M2-0559 capture gate readiness proof')).catch(() => undefined)
    const deadline = Date.now() + READY_TIMEOUT_MS
    let last = null
    while (Date.now() < deadline) {
      last = await readSettings(page).catch(() => null)
      if (last?.backgroundScreenReady === true && last?.localReady === true) {
        return { observed: true, backgroundScreenReady: true, localReady: true }
      }
      await sleep(POLL_MS)
    }
    return {
      observed: false,
      backgroundScreenReady: last?.backgroundScreenReady === true,
      localReady: last?.localReady === true
    }
  } catch {
    return { observed: false, backgroundScreenReady: false, localReady: false }
  }
}

async function backgroundScreenReadyAfterPark(page) {
  try {
    const settings = await readSettings(page)
    return { observed: true, backgroundScreenReady: settings?.backgroundScreenReady === true }
  } catch {
    return { observed: false, backgroundScreenReady: null }
  }
}

function captureState(probe) {
  if (probe?.ok === true && probe?.category === 'ok') return { captureWorks: true, category: 'ok' }
  if (probe?.ok === false && probe?.category === 'capture_unavailable') {
    return { captureWorks: false, category: 'capture_unavailable' }
  }
  return { captureWorks: null, category: probe?.category === 'timeout' ? 'timeout' : 'process_error' }
}

function observeOwnedCandidate(child, monotonicNow) {
  const pid = child?.pid
  const canObserve = typeof child?.on === 'function' && typeof child?.removeListener === 'function'
  const ownedIdentity = canObserve && Number.isInteger(pid) && pid > 0
  let exitObserved = false
  let exitedAtMs = null
  let processErrorObserved = false
  const onExit = () => {
    if (exitObserved) return
    exitObserved = true
    const atMs = monotonicNow()
    exitedAtMs = Number.isFinite(atMs) ? atMs : null
  }
  const onError = () => { processErrorObserved = true }
  if (canObserve) {
    child.on('exit', onExit)
    child.on('error', onError)
  }
  // Retain the owned process handle and latch its exit; a reused numeric PID cannot revive it.
  const snapshot = () => {
    if (Number.isInteger(child?.exitCode) || typeof child?.signalCode === 'string') onExit()
    const knownStatus = (child?.exitCode === null || Number.isInteger(child?.exitCode)) &&
      (child?.signalCode === null || typeof child?.signalCode === 'string')
    const observed = ownedIdentity && child.pid === pid && knownStatus && !processErrorObserved
    return {
      observed,
      alive: observed ? !exitObserved : null,
      exitObserved,
      exitedAtMs,
      processErrorObserved
    }
  }
  snapshot()
  return {
    snapshot,
    dispose: () => {
      if (canObserve) {
        child.removeListener('exit', onExit)
        child.removeListener('error', onError)
      }
    }
  }
}

export async function runCaptureGate({
  child,
  maxBgFailures,
  connect,
  readAudit,
  probe = captureProbe,
  induce = lockWorkstation,
  proveReady = readinessProof,
  hide = (page) => page.evaluate(() => window.toto.hide?.()).catch(() => undefined),
  readAfterPark = backgroundScreenReadyAfterPark,
  now = Date.now,
  monotonicNow = () => performance.now(),
  wait = (ms) => sleep(ms),
  launchAtMs = now(),
  onInductionAt = (atMs) => {}
}) {
  const lifetime = observeOwnedCandidate(child, monotonicNow)
  try {
    const page = await connect()
    const beforeProbe = probe()
    const ready = await proveReady(page)
    const baselineAudit = readAudit('baseline')
    const baselineAtMs = now()
    const baselineAtMonotonicMs = monotonicNow()
    const baselineAnchors = auditAnchors(baselineAudit, launchAtMs, baselineAtMs)
    const continuity = auditProgress(baselineAudit)
    if (beforeProbe.ok === true) await hide(page)

    const inductionAtMs = now()
    onInductionAt(inductionAtMs)
    const inductionAtMonotonicMs = monotonicNow()
    const aliveAtInduction = lifetime.snapshot().alive
    const induction = induce()
    await wait(PROBE_SETTLE_MS)
    const afterInductionProbe = probe()

    const parkStartedAtMs = monotonicNow()
    let lastParkAtMs = parkStartedAtMs
    let clockObserved = Number.isFinite(parkStartedAtMs)
    let parkElapsedMs = clockObserved ? 0 : null
    let waitedForPark = false
    while (clockObserved) {
      const atMs = monotonicNow()
      if (!Number.isFinite(atMs) || atMs < lastParkAtMs || (waitedForPark && atMs === lastParkAtMs)) {
        clockObserved = false
        parkElapsedMs = null
        break
      }
      lastParkAtMs = atMs
      parkElapsedMs = atMs - parkStartedAtMs
      if (parkElapsedMs >= PARK_MS || lifetime.snapshot().alive !== true) break
      continuity.observe(readAudit('park'))
      await wait(Math.min(POLL_MS, PARK_MS - parkElapsedMs))
      waitedForPark = true
    }
    // Drain owned-child notifications before and after the final probes, including synchronous ones.
    await wait(0)
    const afterParkProbe = probe()
    const afterParkReady = await readAfterPark(page)
    await wait(0)
    const audit = readAudit('final')
    const finalAtMs = now()
    const finalAtMonotonicMs = monotonicNow()
    continuity.observe(audit)
    await wait(0)
    const afterPark = lifetime.snapshot()
    const candidateLivenessProof = {
      observed: afterPark.observed && clockObserved,
      aliveAtInduction,
      aliveAfterPark: afterPark.alive,
      exitObserved: afterPark.exitObserved,
      exitedBeforeParkComplete: afterPark.exitObserved && (
        !clockObserved || afterPark.exitedAtMs === null || afterPark.exitedAtMs < parkStartedAtMs + PARK_MS
      ),
      processErrorObserved: afterPark.processErrorObserved,
      parkElapsedMs
    }
    const auditProof = auditCoverageProof(baselineAudit, audit, baselineAnchors, {
      launchAtMs,
      inductionAtMs,
      finalAtMs,
      baselineAtMonotonicMs,
      inductionAtMonotonicMs,
      finalAtMonotonicMs,
      parkStartedAtMs,
      candidateLivenessProof,
      progress: continuity.proof
    })
    const failingStateProof = {
      method: INDUCTION_METHOD,
      inductionStarted: induction?.ok === true && induction?.category === 'ok',
      beforeInduction: captureState(beforeProbe),
      afterInduction: captureState(afterInductionProbe),
      afterPark: captureState(afterParkProbe),
      candidateLivenessProof,
      auditProof
    }
    return buildReport({
      records: audit.records,
      readinessProof: ready,
      failingStateProof,
      inductionAtMs,
      maxBgFailures,
      backgroundScreenReadyAfterPark: afterParkReady
    })
  } finally {
    lifetime.dispose()
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (process.platform !== 'win32') throw new Precondition('capture-gate runs on Windows only.')
  if (!existsSync(args.app)) throw new Precondition('installed Metis.exe was not found.')

  mkdirSync(dirname(args.report), { recursive: true })
  const profile = mkdtempSync(join(tmpdir(), 'metis-capture-gate-'))
  seedProfile(profile)
  const port = await freeLoopbackPort()
  const env = launchEnv(process.env, profile, { hostFloorOverride: true })
  let child = null
  let browser = null
  let page = null
  let report = null
  let inductionAtMs = Date.now()

  try {
    const launchAtMs = Date.now()
    child = spawn(args.app, [`--remote-debugging-port=${port}`], { env, stdio: 'ignore' })
    child.once('error', () => {})
    report = await runCaptureGate({
      child,
      maxBgFailures: args.maxBgFailures,
      connect: async () => {
        ;({ browser, page } = await waitForTotoPage(port))
        return page
      },
      readAudit: () => readCaptureAudit(profile),
      launchAtMs,
      onInductionAt: (atMs) => { inductionAtMs = atMs }
    })
  } catch (error) {
    const reason = error instanceof Precondition ? 'readiness_unproven' : 'failing_state_unproven'
    report = buildReport({
      records: readRecords(profile),
      readinessProof: { observed: false, backgroundScreenReady: false, localReady: false },
      failingStateProof: {
        method: INDUCTION_METHOD,
        inductionStarted: false,
        beforeInduction: { captureWorks: null },
        afterInduction: { captureWorks: null },
        afterPark: { captureWorks: null }
      },
      inductionAtMs,
      maxBgFailures: args.maxBgFailures,
      backgroundScreenReadyAfterPark: { observed: false, backgroundScreenReady: null }
    })
    report = { ...report, outcome: 'PRECONDITION', reasons: [reason] }
  } finally {
    writeFileSync(args.report, `${JSON.stringify(report, null, 2)}\n`)
    try {
      if (page) await page.evaluate(() => window.toto.quit()).catch(() => undefined)
    } catch {
      /* best effort */
    }
    try {
      await browser?.close()
    } catch {
      /* best effort */
    }
    if (child) {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      await waitForChildExit(child, 5_000)
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }
    try {
      rmSync(profile, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }

  return exitCodeForOutcome(report.outcome)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    process.exitCode = await main()
  } catch (error) {
    const reportPath = process.argv[3]
    if (reportPath) {
      mkdirSync(dirname(reportPath), { recursive: true })
      const report = buildReport({
        records: [],
        readinessProof: { observed: false, backgroundScreenReady: false, localReady: false },
        failingStateProof: {
          method: INDUCTION_METHOD,
          inductionStarted: false,
          beforeInduction: { captureWorks: null },
          afterInduction: { captureWorks: null },
          afterPark: { captureWorks: null }
        },
        inductionAtMs: Date.now(),
        maxBgFailures: 0,
        backgroundScreenReadyAfterPark: { observed: false, backgroundScreenReady: null }
      })
      writeFileSync(reportPath, `${JSON.stringify({ ...report, outcome: 'PRECONDITION', reasons: ['readiness_unproven'] }, null, 2)}\n`)
    }
    console.error(`::warning title=capture-gate PRECONDITION::${error instanceof Failure ? 'failed' : 'precondition'}`)
    process.exitCode = 2
  }
}
