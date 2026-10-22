// WP14 sandbox acceptance, opt-in scenario `--scenario stress` (C31): the pure helpers. Nothing here launches an app or opens a
// page; every function takes what it needs as arguments, so the unit tests run on any host. The runtime half (launching the
// installed QA build, clicking, killing, relaunching) lives in stress.mjs and calls these to turn observations into verdicts.
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { median, theilSenSlope } from '../soak/growth.mjs'

export const MIB = 1024 * 1024
export const MINUTE_MS = 60_000

/** The eight stress cases, in the order they run. */
export const STRESS_CASES = Object.freeze(['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'])

/** Step ids per case, as `--dry-run` prints them (a case that is not selected contributes none). */
export const CASE_STEPS = Object.freeze({
  s1: ['s1-start-stop-spam'],
  s2: ['s2-kill9-mid-meeting', 's2-journal-tail'],
  s3: ['s3-kill9-during-save'],
  s4: ['s4-relaunch-loop'],
  s5: [
    's5-create-meetings',
    's5-start-click-reliable',
    's5-history-lists-all',
    's5-search-works',
    's5-delete-confirm',
    's5-external-delete-consistent'
  ],
  s6: ['s6-settings-churn'],
  s7: ['s7-long-meeting-memory'],
  s8: ['s8-overlay-click-spam']
})

export const stressSteps = (cases = STRESS_CASES) => ['install', ...cases.flatMap((id) => CASE_STEPS[id] ?? [])]

/** `s1,s3` or `all` to a validated, ordered list; throws on an unknown id. */
export function parseCases(text) {
  const raw = String(text ?? 'all')
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
  if (raw.length === 0 || raw.includes('all')) return [...STRESS_CASES]
  const unknown = raw.filter((id) => !STRESS_CASES.includes(id))
  if (unknown.length)
    throw new Error(`unknown stress case ${unknown.join(', ')}; use ${STRESS_CASES.join(', ')} or all`)
  return STRESS_CASES.filter((id) => raw.includes(id))
}

/** Small seeded generator so a run's click rhythm is reproducible (mulberry32). */
export function seededRandom(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** `count` pauses between clicks, each in [minMs, maxMs]. */
export function spamGaps({ count, minMs, maxMs, seed = 1 }) {
  const random = seededRandom(seed)
  return Array.from({ length: count }, () => Math.round(minMs + random() * (maxMs - minMs)))
}

// ---------------------------------------------------------------------------------------------------------------
// Renderer responsiveness

/**
 * @param {{ ms: number | null, timedOut?: boolean }[]} samples one entry per probe; ms is null when the probe never returned
 * @param {number} [limitMs]
 */
export function summarizeLatency(samples, limitMs = 2000) {
  const answered = samples
    .filter((sample) => sample.ms !== null && Number.isFinite(sample.ms))
    .map((sample) => sample.ms)
  const sorted = [...answered].sort((a, b) => a - b)
  const at = (fraction) =>
    sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] : null
  const timeouts = samples.filter((sample) => sample.timedOut || sample.ms === null).length
  return {
    probes: samples.length,
    answered: answered.length,
    timeouts,
    limitMs,
    overLimit: answered.filter((ms) => ms >= limitMs).length,
    medianMs: median(answered),
    p95Ms: at(0.95),
    maxMs: sorted.length ? sorted[sorted.length - 1] : null
  }
}

/** Problems with a latency summary: it needs probes, no timeout and nothing at or over the limit. */
export function latencyProblems(summary, label = 'renderer') {
  const problems = []
  if (summary.probes === 0) problems.push(`no ${label} responsiveness probe ran`)
  if (summary.timeouts > 0)
    problems.push(`${summary.timeouts} ${label} probe(s) did not answer within ${summary.limitMs} ms`)
  if (summary.overLimit > 0)
    problems.push(`${summary.overLimit} ${label} probe(s) took ${summary.limitMs} ms or more (max ${summary.maxMs} ms)`)
  return problems
}

// ---------------------------------------------------------------------------------------------------------------
// Audit records

/** Audit events that mean the app died, hung or failed to start: any of these during a stress case is a FAIL. */
export const FATAL_AUDIT_EVENTS = Object.freeze([
  'app.crash',
  'app.unresponsive',
  'app.render_loop_halted',
  'app.error.boot_step',
  'app.error.early_death',
  'app.error.reload_failed',
  'app.error.window_create',
  'settings.profile_recovered'
])

