import type { BrainStatus } from '@shared/brain'

export function brainStatusIsWorking(status: Pick<BrainStatus, 'backfill' | 'live' | 'intelligenceIndex'> | null): boolean {
  return !!(status?.backfill?.running || status?.backfill?.preparing || status?.live?.running || status?.intelligenceIndex?.running)
}

/** Compact status remains cheap enough to poll while idle; full reads stay reserved for a transition. */
export function brainStatusPollInterval(working: boolean): number {
  return working ? 1_000 : 2_000
}

export function shouldRefreshAfterBrainStatusTransition(wasWorking: boolean, isWorking: boolean): boolean {
  return wasWorking && !isWorking
}

/** A revision catches same-count changes such as a correction, a source-file edit, or a repaired merge. */
export function shouldRefreshAfterBrainStatus({
  previousRevision,
  revision,
  wasWorking,
  isWorking
}: {
  previousRevision: number | undefined
  revision: number | undefined
  wasWorking: boolean
  isWorking: boolean
}): boolean {
  const revisionChanged = typeof revision === 'number' && previousRevision !== revision
  return revisionChanged || shouldRefreshAfterBrainStatusTransition(wasWorking, isWorking)
}
