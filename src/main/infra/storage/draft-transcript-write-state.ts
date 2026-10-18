import { resolve } from 'node:path'

// Keyed by the meeting's OWN startedAt (like saveMeeting's real filename), not a single fixed name.
// A fixed name would let the NEXT meeting's very first autosave tick silently overwrite a PREVIOUS
// meeting's crash-recovery copy before anyone had a chance to notice it — defeating the whole point.
// stamp() alone only has 1-second (HHMMSS) resolution, so two meetings starting in the same wall-clock
// second would still collide on it — the millisecond suffix (kept behind its own "-", so it still reads
// as "<HHMMSS>-<ms>" for recall.ts's FILENAME_TIMESTAMP retention regex, which only requires a literal
// "-" right after the 6-digit time) closes that gap down to true per-meeting uniqueness.
export const draftFilename = (started: number, timestamp: string): string =>
  `.autosave-draft-${timestamp}-${String(started % 1000).padStart(3, '0')}.md`

// Cleanup must join autosaves already rendering/encrypting/replacing this exact draft. Otherwise a
// normal final save can remove the old draft before a pending autosave publishes a new orphan copy.
// Entries exist only while writes are in flight; later writes remain permitted after cleanup.
const draftWritesInFlight = new Map<string, Set<Promise<void>>>()

export function trackDraftWrite(file: string): () => void {
  const key = resolve(file)
  let settle!: () => void
  const pending = new Promise<void>((done) => {
    settle = done
  })
  const writes = draftWritesInFlight.get(key) ?? new Set<Promise<void>>()
  writes.add(pending)
  draftWritesInFlight.set(key, writes)
  return () => {
    writes.delete(pending)
    if (!writes.size) draftWritesInFlight.delete(key)
    settle()
  }
}

// Join only writes accepted before this cleanup. This is not a terminal owner/quit acknowledgement
// and deliberately does not suppress another draft operation admitted after this snapshot.
export function snapshotDraftWrites(file: string): readonly Promise<void>[] | undefined {
  const writes = draftWritesInFlight.get(resolve(file))
  return writes ? [...writes] : undefined
}
