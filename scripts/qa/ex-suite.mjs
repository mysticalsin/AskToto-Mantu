#!/usr/bin/env node
/**
 * EX suite for M2-0033: automatic ingest never spends model work on a source it must hold, and no model-bound
 * maintenance starts in the first 120 s of a boot (BOOT_QUIET_PERIOD_MS, src/main/infra/scheduler/policy.ts).
 *
 *   node scripts/qa/ex-suite.mjs
 *       Hermetic: runs the EX vitest files (EX-1 and EX-3 in ingest-retry-policy.test.ts, EX-2 in
 *       ingest-maintenance-gate.test.ts) and exits with their status.
 *   node scripts/qa/ex-suite.mjs --packaged <installed app> <report.json> [--relaunches 3]
 *       Packaged: seeds a fresh ASKTOTO_USERDATA profile and meetings folder under the runner temp with the five
 *       ledger states, launches the installed app at least 3 times, samples the owned-process table through each
 *       boot, quits each launch through the app's own quit path (quit-app.mjs), and checks the ledger after every
 *       quit. A positive control then starts the bundled model on demand, so a census that saw no llama-server is
 *       shown to mean something on this runner.
 *
 * Both modes run in GitHub Actions only (owner decision D-28). Exit 0 PASS, 1 FAIL, 2 PRECONDITION. The packaged
 * report is content-free: state names, counts and timings; never a path, a file name or transcript text.
 */

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { freemem, tmpdir, totalmem } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { LOCAL_LLM_SETTINGS } from './lib/local-llm-settings.mjs'
import { listProcesses, ownedProcesses, roleCounts } from './owned-processes.mjs'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const QUIT_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'quit-app.mjs')

export const HERMETIC_TEST_FILES = Object.freeze([
  'src/main/brain/ingest-retry-policy.test.ts',
  'src/main/brain/ingest-maintenance-gate.test.ts'
])

/** BOOT_QUIET_PERIOD_MS and MAX_INGEST_ATTEMPTS (src/main/infra/scheduler/policy.ts). */
export const QUIET_PERIOD_MS = 120_000
export const MAX_INGEST_ATTEMPTS = 6

export const MIN_LAUNCHES = 3
export const LAUNCH_MIN_MS = 130_000
export const SAMPLE_INTERVAL_MS = 1_000
export const MAX_SAMPLE_GAP_MS = 2_000
export const READY_TIMEOUT_MS = 150_000
export const SETTLE_TIMEOUT_MS = 60_000
export const LEDGER_QUIET_MS = 5_000
export const QUIT_TIMEOUT_MS = 30_000
export const OWNED_EXIT_TIMEOUT_MS = 15_000
export const CONTROL_PREWARM_TIMEOUT_MS = 90_000
export const CONTROL_ASK_TIMEOUT_MS = 120_000
/** PREWARM_MIN_FREE_RAM_GB (src/main/llm/local-routing.ts); recorded as evidence only. */
export const PREWARM_MIN_FREE_RAM_GB = 4

/** Every wait the packaged run can make, at its bound: the job timeout must cover it. */
export function worstCaseRunMs(launches) {
  const perLaunch = Math.max(READY_TIMEOUT_MS, LAUNCH_MIN_MS) + SETTLE_TIMEOUT_MS + QUIT_TIMEOUT_MS + OWNED_EXIT_TIMEOUT_MS
  return launches * perLaunch + CONTROL_PREWARM_TIMEOUT_MS + CONTROL_ASK_TIMEOUT_MS
}

/** The five ledger states and the synthetic source each one is seeded on. Only the state names reach the report. */
export const STATE_FILES = Object.freeze({
  eligible: 'eligible.md',
  'backed-off': 'backedoff.md',
  exhausted: 'exhausted.md',
  unreadable: 'unreadable.md',
  'completed-unacked': 'unacked.md'
})
/** The slug the app files the unacked source's extraction under (.brain/meetings/<slug>.json). */
export const UNACKED_SLUG = 'unacked-md'
export const HELD_STATES = Object.freeze(['backed-off', 'exhausted', 'unreadable'])

const SYNTHETIC_DATES = Object.freeze({
  eligible: '2026-01-01',
  'backed-off': '2026-01-02',
  exhausted: '2026-01-03',
  unreadable: '2026-01-04',
  'completed-unacked': '2026-01-05'
})

