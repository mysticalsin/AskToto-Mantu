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
 *   node scripts/qa/capture-gate.mjs <installed Metis.exe> <report.json> --max-bg-failures 6
 *
 * Exit 0 PASS · 1 FAIL · 2 PRECONDITION.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { LOCAL_LLM_SETTINGS } from './lib/local-llm-settings.mjs'
import { attach, findPage, freeLoopbackPort, waitForChildExit } from './lib/app-driver.mjs'
import { parseAuditLog, readAuditLog } from './golden-flows/smoke-support.mjs'
import { launchEnv } from './sidecar-boot-reaper.mjs'

export const INDUCTION_METHOD = 'windows-lock-workstation'
export const PARK_MS = 30 * 60_000
export const FINAL_TAIL_MS = 15 * 60_000
export const READY_TIMEOUT_MS = 180_000
export const PROBE_SETTLE_MS = 2_000
export const POLL_MS = 1_000
export const REPORT_SCHEMA = 1

const FIXED_PRECONDITION_REASONS = Object.freeze(['readiness_unproven', 'failing_state_unproven'])
const FIXED_FAILURE_REASONS = Object.freeze(['bg_screen_failed_total', 'bg_screen_failed_final_tail'])

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

function readNumericExport(source, name) {
  const match = new RegExp(`export const ${name}\\s*=\\s*([^\\n]+)`).exec(source)
  if (!match) throw new Error(`${name} was not found in capture-backoff.ts`)
  const value = Function(`"use strict"; return (${match[1].replace(/;.*/, '')});`)()
  if (!Number.isFinite(value)) throw new Error(`${name} did not resolve to a finite number`)
  return value
}

export function readCaptureBackoffConstants(source) {
  return {
    BACKOFF_MAX_MS: readNumericExport(source, 'BACKOFF_MAX_MS'),
    BACKOFF_LATCH_AFTER: readNumericExport(source, 'BACKOFF_LATCH_AFTER')
  }
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
    proof?.afterInduction?.captureWorks === false &&
    proof?.afterPark?.captureWorks === false
  )
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
  if (!proofReady(readinessProof)) {
    return {
      outcome: 'PRECONDITION',
      reasons: ['readiness_unproven'],
      bgScreenCaptureFailedTotal: 0,
      bgScreenCaptureFailedFinal15Minutes: 0,
      screenPreprocessSuspended: suspendedSummary(records)
    }
  }
  if (!failingStateProved(failingStateProof)) {
    return {
      outcome: 'PRECONDITION',
      reasons: ['failing_state_unproven'],
      bgScreenCaptureFailedTotal: 0,
      bgScreenCaptureFailedFinal15Minutes: 0,
      screenPreprocessSuspended: suspendedSummary(records)
    }
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

function runPowerShell(script, timeoutMs = 20_000) {
  const child = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  if (child.error) return { ok: false, category: child.error.code === 'ETIMEDOUT' ? 'timeout' : 'process_error' }
  return { ok: child.status === 0, category: child.status === 0 ? 'ok' : 'capture_unavailable' }
}

function captureProbe() {
  return runPowerShell(`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bitmap = New-Object System.Drawing.Bitmap 1, 1
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
  $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, (New-Object System.Drawing.Size 1, 1))
  exit 0
} finally {
  $graphics.Dispose()
  $bitmap.Dispose()
}
`)
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

function readRecords(profile) {
  return parseAuditLog(readAuditLog(join(profile, 'logs', 'audit.log')))
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
    child = spawn(args.app, [`--remote-debugging-port=${port}`], { env, stdio: 'ignore' })
    child.once('error', () => {})
    ;({ browser, page } = await waitForTotoPage(port))

    const beforeProbe = captureProbe()
    const ready = await readinessProof(page)
    if (beforeProbe.ok === true) {
      await page.evaluate(() => window.toto.hide?.()).catch(() => undefined)
    }

    inductionAtMs = Date.now()
    const induction = lockWorkstation()
    await sleep(PROBE_SETTLE_MS)
    const afterInductionProbe = captureProbe()

    await sleep(PARK_MS)
    const afterParkProbe = captureProbe()
    const afterParkReady = await backgroundScreenReadyAfterPark(page)

    const failingStateProof = {
      method: INDUCTION_METHOD,
      inductionStarted: induction.ok === true,
      beforeInduction: { captureWorks: beforeProbe.ok === true },
      afterInduction: { captureWorks: afterInductionProbe.ok === true ? true : false },
      afterPark: { captureWorks: afterParkProbe.ok === true ? true : false }
    }

    report = buildReport({
      records: readRecords(profile),
      readinessProof: ready,
      failingStateProof,
      inductionAtMs,
      maxBgFailures: args.maxBgFailures,
      backgroundScreenReadyAfterPark: afterParkReady
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
