import type { ImportJob, ImportJobState } from './import-job-types'

/** One decoded recording at a time, from decoder admission through retained-PCM consumption. */
export const MAX_CONCURRENT_DECODES = 1
/** @deprecated Use MAX_CONCURRENT_DECODES. Kept so existing imports keep compiling. */
export const MAX_CONCURRENT_IMPORTS = MAX_CONCURRENT_DECODES

/** The singleton decoder can be reaped once the job is no longer in the decode phase. */
export function decoderSlotIsStale(state: ImportJobState | undefined): boolean {
  return state !== 'decoding'
}

/** VAD cursors count utterance windows, not decoder slabs. Both decoders must replay all PCM. */
export function decodeSkipThrough(job: Pick<ImportJob, 'pipeline' | 'cursor'>): number {
  return job.pipeline === 'vad-v1' || job.pipeline === 'vad-v2' ? 0 : job.cursor
}

export function isTerminalImportJobState(state: ImportJobState): boolean {
  return state === 'done' || state === 'failed' || state === 'policy-held' || state === 'cancelled'
}

export function copyImportJobValue<T>(value: T): T {
  return structuredClone(value)
}

interface AttemptAuthorityState {
  authority?: { assertCurrent(): void; retire(): void }
  accepting: boolean
  tailAllowed: boolean
  authorityRetired: boolean
}

export function retireImportAttemptAuthority(attempt: AttemptAuthorityState): void {
  if (attempt.authorityRetired) return
  attempt.authorityRetired = true
  try {
    attempt.authority?.retire()
  } catch {
    // Retirement is monotonic in the owner; cleanup must not revive or wedge this local attempt.
  }
}

export function stopImportAttempt(attempt: AttemptAuthorityState | undefined): void {
  if (!attempt) return
  attempt.accepting = false
  attempt.tailAllowed = false
  retireImportAttemptAuthority(attempt)
}

export function canFinishImportAttempt(
  attempt: AttemptAuthorityState,
  isCurrent: boolean,
  persistenceConfigured: () => boolean
): boolean {
  if (!isCurrent || !attempt.tailAllowed) return false
  try {
    if (attempt.authority) attempt.authority.assertCurrent()
    else if (persistenceConfigured()) throw new Error('Attempt authority is unavailable.')
    return true
  } catch {
    attempt.accepting = false
    attempt.tailAllowed = false
    retireImportAttemptAuthority(attempt)
    return false
  }
}
