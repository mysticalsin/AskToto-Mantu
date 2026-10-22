import type { TranscriptLine } from '@shared/transcript-line'

/**
 * The seam between the transcript draft lifecycle (transcripts.ts, launch recovery) and the live meeting journal.
 * Nothing here knows how the journal is stored: the lifecycle wiring binds one implementation, and every function
 * is a no-op until it does, so a build or a test with no journal behaves exactly as it did before the journal
 * existed. No function throws and none returns content: a journal problem never fails a save, a Disregard or a launch.
 */

export type LiveJournalEndState = 'finalized' | 'discarded'

export interface DraftJournalHooks {
  /**
   * The draft text with any journal records the draft is missing merged in (draft authoritative), or the same text
   * when there is nothing to add or the journal cannot be trusted. Never throws.
   */
  merge(draftText: string): Promise<string>
  /** Called after the draft was promoted to a recovered meeting: the journal's records now live in that file. */
  promoted(draftText: string): Promise<void>
  /**
   * True when the draft's journal is sealed 'discarded': the user disregarded this meeting but the draft could not be
   * removed at the time. Such a draft must be deleted, never promoted. False when unknown or the journal cannot be read.
   */
  isDiscarded(draftText: string): Promise<boolean>
  /** Called once a discarded draft is really gone: the sealed journal, its last tombstone, can now be removed. */
  discardSettled(draftText: string): Promise<void>
}

export interface LiveJournalLifecycle {
  /** Seals the meeting's journal(s) as finalized or discarded, so a crash before the purge never resurrects them. */
  end(startedAt: number, state: LiveJournalEndState): Promise<void>
  /** Removes the meeting's journal directory (records and wrapped key). */
  purge(startedAt: number): Promise<void>
  /** Hooks for promoting an orphaned draft; null while the journal is off. */
  draftHooks(): DraftJournalHooks | null
  /**
   * Launch work that follows draft promotion: promotes journals that have no draft (crash before the first autosave),
   * then runs the retention sweep. Returns how many meetings were promoted.
   */
  recoverRemaining(context: JournalRecoveryContext): Promise<{ promoted: number }>
}

/** What launch recovery tells the journal about the meetings folder; the journal never resolves it itself. */
export interface JournalRecoveryContext {
  /** Names of the `.autosave-draft-*.md` files still on disk after promotion (their journals are protected). */
  draftNames: readonly string[]
  /** True when a saved or recovered meeting (not a draft) already carries this canonical start instant. */
  meetingExists(startedAt: number): Promise<boolean>
  /** Writes a recovered meeting for a journal that has no draft; returns whether it was durably written. */
  promote(startedAt: number, lines: readonly TranscriptLine[]): Promise<boolean>
}

let bound: LiveJournalLifecycle | null = null

/** Binds the journal implementation; the disposer unbinds only its own. */
export function bindLiveJournalLifecycle(lifecycle: LiveJournalLifecycle): () => void {
  bound = lifecycle
  return () => {
    if (bound === lifecycle) bound = null
  }
}

export function currentLiveJournalLifecycle(): LiveJournalLifecycle | null {
  return bound
}

export async function endLiveMeetingJournal(startedAt: number, state: LiveJournalEndState): Promise<void> {
  try {
    await bound?.end(startedAt, state)
  } catch {
    /* best effort: a journal that cannot be sealed is removed by the retention sweep */
  }
}

export async function purgeLiveMeetingJournal(startedAt: number): Promise<void> {
  try {
    await bound?.purge(startedAt)
  } catch {
    /* best effort: a purge failure never fails a save or a Disregard */
  }
}
