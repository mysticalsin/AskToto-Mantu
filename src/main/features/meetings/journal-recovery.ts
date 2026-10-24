import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import type { TranscriptLine } from '@shared/transcript-line'
import { purgeMeetingJournalDirectory, resolveMeetingJournalRoot } from '../../infra/storage/meeting-journal-purge'
import { draftFilename } from '../../infra/storage/draft-transcript-write-state'
import { isErasureFenced } from '../../memory-partition/erasure-fence'
import { stamp } from './transcript-document-format'
import {
  listJournalIds,
  openJournal,
  ownerCandidates,
  readJournalForMeeting,
  readJournalState,
  readVerifiedJournalStart,
  readJournal,
  type JournalIgnoreReason,
  type JournalReaderDeps,
  type JournalState
} from './journal-reader'
import { mergeJournalIntoDraft } from './journal-merge'
import { liveMeetingJournalId } from './live-meeting-journal'
import { readMeetingFields } from './meeting-document'
import type {
  DraftJournalHooks,
  JournalRecoveryContext,
  LiveJournalEndState,
  LiveJournalLifecycle
} from './live-journal-lifecycle'

/**
 * Launch recovery, purge and retention of the live meeting journal (WP03 / C09b T6 + T7). Everything is metadata-only
 * in the audit trail (outcome enums and counts, never a line, a key or a path) and nothing here ever throws.
 */

export type JournalRecoveryAuditRecord =
  | { outcome: 'merged'; added: number }
  | { outcome: 'promoted'; records: number }
  | { outcome: 'ignored'; reason: JournalIgnoreReason | 'not-active' | 'unmergeable' }
  | { outcome: 'purged'; removedFiles: number }
  | { outcome: 'swept'; removed: number; kept: number }

export interface JournalRecoveryDeps extends JournalReaderDeps {
  /** The signed-in owner's key, or null while signed out or before the owner key salt has loaded. */
  currentOwnerKey(): string | null
  /** Ends a live session (its in-flight append settles and its key buffer is zeroed) before its files are touched. */
  closeSession(startedAt: number): Promise<void>
  /** Journal ids opened by this process for the meeting, any owner. */
  journalIdsFor(startedAt: number): string[]
  /** Journal ids of live sessions: never swept. */
  liveJournalIds(): string[]
  audit(record: JournalRecoveryAuditRecord): void
  now?(): number
}

/** Owner-approved retention (2026-10-21): 14 days, 10 journals, oldest first. */
export const LIVE_MEETING_JOURNAL_RETENTION = Object.freeze({ maxAgeMs: 14 * 24 * 60 * 60 * 1000, maxJournals: 10 })

/** `date:` of a draft, as the canonical start instant. */
function startedAtOfDraft(text: string): number | null {
  const fields = readMeetingFields(text)
  if (fields.type !== 'meeting-transcript-draft' || !fields.date) return null
  const startedAt = Date.parse(fields.date)
  return Number.isSafeInteger(startedAt) ? startedAt : null
}