/** A synthetic transcript: a date and one marker word, never meeting content. */
export function syntheticTranscript(state) {
  return `---\ndate: ${SYNTHETIC_DATES[state]}\n---\n${basename(STATE_FILES[state], '.md')} transcript body`
}

/** What one scan sees of a source (src/main/brain/inputs.ts observationOf). */
export function sourceObservation(stats) {
  return { version: `${Math.round(stats.mtimeMs)}:${stats.size}`, changedAtMs: Math.round(stats.ctimeMs) }
}

/**
 * The seeded .brain/index.json, in the shape the hermetic EX tests seed. Each record lists its fields in
 * BrainIndexSchema order (src/shared/brain.ts), the order the app writes them back in, so an untouched record
 * serializes to the same bytes after a rewrite. The eligible source has no record; the unacked one has only its
 * extraction file.
 */
export function seedIndex({ now, observations }) {
  const version = (state) => observations[STATE_FILES[state]].version
  return {
    ingested: {
      [STATE_FILES['backed-off']]: {
        at: now,
        ok: false,
        error: 'synthetic backed off',
        sourceVersion: version('backed-off'),
        attempts: 2,
        retryAfter: now + 60 * 60_000
      },
      [STATE_FILES.exhausted]: {
        at: now,
        ok: false,
        error: 'synthetic exhausted',
        sourceVersion: version('exhausted'),
        attempts: MAX_INGEST_ATTEMPTS,
        retryAfter: now - 1,
        exhausted: true
      },
      [STATE_FILES.unreadable]: {
        at: now,
        ok: false,
        error: 'synthetic unreadable',
        sourceVersion: version('unreadable'),
        attempts: 1,
        unreadable: { changedAtMs: observations[STATE_FILES.unreadable].changedAtMs }
      }
    },
    backfillRequested: true
  }
}

/** A completed extraction the ledger never acknowledged (MeetingExtractionSchema fills every other field). */
export const SEED_EXTRACTION = Object.freeze({ schema_version: 2, title24: 'Unacked synthetic extraction' })

/** Plaintext brain files (encryptTranscripts defaults to true) and a startable local model. */
export function seedSettings(meetingsFolder) {
  return { ...LOCAL_LLM_SETTINGS, encryptTranscripts: false, meetingsFolder }
}

/**
 * The launch env: the isolated profile, llama-server as the local engine, and the M2-0482 QA host-floor override,
 * so the RAM floors a 7 GiB hosted runner sits under do not refuse the model and the maintenance gate is the only
 * thing that can hold it in the quiet period. API keys and the HK-M hook are stripped.
 */
export function launchEnv(baseEnv, profile) {
  const env = { ...baseEnv, ASKTOTO_USERDATA: profile, METIS_DISABLE_APPLE_FM: '1', METIS_QA_HOST_FLOOR_OVERRIDE: '1' }
  for (const key of Object.keys(env)) if (/_API_KEY$/i.test(key)) delete env[key]
  delete env.METIS_HK_M_SCENARIO
  return env
}

/** Writes the seeded profile and meetings folder under `root`; returns their paths and the seeded record bytes. */
export function seedProfile(root, now = Date.now()) {
  const profile = join(root, 'profile')
  const meetingsFolder = join(root, 'meetings')
  mkdirSync(profile, { recursive: true, mode: 0o700 })
  mkdirSync(join(meetingsFolder, '.brain', 'meetings'), { recursive: true })
  for (const [state, file] of Object.entries(STATE_FILES)) writeFileSync(join(meetingsFolder, file), syntheticTranscript(state), 'utf8')
  const observations = Object.fromEntries(
    Object.values(STATE_FILES).map((file) => [file, sourceObservation(statSync(join(meetingsFolder, file)))])
  )
  const index = seedIndex({ now, observations })
  writeFileSync(join(meetingsFolder, '.brain', 'index.json'), JSON.stringify(index, null, 2), 'utf8')
  writeFileSync(join(meetingsFolder, '.brain', 'meetings', `${UNACKED_SLUG}.json`), JSON.stringify(SEED_EXTRACTION, null, 2), 'utf8')
  writeFileSync(join(profile, 'settings.json'), JSON.stringify(seedSettings(meetingsFolder), null, 2), { mode: 0o600 })
  return { profile, meetingsFolder, seeded: seededRecords(index) }
}

