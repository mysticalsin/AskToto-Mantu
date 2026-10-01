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
  const bounded = Promise.race([
    Promise.resolve()
      .then(() => (${expression}))
      .then((value) => ({ ok: true, value }), (error) => ({ ok: false, error: String(error?.message ?? error) })),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, timedOut: true }), ${Number(ms)})
    })
  ])
  bounded.then(() => clearTimeout(timer))
  pending[${JSON.stringify(key)}] = bounded
  return bounded
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

/** One History round trip for the report. A round trip that never settled is `hung` with how long it was
 *  waited for — the signal that History itself stalls. */
export function historyEntry(tMs, outcome) {
  const ms = Math.round(outcome.elapsedMs)
  if (outcome.timedOut) return { tMs, hung: true, ms }
  if (!outcome.ok) return { tMs, error: outcome.error, ms }
  return { tMs, ...outcome.value }
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
export const WINDOW_VARIANTS = ['shipped', 'spellcheck-off', 'paint-when-hidden', 'prewarm-spellchecker', 'prewarm-view']

/** The only purpose besides ST-1 itself: a short launch that measures the window constructor under one variant. */
export const WINDOW_CONSTRUCTION = 'window-construction'

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

/** The pass/fail criteria. They read only the measurement, never the attribution evidence. */
export function evaluateCriteria(row, measured, evidence) {
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
  windowVariant = 'shipped'
}) {
  const criteria = evaluateCriteria(row, measured, evidence)
  // The control row has nothing to exercise: its verdict is the criteria alone.
  const exercised = row === 'none' || evidence?.exercised
  const verdict = !complete ? 'INCOMPLETE' : !exercised ? 'NOT_EXERCISED' : criteria.every((c) => c.pass) ? 'PASS' : 'FAIL'
  const timeline = [...measured.samples, ...measured.late.map((entry) => ({ ...entry, late: true }))].sort((a, b) => a.tMs - b.tMs)
  return {
    harness: 'ST-1',
    ...(purpose === WINDOW_CONSTRUCTION ? { purpose, st1Evidence: false, windowVariant } : {}),
    row,
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
    exercised: evidence?.exercised ?? null,
    ...(row === 'fifo' || row === 'synthetic-dataless' ? { fixturesOpened: evidence?.fixturesOpened ?? null } : {}),
    ...(row === 'synthetic-dataless'
      ? { fixtureKind: 'synthetic-dataless', fixtureCounts, sfDatalessSet: evidence?.sfDatalessSet ?? null }
      : {}),
    ...(row === 'dataless' ? { stillDataless: evidence?.stillDataless ?? null } : {}),
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

/** The launch itself never reached a candidate to measure: a genuine FAIL (inspector: false), never a
 *  skipped row. A window-construction launch is marked as in buildReport. */
export function buildLaunchFailureReport({ row, installer, candidate, fixtures, reason, purpose = 'st-1', windowVariant = 'shipped' }) {
  return {
    harness: 'ST-1',
    ...(purpose === WINDOW_CONSTRUCTION ? { purpose, st1Evidence: false, windowVariant } : {}),
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
