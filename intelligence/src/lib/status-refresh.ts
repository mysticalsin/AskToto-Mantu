export interface BrainStatusSnapshot {
  revision?: number
  backfill?: { running?: boolean }
  live?: { running?: boolean }
}

export const BRAIN_STATUS_STALE_REFRESH_MS = 30 * 60 * 1000

export function brainStatusIsWorking(status: BrainStatusSnapshot): boolean {
  return !!status.backfill?.running || !!status.live?.running
}

/** Full dashboard reads are needed for a persisted change, terminal ingest transition, or clock freshness. */
export function shouldReloadForBrainStatus({
  status,
  previousRevision,
  wasWorking,
  lastLoadAt,
  now
}: {
  status: BrainStatusSnapshot
  previousRevision: number | undefined
  wasWorking: boolean
  lastLoadAt: number
  now: number
}): boolean {
  const revisionChanged = typeof status.revision === 'number' && status.revision !== previousRevision
  const settled = wasWorking && !brainStatusIsWorking(status)
  return revisionChanged || settled || now - lastLoadAt >= BRAIN_STATUS_STALE_REFRESH_MS
}