export function createJournalRecovery(deps: JournalRecoveryDeps): LiveJournalLifecycle {
  const now = deps.now ?? Date.now
  const audit = (record: JournalRecoveryAuditRecord): void => {
    try {
      deps.audit(record)
    } catch {
      /* auditing never changes an outcome */
    }
  }
  const owners = (): Array<string | null> => {
    try {
      return ownerCandidates(deps.currentOwnerKey())
    } catch {
      return [null]
    }
  }
  const idsFor = (startedAt: number): string[] => [
    ...new Set([...deps.journalIdsFor(startedAt), ...owners().map((owner) => liveMeetingJournalId(startedAt, owner))])
  ]
  /** Per launch: drafts whose journal was fully accounted for (merged, nothing to add, absent), safe to purge. */
  const covered = new Set<number>()

  async function end(startedAt: number, state: LiveJournalEndState): Promise<void> {
    await deps.closeSession(startedAt)
    // Marking is a manifest read and rewrite: it follows the kill switch. The purge that follows does not.
    if (!deps.readsAllowed()) return
    for (const id of idsFor(startedAt)) {
      const opened = await openJournal(deps, id)
      if (opened.status !== 'open') continue
      try {
        await opened.storage.transitionState(state, () => true)
      } finally {
        opened.storage.dispose()
      }
    }
  }

  async function purgeById(id: string): Promise<boolean> {
    const result = await purgeMeetingJournalDirectory(deps.userDataPath(), id)
    if (result.status === 'purged') audit({ outcome: 'purged', removedFiles: result.removedFiles })
    return result.status === 'purged'
  }

  async function purge(startedAt: number): Promise<void> {
    await deps.closeSession(startedAt)
    for (const id of idsFor(startedAt)) await purgeById(id)
  }

  const draftHooks = (): DraftJournalHooks | null => {
    if (!deps.readsAllowed()) return null
    return {
      async merge(draftText) {
        try {
          const startedAt = startedAtOfDraft(draftText)
          if (startedAt === null) return draftText
          await deps.closeSession(startedAt)
          const read = await readJournalForMeeting(deps, startedAt, owners())
          if (read.status === 'absent') {
            covered.add(startedAt)
            return draftText
          }
          if (read.status === 'ignored') {
            audit({ outcome: 'ignored', reason: read.reason })
            return draftText // draft path unchanged; the journal stays for the retention window
          }
          if (read.state !== 'active') {
            // Finalized or discarded: the meeting was already saved or disregarded, nothing to add.
            covered.add(startedAt)
            audit({ outcome: 'ignored', reason: 'not-active' })
            return draftText
          }
          const merged = await mergeJournalIntoDraft(draftText, startedAt, read.records)
          if (merged.status === 'merged') {
            covered.add(startedAt)
            audit({ outcome: 'merged', added: merged.added })
            return merged.text
          }
          if (merged.status === 'nothing-to-add') {
            covered.add(startedAt)
            return draftText
          }
          audit({ outcome: 'ignored', reason: 'unmergeable' })
          return draftText
        } catch {
          return draftText
        }
      },
      async promoted(draftText) {
        const startedAt = startedAtOfDraft(draftText)
        // Only a journal that was fully merged (or had nothing to add) is deleted; an unreadable one is left alone.
        if (startedAt === null || !covered.delete(startedAt)) return
        await end(startedAt, 'finalized')
        await purge(startedAt)
      },
      async isDiscarded(draftText) {
        try {
          const startedAt = startedAtOfDraft(draftText)
          if (startedAt === null) return false
          const read = await readJournalForMeeting(deps, startedAt, owners())
          return read.status === 'ok' && read.state === 'discarded'
        } catch {
          return false
        }
      },
      async discardSettled(draftText) {
        try {
          const startedAt = startedAtOfDraft(draftText)
          if (startedAt !== null) await purge(startedAt)
        } catch {
          /* the retention sweep removes a sealed journal whose draft is gone */
        }
      }
    }
  }

  /** Newest modification of the journal directory or its records directory (an append rewrites the manifest there). */
  async function modifiedAt(root: string, id: string): Promise<number> {
    let newest = 0
    for (const path of [join(root, id), join(root, id, 'records')]) {
      try {
        newest = Math.max(newest, (await lstat(path)).mtimeMs)
      } catch {
        /* a missing records directory just does not contribute */
      }
    }
    return newest
  }

  async function promoteJournalOnly(context: JournalRecoveryContext): Promise<number> {
    if (!deps.readsAllowed()) return 0
    const ids = await listJournalIds(deps.userDataPath())
    if (ids === 'unsafe') return 0
    const live = new Set(deps.liveJournalIds())
    let promoted = 0
    for (const id of ids) {
      try {
        if (live.has(id)) continue
        const start = await readVerifiedJournalStart(deps.userDataPath(), id, owners())
        if (!start) continue // no verified start: another owner's journal, or one written without it
        const { startedAt } = start
        // G82: a journal that outlived an erasure is never promoted back into a meeting.
        if (isErasureFenced(startedAt)) continue
        // A draft still on disk owns this meeting (merged or deliberately preserved by the draft path).
        if (context.draftNames.includes(draftFilename(startedAt, stamp(startedAt)))) continue
        // A saved or recovered meeting with this start already exists: promoting would duplicate it.
        if (await context.meetingExists(startedAt)) continue
        const read = await readJournal(deps, id)
        if (read.status === 'ignored') {
          audit({ outcome: 'ignored', reason: read.reason })
          continue
        }
        if (read.status !== 'ok' || read.state !== 'active' || read.records.length === 0) continue
        const lines: TranscriptLine[] = [...read.records].sort((a, b) => a.revision - b.revision).map((r) => r.line)
        if (!(await context.promote(startedAt, lines))) continue
        promoted++
        audit({ outcome: 'promoted', records: lines.length })
        await end(startedAt, 'finalized')
        await purgeById(id)
      } catch {
        /* one bad journal never blocks the others */
      }
    }
    return promoted
  }

  /**
   * Retention: a journal is removed when its meeting is sealed (finalized or discarded), older than 14 days, or beyond
   * the newest 10. A journal that is live, or whose meeting still has a draft on disk, is never removed, and the count
   * rule never removes an active journal whose meeting was not saved or recovered (only the age rule does).
   */
  async function sweep(context: JournalRecoveryContext): Promise<void> {
    const userData = deps.userDataPath()
    const ids = await listJournalIds(userData)
    if (ids === 'unsafe' || ids.length === 0) return
    const root = await resolveMeetingJournalRoot(userData)
    if (root === 'absent' || root === 'unsafe') return
    const live = new Set(deps.liveJournalIds())
    const entries = await Promise.all(ids.map(async (id) => ({ id, modified: await modifiedAt(root, id) })))
    entries.sort((a, b) => b.modified - a.modified)
    let removed = 0
    let kept = 0
    for (const [index, entry] of entries.entries()) {
      try {
        if (live.has(entry.id)) {
          kept++
          continue
        }
        const start = await readVerifiedJournalStart(userData, entry.id, owners())
        const hasDraft = !!start && context.draftNames.includes(draftFilename(start.startedAt, stamp(start.startedAt)))
        const tooOld = now() - entry.modified > LIVE_MEETING_JOURNAL_RETENTION.maxAgeMs
        // A journal with no verified start cannot be matched to a draft: it is kept for the count rule, not the age rule.
        let overCount = index >= LIVE_MEETING_JOURNAL_RETENTION.maxJournals && !!start
        let sealedState: JournalState | null = null
        if (!hasDraft && deps.readsAllowed()) {
          try {
            const state = await readJournalState(deps, entry.id)
            if (state.status === 'ok') sealedState = state.state
          } catch {
            /* an unreadable state never blocks the age rule */
          }
        }
        // The count rule never removes the only copy of speech nobody has saved: a verified active journal whose
        // meeting does not exist yet (promotion failed or is pending) waits for the age rule.
        if (overCount && sealedState === 'active' && !(await context.meetingExists(start!.startedAt))) overCount = false
        let remove = !hasDraft && (tooOld || overCount)
        if (!remove && !hasDraft) remove = sealedState !== null && sealedState !== 'active'
        if (remove && (await purgeById(entry.id))) removed++
        else kept++
      } catch {
        kept++
      }
    }
    if (removed > 0) audit({ outcome: 'swept', removed, kept })
  }

  return {
    end,
    purge,
    draftHooks,
    async recoverRemaining(context) {
      let promoted = 0
      try {
        promoted = await promoteJournalOnly(context)
      } catch {
        /* recovery never blocks launch */
      }
      try {
        await sweep(context)
      } catch {
        /* the sweep is retried on the next launch */
      }
      return { promoted }
    }
  }
}