/** The serialized record of each held state, as seeded. */
export function seededRecords(index) {
  return Object.fromEntries(HELD_STATES.map((state) => [state, JSON.stringify(index.ingested[STATE_FILES[state]])]))
}

/**
 * The ledger after every quit. `snapshots[i]` is `{ index, extractionSha256 }` read after boot i + 1 quit (index
 * null when unreadable). Held records must stay byte-for-byte as seeded. The unacked source is ok after every
 * boot and its extraction never changes after the first. The eligible source is attempted at most once: its record
 * appears at most once, never with more than one attempt, and never changes after it appears.
 */
export function ledgerVerdict(seeded, snapshots) {
  const failures = []
  const states = {
    'backed-off': 'unchanged',
    exhausted: 'unchanged',
    unreadable: 'unchanged',
    'completed-unacked': { mergedAfterFirstBoot: false, extractionStable: true },
    eligible: { outcome: 'not-attempted', attempts: 0, changedAfterAttempt: false }
  }
  let eligibleSeen = null
  snapshots.forEach(({ index, extractionSha256 }, i) => {
    const boot = i + 1
    if (!index || typeof index.ingested !== 'object' || index.ingested === null) {
      failures.push(`boot ${boot}: the ledger was unreadable after quit`)
      return
    }
    const record = (state) => index.ingested[STATE_FILES[state]]
    for (const state of HELD_STATES) {
      if (JSON.stringify(record(state)) !== seeded[state] && states[state] === 'unchanged') {
        states[state] = `changed-after-boot-${boot}`
        failures.push(`boot ${boot}: the ${state} record changed`)
      }
    }
    const unacked = states['completed-unacked']
    if (record('completed-unacked')?.ok !== true) failures.push(`boot ${boot}: the completed-unacked source is not ok`)
    else if (boot === 1) unacked.mergedAfterFirstBoot = true
    if (!extractionSha256) failures.push(`boot ${boot}: the completed-unacked extraction is missing`)
    else if (boot > 1 && extractionSha256 !== snapshots[0].extractionSha256 && unacked.extractionStable) {
      unacked.extractionStable = false
      failures.push(`boot ${boot}: the completed-unacked extraction was re-extracted`)
    }
    const eligible = record('eligible')
    const summary = states.eligible
    if (eligible === undefined) {
      if (eligibleSeen !== null) failures.push(`boot ${boot}: the eligible record disappeared`)
      return
    }
    const serialized = JSON.stringify(eligible)
    summary.outcome = eligible.ok ? 'ok' : 'failed-held'
    summary.attempts = eligible.attempts ?? 0
    if (summary.attempts > 1) failures.push(`boot ${boot}: the eligible source has ${summary.attempts} attempts`)
    if (eligibleSeen !== null && serialized !== eligibleSeen && !summary.changedAfterAttempt) {
      summary.changedAfterAttempt = true
      failures.push(`boot ${boot}: the eligible source was attempted again`)
    }
    eligibleSeen ??= serialized
  })
  return { failures, states }
}

const HELD_COUNT_FIELDS = Object.freeze(['heldExhausted', 'heldBackedOff', 'heldUnreadable'])

/**
 * scheduler.job audits across the run: at least one backfill scan, every scan carrying the three held counts, every
 * automatic scan holding each seeded held state, and no record naming a seeded source.
 */
export function schedulerVerdict(records) {
  const jobs = records.filter((record) => record?.event === 'scheduler.job')
  const scans = jobs.filter((record) => record.kind === 'backfill' && record.outcome === 'scanned')
  const failures = []
  if (scans.length === 0) failures.push('no backfill scan was audited')
  if (scans.some((scan) => HELD_COUNT_FIELDS.some((field) => !Number.isInteger(scan[field])))) {
    failures.push('a backfill scan audit carries no held counts')
  }
  const automatic = scans.filter((scan) => scan.trigger === 'automatic')
  if (automatic.some((scan) => HELD_COUNT_FIELDS.some((field) => !(scan[field] >= 1)))) {
    failures.push('an automatic scan did not hold every seeded held state')
  }
  const text = JSON.stringify(jobs)
  if ([...Object.values(STATE_FILES), UNACKED_SLUG].some((name) => text.includes(name))) {
    failures.push('a scheduler.job audit names a source file')
  }
  return {
    failures,
    scans: scans.map((scan) => ({
      trigger: scan.trigger === 'user' || scan.trigger === 'automatic' ? scan.trigger : 'unknown',
      queued: Number.isInteger(scan.queued) ? scan.queued : null,
      revived: Number.isInteger(scan.revived) ? scan.revived : null,
      ...Object.fromEntries(HELD_COUNT_FIELDS.map((field) => [field, Number.isInteger(scan[field]) ? scan[field] : null]))
    }))
  }
}

