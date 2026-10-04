#!/usr/bin/env node
/**
 * File-fed capture smoke: proves the QA-identity file-fed microphone (M2-0494) engages on the candidate's own
 * bytes. PASS needs, within 180 s of the launch: the qa.capture.file_source audit event; at least two live
 * transcript lines within 120 s of Listen; a saved meeting file after Stop; and at least three of the fixture
 * sentences' distinctive tokens in the saved transcript. Otherwise FAIL. An app that never becomes ready is
 * PRECONDITION. The report holds counts, booleans and the ASR engine name only.
 *
 * Usage: node scripts/qa/meeting/file-capture-smoke.mjs --installer <Metis-QA-<v>.zip|exe> [--platform <darwin|win32>] [--out <dir>]
 * Exit codes: 0 PASS, 1 FAIL, 2 PRECONDITION or usage.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { LINES_TIMEOUT_MS, LIVE_LINES_NEEDED, runFileCapture } from './file-capture.mjs'

export const DEADLINE_MS = 180_000
export const TOKENS_NEEDED = 3
export const PRECONDITION_REASON_MAX = 200

export function preconditionReason(error) {
  return String(error?.message ?? error ?? 'unknown precondition failure')
    .replace(/(?:\/Users|\/private|\/tmp|[A-Za-z]:\\)[^\s'",)}]+/g, '[path]')
    .slice(0, PRECONDITION_REASON_MAX)
}

/** The verdict and exit code for one run's observations. */
export function judge(observed) {
  if (!observed.ready) {
    return { verdict: 'PRECONDITION', exitCode: 2, checks: null, reason: observed.reason ?? null }
  }
  const checks = {
    auditEvent: observed.auditEvent === true,
    liveLines: observed.linesReachedMs !== null && observed.linesReachedMs <= LINES_TIMEOUT_MS,
    savedMeeting: observed.meetingFilesAfter > observed.meetingFilesBefore && observed.savedBytes > 0,
    tokens: observed.tokenMatches >= TOKENS_NEEDED,
    driverCompleted: observed.driverError !== true,
    withinDeadline: observed.totalMs <= DEADLINE_MS
  }
  const pass = Object.values(checks).every(Boolean)
  return { verdict: pass ? 'PASS' : 'FAIL', exitCode: pass ? 0 : 1, checks }
}

/** The content-free report: numbers, booleans and the engine name, never a line of the transcript. */
export function buildReport(observed, { verdict, checks }) {
  if (verdict === 'PRECONDITION') {
    return {
      verdict,
      reason: observed.reason ?? null
    }
  }
  return {
    verdict,
    asrEngine: observed.asrEngine,
    checks,
    thresholds: { liveLines: LIVE_LINES_NEEDED, liveLinesWithinMs: LINES_TIMEOUT_MS, tokens: TOKENS_NEEDED, deadlineMs: DEADLINE_MS },
    counts: {
      maxLiveLines: observed.maxLines,
      linesReachedMs: observed.linesReachedMs,
      meetingFilesBefore: observed.meetingFilesBefore,
      meetingFilesAfter: observed.meetingFilesAfter,
      savedBytes: observed.savedBytes,
      tokenMatches: observed.tokenMatches,
      tokenTotal: observed.tokenTotal,
      pageStoppedAnswering: observed.pageStoppedAnswering === true,
      totalMs: observed.totalMs
    },
    diagnostics: observed.diagnostics
      ? {
          engine: observed.diagnostics.engine,
          wavSource: observed.diagnostics.wavSource,
          candidateSource: observed.diagnostics.candidateSource,
          source: observed.diagnostics.source,
          fakeDevice: observed.diagnostics.fakeDevice === true,
          getUserMediaFailed: observed.diagnostics.getUserMediaFailed === true,
          framesFed: Number(observed.diagnostics.framesFed ?? 0),
          peakRms: Number(observed.diagnostics.peakRms ?? 0),
          firstLineMs: observed.diagnostics.firstLineMs,
          stderrFakeDeviceInput: observed.diagnostics.stderrFakeDeviceInput === true,
          fakeMicPinned: observed.diagnostics.fakeMicPinned === true,
          whisperEngineMessages: Number(observed.diagnostics.whisperEngineMessages ?? 0),
          asrLoadFailedMessages: Number(observed.diagnostics.asrLoadFailedMessages ?? 0),
          microphoneCaptureFailedMessages: Number(observed.diagnostics.microphoneCaptureFailedMessages ?? 0),
          backpressureMessages: Number(observed.diagnostics.backpressureMessages ?? 0),
          loadingModel: observed.diagnostics.loadingModel === true
        }
      : null
  }
}

export function diagnosticLine(report) {
  const d = report.diagnostics
  if (!d) return null
  const firstLineMs = d.firstLineMs === null || d.firstLineMs === undefined ? 'null' : Math.round(d.firstLineMs)
  return `DIAG engine=${d.engine} source=${d.source} framesFed=${d.framesFed}/peak=${Number(d.peakRms).toFixed(4)} firstLineMs=${firstLineMs}`
}

/** Keep the profile/WAV under the workspace artifact path, not the macOS temp sandbox. */
export function smokeWorkDir(outDir, cwd = process.cwd()) {
  return resolve(cwd, outDir, 'work')
}

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, '')] = argv[i + 1]
  return args
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.installer) {
    console.error('Usage: node scripts/qa/meeting/file-capture-smoke.mjs --installer <Metis-QA-<v>.zip|exe> [--platform <darwin|win32>] [--out <dir>]')
    return 2
  }
  const outDir = args.out ?? 'out/file-capture'
  mkdirSync(outDir, { recursive: true })
  const workDir = smokeWorkDir(outDir)
  let observed
  try {
    observed = await runFileCapture({ installer: args.installer, reportDir: outDir, workDir, platform: args.platform ?? process.platform })
  } catch (error) {
    const reason = preconditionReason(error)
    console.error(`file-capture precondition: ${reason}`)
    observed = { ready: false, reason }
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
  const outcome = judge(observed)
  const report = buildReport(observed, outcome)
  writeFileSync(join(outDir, 'file-capture-report.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(`[file-capture-smoke] ${outcome.verdict} ${outcome.reason ? JSON.stringify({ reason: outcome.reason }) : JSON.stringify(report.checks ?? {})}`)
  if (outcome.verdict === 'FAIL') console.log(diagnosticLine(report))
  return outcome.exitCode
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(await main())