/** Events worth showing next to a verdict without failing it. */
export const NOTABLE_AUDIT_EVENTS = Object.freeze([
  'app.stall',
  'app.recovery',
  'capture.failed',
  'meeting.journal.degraded',
  'meeting.speech.worker.degraded',
  'local.runtime.crash',
  'security.ipc_denied',
  'security.rate_limited',
  'ipc.refused'
])

/** Counts by event name over parsed audit records, split into fatal and notable. Names only, never fields. */
export function classifyAudit(records) {
  const counts = {}
  for (const record of records)
    if (typeof record?.event === 'string') counts[record.event] = (counts[record.event] ?? 0) + 1
  const pick = (names) => Object.fromEntries(names.filter((name) => counts[name]).map((name) => [name, counts[name]]))
  return { counts, fatal: pick(FATAL_AUDIT_EVENTS), notable: pick(NOTABLE_AUDIT_EVENTS) }
}

export const fatalProblems = (classified) =>
  Object.entries(classified.fatal).map(([event, count]) => `${count} ${event} audit record(s)`)

/** Parsed audit record `ts` (ISO) as epoch ms, or null. */
export const auditTime = (record) => {
  const ms = Date.parse(record?.ts ?? '')
  return Number.isFinite(ms) ? ms : null
}

/** Milliseconds between the first `app.started` and the first `app.renderer.ready` in a launch's records, or null. */
export function bootMsFromAudit(records) {
  const started = records.find((record) => record?.event === 'app.started')
  const ready = records.find((record) => record?.event === 'app.renderer.ready')
  const a = auditTime(started)
  const b = auditTime(ready)
  return a !== null && b !== null && b >= a ? b - a : null
}

// ---------------------------------------------------------------------------------------------------------------
// Meeting files

const STAMP = /^(\d{4}-\d{2}-\d{2}_\d{6})-/

/** The second-resolution start stamp a saved meeting's name begins with, or null. */
export const stampOf = (name) => STAMP.exec(name)?.[1] ?? null

/** Leftovers of an interrupted write: an atomic-write temp (`<file>.<hex>.tmp`) or a conventional partial. */
export const isStragglerFile = (name) =>
  /\.(tmp|part|partial|bak|swp|new)$/i.test(name) || /~$/.test(name) || /^\.tmp-/.test(name)

/**
 * Meetings that look like the same one saved twice: two names with the same start stamp (a meeting is one start instant),
 * or two files with identical bytes.
 * @param {{ name: string, sha256?: string }[]} entries
 */
export function findDuplicateMeetings(entries) {
  const group = (keyOf) => {
    const map = new Map()
    for (const entry of entries) {
      const key = keyOf(entry)
      if (!key) continue
      map.set(key, [...(map.get(key) ?? []), entry.name])
    }
    return [...map.values()].filter((names) => names.length > 1)
  }
  return { sameStamp: group((entry) => stampOf(entry.name)), sameBytes: group((entry) => entry.sha256 ?? null) }
}

/** True when the first bytes are an encrypted-at-rest header or plain frontmatter, and the file is not empty or NUL-filled. */
export function looksIntact(head, totalBytes) {
  if (!totalBytes || !head || head.length === 0) return false
  const text = Buffer.from(head).toString('latin1')
  if (/^\0+$/.test(text)) return false
  return text.startsWith('ATKENC') || text.startsWith('---')
}

/**
 * What a meetings folder holds, from a name -> { sha256, bytes } snapshot of it (see upgrade.mjs snapshotMeetings).
 * @param {{ saved: Record<string, { sha256: string, bytes: number }>, others: Record<string, { sha256: string, bytes: number }> }} snapshot
 */
export function classifyFolder(snapshot) {
  const saved = Object.keys(snapshot.saved).sort()
  const otherNames = Object.keys(snapshot.others).sort()
  const drafts = otherNames.filter((name) => name.startsWith('.autosave-draft-'))
  const stragglers = [...saved, ...otherNames].filter(isStragglerFile)
  const duplicates = findDuplicateMeetings(saved.map((name) => ({ name, sha256: snapshot.saved[name].sha256 })))
  return { saved, drafts, stragglers, duplicates, otherNames }
}

