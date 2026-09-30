import {
  beginDurableWatch,
  describeEarlyDeath,
  endDurableWatch,
  newestCrashDump,
  readDurableWatchRecord,
  type BootRecord,
  type EarlyDeath
} from './boot-sentinel'

const BRAIN_RESUME_SENTINEL = 'brain-resume-incomplete.json'

export type BrainResumeDeath = BootRecord & { crashDump: string | null }
export type BrainResumeSafeStartReason = 'brain-resume' | 'early-boot'
export type BrainResumeSafeStart = { reason: BrainResumeSafeStartReason; detail: string; consecutive: number }

export interface BrainResumeBackfillOptions {
  bootWork: { run(name: string, job: () => unknown): void }
  userData: string
  version: string
  resumeBackfillIfPending: () => Promise<unknown>
  warn: (message: string, error: unknown) => void
}

export interface BrainResumeSafeStartLoggers {
  warn: (message: string) => void
  audit: (event: 'app.error.early_death', detail: { consecutive: number; recoveryStatus: 'safe_start' }) => void
}

/** Read a stale brain-resume marker without claiming the current run's resume window. */
export function readBrainResumeDeath(userData: string): BrainResumeDeath | null {
  const previous = readDurableWatchRecord(userData, BRAIN_RESUME_SENTINEL)
  return previous ? { ...previous, consecutive: previous.consecutive + 1, crashDump: newestCrashDump(userData) } : null
}

export function brainResumeSafeStartDecision(userData: string, earlyDeath: EarlyDeath | null): BrainResumeSafeStart | null {
  const brainResumeDeath = readBrainResumeDeath(userData)
  if (brainResumeDeath) {
    return {
      reason: 'brain-resume',
      detail: describeBrainResumeDeath(brainResumeDeath),
      consecutive: brainResumeDeath.consecutive
    }
  }
  if (earlyDeath) {
    return {
      reason: 'early-boot',
      detail: describeEarlyDeath(earlyDeath),
      consecutive: earlyDeath.consecutive
    }
  }
  return null
}

/**
 * Claim the delayed brain-resume window and report the previous launch if it died inside that window.
 * The early boot sentinel may already be cleared by this point; this marker is deliberately separate.
 */
export function beginBrainResumeWatch(
  userData: string,
  version: string,
  now: () => string = () => new Date().toISOString()
): BrainResumeDeath | null {
  const previous = beginDurableWatch(userData, BRAIN_RESUME_SENTINEL, version, now)
  return previous ? { ...previous, crashDump: newestCrashDump(userData) } : null
}

/** Clear the delayed brain-resume marker. Idempotent for finally/will-quit/forced-exit paths. */
export function endBrainResumeWatch(userData: string): void {
  endDurableWatch(userData, BRAIN_RESUME_SENTINEL)
}

export async function withBrainResumeWatch<T>(
  userData: string,
  version: string,
  job: () => Promise<T>
): Promise<T> {
  beginBrainResumeWatch(userData, version)
  try {
    return await job()
  } finally {
    endBrainResumeWatch(userData)
  }
}

export function queueBrainResumeBackfill(options: BrainResumeBackfillOptions): void {
  const { bootWork, userData, version, resumeBackfillIfPending, warn } = options
  try {
    bootWork.run('resumeBackfillIfPending', () =>
      withBrainResumeWatch(userData, version, async () => {
        try {
          await resumeBackfillIfPending()
        } catch (error) {
          warn('[boot] resumeBackfillIfPending failed:', error)
        }
      })
    )
  } catch (error) {
    warn('[boot] resumeBackfillIfPending failed:', error)
  }
}

export function recordBrainResumeSafeStart(safeStart: BrainResumeSafeStart, loggers: BrainResumeSafeStartLoggers): void {
  loggers.warn(`[boot] safe start — skipping the brain backfill/reconcile resume: ${safeStart.detail}`)
  loggers.audit('app.error.early_death', { consecutive: safeStart.consecutive, recoveryStatus: 'safe_start' })
}

export function finishBrainResumeTimer(userData: string, safeStart: BrainResumeSafeStart | null): void {
  if (safeStart?.reason === 'brain-resume') endBrainResumeWatch(userData)
}

export function describeBrainResumeDeath(d: BrainResumeDeath): string {
  return (
    `previous launch (pid ${d.pid}, v${d.version}, started ${d.startedAt}) died during brain resume; ` +
    `consecutive brain-resume deaths: ${d.consecutive}; newest Crashpad minidump: ${d.crashDump ?? 'none'}`
  )
}