/**
 * Start offsets (ms after main's own start) of the owned llama-servers in `table` that this boot started. Both
 * start times come from the same 1-s-resolution process table, so a server started at or after main + 120 s never
 * reads below 120 000. Null when main is not in the table.
 */
export function llamaStartOffsets(table, { mainPid, installRoot, platform = 'darwin' }) {
  const main = table.find((entry) => entry.pid === mainPid)
  if (!main) return null
  return ownedProcesses(table, { mainPid, installRoot, platform })
    .filter((entry) => entry.role === 'llama-server' && entry.startedMs >= main.startedMs)
    .map((entry) => entry.startedMs - main.startedMs)
}

export function initialCensus(spawnedAtMs) {
  return { samples: 0, lastAtMs: spawnedAtMs, spawnedAtMs, maxGapMs: 0, mainSeen: false, firstLlamaStartMs: null }
}

/** One census sample. The sampling gap counts only while the quiet period can still be violated. */
export function censusStep(state, { atMs, table, mainPid, installRoot, platform = 'darwin' }) {
  const next = { ...state, samples: state.samples + 1, lastAtMs: atMs }
  if (state.lastAtMs - state.spawnedAtMs <= QUIET_PERIOD_MS) next.maxGapMs = Math.max(state.maxGapMs, atMs - state.lastAtMs)
  const offsets = llamaStartOffsets(table, { mainPid, installRoot, platform })
  if (offsets === null) return next
  next.mainSeen = true
  for (const offset of offsets) {
    if (next.firstLlamaStartMs === null || offset < next.firstLlamaStartMs) next.firstLlamaStartMs = offset
  }
  return next
}

/** A boot's own audit records: how the previous run ended, when the maintenance window opened, model starts. */
export function bootAudit(records, spawnedAtMs) {
  const started = records.find((record) => record?.event === 'app.started')
  const windowOpen = records.find(
    (record) => record?.event === 'scheduler.job' && record.kind === 'model-work' && record.outcome === 'window-open'
  )
  const modelStarts = records
    .filter(
      (record) =>
        record?.event === 'local.runtime.start' || (record?.event === 'sidecar.spawn' && record.name === 'llama-server')
    )
    .map((record) => Date.parse(record.ts) - spawnedAtMs)
    .filter(Number.isFinite)
  const prev = started?.prevShutdown
  return {
    prevShutdown: prev === 'clean' || prev === 'unclean' || prev === 'unknown' ? prev : null,
    windowOpenUptimeMs: Number.isFinite(windowOpen?.uptimeMs) ? windowOpen.uptimeMs : null,
    firstAuditedModelStartMs: modelStarts.length ? Math.min(...modelStarts) : null
  }
}

/** Per-boot checks: no llama-server in the quiet period (census or audit), a clean prior exit from boot 2 on, a
 *  clean quit, and a census that sampled often enough to be evidence. */
export function bootVerdict(boots) {
  const failures = []
  const preconditions = []
  for (const boot of boots) {
    const n = boot.boot
    if (boot.failure) failures.push(`boot ${n}: ${boot.failure}`)
    if (boot.census) {
      if (!boot.census.mainSeen) preconditions.push(`boot ${n}: the census never saw the main process`)
      if (boot.census.maxGapMs > MAX_SAMPLE_GAP_MS) {
        preconditions.push(`boot ${n}: the census left a ${boot.census.maxGapMs} ms gap in the quiet period`)
      }
      if (boot.census.firstLlamaStartMs !== null && boot.census.firstLlamaStartMs < QUIET_PERIOD_MS) {
        failures.push(`boot ${n}: llama-server started ${Math.round(boot.census.firstLlamaStartMs / 1000)} s after boot`)
      }
    }
    const audit = boot.audit
    if (audit) {
      if (audit.firstAuditedModelStartMs !== null && audit.firstAuditedModelStartMs < QUIET_PERIOD_MS) {
        failures.push(`boot ${n}: a local model start was audited ${Math.round(audit.firstAuditedModelStartMs / 1000)} s after boot`)
      }
      if (audit.windowOpenUptimeMs !== null && audit.windowOpenUptimeMs < QUIET_PERIOD_MS) {
        failures.push(`boot ${n}: the maintenance window opened ${Math.round(audit.windowOpenUptimeMs / 1000)} s after boot`)
      }
      if (n > 1 && audit.prevShutdown !== 'clean') failures.push(`boot ${n}: the previous launch did not end cleanly`)
    }
    if (boot.quit && boot.quit.outcome !== 'clean') failures.push(`boot ${n}: the quit path did not end the app`)
  }
  return { failures, preconditions }
}

