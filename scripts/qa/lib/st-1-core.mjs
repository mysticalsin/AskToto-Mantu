/**
 * The pure pieces of ST-1 (scripts/qa/st-1.mjs): bounded waits, the in-app expression that keeps an
 * awaited promise reachable, how each probe's outcome is recorded, and the report with its criteria.
 * Nothing here touches the app, the inspector or the file system, so scripts/qa/st-1.test.ts can drive it
 * directly.
 *
 * Every outcome has one of three shapes and none of these functions ever rejects:
 *   { ok: true, value }             settled in time
 *   { ok: false, timedOut: true }   did not settle within its bound
 *   { ok: false, error }            settled with an error (message string)
 */

/** Where in-flight evaluations live inside the candidate, keyed per evaluation. */
export const PENDING_GLOBAL = '__st1pending'

/** History's degraded-view budget: a History open or search answers with a usable list within this. */
export const HISTORY_BUDGET_MS = 2_000

/** The History row's first-call budget: History's first recallList answers within this. */
export const HISTORY_FIRST_LIST_MS = 250

/** The History calls the probe times one by one, in the order the summary lists them. */
export const HISTORY_CALLS = ['recallList', 'brainStatus', 'recallSearch']

/** What admission.ts logs when every meetings-root permit is held by a stalled call and it starts refusing. */
export const STORAGE_SATURATED_LOG = '[storage] every permit is held by a stalled call'

/** Command-line flags as camelCase keys over `defaults`: `--cloud-dir x` becomes `cloudDir: 'x'`. A flag
 *  with no value (last, or followed by another flag) is the string 'true'. */
export function parseArgs(argv, defaults = {}) {
  const args = { ...defaults }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (!flag.startsWith('--')) continue
    const key = flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
    const next = argv[i + 1]
    args[key] = next === undefined || next.startsWith('--') ? 'true' : argv[++i]
  }
  return args
}

/** Resolves with `promise`'s outcome, or `{ ok: false, timedOut: true }` after `ms`. Never rejects; the
 *  timer is cleared as soon as either side settles. */
export function withTimeout(promise, ms) {
  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, timedOut: true }), ms)
  })
  const settled = Promise.resolve(promise).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error: String(error?.message ?? error) })
  )
  return Promise.race([settled, timeout]).finally(() => clearTimeout(timer))
}

/**
 * An expression for Runtime.evaluate (awaitPromise) that runs `expression` inside the candidate, bounded
 * by `ms` there, and stores the bounded promise at `globalThis.__st1pending[key]`. The inspector holds an
 * awaited promise only weakly: an unreferenced pending promise can be garbage-collected, which ends the
 * evaluation with "Promise was collected". The global keeps it reachable until releaseExpression(key).
 * The stored promise always fulfils with an outcome (see the header), so the evaluation itself never
 * reports an exception for the expression's own failure or hang.
 */
export function pinnedExpression(key, expression, ms) {
  return `(() => {
  const pending = (globalThis.${PENDING_GLOBAL} ??= {})
  let timer
  const clearBound = () => {
    try {
      if (timer !== undefined) clearTimeout(timer)
    } catch {}
  }
  const settled = Promise.resolve()
    .then(() => (${expression}))
    .then((value) => ({ ok: true, value }), (error) => ({ ok: false, error: String(error?.message ?? error) }))
  let resolveTimeout
  const timeout = new Promise((resolve) => {
    resolveTimeout = resolve
  })
  try {
    timer = setTimeout(() => resolveTimeout({ ok: false, timedOut: true }), ${Number(ms)})
  } catch {}
  const bounded = Promise.race([settled, timeout]).finally(clearBound)
  pending[${JSON.stringify(key)}] = bounded
  return bounded
})()`
}

/** One app-side sample expression. The reported max covers the interval before the sample plus the probe
 *  write after the histogram reset, and uses the never-reset run histogram only when it rose in this
 *  interval, so a dropped post-reset block reaches one timeline sample without being replayed forever. */
