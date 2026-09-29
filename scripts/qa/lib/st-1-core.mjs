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
 * error only.
 */
export function recordSample(run, tMs, outcome, { lateAfterMs, boundMs }) {
  if (outcome.ok) {
    const entry = { tMs, ...outcome.value, answeredMs: Math.round(outcome.elapsedMs) }
    if (outcome.elapsedMs > lateAfterMs) run.late.push(entry)
    else run.samples.push(entry)
    return
  }
  if (outcome.timedOut) run.late.push({ tMs, hung: true })
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
  return { poolSize: null, setupAtMs: null, samples: [], late: [], history: [], errors: [], profiler: null, loop: null }
}

/**
 * The ST-1 report. `complete` is false for the periodic partial report and for a run the harness itself
 * could not finish (`harnessError`); either has verdict INCOMPLETE, because a measurement that stopped
 * early proves nothing either way. A complete run's verdict comes from the criteria alone.
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
  fixtureCounts = null
}) {
  const criteria = evaluateCriteria(row, measured, evidence)
  // The control row has nothing to exercise: its verdict is the criteria alone.
  const exercised = row === 'none' || evidence?.exercised
  const verdict = !complete ? 'INCOMPLETE' : !exercised ? 'NOT_EXERCISED' : criteria.every((c) => c.pass) ? 'PASS' : 'FAIL'
  return {
    harness: 'ST-1',
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
    timeline: [...measured.samples, ...measured.late.map((entry) => ({ ...entry, late: true }))].sort((a, b) => a.tMs - b.tMs),
    historyMode,
    history: measured.history,
    cpuProfile: measured.profiler,
    mainLog: !attribution.mainLog
      ? null
      : attribution.mainLog.error
        ? { error: attribution.mainLog.error }
        : { fromByte: attribution.mainLog.fromByte, exactLaunchOffset: attribution.mainLog.exactLaunchOffset },
    appEvidence: attribution.appEvidence
  }
}

/** The launch itself never reached a candidate to measure: a genuine FAIL (inspector: false), never a
 *  skipped row. */
export function buildLaunchFailureReport({ row, installer, candidate, fixtures, reason }) {
  return {
    harness: 'ST-1',
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
