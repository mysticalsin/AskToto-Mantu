// WP14 sandbox acceptance — the growth verdict for the 60-minute installed soak, SOAK-ACCEPT-1. This is NOT the
// pre-registered 5.5 h IDLE-GROWTH-1 / MEETING-GROWTH-1 rule set (scripts/qa/soak/growth-rule.mjs, hash-pinned); it is
// a shorter acceptance rule with the same statistics (Theil-Sen slope, medians) and the same outcome logic
// (decideOutcome). Every threshold is stated in THRESHOLDS and echoed into the report and the markdown summary.
import { decideOutcome, median, theilSenSlope } from '../soak/growth.mjs'
import { oneCoreCpuPercent } from '../census/lib.mjs'
import { totalRss } from './sampler.mjs'

export const SOAK_RULE_ID = 'SOAK-ACCEPT-1'
export const MIB = 1024 * 1024
export const MINUTE_MS = 60_000

export const THRESHOLDS = Object.freeze({
  fullSoakMinutes: 60,
  minCompleteSampleFraction: 0.95,
  settle:
    'first min(10 min, 25% of the phase) of each phase is settle; the reference is the median of the last 2.5 min of settle',
  minWindowSamples: 4,
  projectionMinutes: 60,
  idle: Object.freeze({
    rssGrowth:
      'Theil-Sen slope of total RSS over the window, projected to 60 min, and last-3 minus first-3 median, each <= max(64 MiB, 10% of reference)',
    processCount: 'max owned-process count in the window <= reference count + 2',
    cpu: 'mean one-core CPU% of the last third of the window <= the first third + 0.5 points',
    rssFloorBytes: 64 * MIB,
    rssFraction: 0.1,
    processAllowance: 2,
    cpuAllowancePoints: 0.5,
    absoluteCpu:
      'PROPOSED, advisory (C30 / D10-9): mean one-core CPU% over the idle window <= 5% (target: the default hide layout); reported, not part of the outcome until accepted',
    absoluteCpuBudgetPercent: 5
  }),
  meeting: Object.freeze({
    rssGrowth:
      'as idle, bound max(160 MiB, 20% of reference): the live transcript lives in renderer state until the journal',
    processCount:
      'max owned-process count in the window <= reference count + 4 (ASR, speaker and local-LLM helpers may appear)',
    cpu: 'mean one-core CPU% of the last third of the window <= the first third + 5 points',
    rssFloorBytes: 160 * MIB,
    rssFraction: 0.2,
    processAllowance: 4,
    cpuAllowancePoints: 5
  }),
  post: Object.freeze({
    rssReturn: 'median of the last 3 post-meeting total-RSS samples <= the meeting reference + max(160 MiB, 20% of it)',
    processCount: 'max owned-process count after the meeting <= idle reference count + 4'
  })
})

const SETTLE_REF_WINDOW_MS = 2.5 * MINUTE_MS
const SETTLE_MAX_MS = 10 * MINUTE_MS
const SETTLE_FRACTION = 0.25
const bounded = (id, subject, measured, bound, unit) => ({
  id: `${id}-${subject}`,
  family: id,
  subject,
  measured,
  bound,
  unit,
  pass: measured <= bound
})

/** The slice of `samples` inside a phase, complete samples only (main alive and every process has an RSS). */
function completeIn(samples, phase) {
  return samples.filter(
    (sample) =>
      sample.mainAlive && sample.tMs >= phase.startMs && sample.tMs <= phase.endMs && totalRss(sample) !== null
  )
}

function cpuMean(subset) {
  if (subset.length < 2) return null
  const wallSeconds = (subset.at(-1).tMs - subset[0].tMs) / 1000
  return wallSeconds > 0 ? oneCoreCpuPercent(subset, wallSeconds) : null
}