export function sampleExpression(probeFile) {
  return `(async () => {
  const loopMaxBeforeWriteMs = __st1since.max / 1e6
  __st1since.reset()
  const resources = {}
  if (typeof process.getActiveResourcesInfo === 'function') {
    for (const type of process.getActiveResourcesInfo()) resources[type] = (resources[type] ?? 0) + 1
  }
  const { writeFile } = process.getBuiltinModule('node:fs/promises')
  const { lookup } = process.getBuiltinModule('node:dns/promises')
  let started = performance.now()
  await writeFile(${JSON.stringify(probeFile)}, String(started))
  const writeMs = performance.now() - started
  const loopMaxDuringWriteMs = __st1since.max / 1e6
  const runLoopMaxMs = __st1.max / 1e6
  const previousRunLoopMaxMs = globalThis.__st1lastRunLoopMaxMs ?? 0
  globalThis.__st1lastRunLoopMaxMs = Math.max(previousRunLoopMaxMs, runLoopMaxMs)
  const sampleLoopMaxMs = Math.max(loopMaxBeforeWriteMs, loopMaxDuringWriteMs)
  started = performance.now()
  await lookup('localhost')
  return {
    writeMs,
    loopMaxDuringWriteMs,
    runLoopMaxMs,
    lookupMs: performance.now() - started,
    loopMaxSinceLastMs: runLoopMaxMs > previousRunLoopMaxMs ? Math.max(sampleLoopMaxMs, runLoopMaxMs) : sampleLoopMaxMs,
    resources
  }
})()`
}

/** Drops the reference pinnedExpression(key, …) stored, once its evaluation has been answered. */
export function releaseExpression(key) {
  return `void (globalThis.${PENDING_GLOBAL} && delete globalThis.${PENDING_GLOBAL}[${JSON.stringify(key)}])`
}

/** The report's record of a probe that did not settle in time or failed. */
export function failureRecord(step, tMs, outcome, boundMs) {
  return { step, tMs, message: outcome.timedOut ? `no answer within ${boundMs} ms` : outcome.error }
}

/**
 * Files one sample's outcome into `run`. An answer within `lateAfterMs` is a sample; a slower answer is
 * late but keeps its values; a sample that never answered is late and an error; a failed evaluation is an
 * error only. `witness`, when given, is the runner's own state at the sample instant (report-only); every
 * timeline entry this files, late ones included, carries it.
 */
export function recordSample(run, tMs, outcome, options) {
  const { lateAfterMs, boundMs, witness } = options
  const witnessed = witness ? { witness } : {}
  if (outcome.ok) {
    const entry = { tMs, ...outcome.value, answeredMs: Math.round(outcome.elapsedMs), ...witnessed }
    if (outcome.elapsedMs > lateAfterMs) run.late.push(entry)
    else run.samples.push(entry)
    return
  }
  if (outcome.timedOut) run.late.push({ tMs, hung: true, ...witnessed })
  run.errors.push(failureRecord('sample', tMs, outcome, boundMs))
}

/**
 * An expression (for executeJavaScript in the renderer) that starts every call in `calls` (name → expression)
 * at once and times each on its own, bounded by `boundMs`. It always fulfils with name → outcome:
 *   { ms, value }        settled in time
 *   { ms, error }        rejected (message string)
 *   { ms, hung: true }   did not settle within boundMs
 */
export function timedCallsExpression(calls, boundMs) {
  const entries = Object.entries(calls).map(([name, expression]) => `[${JSON.stringify(name)}, () => (${expression})]`)
  return `(() => {
  const timed = (call) => {
    const started = performance.now()
    let timer
    return Promise.race([
      Promise.resolve()
        .then(call)
        .then(
          (value) => ({ ms: performance.now() - started, value }),
          (error) => ({ ms: performance.now() - started, error: String(error?.message ?? error) })
        ),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ ms: performance.now() - started, hung: true }), ${Number(boundMs)})
      })
    ]).finally(() => clearTimeout(timer))
  }
  return Promise.all([${entries.join(', ')}].map(([name, call]) => timed(call).then((outcome) => [name, outcome]))).then(Object.fromEntries)
})()`
}

/** A timed call's report record: its time and how it failed, never its value. */
function callRecord({ ms, error, hung }) {
  return { ms, ...(hung ? { hung: true } : {}), ...(error !== undefined ? { error } : {}) }
}

/**
 * A probe's per-call outcomes (`open`: recallList and brainStatus, `search`: recallSearch, each a
 * timedCallsExpression outcome) as the report's record: `calls` holds each call's own time, and the combined
 * fields stay as before. An open call that did not settle makes the open `hung`, one that failed makes it an
 * `error`; a search that did not settle or failed is a `searchError`. A probe without per-call outcomes is kept
 * as it is.
 */
function historyRecord({ open, search, ...probe }) {
  if (!open) return probe
  const { recallList, brainStatus } = open
  const record = { ...probe, calls: { recallList: callRecord(recallList), brainStatus: callRecord(brainStatus) } }
  if (recallList.value) Object.assign(record, recallList.value)
  const failed = [recallList, brainStatus].find((call) => call.hung || call.error !== undefined)
  if (failed?.hung) record.hung = true
  else if (failed) record.error = failed.error
  if (search) {
    record.calls.recallSearch = callRecord(search)
    if (search.hung) record.searchError = `no answer within ${Math.round(search.ms)} ms`
    else if (search.error !== undefined) record.searchError = search.error
    else record.hits = search.value
  }
  return record
}

