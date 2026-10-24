import { erasureFenceReady, isErasureFenced } from '../../memory-partition/erasure-fence'
import type {
  ReceiptJournalPort,
  SaveReceiptRecord,
  SaveReceiptStage
} from '../../infra/storage/transcript-receipt-journal'

/** The post-save stages a fresh process can finish from the saved file alone, in the save handler's order. */
export const RESUMABLE_STAGES = ['draft-cleanup', 'rebuild', 'ingest'] as const satisfies readonly SaveReceiptStage[]
/** Stages that need the in-memory payload or live session; a relaunch reports them instead of guessing. */
const SESSION_STAGES: readonly SaveReceiptStage[] = ['summary-credit', 'time-saved-credit', 'audit', 'speaker-save']

export interface ResumeStages {
  'draft-cleanup'(path: string, meetingStartedAt: number): Promise<void>
  rebuild(): Promise<void>
  ingest(path: string, options: { deferred: boolean }): Promise<void>
}

export type SavedReceiptIdentityCheck = 'match' | 'missing' | 'mismatch' | 'unavailable'

export interface ResumeDeps {
  journal: ReceiptJournalPort
  /** One captured meetings folder and its verifier. Only an authoritative read/classification may say `missing`. */
  folder: {
    join(name: string): string
    idSha256: string
    verifySavedIdentity(name: string, meetingStartedAt: number, revision: number): Promise<SavedReceiptIdentityCheck>
  }
  stages: ResumeStages
  deferredDefault: boolean
  now(): number
}

export interface ResumeOutcome {
  /** Records whose resumable stages all finished; their records are removed. */
  finished: number
  /** Records left for a later launch: another meetings folder, or a stage that failed. */
  kept: number
  /** Records whose saved file is gone (deleted or discarded); removed without running anything. */
  dropped: number
  /** Session-only stages that never completed before the kill, summed over finished records. */
  abandoned: number
  error?: 'corrupt' | 'unreadable'
}

function withStage(rec: SaveReceiptRecord, stage: SaveReceiptStage, now: number): SaveReceiptRecord {
  const completed = rec.completed.includes(stage) ? rec.completed : [...rec.completed, stage]
  const has = (s: SaveReceiptStage): boolean => completed.includes(s)
  return {
    ...rec,
    completed,
    stages: {
      ...rec.stages,
      draftSealed: has('draft-cleanup'),
      draftsUnlinked: has('draft-cleanup'),
      brainIngestQueued: has('ingest')
    },
    updatedAt: Math.max(rec.updatedAt, Math.trunc(now))
  }
}

/**
 * Launch resumption of durable save receipts (WP03-S09/S11). Each incomplete stage is attempted at least once, after
 * the current saved document is checked against its receipt. A durably recorded stage is skipped after restart, but
 * a process can die after an external effect and before its completion marker, so that effect may be repeated. A
 * corrupt or unreadable journal fails closed: nothing runs and nothing is rewritten.
 */
export async function resumeJournaledSaves(deps: ResumeDeps): Promise<ResumeOutcome> {
  const outcome: ResumeOutcome = { finished: 0, kept: 0, dropped: 0, abandoned: 0 }
  await erasureFenceReady()
  const loaded = await deps.journal.load()
  if (!loaded.ok) return { ...outcome, error: loaded.error }
  if (loaded.records.length === 0) return outcome
  for (const original of loaded.records) {
    let rec = original
    try {
      // G82: a receipt for a meeting the owner erased replays nothing (no draft cleanup, rebuild or ingest).
      if (isErasureFenced(rec.meetingStartedAt)) {
        await deps.journal.remove(rec.receiptId).catch(() => undefined)
        outcome.dropped++
        continue
      }
      if (!rec.stages.savedWritten || !rec.savedBasename || rec.folderIdSha256 !== deps.folder.idSha256) {
        outcome.kept++
        continue
      }
      const savedBasename = rec.savedBasename
      const path = deps.folder.join(savedBasename)
      let stopped = false
      let completedDuringResume = false
      for (const stage of RESUMABLE_STAGES) {
        if (rec.completed.includes(stage)) continue
        let identity: SavedReceiptIdentityCheck
        try {
          identity = await deps.folder.verifySavedIdentity(savedBasename, rec.meetingStartedAt, rec.revision)
        } catch {
          identity = 'unavailable'
        }
        if (identity === 'missing') {
          if (completedDuringResume) outcome.kept++
          else {
            await deps.journal.remove(rec.receiptId)
            outcome.dropped++
          }
          stopped = true
          break
        }
        if (identity !== 'match') {
          outcome.kept++
          stopped = true
          break
        }
        if (stage === 'draft-cleanup') await deps.stages['draft-cleanup'](path, rec.meetingStartedAt)
        else if (stage === 'rebuild') await deps.stages.rebuild()
        else await deps.stages.ingest(path, { deferred: rec.deferredIngest ?? deps.deferredDefault })
        rec = withStage(rec, stage, deps.now())
        await deps.journal.put(rec)
        completedDuringResume = true
      }
      if (stopped) continue
      outcome.abandoned += SESSION_STAGES.filter((stage) => !rec.completed.includes(stage)).length
      await deps.journal.remove(rec.receiptId)
      outcome.finished++
    } catch {
      // the record stays with every stage that did finish; the next launch resumes the rest
      outcome.kept++
    }
  }
  return outcome
}
