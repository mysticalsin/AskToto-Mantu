import type { IncrementalJournalLimits } from './incremental-meeting-journal'
import { MEETING_SPEECH_LIMITS } from './meeting-speech-policy'

/**
 * The trusted, main-owned budgets of the live meeting journal. Approved by the owner 2026-10-21 (Métis 2.12, C09b
 * design section 2); no renderer setting or IPC can change them. The per-record limits are exactly the speech
 * provenance budget (the journal and the save codec share one definition of a legal line); the journal adds its
 * own disk cap.
 */
export const LIVE_MEETING_JOURNAL_LIMITS: Readonly<IncrementalJournalLimits> = Object.freeze({
  ...MEETING_SPEECH_LIMITS,
  /** 2x the whole-meeting payload: physical overhead is +50% at ~2 KB records and more at tiny ones (128 MiB). */
  maxJournalBytes: 134_217_728
})

/** The physical store budgets the file adapter requires explicitly (it supplies no defaults). */
export interface LiveMeetingJournalStorageBudget {
  maxPhysicalRecordBytes: number
  maxChunkBytes: number
  maxPageRecords: number
  maxPageBytes: number
}

export const LIVE_MEETING_JOURNAL_STORAGE_BUDGET: Readonly<LiveMeetingJournalStorageBudget> = Object.freeze({
  /** maxRecordBytes + ~8 KiB for the identity/source wrapper, record metadata and the 44 B header (136 KiB). */
  maxPhysicalRecordBytes: 139_264,
  /** The 64 KiB buffer already used by atomic-saved-write. */
  maxChunkBytes: 65_536,
  /** One recovery slice; the reader asks for 128 and yields between pages. */
  maxPageRecords: 256,
  /** maxPageRecords x maxPhysicalRecordBytes. Accounting only: a legal page is never falsely refused. */
  maxPageBytes: 35_651_584
})

/** Finals arrive ~1-2/s/track and drain in ~20 ms; overflow is covered by the next 60 s draft tick. */
export const LIVE_MEETING_JOURNAL_APPEND_QUEUE_MAX = 64

/** After a failed open the meeting is not retried for this long: bounded I/O, no per-final retry storm. */
export const LIVE_MEETING_JOURNAL_OPEN_RETRY_MS = 15_000

/**
 * The section 2 DERIVED per-record size for a 12-word final (~2 KB canonical, ~3 KB physical per record including
 * its identity and index files). Kept only so the size test can fail loudly if measurement contradicts it by more
 * than 2x; no runtime code reads it.
 */
export const LIVE_MEETING_JOURNAL_RECORD_ESTIMATE = Object.freeze({ canonicalBytes: 2_048, physicalBytes: 2_950 })

/** Throws when the shipped numbers contradict each other; a broken policy must fail at first use, never silently. */
export function validateLiveMeetingJournalPolicy(
  limits: Readonly<IncrementalJournalLimits> = LIVE_MEETING_JOURNAL_LIMITS,
  storage: Readonly<LiveMeetingJournalStorageBudget> = LIVE_MEETING_JOURNAL_STORAGE_BUDGET,
  queueMax: number = LIVE_MEETING_JOURNAL_APPEND_QUEUE_MAX
): void {
  const values = [...Object.values(limits), ...Object.values(storage), queueMax]
  if (
    Object.keys(limits).length !== 6 ||
    Object.keys(storage).length !== 4 ||
    values.some((value) => !Number.isSafeInteger(value) || value <= 0) ||
    limits.maxFieldBytes > limits.maxRecordBytes ||
    limits.maxRecordBytes > limits.maxPayloadBytes ||
    limits.maxPayloadBytes > limits.maxJournalBytes ||
    storage.maxPhysicalRecordBytes <= limits.maxRecordBytes ||
    storage.maxPhysicalRecordBytes > limits.maxJournalBytes ||
    storage.maxChunkBytes > Math.min(limits.maxJournalBytes, storage.maxPhysicalRecordBytes) ||
    storage.maxPageBytes > limits.maxJournalBytes ||
    storage.maxPageBytes !== storage.maxPageRecords * storage.maxPhysicalRecordBytes
  )
    throw new Error('Live meeting journal policy is inconsistent.')
}