/** One History round trip for the report. A round trip that never settled is `hung` with how long it was
 *  waited for — the signal that History itself stalls. */
export function historyEntry(tMs, outcome) {
  const ms = Math.round(outcome.elapsedMs)
  if (outcome.timedOut) return { tMs, hung: true, ms }
  if (!outcome.ok) return { tMs, error: outcome.error, ms }
  return { tMs, ...historyRecord(outcome.value) }
}

/** How many times a main.log text says every meetings-root permit was held by a stalled call. */
export function countStorageSaturations(mainLogText) {
  return mainLogText.split('\n').filter((line) => line.includes(STORAGE_SATURATED_LOG)).length
}

/** Whether this sample should schedule the next History probe. Pure so the idle row can prove no probe is
 *  scheduled while `--history off` keeps History untouched. */
export function shouldProbeHistory({ historyOn, historyRunning, tMs, historyLastMs, fromMs, everyMs }) {
  return historyOn && !historyRunning && tMs >= fromMs && tMs - historyLastMs >= everyMs
}

/** The representative profile of ARCHITECTURE 6.1: 59 meetings, 6 of them cloud-only, and a mostly
 *  cloud-only `.brain`. */
export const SYNTHETIC_LOCAL_MEETINGS = 53
export const SYNTHETIC_FIFO_MEETINGS = 6
export const SYNTHETIC_BRAIN_ENTITY_FIFOS = 4

/**
 * Where `--fixtures synthetic-dataless` places things, relative to the meetings root. Hosted runners have
 * no cloud-file provider, so a kernel-blocking FIFO stands at every path a mostly-evicted cloud folder
 * would present as unreadable: `local` are content-free placeholder meeting files, `fifos` the paths that
 * block a reader. Pure: st-1.mjs materializes it.
 */
export function syntheticDatalessPlan() {
  const pad = (n) => String(n).padStart(2, '0')
  const meeting = (i, tag) => `2026-${pad(1 + Math.floor(i / 28))}-${pad((i % 28) + 1)}_090000-st1-${tag}.md`
  const local = Array.from({ length: SYNTHETIC_LOCAL_MEETINGS }, (_, i) => meeting(i, 'local'))
  const meetingFifos = Array.from({ length: SYNTHETIC_FIFO_MEETINGS }, (_, i) => meeting(SYNTHETIC_LOCAL_MEETINGS + i, 'cloud-only'))
  const brainFifos = [
    '.brain/index.json',
    ...Array.from({ length: SYNTHETIC_BRAIN_ENTITY_FIFOS }, (_, i) => `.brain/entities/${i % 2 === 0 ? 'person' : 'org'}/st1-cloud-only-${i + 1}.json`)
  ]
  return {
    local,
    fifos: [...meetingFifos, ...brainFifos],
    counts: { localMeetings: local.length, fifoMeetings: meetingFifos.length, brainFifos: brainFifos.length }
  }
}

/** The boot window variants the QA-identity build can construct (src/main/infra/observability/projection.ts
 *  BOOT_WINDOW_VARIANTS, M2-0516). An ST-1 run always launches 'shipped'. */
export const WINDOW_VARIANTS = ['shipped', 'spellcheck-off', 'paint-when-hidden', 'prewarm-spellchecker']

/** The only purpose besides ST-1 itself: a short launch that measures the window constructor under one variant. */
export const WINDOW_CONSTRUCTION = 'window-construction'

/** The two boot-window chromes ST-1 measures: first-run onboarding and onboarded transparent overlay. */
export const WINDOW_CHROMES = ['opaque', 'transparent']

/** The window-construction gate's measured repeats per variant/chrome after warm-up. */
export const WINDOW_MEASURED_REPEATS = 2

/**
 * `--purpose` and `--window-variant`, checked: `{ purpose, windowVariant }` or `{ error }`. Without a purpose the
 * run is ST-1 and builds the shipped window, so a variant is refused there; a window-construction run names
 * one known variant.
 * @param {{ purpose?: string, windowVariant?: string }} args
 */
export function runPurpose({ purpose, windowVariant }) {
  if (purpose === undefined) {
    if (windowVariant !== undefined) return { error: `--window-variant needs --purpose ${WINDOW_CONSTRUCTION}` }
    return { purpose: 'st-1', windowVariant: 'shipped' }
  }
  if (purpose !== WINDOW_CONSTRUCTION) return { error: `--purpose must be ${WINDOW_CONSTRUCTION}, got ${JSON.stringify(purpose)}` }
  if (!WINDOW_VARIANTS.includes(windowVariant)) {
    return { error: `--window-variant must be one of ${WINDOW_VARIANTS.join(', ')}, got ${JSON.stringify(windowVariant)}` }
  }
  return { purpose, windowVariant }
}