/** The outcome in one place: any FAIL is 1; a precondition, or a control that could not start the model, is 2. */
export function verdict({ failures, preconditions, control }) {
  if (failures.length) return { result: 'FAIL', exitCode: 1 }
  if (preconditions.length || control?.status !== 'PASS') return { result: 'PRECONDITION', exitCode: 2 }
  return { result: 'PASS', exitCode: 0 }
}

/** The control's report block when no app path started the model on this runner. */
export function blockedControl(refused, detail = {}) {
  return {
    status: 'BLOCKED_EXTERNAL',
    path: null,
    refused,
    censusMeaningful: false,
    note: 'No app path started llama-server on this runner, so the 120-s census could not be shown to be meaningful.',
    unblock: 'Run on a host where window.toto.localPrewarm or a local suggest request starts the bundled model.',
    ...detail
  }
}

/** Both modes run in GitHub Actions only (D-28). */
export function ciOnlyProblem(env) {
  return env.GITHUB_ACTIONS === 'true' ? null : 'ex-suite runs in GitHub Actions only (owner decision D-28).'
}

export function hermeticArgv(root = REPO_ROOT) {
  return [join(root, 'node_modules', 'vitest', 'vitest.mjs'), 'run', ...HERMETIC_TEST_FILES]
}

export function parseArgs(argv) {
  if (argv.length === 0) return { mode: 'hermetic' }
  if (argv[0] !== '--packaged') throw new Precondition(USAGE)
  const [, appPath, reportPath, ...rest] = argv
  if (!appPath || !reportPath || appPath.startsWith('--') || reportPath.startsWith('--')) throw new Precondition(USAGE)
  let launches = MIN_LAUNCHES
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--relaunches') launches = Number(rest[++i])
    else throw new Precondition(USAGE)
  }
  if (!Number.isInteger(launches) || launches < MIN_LAUNCHES) throw new Precondition(`--relaunches must be an integer of at least ${MIN_LAUNCHES}.`)
  return { mode: 'packaged', appPath, reportPath, launches }
}

const USAGE = 'usage: node scripts/qa/ex-suite.mjs [--packaged <installed app> <report.json> [--relaunches 3]]'

class Precondition extends Error {}

// --- Everything below drives the installed app; it runs only when this script is executed directly. ----------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() >= deadline) return undefined
    await sleep(intervalMs)
  }
}

function freeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

function readAudit(profile) {
  let text
  try {
    text = readFileSync(join(profile, 'logs', 'audit.log'), 'utf8')
  } catch {
    return []
  }
  const records = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      records.push(JSON.parse(line))
    } catch {
      /* a partial last line */
    }
  }
  return records
}

function readLedger(meetingsFolder) {
  let index = null
  try {
    index = JSON.parse(readFileSync(join(meetingsFolder, '.brain', 'index.json'), 'utf8'))
  } catch {
    index = null
  }
  let extractionSha256 = null
  try {
    extractionSha256 = createHash('sha256')
      .update(readFileSync(join(meetingsFolder, '.brain', 'meetings', `${UNACKED_SLUG}.json`)))
      .digest('hex')
  } catch {
    extractionSha256 = null
  }
  return { index, extractionSha256 }
}

function ledgerStamp(meetingsFolder) {
  try {
    const stats = statSync(join(meetingsFolder, '.brain', 'index.json'))
    return `${stats.mtimeMs}:${stats.size}`
  } catch {
    return 'missing'
  }
}

