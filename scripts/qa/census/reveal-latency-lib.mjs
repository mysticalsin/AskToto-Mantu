/**
 * Reveal latency of the packaged app's parked Hide overlay (ADR-018, M2-0039): how long after the real pointer
 * enters the right-edge reveal band the window leaves its parked band, net of the intentional hover dwell.
 * Pure helpers; reveal-latency.mjs drives the app.
 */

/** Acceptance bar for the net p95 (the intentional dwell is not latency). */
export const REVEAL_LATENCY_P95_MAX_MS = 150
/** CURSOR_REVEAL_DWELL_MS in src/main/island/cursor-watch.ts: the right-edge band's intentional dwell. */
export const RIGHT_EDGE_REVEAL_DWELL_MS = 150
/** RIGHT_EDGE_REVEAL_BAND_PX in src/main/island/geometry.ts: the band is the parked window's rightmost pixels. */
export const RIGHT_EDGE_REVEAL_BAND_PX = 4
/** CURSOR_WATCH_IDLE_INTERVAL_MS in src/main/island/idle-throttle.ts; each trial starts at a random phase of it. */
export const CURSOR_WATCH_IDLE_INTERVAL_MS = 250
/** A parked Hide window is the 4 px band (Windows widens frameless windows to 32 px); a revealed drawer is far wider. */
export const PARKED_MAX_WIDTH_PX = 40
/** Every approach starts this far left of the band, beyond the idle-throttle fast-polling margin, at rest. */
export const APPROACH_START_OFFSET_PX = 600
export const DEFAULT_TRIALS = 20
/**
 * Approach speeds in px/ms. 1 px/ms is a brisk pointer move and sits inside the idle throttle's design speed, so it
 * gates the result; the 3 px/ms fling is recorded for the cadence tuning of M2-0039.3 and does not gate.
 */
export const APPROACH_SERIES = [
  { name: 'approach', speedPxPerMs: 1, gated: true },
  { name: 'fling', speedPxPerMs: 3, gated: false }
]

/** Reveal latency is measured on the shipped default: Hide, docked at the right edge, onboarding done. */
export function validateRevealProfile(settings) {
  if (settings?.overlayLayout !== 'hide' || settings?.overlayPlacement !== 'right-edge' || settings?.onboardingDone !== true) {
    throw new Error(
      'reveal latency needs a profile with overlayLayout hide, overlayPlacement right-edge and onboarding done; build one with profile.mjs --overlay-layout hide'
    )
  }
}

export function isParkedBounds(bounds) {
  return Number.isFinite(bounds?.width) && bounds.width > 0 && bounds.width <= PARKED_MAX_WIDTH_PX
}

/**
 * Pointer moves for one parked band: `away` rests the pointer left of the band at its vertical centre, `approach(speed)`
 * runs from there to the display edge; entry is the first point inside the band.
 */
export function approachPlan(parked) {
  if (!isParkedBounds(parked)) throw new Error(`the overlay is not parked in its right-edge band: ${JSON.stringify(parked)}`)
  const edge = parked.x + parked.width
  const toX = edge - 1
  const fromX = toX - APPROACH_START_OFFSET_PX
  if (fromX < 0) throw new Error(`the display is too narrow to start ${APPROACH_START_OFFSET_PX} px left of the band`)
  const y = Math.round(parked.y + parked.height / 2)
  return {
    away: { fromX, toX: fromX, y, speedPxPerMs: 0, entryX: fromX },
    approach: (speedPxPerMs) => ({ fromX, toX, y, speedPxPerMs, entryX: edge - RIGHT_EDGE_REVEAL_BAND_PX })
  }
}

/** Nearest-rank percentile; null for no values. */
export function percentile(values, p) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length))) - 1]
}

/**
 * trials: [{ entryAt, revealAt }] with revealAt null for a reveal that never came. A missed reveal fails the series:
 * it is the worst latency there is, never a dropped sample.
 */
