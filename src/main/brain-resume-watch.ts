import { beginDurableWatch, endDurableWatch, newestCrashDump, readDurableWatchRecord, type BootRecord } from './boot-sentinel'

const BRAIN_RESUME_SENTINEL = 'brain-resume-incomplete.json'

export type BrainResumeDeath = BootRecord & { crashDump: string | null }

/** Read a stale brain-resume marker without claiming the current run's resume window. */
export function readBrainResumeDeath(userData: string): BrainResumeDeath | null {
  const previous = readDurableWatchRecord(userData, BRAIN_RESUME_SENTINEL)
  return previous ? { ...previous, consecutive: previous.consecutive + 1, crashDump: newestCrashDump(userData) } : null
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

export function describeBrainResumeDeath(d: BrainResumeDeath): string {
  return (
    `previous launch (pid ${d.pid}, v${d.version}, started ${d.startedAt}) died during brain resume; ` +
    `consecutive brain-resume deaths: ${d.consecutive}; newest Crashpad minidump: ${d.crashDump ?? 'none'}`
  )
}