/** The candidate's environment: this one, on the isolated profile, with the window variant set explicitly so an
 *  inherited value can never reach an ST-1 run. */
export function candidateEnv(env, profile, windowVariant) {
  return { ...env, ASKTOTO_USERDATA: profile, METIS_QA_WINDOW_VARIANT: windowVariant }
}

/** The window-construction gate's budget (M2-0519): every shipped createWindow.prewarm and createWindow.construct
 *  stays under it, in both chromes. */
export const WINDOW_STAGE_BUDGET_MS = 250

/** The boot stages the window-construction gate holds to its budget. */
export const GATED_WINDOW_STAGES = ['createWindow.prewarm', 'createWindow.construct']

/** The diagnosis behind the launch plan and gate report. CI evidence from 36999698235 and 37080909059 showed
 *  the over-budget shipped row on the first measured launch of the run, while later measured launches stayed
 *  comparable. That points at harness cold conditions, not a shipped-only app regression: every
 *  variant/chrome now receives the same warm-up before measurement, and the unchanged 250 ms gate still
 *  covers the user's first visible window work in the measured launch. */
export const WINDOW_CONSTRUCTION_ROOT_CAUSE = {
  classification: 'harness-cold-first-measured-launch',
  evidenceRuns: ['36999698235', '37080909059'],
  fix: 'one marked warm-up per variant/chrome before any measured launch; measured launches still include createWindow.prewarm and createWindow.construct under the unchanged 250 ms budget',
  leadAction: 'LEAD_ACTION: dispatch qa-candidate three consecutive times on the PR and attach the st1-report gate.json artifacts'
}

/**
 * The CI launch order for window construction. Every variant/chrome pair gets the same explicit warm-up
 * before any measured launch, so the shipped gate never compares a cold first measured launch with warmed
 * later launches.
 */
export function windowConstructionPlan({ variants = WINDOW_VARIANTS, chromes = WINDOW_CHROMES, repeats = WINDOW_MEASURED_REPEATS } = {}) {
  const warmups = variants.flatMap((variant) =>
    chromes.map((chrome) => ({ name: `window-warmup-${variant}-${chrome}`, variant, chrome, warmup: true }))
  )
  const measured = Array.from({ length: repeats }, (_, i) => i + 1).flatMap((repeat) =>
    variants.flatMap((variant) => chromes.map((chrome) => ({ name: `window-${variant}-${chrome}-${repeat}`, variant, chrome, repeat, warmup: false })))
  )
  return [...warmups, ...measured]
}

function launchNameFromReportPath(name) {
  const [head] = String(name).split(/[\\/]/)
  return head || String(name)
}

function windowLaunchStageRows(reports) {
  return reports.flatMap(({ name, report }) => {
    if (report?.purpose !== WINDOW_CONSTRUCTION) return []
    const stages = Array.isArray(report.bootStages?.stages) ? report.bootStages.stages : []
    return stages.map((entry) => {
      const chrome = entry.transparent === true ? 'transparent' : entry.transparent === false ? 'opaque' : null
      return {
        report: name,
        launch: launchNameFromReportPath(name),
        variant: entry.windowVariant ?? report.windowVariant ?? null,
        warmup: report.warmup === true,
        stage: entry.stage,
        chrome,
        ms: entry.ms
      }
    })
  })
}

/**
 * The window-construction gate (M2-0519) over a set of window-construction reports: `{ pass, rows, failures }`.
 * Only the shipped variant is gated; marked warm-ups and the other variants stay report-only. It fails unless
 * every measured shipped report carries each gated stage with a measured ms under WINDOW_STAGE_BUDGET_MS, and the
 * measured shipped reports built both chromes (opaque and transparent). A measured shipped report without boot
 * stages (a launch that never reached the window) fails as missing, never passes as absent. `rows` lists every
 * measured shipped gated stage found, per report.
 * @param {Array<{ name: string, report: any }>} reports
 */