export function summarizeRevealSeries(trials, { dwellMs = RIGHT_EDGE_REVEAL_DWELL_MS, p95MaxMs = REVEAL_LATENCY_P95_MAX_MS } = {}) {
  const gross = trials.filter((trial) => Number.isFinite(trial.revealAt)).map((trial) => trial.revealAt - trial.entryAt)
  const net = gross.map((ms) => ms - dwellMs)
  const misses = trials.length - gross.length
  const netP95Ms = percentile(net, 95)
  return {
    trials: trials.length,
    misses,
    grossMs: gross,
    netP50Ms: percentile(net, 50),
    netP95Ms,
    netMaxMs: net.length ? Math.max(...net) : null,
    status: trials.length > 0 && misses === 0 && netP95Ms <= p95MaxMs ? 'PASS' : 'FAIL'
  }
}

/** The artifact: the gated series decides the status. */
export function revealLatencyReport({ platform, productVersion, parked, series }) {
  const gated = series.filter((row) => row.gated)
  return {
    schema: 'metis.reveal-latency.v1',
    platform,
    productVersion,
    layout: 'hide',
    placement: 'right-edge',
    dwellMs: RIGHT_EDGE_REVEAL_DWELL_MS,
    p95MaxMs: REVEAL_LATENCY_P95_MAX_MS,
    definition:
      'net latency = time the window leaves its parked band minus time the real pointer entered the reveal band, minus the intentional dwell',
    parked,
    series,
    status: gated.length > 0 && gated.every((row) => row.status === 'PASS') ? 'PASS' : 'FAIL'
  }
}

export function revealLatencyFailedReport({ platform, productVersion = null, reason }) {
  return { schema: 'metis.reveal-latency.v1', platform, productVersion, status: 'FAIL', reason }
}

export function revealLatencyBlockedReport({ platform, productVersion = null, reason }) {
  return {
    schema: 'metis.reveal-latency.v1',
    platform,
    productVersion,
    status: 'BLOCKED_EXTERNAL',
    reason,
    unblockStep:
      'Run node scripts/qa/census/reveal-latency.mjs --app <installed app> --profile <hide profile> --output <json> on a session that can move the pointer (an interactive desktop).'
  }
}

/** Exit code for a report: 0 PASS, 1 FAIL, 3 BLOCKED_EXTERNAL. */
export function revealLatencyExitCode(report) {
  if (report.status === 'PASS') return 0
  if (report.status === 'BLOCKED_EXTERNAL') return 3
  return 1
}

/**
 * CI gate over a written report (or null when none was written): only a FAIL, or no report at all, fails the job;
 * BLOCKED_EXTERNAL passes with a warning that names the unblock step, so it is never read as a measurement.
 */
export function revealLatencyGate(report) {
  if (!report) return { fail: true, message: 'no reveal-latency report was written; see the measurement step log' }
  if (report.status === 'PASS') return { fail: false, message: 'reveal latency PASS' }
  if (report.status === 'BLOCKED_EXTERNAL') {
    return { fail: false, warning: true, message: `reveal latency BLOCKED_EXTERNAL: ${report.reason}. ${report.unblockStep}` }
  }
  return { fail: true, message: `reveal latency ${report.status}: ${report.reason ?? 'net p95 over the bar or a missed reveal'}` }
}

export function readRevealLatencyArgs(argv) {
  const args = { trials: DEFAULT_TRIALS, settleMs: 15_000 }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      i += 1
      if (i >= argv.length) throw new Error(`${arg} requires a value`)
      return argv[i]
    }
    if (arg === '--app') args.app = next()
    else if (arg === '--profile') args.profile = next()
    else if (arg === '--output') args.output = next()
    else if (arg === '--trials') args.trials = Number(next())
    else if (arg === '--settle-ms') args.settleMs = Number(next())
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (!args.app || !args.profile || !args.output) throw new Error('--app, --profile and --output are required')
  if (!Number.isInteger(args.trials) || args.trials < 1) throw new Error('--trials must be a positive whole number')
  if (!Number.isFinite(args.settleMs) || args.settleMs < 0) throw new Error('--settle-ms must be a non-negative number')
  return args
}