// ---------------------------------------------------------------------------------------------------------------
// Case verdicts: each returns the list of problems (empty = pass); the runner turns problems into FAIL evidence.

/** S1: the app survived 20 rapid Start/Stop clicks and ended idle with nothing left capturing. */
export function judgeSpam({
  clicks,
  mainAlive,
  fatal,
  latency,
  settledIdle,
  stuck,
  liveTracks,
  trackProbeEffective,
  folder,
  unreadable,
  leftoverProcesses
}) {
  const problems = []
  if (clicks.start + clicks.stop < clicks.planned / 2)
    problems.push(`only ${clicks.start + clicks.stop} of ${clicks.planned} clicks found a Start or Stop control`)
  if (!mainAlive) problems.push('the main process is no longer running')
  problems.push(...fatalProblems({ fatal }))
  problems.push(...latencyProblems(latency))
  if (stuck) problems.push('the overlay was stuck (neither Start nor Stop reachable) and never settled')
  else if (!settledIdle) problems.push('the app did not end idle (Start listening reachable, no live meeting)')
  if (trackProbeEffective && liveTracks > 0)
    problems.push(`${liveTracks} audio track(s) still live after the meeting ended (orphan capture)`)
  if (folder.stragglers.length)
    problems.push(`partial files left in the meetings folder: ${folder.stragglers.join(', ')}`)
  if (folder.duplicates.sameStamp.length || folder.duplicates.sameBytes.length)
    problems.push(`duplicate meeting files: ${JSON.stringify(folder.duplicates)}`)
  if (unreadable.length) problems.push(`meeting file(s) that do not open: ${unreadable.join(', ')}`)
  if (leftoverProcesses > 0)
    problems.push(`${leftoverProcesses} owned process(es) beyond the idle baseline plus allowance`)
  return problems
}

/**
 * S2 / S3: after a SIGKILL and a relaunch the profile must hold exactly `expectedMeetings` readable meetings, no duplicate,
 * no leftover draft and no partial write.
 */
export function judgeKillRecovery({
  expectedMeetings = 1,
  folder,
  listed,
  unreadable,
  minLines,
  lines,
  fatal,
  mainAlive = true
}) {
  const problems = []
  if (folder.saved.length !== expectedMeetings)
    problems.push(`${folder.saved.length} saved meeting file(s) on disk, expected exactly ${expectedMeetings}`)
  if (listed !== expectedMeetings)
    problems.push(`History lists ${listed} meeting(s), expected exactly ${expectedMeetings}`)
  if (folder.duplicates.sameStamp.length || folder.duplicates.sameBytes.length)
    problems.push(`duplicate meeting files: ${JSON.stringify(folder.duplicates)}`)
  if (folder.drafts.length) problems.push(`${folder.drafts.length} autosave draft(s) left beside the recovered meeting`)
  if (folder.stragglers.length) problems.push(`partial files left on disk: ${folder.stragglers.join(', ')}`)
  if (unreadable.length) problems.push(`meeting file(s) that are corrupt or do not open: ${unreadable.join(', ')}`)
  if (lines !== null && lines < minLines)
    problems.push(`the meeting holds ${lines} transcript line(s), expected at least ${minLines}`)
  if (!mainAlive) problems.push('the relaunched app is not running')
  problems.push(...fatalProblems({ fatal }))
  return problems
}

/**
 * S4: every cycle shut down cleanly and the next one saw it; nothing grew.
 * @param {{ cycle: number, startupMs: number, bootMs: number | null, clean: boolean, cleanRecord: boolean, leftovers: number,
 *   prevShutdown: string | null, files: number, meetingEntries: number, ownedProcesses: number, fatal: Record<string, number> }[]} cycles
 */
