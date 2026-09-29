/**
 * Scheduler policy: the pure decisions every background caller shares. Callers pass what they observed;
 * maintenance.ts holds the process state.
 *  - Retry and exhaustion: may a not-yet-ingested source be queued now, and what does a failure do to its
 *    ledger record.
 *  - Maintenance admission: may unattended model work start now.
 */

/** Who asked for the work. Only 'user' (an explicit click) revives an exhausted source or starts model work
 *  while maintenance is deferred. Every caller that does not say otherwise is 'automatic'. */
export type WorkTrigger = 'user' | 'automatic'

/** Consecutive genuine failures after which automatic triggers stop retrying a source. */
export const MAX_INGEST_ATTEMPTS = 6

const MAX_RETRY_DELAY_MS = 30 * 60_000
const retryDelayMs = (attempts: number): number =>
  Math.min(MAX_RETRY_DELAY_MS, 60_000 * 2 ** Math.max(0, attempts - 1))

/** One source file as one scan sees it. `changedAtMs` is its ctime: edits move it, and so do cloud
 *  hydration and eviction, which leave mtime and size unchanged (infra/storage/dataless.ts relies on the same). */
export interface SourceObservation {
  version?: string
  changedAtMs?: number
}

/** The retry fields of a ledger record that is not ok (structural subset of BrainIndex['ingested'][key]). */
export interface AttemptRecord {
  sourceVersion?: string
  attempts?: number
  retryAfter?: number
  exhausted?: boolean
  unreadable?: { changedAtMs?: number }
}

export type HoldReason = 'exhausted' | 'backed-off' | 'unreadable'
export type Admission = { action: 'queue' } | { action: 'revive' } | { action: 'hold'; reason: HoldReason }

export function admitSource(
  record: AttemptRecord | undefined,
  source: SourceObservation,
  trigger: WorkTrigger,
  now: number
): Admission {
  if (!record) return { action: 'queue' }
  if (trigger === 'user') return record.exhausted ? { action: 'revive' } : { action: 'queue' }
  if (record.exhausted) return { action: 'hold', reason: 'exhausted' }
  if (record.unreadable) {
    return record.unreadable.changedAtMs === source.changedAtMs
      ? { action: 'hold', reason: 'unreadable' }
      : { action: 'queue' }
  }
  const unchanged = source.version !== undefined && record.sourceVersion === source.version
  return unchanged && (record.retryAfter ?? 0) > now ? { action: 'hold', reason: 'backed-off' } : { action: 'queue' }
}

/** Gives an exhausted source a fresh attempt budget with no backoff. Only an explicit Retry reaches this. */
export function reviveExhausted(record: AttemptRecord): void {
  record.attempts = 0
  delete record.exhausted
  delete record.retryAfter
}

/** The retry fields of the record a failed job leaves. A source this device could not read spends no attempt.
 *  A permanent failure (the source cannot fit the model's context) is exhausted at once: retrying the same
 *  bytes against the same window can only fail again, so only an explicit Retry may spend another model call. */
export function retryStateAfterFailure(
  previous: AttemptRecord | undefined,
  failure: { unreadable: boolean; permanent?: boolean; source: SourceObservation },
  now: number
): Pick<AttemptRecord, 'attempts' | 'retryAfter' | 'exhausted' | 'unreadable'> {
  const spent = previous?.attempts ?? 0
  if (failure.unreadable) return { attempts: spent, unreadable: { changedAtMs: failure.source.changedAtMs } }
  const attempts = spent + 1
  if (failure.permanent) return { attempts, exhausted: true }
  return {
    attempts,
    retryAfter: now + retryDelayMs(attempts),
    ...(attempts >= MAX_INGEST_ATTEMPTS ? { exhausted: true } : {})
  }
}

/** No unattended model work in the first two minutes of a process. */
export const BOOT_QUIET_PERIOD_MS = 120_000

export type MaintenanceDeferral =
  | 'boot_quiet_period'
  | 'awaiting_first_interaction'
  | 'maintenance_running'
  | 'interactive_active'
export type DeferredReason = MaintenanceDeferral | 'ledger_unavailable'

export interface MaintenanceState {
  uptimeMs: number
  /** How the previous run ended; undefined until this run has read it. */
  priorExit: 'clean' | 'unclean' | 'unknown' | undefined
  interacted: boolean
  holding: boolean
  interactiveActive: boolean
}

export function deferralFor(state: MaintenanceState): MaintenanceDeferral | null {
  if (state.uptimeMs < BOOT_QUIET_PERIOD_MS) return 'boot_quiet_period'
  if (!state.interacted && (state.priorExit === undefined || state.priorExit === 'unclean')) return 'awaiting_first_interaction'
  if (state.holding) return 'maintenance_running'
  if (state.interactiveActive) return 'interactive_active'
  return null
}

/** Input only a person produces: a press, never a hover, move or scroll. */
export function isDeliberateInput(type: string): boolean {
  return type === 'mouseDown' || type === 'rawKeyDown' || type === 'keyDown' || type === 'touchStart'
}