export function windowConstructionGate(reports, budgetMs = WINDOW_STAGE_BUDGET_MS) {
  const launches = windowLaunchStageRows(reports)
  const rows = []
  const failures = []
  const chromes = new Set()
  const windowReports = reports.filter(({ report }) => report?.purpose === WINDOW_CONSTRUCTION)
  const warmups = windowReports.filter(({ report }) => report.warmup === true)
  const shipped = windowReports.filter(({ report }) => report.windowVariant === 'shipped' && report.warmup !== true)
  if (shipped.length === 0) failures.push('no shipped window-construction report')
  for (const { name, report } of shipped) {
    const stages = Array.isArray(report.bootStages?.stages) ? report.bootStages.stages : []
    for (const stage of GATED_WINDOW_STAGES) {
      const found = stages.filter((entry) => entry.stage === stage)
      if (found.length === 0) failures.push(`${name}: ${stage} missing`)
      for (const entry of found) {
        const chrome = entry.transparent === true ? 'transparent' : entry.transparent === false ? 'opaque' : null
        if (chrome) chromes.add(chrome)
        rows.push({ report: name, launch: launchNameFromReportPath(name), variant: report.windowVariant ?? null, stage, chrome, ms: entry.ms })
        if (typeof entry.ms !== 'number') failures.push(`${name}: ${stage} has no measured ms`)
        else if (entry.ms >= budgetMs) failures.push(`${name}: ${stage} ${entry.ms} ms >= ${budgetMs} ms`)
        if (!chrome) failures.push(`${name}: ${stage} does not say which chrome it built`)
      }
    }
  }
  for (const chrome of ['opaque', 'transparent']) {
    if (shipped.length > 0 && !chromes.has(chrome)) failures.push(`no shipped ${chrome} window was measured`)
  }
  return { pass: failures.length === 0, budgetMs, skippedWarmups: warmups.length, rootCause: WINDOW_CONSTRUCTION_ROOT_CAUSE, launches, rows, failures }
}

/** The app's own native boot stage timings (tray stages, window construction, navigation and first show): every
 *  `app.boot.stage` record of an audit log's text, in order, so each run names its long stretches without a
 *  CPU profile. Lines that are not a complete JSON record are skipped. A window stage keeps the chrome and
 *  variant it built. With the launch's wall-clock spawn time, each stage also says when its record was written since
 *  the spawn (`sinceSpawnMs`): the app writes it in a task after the stage, so it bounds the stage's end
 *  from above. */
export function bootStagesFromAudit(auditText, spawnedWallMs) {
  const stages = []
  for (const line of auditText.split('\n')) {
    if (!line.includes('"app.boot.stage"')) continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (record.event !== 'app.boot.stage') continue
    const endedAt = Date.parse(record.ts)
    stages.push({
      stage: record.stage,
      ms: typeof record.ms === 'number' ? Math.round(record.ms * 10) / 10 : null,
      ts: record.ts,
      ...(typeof record.transparent === 'boolean' ? { transparent: record.transparent } : {}),
      ...(typeof record.windowVariant === 'string' ? { windowVariant: record.windowVariant } : {}),
      ...(typeof spawnedWallMs === 'number' && Number.isFinite(endedAt) ? { sinceSpawnMs: endedAt - spawnedWallMs } : {})
    })
  }
  return stages
}

const CPU_BUSY_TIMES = new Set(['user', 'nice', 'sys', 'irq'])

/** The machine's CPU busy share in percent (one decimal) between two `os.cpus()` snapshots: user, nice, sys
 *  and irq time over all time, summed over every core. Null without a previous snapshot or elapsed time. */
export function cpuBusyPct(previous, current) {
  if (!previous || !current) return null
  let busy = 0
  let total = 0
  for (const [snapshot, sign] of [[current, 1], [previous, -1]]) {
    for (const cpu of snapshot) {
      for (const [name, value] of Object.entries(cpu.times)) {
        total += sign * value
        if (CPU_BUSY_TIMES.has(name)) busy += sign * value
      }
    }
  }
  return total > 0 ? Math.round((busy / total) * 1000) / 10 : null
}

/** The report's runner witness: the harness's own loop delay over the whole run (`loop`, null until it is
 *  read), the slowest probe write and the busiest CPU interval over every timeline entry's witness. A value
 *  no entry measured is null. */
export function witnessSummary(timeline, loop) {
  const max = (key) => {
    const values = timeline.map((entry) => entry.witness?.[key]).filter((value) => typeof value === 'number')
    return values.length > 0 ? Math.max(...values) : null
  }
  return { loop: loop ?? null, write: { maxMs: max('writeMs') }, cpuBusyMaxPct: max('cpuBusyPct') }
}

/** The History probes that reached a window (`skipped` ones did not: no window bridged History yet). */
function historyProbes(measured) {
  return measured.history.filter((entry) => !entry.skipped)
}

function maxNumber(values) {
  const numbers = values.filter((value) => typeof value === 'number')
  return numbers.length > 0 ? Math.max(...numbers) : null
}

function fifoMeetingFixtures(row, fixtures, fixtureCounts, evidence) {
  if (typeof evidence?.fifoMeetingFixtures === 'number') return evidence.fifoMeetingFixtures
  if (row === 'synthetic-dataless' && typeof fixtureCounts?.fifoMeetings === 'number') return fixtureCounts.fifoMeetings
  return fixtures.filter((fixture) => String(fixture).endsWith('.md')).length
}

