#!/usr/bin/env node
/**
 * Long file-fed meeting with repeated History use. The report is content-free: counts, timings, process
 * kinds and event names only. Transcript text, meeting titles, result text and local paths never leave
 * this process.
 */
import { spawn } from 'node:child_process'
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { freemem, tmpdir, totalmem } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { sha256File } from '../provenance.mjs'
import { writeAuditCounts } from '../census/audit-counts.mjs'
import { evaluateGrowth } from '../soak/growth.mjs'
import {
  ASR_ENGINE,
  AUDIT_EVENT,
  LINE_COUNT,
  LINES_TIMEOUT_MS,
  LISTEN_CLICK,
  LIVE_LINES_NEEDED,
  SAVE_TIMEOUT_MS,
  STOP_CLICK,
  STOP_PRESENT,
  TRANSCRIPT_CLICK,
  TRANSCRIPT_PRESENT,
  appSpawnOptions,
  auditHasEvent,
  freePort,
  installQaZipDetails,
  launchSpec,
  meetingFiles,
  overlayPage,
  seedProfile,
  waitFor
} from './file-capture.mjs'
import { writeCaptureWav } from './capture-wav.mjs'
import {
  EVALUATE_TIMEOUT_MS,
  inspectorUrlFromChild,
  mainInspector,
  sampleMainLoop,
  setupMainLoopMonitor,
  summarizeMainLoop
} from '../lib/main-inspector.mjs'

export const SAMPLE_EVERY_MS = 5_000
export const HISTORY_EVERY_MS = 30_000
export const HISTORY_JITTER_MS = 5_000
export const LOOP_P99_BUDGET_MS = 50
export const STRICT_BUDGET_MS = 250
export const HISTORY_COMPLETION_FRACTION = 0.95

export function seededRandom(seed) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000
  }
}

export function scheduleHistoryCycles({ durationMs, everyMs = HISTORY_EVERY_MS, jitterMs = HISTORY_JITTER_MS, seed = 496 }) {
  const random = seededRandom(seed)
  const cycles = []
  for (let base = everyMs; base < durationMs; base += everyMs) {
    const jitter = Math.round((random() * 2 - 1) * jitterMs)
    cycles.push(Math.max(0, base + jitter))
  }
  return cycles
}

const safeNumber = (value) => (Number.isFinite(value) ? value : null)

export function hostMemorySnapshot() {
  return { totalBytes: totalmem(), freeBytes: freemem() }
}

