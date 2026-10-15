import { fnv1a } from '@shared/hash'
import { basename } from 'node:path'
import type { BrainIndex } from '@shared/brain'
import type { WorkTrigger } from '../infra/scheduler/policy'
import { slugify } from './provenance-order'

export type IngestWorkIdentity = {
  file: string
  key?: string
  origin: 'live' | 'backfill'
  trigger: WorkTrigger
  strategy?: 'reconcile'
}

export function isUnattendedModelWork(job: IngestWorkIdentity): boolean {
  return job.origin === 'backfill' && job.trigger === 'automatic' && job.strategy !== 'reconcile'
}

export function effectiveBackfillTrigger(trigger: WorkTrigger | undefined, pending: WorkTrigger): WorkTrigger {
  return trigger === 'user' || pending === 'user' ? 'user' : 'automatic'
}

export const jobKey = (job: Pick<IngestWorkIdentity, 'key' | 'file'>): string => job.key ?? basename(job.file)

export const extractionSlug = (key: string): string =>
  key.includes('/') ? `${slugify(key)}-${fnv1a(key).toString(16)}` : slugify(key)

export function claimSourceRefreshWork(index: Pick<BrainIndex, 'ingested'>): Set<string> {
  return new Set(
    Object.entries(index.ingested)
      .filter(([, record]) => record.ok)
      .map(([key]) => key)
  )
}

export function observeSourceRefreshWorkFromIndex(
  index: BrainIndex,
  workKeys: ReadonlySet<string>,
  retryKeys: ReadonlySet<string>,
  observe: (key: string) => void
): void {
  for (const key of workKeys) observe(key)
  for (const key of retryKeys) observe(key)
  if (workKeys.size > 0 || retryKeys.size > 0 || !index.sourceRefreshRequested || index.replayPending) return
  for (const key of claimSourceRefreshWork(index)) observe(key)
}

export function preserveSourceRefreshWork(
  index: BrainIndex,
  current: Set<string>,
  observe: (key: string) => void
): Set<string> {
  const keys = claimSourceRefreshWork(index)
  const preserved = keys.size > 0 ? keys : current
  for (const key of preserved) observe(key)
  return preserved
}

export class PublicationFailure extends Error {
  constructor(error: unknown) {
    super(error instanceof Error ? error.message : String(error))
  }
}

export class BackfillScanFailure extends Error {
  constructor(error: unknown) {
    super(error instanceof Error ? error.message : String(error))
  }
}

export type CompletionError = 'incomplete' | 'no-provider' | 'scan-failed' | 'publication-failed' | 'write-failed'

export function recordCompletionError<T extends { error?: CompletionError }>(
  observer: T | null,
  error: CompletionError
): void {
  if (!observer) return
  const priority: Record<CompletionError, number> = {
    incomplete: 0,
    'no-provider': 1,
    'scan-failed': 2,
    'publication-failed': 3,
    'write-failed': 4
  }
  if (!observer.error || priority[error] > priority[observer.error]) observer.error = error
}

export async function trackedPublication(work: () => Promise<unknown>, onFailure: () => void): Promise<void> {
  try {
    await work()
  } catch (error) {
    onFailure()
    throw new PublicationFailure(error)
  }
}