/** @returns {{ ref: { totalBytes: number, count: number, samples: number } | null, window: any[], settleMs: number }} */
export function phaseFrame(samples, phase) {
  const inPhase = completeIn(samples, phase)
  const settleMs = Math.min(SETTLE_MAX_MS, SETTLE_FRACTION * (phase.endMs - phase.startMs))
  const settleEnd = phase.startMs + settleMs
  const refSamples = inPhase.filter(
    (sample) => sample.tMs < settleEnd && sample.tMs >= settleEnd - SETTLE_REF_WINDOW_MS
  )
  const window = inPhase.filter((sample) => sample.tMs >= settleEnd)
  const ref = refSamples.length
    ? {
        totalBytes: median(refSamples.map(totalRss)),
        count: median(refSamples.map((sample) => sample.processes.length)),
        samples: refSamples.length
      }
    : null
  return { ref, window, settleMs }
}

/**
 * Judge a soak. `samples` are { tMs (from soak start), mainAlive, processes[] }; `phases` are the ACTUAL phase
 * boundaries ({ id: 'idle' | 'meeting' | 'post', startMs, endMs }) measured from soak start.
 * `layout` is the seeded overlay layout, recorded with the advisory absolute idle CPU budget (B1-idle).
 * @param {{ samples: any[], phases: { id: string, startMs: number, endMs: number }[], intervalMs: number, requestedMinutes: number, layout?: string }} args
 */