export function judgeRelaunchLoop(cycles, { maxFileGrowth = 3, startupFactor = 2, startupSlackMs = 3000 } = {}) {
  const problems = []
  if (cycles.length === 0) return ['no cycle completed']
  for (const cycle of cycles) {
    if (!cycle.clean) problems.push(`cycle ${cycle.cycle}: the app did not exit cleanly`)
    if (!cycle.cleanRecord) problems.push(`cycle ${cycle.cycle}: no app.shutdown.clean audit record`)
    if (cycle.leftovers > 0)
      problems.push(`cycle ${cycle.cycle}: ${cycle.leftovers} owned process(es) survived the quit`)
    if (cycle.cycle > 1 && cycle.prevShutdown !== 'clean')
      problems.push(
        `cycle ${cycle.cycle}: app.started reported prevShutdown ${JSON.stringify(cycle.prevShutdown)}, expected "clean"`
      )
    for (const [event, count] of Object.entries(cycle.fatal)) problems.push(`cycle ${cycle.cycle}: ${count} ${event}`)
  }
  const first = cycles[0]
  const last = cycles.at(-1)
  if (last.files - first.files > maxFileGrowth)
    problems.push(`profile file count grew from ${first.files} to ${last.files} (allowed +${maxFileGrowth})`)
  if (last.meetingEntries !== first.meetingEntries)
    problems.push(`meetings folder entries went from ${first.meetingEntries} to ${last.meetingEntries}`)
  if (last.ownedProcesses > first.ownedProcesses + 1)
    problems.push(`owned processes at ready grew from ${first.ownedProcesses} to ${last.ownedProcesses}`)
  const head = median(cycles.slice(0, 3).map((cycle) => cycle.startupMs))
  const tail = median(cycles.slice(-3).map((cycle) => cycle.startupMs))
  if (head !== null && tail !== null && tail > head * startupFactor + startupSlackMs)
    problems.push(`startup slowed: median of the first 3 cycles ${Math.round(head)} ms, last 3 ${Math.round(tail)} ms`)
  return problems
}

/** Startup statistics for the report. */
export function startupStats(cycles) {
  const values = cycles.map((cycle) => cycle.startupMs).filter(Number.isFinite)
  if (!values.length) return { count: 0 }
  const sorted = [...values].sort((a, b) => a - b)
  return { count: values.length, minMs: sorted[0], medianMs: median(values), maxMs: sorted.at(-1) }
}

// ---------------------------------------------------------------------------------------------------------------
// S6 settings churn

/** The click order: `rounds` passes over `count` switches, then one extra click on each index in `extra`. */
export function churnSequence({ count, rounds, extra = [] }) {
  const sequence = []
  for (let round = 0; round < rounds; round += 1) for (let index = 0; index < count; index += 1) sequence.push(index)
  return [...sequence, ...extra]
}

/** The value each switch ends on if every click took effect, from its starting value. */
export function expectedAfterClicks(initial, sequence) {
  const state = [...initial]
  for (const index of sequence) state[index] = !state[index]
  return state
}

/**
 * S6: what the UI settled on, what main holds, what a relaunched process reads, and what the reopened pane shows must agree.
 * `lostClicks` (the click-count parity prediction differing) is reported, not failed: it measures how many rapid clicks the UI
 * coalesced, which is a UX fact, whereas disagreement between layers is corruption.
 */
export function judgeSettingsChurn({
  keys,
  uiFinal,
  mainFinal,
  afterRelaunch,
  paneAfterRelaunch,
  expected,
  settingsFile,
  fatal,
  profileRecovered
}) {
  const problems = []
  keys.forEach((key, index) => {
    if (uiFinal[index] !== mainFinal[index])
      problems.push(`${key}: the switch showed ${uiFinal[index]} but main held ${mainFinal[index]}`)
    if (afterRelaunch[index] !== mainFinal[index])
      problems.push(`${key}: ${mainFinal[index]} before the quit but ${afterRelaunch[index]} after the relaunch`)
    if (paneAfterRelaunch[index] !== afterRelaunch[index])
      problems.push(
        `${key}: the reopened pane shows ${paneAfterRelaunch[index]} while settings hold ${afterRelaunch[index]}`
      )
  })
  if (!settingsFile.present || settingsFile.bytes === 0)
    problems.push('settings.json is missing or empty after the churn')
  if (profileRecovered > 0)
    problems.push(`${profileRecovered} settings.profile_recovered audit record(s): the profile was reset or recovered`)
  problems.push(...fatalProblems({ fatal }))
  const lostClicks = keys.filter((_, index) => expected[index] !== mainFinal[index])
  return { problems, lostClicks }
}

// ---------------------------------------------------------------------------------------------------------------
// S7 memory growth