function hostMemory() {
  let availableBytes = null
  try {
    const output = spawnSync('/usr/bin/vm_stat', [], { encoding: 'utf8', timeout: 2_000 }).stdout ?? ''
    const pageSize = /page size of (\d+) bytes/.exec(output)
    if (pageSize) {
      let pages = 0
      for (const kind of ['free', 'inactive', 'speculative', 'purgeable']) {
        pages += Number(new RegExp(`^Pages ${kind}:\\s+(\\d+)`, 'm').exec(output)?.[1] ?? 0)
      }
      availableBytes = pages * Number(pageSize[1])
    }
  } catch {
    availableBytes = null
  }
  const available = availableBytes ?? freemem()
  return { totalmemBytes: totalmem(), availableBytes: available, prewarmFloorPasses: available / 1024 ** 3 >= PREWARM_MIN_FREE_RAM_GB }
}

async function withTotoPage(port, timeoutMs, fn) {
  const { chromium } = await import('playwright-core')
  const found = await waitFor(async () => {
    let browser
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
      for (const context of browser.contexts()) {
        for (const page of context.pages()) {
          try {
            if (await page.evaluate(() => typeof window.toto !== 'undefined')) return { browser, page }
          } catch {
            /* not the app page, or it navigated */
          }
        }
      }
      await browser.close()
    } catch {
      if (browser) await browser.close().catch(() => {})
    }
    return undefined
  }, timeoutMs)
  if (!found) return { reached: false }
  try {
    return { reached: true, value: await fn(found.page) }
  } finally {
    await found.browser.close().catch(() => {})
  }
}