export function evaluateSoak({ samples, phases, intervalMs, requestedMinutes, layout = 'unrecorded' }) {
  if (!phases.length) throw new Error('evaluateSoak needs at least one phase')
  const validity = []
  const checks = []
  const required = []
  const budgets = []
  validity.push({
    id: 'V-MAIN',
    pass: samples.every((sample) => sample.mainAlive),
    measured: samples.filter((sample) => !sample.mainAlive).length,
    bound: 0,
    unit: 'samples with main dead'
  })
  const first = Math.min(...phases.map((phase) => phase.startMs))
  const last = Math.max(...phases.map((phase) => phase.endMs))
  const planned = Math.floor((last - first) / intervalMs) + 1
  const complete = samples.filter((sample) => sample.mainAlive && totalRss(sample) !== null).length
  validity.push({
    id: 'V-SAMPLES',
    pass: complete >= THRESHOLDS.minCompleteSampleFraction * planned,
    measured: complete,
    bound: Math.ceil(THRESHOLDS.minCompleteSampleFraction * planned),
    unit: 'complete samples (planned ' + planned + ')'
  })

  const frames = {}
  const phaseSummaries = {}
  for (const phase of phases) {
    const frame = phaseFrame(samples, phase)
    frames[phase.id] = frame
    validity.push({
      id: `V-REF-${phase.id}`,
      pass: frame.ref !== null,
      measured: frame.ref?.samples ?? 0,
      bound: 1,
      unit: 'reference samples'
    })
    validity.push({
      id: `V-WINDOW-${phase.id}`,
      pass: frame.window.length >= THRESHOLDS.minWindowSamples,
      measured: frame.window.length,
      bound: THRESHOLDS.minWindowSamples,
      unit: 'window samples'
    })
    phaseSummaries[phase.id] = {
      startMs: phase.startMs,
      endMs: phase.endMs,
      settleMs: frame.settleMs,
      referenceTotalBytes: frame.ref?.totalBytes ?? null,
      referenceProcessCount: frame.ref?.count ?? null,
      windowSamples: frame.window.length
    }
    if (!frame.ref || frame.window.length < THRESHOLDS.minWindowSamples) continue

    const totals = frame.window.map(totalRss)
    if (phase.id === 'post') {
      const meeting = frames.meeting?.ref
      const idleRef = frames.idle?.ref
      if (meeting) {
        const bound =
          meeting.totalBytes +
          Math.max(THRESHOLDS.meeting.rssFloorBytes, THRESHOLDS.meeting.rssFraction * meeting.totalBytes)
        checks.push(bounded('POST-R', 'post', median(totals.slice(-3)), bound, 'bytes'))
        required.push('POST-R-post')
      }
      if (idleRef) {
        checks.push(
          bounded(
            'POST-P',
            'post',
            Math.max(...frame.window.map((sample) => sample.processes.length)),
            idleRef.count + THRESHOLDS.meeting.processAllowance,
            'processes'
          )
        )
        required.push('POST-P-post')
      }
      continue
    }
    const rule = THRESHOLDS[phase.id]
    if (!rule) continue
    const bound = Math.max(rule.rssFloorBytes, rule.rssFraction * frame.ref.totalBytes)
    const slopePerMs = theilSenSlope(frame.window.map((sample, index) => ({ x: sample.tMs, y: totals[index] })))
    checks.push(
      bounded('R1', phase.id, slopePerMs * THRESHOLDS.projectionMinutes * MINUTE_MS, bound, 'bytes projected to 60 min')
    )
    checks.push(
      bounded('R2', phase.id, median(totals.slice(-3)) - median(totals.slice(0, 3)), bound, 'bytes last3-first3')
    )
    checks.push(
      bounded(
        'P1',
        phase.id,
        Math.max(...frame.window.map((sample) => sample.processes.length)),
        frame.ref.count + rule.processAllowance,
        'processes'
      )
    )
    if (phase.id === 'idle') {
      // The drift checks bound change only; this states the absolute idle cost against the proposed budget.
      const mean = cpuMean(frame.window)
      if (mean !== null)
        budgets.push({
          id: 'B1-idle',
          status: 'PROPOSED',
          layout,
          measured: mean,
          bound: THRESHOLDS.idle.absoluteCpuBudgetPercent,
          unit: 'mean one-core CPU % over the idle window',
          within: mean <= THRESHOLDS.idle.absoluteCpuBudgetPercent
        })
    }
    const third = Math.floor(frame.window.length / 3)
    const early = cpuMean(frame.window.slice(0, third))
    const late = cpuMean(frame.window.slice(-third))
    if (early !== null && late !== null) {
      checks.push(
        bounded(
          'C1',
          phase.id,
          late - early,
          rule.cpuAllowancePoints,
          'one-core CPU points last third minus first third'
        )
      )
      phaseSummaries[phase.id].cpuEarlyPercent = early
      phaseSummaries[phase.id].cpuLatePercent = late
    }
    required.push(`R1-${phase.id}`, `R2-${phase.id}`, `P1-${phase.id}`, `C1-${phase.id}`)
  }
  const outcome = decideOutcome({ validity, checks, required })
  return {
    rule: { id: SOAK_RULE_ID, thresholds: THRESHOLDS },
    outcome,
    fullSoak: requestedMinutes >= THRESHOLDS.fullSoakMinutes,
    requestedMinutes,
    validity,
    checks,
    budgets,
    layout,
    failed: [
      ...validity.filter((clause) => !clause.pass).map((clause) => clause.id),
      ...checks.filter((check) => !check.pass).map((check) => check.id)
    ],
    phases: phaseSummaries
  }
}

/**
 * Phase lengths in minutes. Defaults to 40% idle, 50% meeting, 10% post-meeting; explicit idle/meeting minutes win and
 * the remainder is post. Throws when the plan does not fit.
 * @param {{ minutes: number, idleMinutes?: number, meetingMinutes?: number }} args
 */
export function planPhases({ minutes, idleMinutes, meetingMinutes }) {
  if (!(minutes > 0)) throw new Error('--minutes must be positive')
  const idle = idleMinutes ?? Math.round(minutes * 0.4 * 2) / 2
  const meeting = meetingMinutes ?? Math.round(minutes * 0.5 * 2) / 2
  const post = minutes - idle - meeting
  if (idle < 0 || meeting < 0 || post < 0)
    throw new Error(`idle (${idle}) + meeting (${meeting}) minutes exceed --minutes (${minutes})`)
  return [
    { id: 'idle', minutes: idle },
    { id: 'meeting', minutes: meeting },
    { id: 'post', minutes: post }
  ].filter((phase) => phase.minutes > 0)
}