/**
 * Growth of the owned process tree's total RSS over a meeting. The first `settleMs` is warm-up (model load, worklet start).
 * The installed build's total RSS swings by several hundred MiB from one 15 s sample to the next (a helper process alternates
 * between idle and busy), so a pairwise slope over raw samples is dominated by which phase the last samples land on. The verdict
 * therefore compares the MEDIAN of the first third of the post-settle window with the median of the last third, projected to
 * 60 minutes from the distance between the two thirds' centres, and bounds it like SOAK-ACCEPT-1's meeting rule:
 * max(160 MiB, 20% of the reference). The reference is the median of the last 60 s of settle. The Theil-Sen slope over the raw
 * samples and the swing (p95 - p5) are reported next to it, not judged.
 * @param {{ tMs: number, rssBytes: number }[]} samples complete samples only
 */
export function rssGrowth(
  samples,
  { settleMs = 2 * MINUTE_MS, projectionMinutes = 60, floorBytes = 160 * MIB, fraction = 0.2 } = {}
) {
  const settle = samples.filter((sample) => sample.tMs < settleMs)
  const window = samples.filter((sample) => sample.tMs >= settleMs)
  const refSamples = settle.filter((sample) => sample.tMs >= settleMs - 60_000)
  const reference = median((refSamples.length ? refSamples : settle).map((sample) => sample.rssBytes))
  if (reference === null || window.length < 6)
    return {
      valid: false,
      reason: `needs a settle reference and at least 6 samples after ${settleMs / 1000}s (have ${settle.length} and ${window.length})`
    }
  const third = Math.floor(window.length / 3)
  const head = window.slice(0, third)
  const tail = window.slice(-third)
  const centre = (part) => part.reduce((sum, sample) => sum + sample.tMs, 0) / part.length
  const headMedian = median(head.map((sample) => sample.rssBytes))
  const tailMedian = median(tail.map((sample) => sample.rssBytes))
  const deltaMs = centre(tail) - centre(head)
  const projectedBytes = deltaMs > 0 ? ((tailMedian - headMedian) / deltaMs) * projectionMinutes * MINUTE_MS : 0
  const slopePerMs = theilSenSlope(window.map((sample) => ({ x: sample.tMs, y: sample.rssBytes })))
  const sorted = window.map((sample) => sample.rssBytes).sort((x, y) => x - y)
  const at = (fractionOf) => sorted[Math.min(sorted.length - 1, Math.floor(fractionOf * sorted.length))]
  const bound = Math.max(floorBytes, fraction * reference)
  const peak = Math.max(...samples.map((sample) => sample.rssBytes))
  return {
    valid: true,
    referenceMiB: round1(reference / MIB),
    peakMiB: round1(peak / MIB),
    firstThirdMedianMiB: round1(headMedian / MIB),
    lastThirdMedianMiB: round1(tailMedian / MIB),
    projectedMiBPerHour: round1(projectedBytes / MIB),
    lastThirdMinusReferenceMiB: round1((tailMedian - reference) / MIB),
    boundMiB: round1(bound / MIB),
    rawTheilSenMiBPerMin: round2((slopePerMs * MINUTE_MS) / MIB),
    swingMiB: round1((at(0.95) - at(0.05)) / MIB),
    pass: projectedBytes <= bound && tailMedian - reference <= bound
  }
}

const round1 = (value) => Math.round(value * 10) / 10
const round2 = (value) => Math.round(value * 100) / 100

/** S7: sizes that a ten-minute meeting should stay well inside. */
export const SANE_LIMITS = Object.freeze({ meetingFileBytes: 2 * MIB, draftFileBytes: 2 * MIB, journalBytes: 20 * MIB })

export function judgeSizes({ drafts, saved, journalBytes }) {
  const problems = []
  for (const draft of drafts)
    if (draft.bytes > SANE_LIMITS.draftFileBytes) problems.push(`autosave draft reached ${draft.bytes} bytes`)
  for (const file of saved)
    if (file.bytes > SANE_LIMITS.meetingFileBytes) problems.push(`saved meeting is ${file.bytes} bytes`)
  if (journalBytes > SANE_LIMITS.journalBytes) problems.push(`live journal grew to ${journalBytes} bytes`)
  const sizes = drafts.map((draft) => draft.bytes)
  if (sizes.some((size, index) => index > 0 && size < sizes[index - 1] * 0.5))
    problems.push(`autosave draft shrank sharply between observations (${sizes.join(' -> ')} bytes)`)
  return problems
}

// ---------------------------------------------------------------------------------------------------------------
// Profile census (S4 growth)