export function sanitizeFailure(error) {
  return String(error?.message ?? error).replace(/(?:\/Users|\/private|\/tmp|[A-Za-z]:\\)[^\s'",)}]+/g, '[path]').slice(0, 200)
}

export function classifyDriverError(observed, error, { preconditionCleared }) {
  const message = sanitizeFailure(error)
  if (preconditionCleared) observed.runtimeFailure = message
  else observed.precondition = message
}

export function judgeMeetingHistory(observed) {
  if (observed.precondition) return { verdict: 'PRECONDITION', exitCode: 2, failures: [observed.precondition] }
  const failures = []
  const samples = observed.samples ?? []
  const actions = observed.historyActions ?? []
  const completed = actions.filter((action) => action.outcome === 'completed')
  const completion = actions.length === 0 ? 0 : completed.length / actions.length
  const saved = observed.meetingFilesAfter > observed.meetingFilesBefore && observed.savedBytes > 0
  const historyRows = observed.historyRowsAfter > observed.historyRowsBefore

  if (observed.runtimeFailure) failures.push(`driver failure after precondition: ${observed.runtimeFailure}`)
  if (!(observed.mainLoop?.p99Ms < LOOP_P99_BUDGET_MS)) failures.push(`whole-capture main p99 ${observed.mainLoop?.p99Ms ?? 'missing'} ms >= ${LOOP_P99_BUDGET_MS} ms`)
  if (!(observed.mainLoop?.maxMs < STRICT_BUDGET_MS)) failures.push(`whole-capture main max ${observed.mainLoop?.maxMs ?? 'missing'} ms >= ${STRICT_BUDGET_MS} ms`)
  for (const action of actions) {
    if (!(action.loopMaxMs < STRICT_BUDGET_MS)) failures.push(`History cycle ${action.index} loop max ${action.loopMaxMs ?? 'missing'} ms >= ${STRICT_BUDGET_MS} ms`)
    if (action.linesAfter < action.linesBefore) failures.push(`History cycle ${action.index} transcript lines dropped`)
  }
  for (const sample of samples) {
    if (!(sample.loopMaxSinceLastMs < STRICT_BUDGET_MS)) failures.push(`sample ${sample.index} loop max ${sample.loopMaxSinceLastMs ?? 'missing'} ms >= ${STRICT_BUDGET_MS} ms`)
    if (!(sample.writeMs < STRICT_BUDGET_MS)) failures.push(`sample ${sample.index} settings write ${sample.writeMs ?? 'missing'} ms >= ${STRICT_BUDGET_MS} ms`)
    if (!(sample.lookupMs < STRICT_BUDGET_MS)) failures.push(`sample ${sample.index} dns.lookup ${sample.lookupMs ?? 'missing'} ms >= ${STRICT_BUDGET_MS} ms`)
  }
  if (completion < HISTORY_COMPLETION_FRACTION) failures.push(`History completion ${completion} < ${HISTORY_COMPLETION_FRACTION}`)
  if (!saved) failures.push('no new non-empty meeting file after Stop')
  if (!historyRows) failures.push('History row count did not increase after Stop')
  if (observed.growth?.outcome !== 'PASS') failures.push(`MEETING-GROWTH-1 ${observed.growth?.outcome ?? 'missing'}`)
  if (observed.auditEvent !== true) failures.push(`${AUDIT_EVENT} audit event missing`)
  if (!(observed.linesReachedMs !== null && observed.linesReachedMs <= LINES_TIMEOUT_MS)) failures.push('live transcript lines did not arrive within 120 s')
  return { verdict: failures.length === 0 ? 'PASS' : 'FAIL', exitCode: failures.length === 0 ? 0 : 1, failures }
}

export function activeKindsFromNdjson(text) {
  const kinds = new Set()
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (record?.record !== 'sample') continue
    for (const process of Array.isArray(record.processes) ? record.processes : []) {
      if (typeof process?.kind === 'string') kinds.add(process.kind)
    }
  }
  return Object.fromEntries(['parakeet-utility', 'whisper-utility', 'speaker-utility', 'llama-server', 'sidecar-supervisor'].map((kind) => [kind, kinds.has(kind)]))
}

function parseNdjsonRecords(text) {
  return String(text)
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

export function mergeCensusStreams({ active, post, stopMs }) {
  const activeRecords = parseNdjsonRecords(active)
  const postRecords = parseNdjsonRecords(post)
  const header = activeRecords.find((record) => record.record === 'header') ?? null
  const activeSamples = activeRecords.filter((record) => record.record === 'sample')
  const postSamples = postRecords
    .filter((record) => record.record === 'sample')
    .map((record) => ({ ...record, tMs: stopMs + record.tMs }))
  const trailer = { record: 'trailer', outcome: 'completed', samples: activeSamples.length + postSamples.length }
  return [header, ...activeSamples, ...postSamples, trailer].filter(Boolean).map((record) => JSON.stringify(record)).join('\n') + '\n'
}

export function evaluateMeetingGrowth({ active, post, auditCounts, captureStartMs, stopMs }) {
  return evaluateGrowth({
    samples: mergeCensusStreams({ active, post, stopMs }),
    auditCounts,
    ruleId: 'MEETING-GROWTH-1',
    captureStartMs,
    stopMs
  })
}

export function buildMeetingHistoryReport(observed, outcome) {
  if (outcome.verdict === 'PRECONDITION') {
    return { verdict: 'PRECONDITION', failures: outcome.failures }
  }
  return {
    verdict: outcome.verdict,
    failures: outcome.failures,
    thresholds: {
      mainP99Ms: LOOP_P99_BUDGET_MS,
      strictMs: STRICT_BUDGET_MS,
      historyCompletionFraction: HISTORY_COMPLETION_FRACTION,
      liveLinesWithinMs: LINES_TIMEOUT_MS
    },
    hostFloorOverride: observed.hostFloorOverride === true,
    hostMemory: observed.hostMemory ?? null,
    asrEngine: observed.asrEngine ?? null,
    sidecars: observed.sidecars ?? {},
    sidecarCauses: observed.sidecarCauses ?? {},
    themChannel: observed.themChannel ?? { active: false, cause: 'not-probed' },
    profile: observed.profile ?? { kind: 'unknown' },
    timingNotes: {
      historyLoopMaxWindow: 'measured from the preceding main-loop sample through the History cycle'
    },
    counts: {
      meetingFilesBefore: observed.meetingFilesBefore,
      meetingFilesAfter: observed.meetingFilesAfter,
      savedBytes: observed.savedBytes,
      historyRowsBefore: observed.historyRowsBefore,
      historyRowsAfter: observed.historyRowsAfter,
      maxLiveLines: observed.maxLines,
      linesReachedMs: observed.linesReachedMs
    },
    mainLoop: observed.mainLoop,
    samples: (observed.samples ?? []).map((sample) => ({
      index: sample.index,
      tMs: sample.tMs,
      loopMaxSinceLastMs: safeNumber(sample.loopMaxSinceLastMs),
      writeMs: safeNumber(sample.writeMs),
      lookupMs: safeNumber(sample.lookupMs),
      resources: sample.resources ?? {}
    })),
    historyActions: (observed.historyActions ?? []).map((action) => ({
      index: action.index,
      tMs: action.tMs,
      durationMs: action.durationMs,
      outcome: action.outcome,
      loopMaxMs: safeNumber(action.loopMaxMs),
      linesBefore: action.linesBefore,
      linesAfter: action.linesAfter,
      listRendered: action.listRendered === true,
      searchRendered: action.searchRendered === true,
      rowOpened: action.rowOpened === true
    })),
    census: observed.census,
    growth: observed.growth
  }
}

export function assertContentFreeReport(report) {
  const text = JSON.stringify(report).toLowerCase()
  const forbidden = ['/users/', '/private/', '\\users\\', 'qa-capture.wav', 'capture-meetings', '.md"', 'synthetic capture']
  return forbidden.filter((token) => text.includes(token))
}

function prepareProfile({ sourceProfile, profileDir }) {
  if (!sourceProfile) {
    const seeded = seedProfile(profileDir)
    return { ...seeded, profile: { kind: 'representative-synthetic', source: 'generated' } }
  }
  cpSync(sourceProfile, profileDir, { recursive: true })
  let settings
  try {
    settings = JSON.parse(readFileSync(join(profileDir, 'settings.json'), 'utf8'))
  } catch {
    const seeded = seedProfile(profileDir)
    return { ...seeded, profile: { kind: 'representative-synthetic', source: 'generated-fallback' } }
  }
  const sourceMeetings = typeof settings.meetingsFolder === 'string' ? settings.meetingsFolder : ''
  const meetingsFolder = sourceMeetings.startsWith(sourceProfile)
    ? join(profileDir, sourceMeetings.slice(sourceProfile.length))
    : join(profileDir, 'capture-meetings')
  mkdirSync(meetingsFolder, { recursive: true })
  const patched = {
    ...settings,
    meetingsFolder,
    onboardingDone: true,
    asrEngine: 'whisper',
    asrQuality: 'fast',
    asrLanguage: 'English',
    overlayLayout: 'bar',
    localLlm: {
      ...(settings.localLlm ?? {}),
      enabled: true,
      useFor: { ...(settings.localLlm?.useFor ?? {}), summary: true }
    },
    backgroundScreenContext: false,
    instantSuggestions: false,
    speakerId: { ...(settings.speakerId ?? {}), enabled: true, saveVoiceprints: false },
    audioSource: 'mic',
    showLiveTranscript: true,
    autoSaveTranscripts: true,
    encryptTranscripts: false
  }
  writeFileSync(join(profileDir, 'settings.json'), `${JSON.stringify(patched, null, 2)}\n`, { mode: 0o600 })
  let manifest = null
  try {
    manifest = JSON.parse(readFileSync(join(profileDir, 'resource-census-profile.json'), 'utf8'))
  } catch {}
  return {
    settings: patched,
    meetingsFolder,
    profile: {
      kind: manifest?.profileKind ?? 'provided',
      meetingCount: Number.isFinite(manifest?.meetingCount) ? manifest.meetingCount : null,
      layout: patched.overlayLayout
    }
  }
}

const HISTORY_OPEN = `(() => {
  const button = document.querySelector('[data-bar-history], button[aria-label="Open History"]')
  if (!button) return false
  button.click()
  return true
})()`

const HISTORY_ROWS = `(() => {
  const buttons = [...document.querySelectorAll('button')]
  return buttons.filter((button) => {
    const label = button.getAttribute('aria-label') || ''
    const text = (button.textContent || '').trim()
    return !label && text && !/^(import meetings|back|rename meeting|show connections|export meeting copy|delete meeting|show all \\d+ meetings)$/i.test(text)
  }).length
})()`

const HISTORY_SEARCH = (term) => `(() => {
  const input = document.querySelector('input[aria-label="Search past meetings"]')
  if (!input) return { ok: false, rows: 0 }
  input.focus()
  input.value = ${JSON.stringify(term)}
  input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(term)} }))
  return { ok: true }
})()`

const HISTORY_RESULT_ROWS = (term) => `(() => {
  const term = ${JSON.stringify(term)}.toLowerCase()
  const buttons = [...document.querySelectorAll('button')]
  return buttons.filter((button) => {
    const label = button.getAttribute('aria-label') || ''
    const text = (button.textContent || '').trim()
    return !label && text.toLowerCase().includes(term) && !/^(import meetings|back|rename meeting|export meeting copy|delete meeting)$/i.test(text)
  }).length
})()`

const HISTORY_OPEN_ROW = (term) => `(() => {
  const term = ${JSON.stringify(term)}.toLowerCase()
  const buttons = [...document.querySelectorAll('button')]
  const row = buttons.find((button) => {
    const label = button.getAttribute('aria-label') || ''
    const text = (button.textContent || '').trim()
    return !label && text.toLowerCase().includes(term) && !/^(import meetings|back|rename meeting|export meeting copy|delete meeting)$/i.test(text)
  })
  if (!row) return false
  row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  return true
})()`

const HISTORY_DETAIL_PRESENT = `(() => {
  return !!document.querySelector('[aria-label="Review meeting title"]')
    || document.body.innerText.includes('Resume session')
})()`

const BACK_OR_TRANSCRIPT = `(() => {
  const back = document.querySelector('button[aria-label="Back"]')
  if (back) { back.click(); return 'back' }
  const transcript = document.querySelector('[data-bar-transcript], button[aria-label="Show transcript"]')
  if (transcript) { transcript.click(); return 'transcript' }
  const history = document.querySelector('[data-bar-history], button[aria-label="Open History"]')
  if (history) { history.click(); return 'history' }
  return 'none'
})()`

async function historyRowCount(page) {
  if (!(await page.evaluate(HISTORY_OPEN).catch(() => false))) return null
  const ready = await waitFor(() => page.evaluate("!!document.querySelector('input[aria-label=\"Search past meetings\"]')"), 5_000, 250)
  if (!ready) return null
  const rows = await page.evaluate(HISTORY_ROWS).catch(() => null)
  await page.evaluate(BACK_OR_TRANSCRIPT).catch(() => null)
  await sleep(250)
  return Number.isFinite(rows) ? rows : null
}

async function historyCycle(page, { index, tMs, term }) {
  const started = performance.now()
  const linesBefore = Number(await page.evaluate(LINE_COUNT).catch(() => 0))
  let listRendered = false
  let searchRendered = false
  let rowOpened = false
  let outcome = 'failed'
  try {
    await page.evaluate(HISTORY_OPEN)
    listRendered = Boolean(await waitFor(() => page.evaluate("!!document.querySelector('input[aria-label=\"Search past meetings\"]')"), 5_000, 250))
    const search = await page.evaluate(HISTORY_SEARCH(term)).catch(() => null)
    searchRendered = Boolean(search?.ok && await waitFor(() => page.evaluate(HISTORY_RESULT_ROWS(term)), 5_000, 250))
    rowOpened = searchRendered && Boolean(await page.evaluate(HISTORY_OPEN_ROW(term)).catch(() => false))
    rowOpened = rowOpened && Boolean(await waitFor(() => page.evaluate(HISTORY_DETAIL_PRESENT), 5_000, 250))
    await sleep(250)
    await page.evaluate(BACK_OR_TRANSCRIPT).catch(() => null)
    await sleep(250)
    await page.evaluate(BACK_OR_TRANSCRIPT).catch(() => null)
    await page.evaluate(TRANSCRIPT_CLICK).catch(() => false)
    outcome = listRendered && searchRendered && rowOpened ? 'completed' : 'failed'
  } catch {
    outcome = 'failed'
  }
  const linesAfter = Number(await page.evaluate(LINE_COUNT).catch(() => 0))
  return { index, tMs, durationMs: Math.round(performance.now() - started), outcome, listRendered, searchRendered, rowOpened, linesBefore, linesAfter }
}

function parseArgs(argv) {
  const args = { minutes: 60, postMinutes: 10, out: 'out/meeting-history', seed: 496 }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => argv[++i]
    if (arg === '--zip') args.zip = next()
    else if (arg === '--sha256') args.sha256 = next()
    else if (arg === '--profile') args.profile = next()
    else if (arg === '--minutes') args.minutes = Number(next())
    else if (arg === '--post-minutes') args.postMinutes = Number(next())
    else if (arg === '--out') args.out = next()
    else if (arg === '--seed') args.seed = Number(next())
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (!args.zip || !args.sha256) throw new Error('Usage: meeting-history.mjs --zip <QA zip> --sha256 <sha> [--profile <dir>] [--minutes 60] [--post-minutes 10] [--out <dir>]')
  return args
}

function startCensus({ profileDir, installRoot, mainPid, state, seconds, ndjson, auditCounts, evidence }) {
  const child = spawn(process.execPath, [
      'scripts/qa/census/run.mjs',
      '--state', state,
      '--main-pid', String(mainPid),
      '--install-root', installRoot,
      '--profile', profileDir,
      '--precondition-evidence', evidence,
      '--seconds', String(seconds),
      '--interval-ms', '30000',
      '--ndjson', ndjson,
      '--audit-counts', auditCounts
  ], { stdio: 'ignore' })
  return {
    child,
    done: new Promise((resolve) => {
    child.once('exit', (code) => resolve({ code }))
    child.once('error', (error) => resolve({ code: null, error: String(error?.message ?? error) }))
    }),
    stop() {
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref()
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  mkdirSync(args.out, { recursive: true })
  const digest = await sha256File(args.zip)
  if (digest !== args.sha256.toLowerCase()) throw new Error('QA zip sha256 mismatch')

  const workDir = mkdtempSync(join(tmpdir(), 'metis-meeting-history-'))
  const installDir = join(workDir, 'app')
  const profileDir = join(workDir, 'profile')
  mkdirSync(installDir, { recursive: true })
  mkdirSync(profileDir, { recursive: true })
  let child = null
  let page = null
  let inspector = null
  const observed = {
    hostFloorOverride: true,
    hostMemory: hostMemorySnapshot(),
    samples: [],
    historyActions: [],
    meetingFilesBefore: 0,
    meetingFilesAfter: 0,
    savedBytes: 0,
    historyRowsBefore: 0,
    historyRowsAfter: 0,
    maxLines: 0,
    linesReachedMs: null,
    auditEvent: false,
    sidecars: {},
    sidecarCauses: {},
    themChannel: { active: false, cause: 'no-screen-recording-grant' },
    census: {}
  }
  let activeCensus = null
  let preconditionCleared = false

  try {
    const { installRoot, executable } = installQaZipDetails(args.zip, installDir)
    const { meetingsFolder, profile } = prepareProfile({ sourceProfile: args.profile, profileDir })
    observed.profile = profile
    const { path: wavPath } = writeCaptureWav(profileDir)
    const before = meetingFiles(meetingsFolder)
    observed.meetingFilesBefore = before.length
    observed.historyRowsBefore = before.length
    const port = await freePort()
    const spec = launchSpec({ executable, profileDir, wavPath, port, inspect: '127.0.0.1:0', hostFloorOverride: true })
    const stderrPath = join(args.out, 'app-stderr.log')
    let stderrFd = openSync(stderrPath, 'w')
    child = spawn(spec.command, spec.args, appSpawnOptions(spec, stderrFd))
    closeSync(stderrFd)
    stderrFd = null
    const wsUrl = await inspectorUrlFromChild(child)
    inspector = mainInspector(wsUrl)
    const setup = await setupMainLoopMonitor(inspector)
    if (!setup.ok) throw new Error('main loop monitor setup failed')

    const overlay = await overlayPage(port, 40_000)
    page = overlay.page
    if (!page) throw new Error(overlay.reason ?? 'overlay page not ready')
    await page.enableDiagnostics()
    observed.asrEngine = (await page.evaluate(ASR_ENGINE).catch(() => null)) ?? null
    observed.historyRowsBefore = await historyRowCount(page)
    if (!(await page.evaluate(LISTEN_CLICK))) throw new Error('Listen control unavailable')
    if (!(await waitFor(() => page.evaluate(STOP_PRESENT), 10_000, 250))) throw new Error('Listen did not enter active capture')
    if (!(await waitFor(async () => {
      if (await page.evaluate(TRANSCRIPT_PRESENT).catch(() => false)) return true
      await page.evaluate(TRANSCRIPT_CLICK).catch(() => false)
      return page.evaluate(TRANSCRIPT_PRESENT).catch(() => false)
    }, 10_000, 250))) throw new Error('Transcript panel did not open')

    const captureStart = Date.now()
    const activeNdjson = join(args.out, 'active-census.ndjson')
    const auditCounts = join(args.out, 'audit-counts.json')
    activeCensus = startCensus({
      profileDir,
      installRoot,
      mainPid: child.pid,
      state: 'active-transcription',
      seconds: Math.ceil(args.minutes * 60),
      ndjson: activeNdjson,
      auditCounts,
      evidence: `file-fed capture active, ${LIVE_LINES_NEEDED} lines`
    })

    const cycleTimes = scheduleHistoryCycles({ durationMs: args.minutes * 60_000, seed: args.seed })
    let nextCycle = 0
    let sampleIndex = 0
    const probeFile = join(profileDir, 'meeting-history-probe.txt')
    while (Date.now() - captureStart < args.minutes * 60_000) {
      const tMs = Date.now() - captureStart
      const lines = Number(await page.evaluate(LINE_COUNT).catch(() => 0))
      observed.maxLines = Math.max(observed.maxLines, lines)
      if (lines >= LIVE_LINES_NEEDED && observed.linesReachedMs === null) observed.linesReachedMs = tMs
      observed.auditEvent = auditHasEvent(profileDir)
      if (observed.auditEvent && observed.linesReachedMs !== null) preconditionCleared = true
      if (tMs > LINES_TIMEOUT_MS && (!observed.auditEvent || observed.linesReachedMs === null)) {
        observed.precondition = 'file-source audit event or live transcript lines missing within 120 s'
        break
      }
      if (nextCycle < cycleTimes.length && tMs >= cycleTimes[nextCycle]) {
        const action = await historyCycle(page, { index: nextCycle, tMs, term: 'synthetic' })
        const sample = await sampleMainLoop(inspector, probeFile)
        action.loopMaxMs = sample.ok ? sample.value.loopMaxSinceLastMs : Infinity
        observed.historyActions.push(action)
        nextCycle += 1
      } else {
        const sample = await sampleMainLoop(inspector, probeFile)
        observed.samples.push({ index: sampleIndex++, tMs, ...(sample.ok ? sample.value : { loopMaxSinceLastMs: Infinity, writeMs: Infinity, lookupMs: Infinity, resources: {} }) })
        await sleep(SAMPLE_EVERY_MS)
      }
    }

    if (!observed.precondition) {
      if (!(await page.evaluate(STOP_CLICK))) throw new Error('Stop control unavailable')
      const stopMs = Date.now() - captureStart
      const saved = await waitFor(() => {
        const now = meetingFiles(meetingsFolder).filter((file) => !before.includes(file))
        return now.length > 0 ? now : null
      }, SAVE_TIMEOUT_MS)
      const after = meetingFiles(meetingsFolder)
      observed.meetingFilesAfter = after.length
      observed.historyRowsAfter = await historyRowCount(page)
      observed.savedBytes = saved?.[0] && existsSync(saved[0]) ? statSync(saved[0]).size : 0
      observed.census.active = await activeCensus.done
      activeCensus = null
      const postNdjson = join(args.out, 'post-census.ndjson')
      const postCensus = startCensus({
        profileDir,
        installRoot,
        mainPid: child.pid,
        state: 'post-meeting',
        seconds: Math.ceil(args.postMinutes * 60),
        ndjson: postNdjson,
        auditCounts,
        evidence: 'file-fed capture stopped, saved meeting observed'
      })
      observed.census.post = await postCensus.done
      const summary = await summarizeMainLoop(inspector)
      observed.mainLoop = summary.ok ? summary.value : { p99Ms: Infinity, maxMs: Infinity }
      writeAuditCounts(auditCounts, { userData: profileDir, from: new Date(captureStart).toISOString(), bucketMinutes: 10 })
      const activeText = existsSync(activeNdjson) ? readFileSync(activeNdjson, 'utf8') : ''
      const postText = existsSync(postNdjson) ? readFileSync(postNdjson, 'utf8') : ''
      observed.sidecars = activeKindsFromNdjson(`${activeText}\n${postText}`)
      observed.sidecarCauses = {
        'llama-server': observed.sidecars['llama-server'] ? null : 'floor-refused-despite-override'
      }
      observed.growth = evaluateMeetingGrowth({
        active: activeText,
        post: postText,
        auditCounts: existsSync(auditCounts) ? readFileSync(auditCounts) : '',
        captureStartMs: 0,
        stopMs
      })
    }
  } catch (error) {
    classifyDriverError(observed, error, { preconditionCleared })
  } finally {
    activeCensus?.stop()
    page?.close()
    inspector?.close()
    child?.kill('SIGTERM')
    await sleep(500)
    child?.kill('SIGKILL')
    rmSync(workDir, { recursive: true, force: true })
  }

  const outcome = judgeMeetingHistory(observed)
  const report = buildMeetingHistoryReport(observed, outcome)
  const leaks = assertContentFreeReport(report)
  if (leaks.length > 0) {
    report.verdict = 'FAIL'
    report.failures = [...(report.failures ?? []), `content-free report violation: ${leaks.join(',')}`]
  }
  writeFileSync(join(args.out, 'meeting-history-report.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(`[meeting-history] ${report.verdict}`)
  return report.verdict === 'PASS' ? 0 : report.verdict === 'PRECONDITION' ? 2 : 1
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(await main())