const fmtMib = (bytes) => (bytes === null || bytes === undefined ? 'n/a' : `${(bytes / MIB).toFixed(1)} MiB`)

/** A short markdown summary: outcome, thresholds, per-phase numbers, queue status. Content-free. */
export function renderSummary({ verdict, queue, meta = {} }) {
  const lines = []
  lines.push(`# Installed soak summary (${SOAK_RULE_ID})`)
  lines.push('')
  lines.push(
    `Outcome: **${verdict.outcome}**${verdict.fullSoak ? '' : ` (NOT A FULL ${THRESHOLDS.fullSoakMinutes}-MINUTE SOAK: ${verdict.requestedMinutes} min requested)`}`
  )
  if (meta.appVersion) lines.push(`App: ${meta.appVersion}${meta.bundleId ? ` (${meta.bundleId})` : ''}`)
  if (verdict.failed.length) lines.push(`Failed or invalid: ${verdict.failed.join(', ')}`)
  lines.push('')
  lines.push('## Thresholds (stated before the run)')
  lines.push(
    `- Validity: main alive at every sample; at least ${THRESHOLDS.minCompleteSampleFraction * 100}% of planned samples complete; at least ${THRESHOLDS.minWindowSamples} window samples per phase.`
  )
  lines.push(`- Settle: ${THRESHOLDS.settle}.`)
  lines.push(`- Idle: ${THRESHOLDS.idle.rssGrowth}; ${THRESHOLDS.idle.processCount}; ${THRESHOLDS.idle.cpu}.`)
  lines.push(
    `- Meeting: ${THRESHOLDS.meeting.rssGrowth}; ${THRESHOLDS.meeting.processCount}; ${THRESHOLDS.meeting.cpu}.`
  )
  lines.push(`- Post-meeting: ${THRESHOLDS.post.rssReturn}; ${THRESHOLDS.post.processCount}.`)
  lines.push('')
  lines.push('## Phases')
  for (const [id, phase] of Object.entries(verdict.phases)) {
    lines.push(
      `- ${id}: ${((phase.endMs - phase.startMs) / MINUTE_MS).toFixed(1)} min, reference ${fmtMib(phase.referenceTotalBytes)} / ${phase.referenceProcessCount ?? 'n/a'} processes, ${phase.windowSamples} window samples` +
        (phase.cpuEarlyPercent === undefined
          ? ''
          : `, CPU ${phase.cpuEarlyPercent.toFixed(2)}% to ${phase.cpuLatePercent.toFixed(2)}% of one core`)
    )
  }
  lines.push('')
  lines.push('## Checks')
  for (const check of verdict.checks) {
    const scale = check.unit.startsWith('bytes') ? fmtMib : (value) => String(Math.round(value * 100) / 100)
    lines.push(
      `- ${check.pass ? 'PASS' : 'FAIL'} ${check.id}: ${scale(check.measured)} (bound ${scale(check.bound)}; ${check.unit})`
    )
  }
  lines.push('')
  lines.push('## Absolute idle CPU budget (PROPOSED, advisory)')
  lines.push(`- ${THRESHOLDS.idle.absoluteCpu}.`)
  for (const budget of verdict.budgets ?? [])
    lines.push(
      `- ${budget.within ? 'WITHIN' : 'OVER'} ${budget.id}: ${Math.round(budget.measured * 100) / 100} (bound ${budget.bound}; ${budget.unit}; layout ${budget.layout})`
    )
  lines.push('')
  lines.push('## Queue depth')
  lines.push(
    queue.status === 'MEASURED'
      ? `- MEASURED via ${queue.source}: max live pending ${queue.maxLivePending}, max backfill remaining ${queue.maxBackfillRemaining}, ${queue.samples} polls.`
      : `- queue: ${queue.status}. ${queue.reason}`
  )
  return `${lines.join('\n')}\n`
}