function killOwned(installRoot, mainPid) {
  for (const entry of ownedProcesses(listProcesses('darwin'), { mainPid, installRoot, platform: 'darwin' })) {
    try {
      process.kill(entry.pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
}

/** Quits through the app's own path (quit-app.mjs over CDP), then waits for main and every owned process to end. */
async function quitCleanly({ port, child, exit, installRoot }) {
  const startedAt = Date.now()
  const quit = { outcome: 'timeout', quitMs: null, exitCode: null, leftoverAfterQuit: {} }
  while (!exit.settled && Date.now() - startedAt < QUIT_TIMEOUT_MS) {
    const result = spawnSync(process.execPath, [QUIT_SCRIPT], {
      env: { ...process.env, METIS_CDP: `http://127.0.0.1:${port}` },
      encoding: 'utf8',
      timeout: QUIT_TIMEOUT_MS
    })
    if (String(result.stdout).includes('quit requested')) break
    await sleep(1_000)
  }
  await waitFor(() => exit.settled, Math.max(0, QUIT_TIMEOUT_MS - (Date.now() - startedAt)), 250)
  if (exit.settled) {
    quit.outcome = 'clean'
    quit.quitMs = Date.now() - startedAt
    quit.exitCode = exit.code
  } else {
    killOwned(installRoot, child.pid)
  }
  const residents = () => ownedProcesses(listProcesses('darwin'), { mainPid: null, installRoot, platform: 'darwin' })
  if (!(await waitFor(() => residents().length === 0, OWNED_EXIT_TIMEOUT_MS, 500))) {
    quit.leftoverAfterQuit = roleCounts(residents())
    killOwned(installRoot, null)
  }
  return quit
}

/**
 * After the last census window: start the bundled model through window.toto.localPrewarm, then, if that path
 * starts nothing (its free-RAM floor, or any other refusal), through an explicit local suggest request.
 */
async function positiveControl({ port, mainPid, installRoot, profile, auditFrom }) {
  const memory = hostMemory()
  const running = () => {
    const table = listProcesses('darwin')
    return ownedProcesses(table, { mainPid, installRoot, platform: 'darwin' }).some((entry) => entry.role === 'llama-server')
  }
  const alreadyRunning = running()
  const refused = []
  const paths = [
    {
      name: 'window.toto.localPrewarm',
      timeoutMs: CONTROL_PREWARM_TIMEOUT_MS,
      start: (page) => page.evaluate(() => window.toto.localPrewarm('ex-suite positive control'))
    },
    {
      name: 'window.toto.ask (suggest, local route)',
      timeoutMs: CONTROL_ASK_TIMEOUT_MS,
      start: (page) =>
        page.evaluate(() => {
          window.toto
            .ask({ id: `ex-suite-control-${Date.now()}`, mode: 'suggest', prompt: '', transcript: 'THEM: hello there', history: [] })
            .catch(() => undefined)
        })
    }
  ]
  const localAudit = () => {
    const records = readAudit(profile).slice(auditFrom)
    const count = (event) => records.filter((record) => record?.event === event).length
    return {
      localRuntimeStart: count('local.runtime.start'),
      localRuntimeMissing: count('local.runtime.missing'),
      hostFloorOverride: count('local.host-floor-override')
    }
  }
  for (const path of paths) {
    const startedAt = Date.now()
    const attached = await withTotoPage(port, 30_000, (page) => path.start(page).catch(() => undefined))
    if (!attached.reached) {
      refused.push(`${path.name} (bridge unreachable)`)
      continue
    }
    if (await waitFor(running, path.timeoutMs, 500)) {
      return {
        status: 'PASS',
        path: path.name,
        refused,
        censusMeaningful: true,
        alreadyRunning,
        llamaObservedMs: Date.now() - startedAt,
        memory,
        audit: localAudit()
      }
    }
    refused.push(path.name)
  }
  return blockedControl(refused, { alreadyRunning, memory, audit: localAudit() })
}

const EXITED_EARLY = 'the app exited before it was quit'

async function runLaunch({ boot, last, executable, installRoot, profile, meetingsFolder, meetingsReal }) {
  const port = await freeLoopbackPort()
  const auditFrom = readAudit(profile).length
  const spawnedAt = Date.now()
  const child = spawn(executable, [`--remote-debugging-port=${port}`], { env: launchEnv(process.env, profile), stdio: 'ignore' })
  const exit = { settled: false, code: null }
  child.once('exit', (code) => Object.assign(exit, { settled: true, code }))
  child.once('error', () => Object.assign(exit, { settled: true }))

  let census = initialCensus(spawnedAt)
  const sample = () => {
    try {
      census = censusStep(census, { atMs: Date.now(), table: listProcesses('darwin'), mainPid: child.pid, installRoot })
    } catch {
      /* a failed ps read leaves a gap, which the verdict reports */
    }
  }
  sample()
  const timer = setInterval(sample, SAMPLE_INTERVAL_MS)
  const result = { boot, readyMs: null, durationMs: null, settleMs: null, census: null, audit: null, quit: null, control: null }
  // The same object the finally block completes (census, audit), so an early return still reports both.
  const fail = (failure) => Object.assign(result, { failure })
  const bootRecords = () => readAudit(profile).slice(auditFrom)
  const stopCensus = () => {
    clearInterval(timer)
    result.census = { ...census, lastAtMs: undefined, spawnedAtMs: undefined }
  }
  try {
    const ready = await waitFor(
      () => exit.settled || bootRecords().some((record) => record?.event === 'app.renderer.ready'),
      READY_TIMEOUT_MS,
      500
    )
    if (exit.settled) return fail(EXITED_EARLY)
    if (!ready) return fail('the renderer never became ready')
    result.readyMs = Date.now() - spawnedAt

    if (boot === 1) {
      const folder = await withTotoPage(port, 60_000, (page) => page.evaluate(async () => (await window.toto.getSettings()).resolvedMeetingsFolder))
      let same = false
      try {
        same = folder.reached && realpathSync.native(folder.value) === meetingsReal
      } catch {
        same = false
      }
      if (!same) throw new Precondition('The app did not open the seeded meetings folder, so its ledger was never measured.')
    }

    await waitFor(() => exit.settled || Date.now() - spawnedAt >= LAUNCH_MIN_MS, LAUNCH_MIN_MS, 500)
    if (exit.settled) return fail(EXITED_EARLY)

    // Settle: the maintenance window has opened and the ledger has been quiet for LEDGER_QUIET_MS.
    const settleStart = Date.now()
    let stamp = ledgerStamp(meetingsFolder)
    let quietSince = Date.now()
    await waitFor(() => {
      const now = ledgerStamp(meetingsFolder)
      if (now !== stamp) {
        stamp = now
        quietSince = Date.now()
      }
      const windowOpen = bootAudit(bootRecords(), spawnedAt).windowOpenUptimeMs !== null
      return exit.settled || (windowOpen && Date.now() - quietSince >= LEDGER_QUIET_MS)
    }, SETTLE_TIMEOUT_MS, 500)
    result.settleMs = Date.now() - settleStart
    if (exit.settled) return fail(EXITED_EARLY)

    stopCensus()
    if (last) result.control = await positiveControl({ port, mainPid: child.pid, installRoot, profile, auditFrom })
    result.durationMs = Date.now() - spawnedAt
    result.quit = await quitCleanly({ port, child, exit, installRoot })
    return result
  } finally {
    if (result.census === null) stopCensus()
    if (!exit.settled) killOwned(installRoot, child.pid)
    result.audit = bootAudit(bootRecords(), spawnedAt)
  }
}

async function runPackaged({ appPath, reportPath, launches }) {
  const report = {
    schema: 1,
    ticket: 'M2-0033',
    mode: 'packaged',
    launches,
    quietPeriodMs: QUIET_PERIOD_MS,
    launchMinMs: LAUNCH_MIN_MS,
    sampleIntervalMs: SAMPLE_INTERVAL_MS,
    hostFloorOverride: true,
    states: Object.keys(STATE_FILES),
    boots: [],
    ledger: null,
    scheduler: null,
    control: null,
    failures: [],
    preconditions: [],
    result: 'PRECONDITION',
    exitCode: 2
  }
  const write = () => {
    mkdirSync(dirname(reportPath), { recursive: true })
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  }
  let root = null
  try {
    if (process.platform !== 'darwin') throw new Precondition('The packaged EX suite runs on macOS only.')
    if (!appPath.endsWith('.app') || !existsSync(appPath)) throw new Precondition('The installed app is not a .app bundle.')
    const installRoot = realpathSync.native(appPath)
    const executable = join(installRoot, 'Contents', 'MacOS', basename(installRoot, '.app'))
    if (!existsSync(executable)) throw new Precondition('The app bundle has no executable.')
    if (ownedProcesses(listProcesses('darwin'), { mainPid: null, installRoot, platform: 'darwin' }).length > 0) {
      throw new Precondition('The install root already has running processes.')
    }

    root = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'metis-ex-suite-'))
    const { profile, meetingsFolder, seeded } = seedProfile(root)
    const meetingsReal = realpathSync.native(meetingsFolder)
    report.host = hostMemory()
    const snapshots = []
    for (let boot = 1; boot <= launches; boot++) {
      const launch = await runLaunch({ boot, last: boot === launches, executable, installRoot, profile, meetingsFolder, meetingsReal })
      if (launch.control) {
        report.control = launch.control
        delete launch.control
      }
      report.boots.push(launch)
      snapshots.push(readLedger(meetingsFolder))
      console.log(
        `[ex-suite] boot ${boot}: ready ${launch.readyMs ?? '-'} ms, first llama-server ${launch.census?.firstLlamaStartMs ?? 'none'}, quit ${launch.quit?.outcome ?? '-'}`
      )
      if (launch.failure) break
    }
    const ledger = ledgerVerdict(seeded, snapshots)
    const scheduler = schedulerVerdict(readAudit(profile))
    const boots = bootVerdict(report.boots)
    report.ledger = ledger.states
    report.scheduler = { scans: scheduler.scans }
    report.failures = [...boots.failures, ...ledger.failures, ...scheduler.failures]
    report.preconditions = boots.preconditions
    if (!report.control) report.control = blockedControl([], { note: 'The run ended before the control ran.' })
  } catch (error) {
    // A harness error is a FAIL, recorded by class only: its message can carry a path.
    if (error instanceof Precondition) report.preconditions.push(error.message)
    else report.failures.push(`harness error (${error?.name ?? 'Error'})`)
    report.control ??= blockedControl([], { note: 'The run ended before the control ran.' })
  } finally {
    Object.assign(report, verdict(report))
    write()
    if (root) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
  return report
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const ciOnly = ciOnlyProblem(process.env)
  if (ciOnly) throw new Precondition(ciOnly)
  if (args.mode === 'hermetic') {
    const child = spawnSync(process.execPath, hermeticArgv(), { cwd: REPO_ROOT, stdio: 'inherit' })
    return child.status ?? 1
  }
  const report = await runPackaged(args)
  if (report.exitCode !== 0) {
    const reasons = [...report.failures, ...report.preconditions]
    if (report.control?.status !== 'PASS') reasons.push(`positive control ${report.control?.status}`)
    console.error(`[ex-suite] ${report.result}: ${reasons.join('; ')}`)
  }
  return report.exitCode
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`[ex-suite] ${error instanceof Precondition ? error.message : error?.name ?? 'Error'}`)
      process.exit(error instanceof Precondition ? 2 : 1)
    }
  )
}
