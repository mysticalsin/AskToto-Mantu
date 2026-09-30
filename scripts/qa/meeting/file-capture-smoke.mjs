#!/usr/bin/env node
/**
 * File-fed capture smoke: proves the QA-identity file-fed microphone (M2-0494) engages on the candidate's own
 * bytes. PASS needs, within 180 s of the launch: the qa.capture.file_source audit event; at least two live
 * transcript lines within 120 s of Listen; a saved meeting file after Stop; and at least three of the fixture
 * sentences' distinctive tokens in the saved transcript. Otherwise FAIL. An app that never becomes ready is
 * PRECONDITION. The report holds counts, booleans and the ASR engine name only.
 *
 * Usage: node scripts/qa/meeting/file-capture-smoke.mjs --installer <Metis-QA-<v>.zip> [--out <dir>]
 * Exit codes: 0 PASS, 1 FAIL, 2 PRECONDITION or usage.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LINES_TIMEOUT_MS, LIVE_LINES_NEEDED, runFileCapture } from './file-capture.mjs'

export const DEADLINE_MS = 180_000
export const TOKENS_NEEDED = 3

/** The verdict and exit code for one run's observations. */
export function judge(observed) {
  if (!observed.ready) {
    return { verdict: 'PRECONDITION', exitCode: 2, checks: null }
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
    }
  }
}

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, '')] = argv[i + 1]
  return args
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.installer) {
    console.error('Usage: node scripts/qa/meeting/file-capture-smoke.mjs --installer <Metis-QA-<v>.zip> [--out <dir>]')
    return 2
  }
  const outDir = args.out ?? 'out/file-capture'
  mkdirSync(outDir, { recursive: true })
  let observed
  try {
    observed = await runFileCapture({ installer: args.installer })
  } catch (error) {
    console.error(`file-capture precondition: ${error.message}`)
    observed = { ready: false }
  }
  const outcome = judge(observed)
  const report = outcome.checks ? buildReport(observed, outcome) : { verdict: outcome.verdict }
  writeFileSync(join(outDir, 'file-capture-report.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(`[file-capture-smoke] ${outcome.verdict} ${JSON.stringify(report.checks ?? {})}`)
  return outcome.exitCode
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(await main())