/** FIFO-backed rows are exercised when History reached the fixture set and refused the unreadable meeting
 * rows without opening a non-regular file. An open reader is reported by its own criterion, never as PASS. */
function fifoRefusalEvidence(row, measured, evidence, fixtures, fixtureCounts) {
  if (row !== 'fifo' && row !== 'synthetic-dataless') return null
  const probes = historyProbes(measured)
  const requiredUnavailableRows = fifoMeetingFixtures(row, fixtures, fixtureCounts, evidence)
  const answered = probes.filter((entry) => !entry.hung && !entry.error)
  const brainStatusAnswered = answered.some((entry) => settledWithin(entry.calls?.brainStatus, Number.POSITIVE_INFINITY))
  const unavailableRows = maxNumber(answered.map((entry) => entry.unavailable ?? entry.notDownloaded))
  const matchingProbe = answered.find(
    (entry) =>
      typeof (entry.unavailable ?? entry.notDownloaded) === 'number' &&
      (entry.unavailable ?? entry.notDownloaded) >= requiredUnavailableRows &&
      settledWithin(entry.calls?.brainStatus, Number.POSITIVE_INFINITY)
  )
  return {
    exercised: Boolean(matchingProbe),
    reason: matchingProbe ? 'history-refused-fixtures' : 'history-did-not-prove-refusal',
    historyProbesAnswered: answered.length,
    unavailableRows,
    requiredUnavailableRows,
    brainStatusAnswered
  }
}

/** Whether one History probe of `row` opened History (list + brain status) with a usable list, or searched
 *  with results, within HISTORY_BUDGET_MS. A hung or failed probe did neither; a failed search
 *  (`searchError`) did not search. A usable list lists at least one fixture row, so a fast empty list never
 *  passes; on the dataless row at least one of them is a 'not downloaded' row (the degraded view). On the
 *  FIFO row the search must hit at least one fixture (their file names carry the `st1` query); a dataless
 *  row's fixtures are the QA folder's own files, whose names the query need not match. */
function openedInBudget(row) {
  return (entry) =>
    !entry.hung &&
    !entry.error &&
    entry.rows >= 1 &&
    (row !== 'dataless' || entry.notDownloaded >= 1) &&
    entry.ms < HISTORY_BUDGET_MS
}
function searchedInBudget(row) {
  return (entry) =>
    !entry.hung &&
    !entry.error &&
    !entry.searchError &&
    typeof entry.hits === 'number' &&
    (row !== 'fifo' || entry.hits >= 1) &&
    entry.searchMs < HISTORY_BUDGET_MS
}

/** Whether a timed call settled (neither hung nor failed) within `budgetMs`. */
function settledWithin(call, budgetMs) {
  return Boolean(call) && !call.hung && call.error === undefined && call.ms < budgetMs
}

/** One History call's times over the probes, by nearest rank: `firstMs` is the first probe's own call (null
 *  when that probe has no per-call time), `unsettled` counts the calls that hung or failed. */
function callStats(probes, name) {
  const calls = probes.map((entry) => entry.calls?.[name]).filter(Boolean)
  const times = calls.map((call) => call.ms).sort((a, b) => a - b)
  const rank = (percent) => (times.length > 0 ? times[Math.ceil((percent / 100) * times.length) - 1] : null)
  return {
    calls: calls.length,
    unsettled: calls.filter((call) => call.hung || call.error !== undefined).length,
    firstMs: probes[0]?.calls?.[name]?.ms ?? null,
    p50Ms: rank(50),
    p95Ms: rank(95),
    maxMs: times.at(-1) ?? null
  }
}

/**
 * The History row's checks, from each call's own time: History's first recallList answers within
 * HISTORY_FIRST_LIST_MS; every recallList answers with a usable list (as openedInBudget) and every recallSearch
 * with results (as searchedInBudget) within HISTORY_BUDGET_MS; the main loop's p99 stays under 50 ms. With no
 * probe every check fails.
 */
function historyChecks(row, measured, probes) {
  const listUsable = (entry) =>
    settledWithin(entry.calls?.recallList, HISTORY_BUDGET_MS) && entry.rows >= 1 && (row !== 'dataless' || entry.notDownloaded >= 1)
  const searchUsable = (entry) =>
    settledWithin(entry.calls?.recallSearch, HISTORY_BUDGET_MS) && typeof entry.hits === 'number' && (row !== 'fifo' || entry.hits >= 1)
  return [
    { name: `first-list < ${HISTORY_FIRST_LIST_MS}`, pass: settledWithin(probes[0]?.calls?.recallList, HISTORY_FIRST_LIST_MS) },
    { name: `list < ${HISTORY_BUDGET_MS}`, pass: probes.length > 0 && probes.every(listUsable) },
    { name: `search < ${HISTORY_BUDGET_MS}`, pass: probes.length > 0 && probes.every(searchUsable) },
    { name: 'loop-p99 < 50', pass: measured.loop?.p99Ms < 50 }
  ]
}