const CACHE_DIRS = new Set([
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'DawnCache',
  'Crashpad',
  'blob_storage',
  'Shared Dictionary',
  'Session Storage',
  'Local Storage',
  'Service Worker',
  'Network',
  'logs'
])
const VOLATILE_FILES = new Set([
  'run-alive.json',
  'run-state.json',
  'DevToolsActivePort',
  'SingletonLock',
  'SingletonCookie',
  'SingletonSocket'
])

/**
 * Entry counts and sizes of a profile directory. `files` is the count of regular files outside Chromium's cache directories and
 * the volatile run markers, which is what "no growth in files" is judged on; `auditBytes` is reported separately because the
 * audit log grows by design.
 * @param {string} userData
 * @param {{ list?: (dir: string) => import('node:fs').Dirent[], size?: (path: string) => number }} [deps]
 */
export function profileCensus(
  userData,
  { list = (dir) => readdirSync(dir, { withFileTypes: true }), size = (path) => statSync(path).size } = {}
) {
  let files = 0
  let bytes = 0
  let topLevel = 0
  const crashFiles = []
  const walk = (dir, depth) => {
    let entries
    try {
      entries = list(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (depth === 0) topLevel += 1
      if (entry.isDirectory()) {
        if (depth === 0 && CACHE_DIRS.has(entry.name)) continue
        walk(join(dir, entry.name), depth + 1)
      } else if (entry.isFile()) {
        if (depth === 0 && VOLATILE_FILES.has(entry.name)) continue
        if (/crash/i.test(entry.name)) crashFiles.push(entry.name)
        files += 1
        try {
          bytes += size(join(dir, entry.name))
        } catch {
          /* vanished */
        }
      }
    }
  }
  walk(userData, 0)
  let auditBytes = 0
  try {
    auditBytes = size(join(userData, 'logs', 'audit.log'))
  } catch {
    /* no log yet */
  }
  return { topLevel, files, bytes, auditBytes, crashFiles }
}

/** Total bytes of every regular file under a directory (0 when it does not exist). */
export function directoryBytes(
  dir,
  { list = (path) => readdirSync(path, { withFileTypes: true }), size = (path) => statSync(path).size } = {}
) {
  let total = 0
  const walk = (path) => {
    let entries
    try {
      entries = list(path)
    } catch {
      return
    }
    for (const entry of entries) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) walk(child)
      else if (entry.isFile()) {
        try {
          total += size(child)
        } catch {
          /* vanished */
        }
      }
    }
  }
  walk(dir)
  return total
}

// ---------------------------------------------------------------------------------------------------------------
// S8 overlay spam

/** One loop of the S8 action cycle; the runner repeats it. */
export const OVERLAY_ACTIONS = Object.freeze([
  'minimize',
  'restore',
  'settings-open',
  'settings-close',
  'history-open',
  'review-open',
  'review-close',
  'history-close'
])

/** S8: the overlay survived the clicks and nothing is left blocking it. */
export function judgeOverlaySpam({ mainAlive, fatal, latency, stuckModals, barReachable, performed }) {
  const problems = []
  if (!mainAlive) problems.push('the main process is no longer running')
  problems.push(...fatalProblems({ fatal }))
  problems.push(...latencyProblems(latency))
  if (stuckModals > 0)
    problems.push(`${stuckModals} modal/dialog element(s) still open after the clicks and a recovery attempt`)
  if (!barReachable) problems.push('the overlay bar was not reachable after the clicks (no Ask input or Start control)')
  if (performed < 1) problems.push('no overlay control click was performed')
  return problems
}

// ---------------------------------------------------------------------------------------------------------------
// Report

/** One row per case for the console and the report: a case's status is the worst of its steps. */
export function caseTable(steps, cases = STRESS_CASES) {
  const rank = { FAIL: 3, SKIPPED: 2, NOT_SUPPORTED: 1, PASS: 0 }
  return cases.map((id) => {
    const own = steps.filter((step) => step.id.startsWith(`${id}-`))
    if (own.length === 0) return { case: id, status: 'NOT_RUN', steps: [] }
    const worst = own.reduce((acc, step) => (rank[step.status] > rank[acc] ? step.status : acc), 'PASS')
    return { case: id, status: worst, steps: own.map((step) => ({ id: step.id, status: step.status })) }
  })
}
