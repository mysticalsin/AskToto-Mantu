import { revisionCheckpointFields } from './transcript-checkpoint'
import type { CheckpointResult, TranscriptRevisionStore } from './transcript-revision-store'

type BoundStore = Pick<TranscriptRevisionStore, 'checkpoint' | 'snapshot'>

// The app's one transcript revision store, bound by the owner-session wiring at registerIpc. The draft IPC and
// the final-save document read it here so neither index.ts's pinned save calls nor transcripts.ts change.
let bound: BoundStore | null = null

/** Binds the store; the returned disposer unbinds it only while it is still the bound one. */
export function bindTranscriptCheckpointStore(store: BoundStore): () => void {
  bound = store
  return () => {
    if (bound === store) bound = null
  }
}

/** One best-effort checkpoint after a successful draft autosave. Null when no store is bound. Never throws. */
export async function checkpointAfterDraftSave(meetingStartedAt: number): Promise<CheckpointResult | null> {
  const store = bound
  if (!store) return null
  try {
    return await store.checkpoint(meetingStartedAt)
  } catch {
    return { ok: false, error: 'write-failed' }
  }
}

/** Frontmatter lines the final save writes for the meeting's revision; empty for a meeting with no open store
 *  entry (local speech), which readers treat as legacy revision 0, finalized. */
export function savedRevisionFrontmatter(meetingStartedAt: number, summaryOnly: boolean): string[] {
  const rev = bound?.snapshot(meetingStartedAt)
  if (!rev) return []
  return revisionCheckpointFields(rev, { languages: !summaryOnly }).map(([key, value]) => `${key}: ${value}`)
}

/** The meeting's current revision number for the durable save receipt; 0 (legacy) when no store entry is open. */
export function savedRevisionNumber(meetingStartedAt: number): number {
  return bound?.snapshot(meetingStartedAt)?.revision ?? 0
}