/**
 * The History row's summary: the first probe is History's first call, the one that paid any start-up wait.
 * `calls` gives each call's own times and `verdict` comes from `checks` alone (INCOMPLETE while the run is
 * not complete); neither changes the report's own criteria or verdict. `firstListCause`, report-only, says why a first recallList missed its budget:
 * 'admission-saturated' when this launch's main.log says every meetings-root permit was held by a stalled call
 * (`storageSaturations` > 0), 'unattributed' when it does not, 'main-log-unread' when it could not be read;
 * null when the first recallList met its budget or no probe ran.
 * @param {{ row?: string, complete?: boolean, storageSaturations?: number | null }} [options]
 */
export function historySummary(measured, options = {}) {
  const { row, complete = true, storageSaturations = null } = options
  const probes = historyProbes(measured)
  const max = (key) => {
    const values = probes.map((entry) => entry[key]).filter((value) => typeof value === 'number')
    return values.length > 0 ? Math.max(...values) : null
  }
  const checks = historyChecks(row, measured, probes)
  const firstListMissed = probes.length > 0 && !checks[0].pass
  return {
    probes: probes.length,
    firstOpenMs: probes[0]?.ms ?? null,
    maxOpenMs: max('ms'),
    maxSearchMs: max('searchMs'),
    maxRows: max('rows'),
    maxNotDownloaded: max('notDownloaded'),
    calls: Object.fromEntries(HISTORY_CALLS.map((name) => [name, callStats(probes, name)])),
    checks,
    verdict: !complete ? 'INCOMPLETE' : checks.every((check) => check.pass) ? 'PASS' : 'FAIL',
    storageSaturations,
    firstListCause: !firstListMissed
      ? null
      : storageSaturations > 0
        ? 'admission-saturated'
        : storageSaturations === 0
          ? 'unattributed'
          : 'main-log-unread'
  }
}

/** The pass/fail criteria. They read only the measurement, never the attribution evidence. The History row
 *  (`history`) adds History open and search: every probe, the first one included, answers with a usable
 *  list of fixture rows (and, on the FIFO row, a search hit) within HISTORY_BUDGET_MS. */
export function evaluateCriteria(row, measured, evidence, { history = false } = {}) {
  const criteria = [
    { name: 'inspector', pass: true }, // only reached once the candidate actually produced a working inspector
    { name: 'has-samples', pass: measured.samples.length > 0 },
    { name: 'no-late-samples', pass: measured.late.length === 0 },
    { name: 'loop-p99 < 50', pass: measured.loop?.p99Ms < 50 },
    { name: 'loop-max < 250', pass: measured.loop?.maxMs < 250 },
    { name: 'async-write < 250', pass: measured.samples.every((s) => s.writeMs < 250) },
    { name: 'dns-lookup < 250', pass: measured.samples.every((s) => s.lookupMs < 250) }
  ]
  if (row === 'dataless') criteria.push({ name: 'still-dataless', pass: evidence?.stillDataless === true })
  if (row === 'fifo' || row === 'synthetic-dataless') {
    criteria.push({ name: 'non-regular-fixtures-unopened', pass: (evidence?.fixturesOpened ?? []).length === 0 })
  }
  if (history) {
    const probes = historyProbes(measured)
    criteria.push(
      { name: 'history-probed', pass: probes.length > 0 },
      { name: `history-open < ${HISTORY_BUDGET_MS}`, pass: probes.length > 0 && probes.every(openedInBudget(row)) },
      { name: `history-search < ${HISTORY_BUDGET_MS}`, pass: probes.length > 0 && probes.every(searchedInBudget(row)) }
    )
  }
  return criteria
}

/** A report with an empty measurement; `measure` fills it in place, so a partial report can be written at
 *  any moment. */
export function emptyRun() {
  return { poolSize: null, setupAtMs: null, samples: [], late: [], history: [], errors: [], profiler: null, loop: null, witnessLoop: null }
}

/**
 * The ST-1 report. `complete` is false for the periodic partial report and for a run the harness itself
 * could not finish (`harnessError`); either has verdict INCOMPLETE, because a measurement that stopped
 * early proves nothing either way. A complete run's verdict comes from the criteria alone; the runner
 * witness and the boot stages are report-only. A window-construction run (`purpose`) says so, names its variant
 * and is never ST-1 evidence (`st1Evidence: false`), whatever its verdict.
 */
export function buildReport({
  row,
  history = false,
  installer,
  candidate,
  minutes,
  measured,
  evidence,
  fixtures,
  attribution,
  complete,
  harnessError,
  historyMode = 'on',
  fixtureCounts = null,
  purpose = 'st-1',
  windowVariant = 'shipped',
  windowWarmup = false
}) {
  const criteria = evaluateCriteria(row, measured, evidence, { history })
  const refusalEvidence = fifoRefusalEvidence(row, measured, evidence, fixtures, fixtureCounts)
  // The control row has nothing to exercise: its verdict is the criteria alone.
  const exercised = refusalEvidence?.exercised ?? (row === 'none' || evidence?.exercised)
  const openedNonRegularFixture = criteria.some((criterion) => criterion.name === 'non-regular-fixtures-unopened' && !criterion.pass)
  const verdict = !complete
    ? 'INCOMPLETE'
    : openedNonRegularFixture
      ? 'FAIL'
      : !exercised
        ? 'NOT_EXERCISED'
        : criteria.every((c) => c.pass)
          ? 'PASS'
          : 'FAIL'
  const timeline = [...measured.samples, ...measured.late.map((entry) => ({ ...entry, late: true }))].sort((a, b) => a.tMs - b.tMs)
  return {
    harness: 'ST-1',
    ...(purpose === WINDOW_CONSTRUCTION ? { purpose, st1Evidence: false, windowVariant } : {}),
    ...(purpose === WINDOW_CONSTRUCTION && windowWarmup ? { warmup: true } : {}),
    row,
    ...(history ? { historyRow: true } : {}),
    platform: process.platform,
    arch: process.arch,
    installer,
    build_run_id: candidate.build_run_id,
    artifact_sha256: candidate.artifact_sha256,
    poolSize: measured.poolSize,
    fixtures: fixtures.length,
    minutes,
    samples: measured.samples.length,
    lateSamples: measured.late.length,
    loop: measured.loop,
    write: { maxMs: Math.max(0, ...measured.samples.map((s) => s.writeMs)) },
    lookup: { maxMs: Math.max(0, ...measured.samples.map((s) => s.lookupMs)) },
    exercised: refusalEvidence?.exercised ?? evidence?.exercised ?? null,
    ...(refusalEvidence ? { exerciseEvidence: refusalEvidence } : {}),
    ...(row === 'fifo' || row === 'synthetic-dataless' ? { fixturesOpened: evidence?.fixturesOpened ?? null } : {}),
    ...(row === 'synthetic-dataless'
      ? { fixtureKind: 'synthetic-dataless', fixtureCounts, sfDatalessSet: evidence?.sfDatalessSet ?? null }
      : {}),
    ...(row === 'dataless' ? { stillDataless: evidence?.stillDataless ?? null } : {}),
    ...(history ? { historySummary: historySummary(measured, { row, complete, storageSaturations: attribution.storageSaturations }) } : {}),
    criteria,
    verdict,
    complete,
    ...(harnessError ? { harnessError } : {}),
    // Report-only attribution evidence; no criterion reads it.
    errors: measured.errors,
    setupAtMs: measured.setupAtMs,
    timeline,
    historyMode,
    witness: witnessSummary(timeline, measured.witnessLoop),
    history: measured.history,
    cpuProfile: measured.profiler,
    bootStages: attribution.bootStages ?? null,
    mainLog: !attribution.mainLog
      ? null
      : attribution.mainLog.error
        ? { error: attribution.mainLog.error }
        : { fromByte: attribution.mainLog.fromByte, exactLaunchOffset: attribution.mainLog.exactLaunchOffset },
    appEvidence: attribution.appEvidence
  }
}

export function writeJsonToStdout(value, stdout = process.stdout) {
  const text = `${JSON.stringify(value, null, 2)}\n`
  return new Promise((resolve, reject) => {
    try {
      stdout.write(text, (error) => {
        if (error) reject(error)
        else resolve()
      })
    } catch (error) {
      reject(error)
    }
  })
}

/** The launch itself never reached a candidate to measure: a genuine FAIL (inspector: false), never a
 *  skipped row. A window-construction launch is marked as in buildReport. */
export function buildLaunchFailureReport({ row, installer, candidate, fixtures, reason, purpose = 'st-1', windowVariant = 'shipped', windowWarmup = false }) {
  return {
    harness: 'ST-1',
    ...(purpose === WINDOW_CONSTRUCTION ? { purpose, st1Evidence: false, windowVariant } : {}),
    ...(purpose === WINDOW_CONSTRUCTION && windowWarmup ? { warmup: true } : {}),
    row,
    platform: process.platform,
    arch: process.arch,
    installer,
    build_run_id: candidate.build_run_id,
    artifact_sha256: candidate.artifact_sha256,
    fixtures: fixtures.length,
    exercised: false,
    criteria: [{ name: 'inspector', pass: false }],
    reason,
    verdict: 'FAIL'
  }
}
