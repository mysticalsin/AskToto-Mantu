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

// Cleanup joins autosaves already rendering/encrypting/replacing a draft in any folder used by its
// meeting, then seals the startedAt identity so a late autosave cannot recreate an orphan elsewhere.
// A separate path-only seal remains available for exact-path callers.
const draftWritesInFlight = new Map<string, Set<Promise<void>>>()
const draftWriteTails = new Map<string, Promise<void>>()
const finalizedDraftPaths = new Set<string>()
const draftPathsByMeeting = new Map<number, Set<string>>()
const finalizedDraftMeetings = new Set<number>()
const draftMeetingFinalizations = new Map<number, Promise<readonly string[]>>()

/** Serialize replacement operations for one exact draft path while allowing unrelated paths to progress. */
export function serializeDraftWrite<T>(file: string, operation: () => Promise<T>): Promise<T> {
  const key = resolve(file)
  const previous = draftWriteTails.get(key) ?? Promise.resolve()
  const current = previous.then(operation, operation)
  const tail = current.then(
    () => undefined,
    () => undefined
  )
  draftWriteTails.set(key, tail)
  void tail.then(() => {
    if (draftWriteTails.get(key) === tail) draftWriteTails.delete(key)
  })
  return current
}

export function isDraftMeetingFinalized(startedAt: number): boolean {
  return finalizedDraftMeetings.has(startedAt)
}

export function trackDraftWrite(file: string, meetingStartedAt?: number): (() => void) | null {
  const key = resolve(file)
  if (finalizedDraftPaths.has(key) || (meetingStartedAt !== undefined && finalizedDraftMeetings.has(meetingStartedAt)))
    return null
  if (meetingStartedAt !== undefined) {
    const paths = draftPathsByMeeting.get(meetingStartedAt) ?? new Set<string>()
    paths.add(key)
    draftPathsByMeeting.set(meetingStartedAt, paths)
  }
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

/** Seal synchronously, then join every write that was admitted before this call. */
export async function finalizeDraftWrites(file: string): Promise<void> {
  const key = resolve(file)
  finalizedDraftPaths.add(key)
  const writes = snapshotDraftWrites(key)
  if (writes) await Promise.all(writes)
}

/**
 * Finalize one meeting identity before awaiting anything, collect every folder it has used plus supplied
 * cleanup paths, and join every write admitted before that synchronous boundary. Future production
 * admissions are rejected by meeting identity, avoiding one retained path tombstone per folder.
 */
export function finalizeDraftMeeting(startedAt: number, files: readonly string[] = []): Promise<readonly string[]> {
  const existing = draftMeetingFinalizations.get(startedAt)
  if (existing) return existing

  finalizedDraftMeetings.add(startedAt)
  const paths = new Set(draftPathsByMeeting.get(startedAt) ?? [])
  draftPathsByMeeting.delete(startedAt)
  for (const file of files) paths.add(resolve(file))

  const writes: Promise<void>[] = []
  for (const path of paths) {
    const admitted = snapshotDraftWrites(path)
    if (admitted) writes.push(...admitted)
  }
  const finalization = Promise.all(writes).then(() => [...paths])
  draftMeetingFinalizations.set(startedAt, finalization)
  void finalization.then(() => {
    if (draftMeetingFinalizations.get(startedAt) === finalization) draftMeetingFinalizations.delete(startedAt)
  })
  return finalization
}

/** Snapshot every tracked folder before a caller seals the meeting and drops this metadata. */
export function knownDraftPathsForMeeting(startedAt: number): readonly string[] {
  return [...(draftPathsByMeeting.get(startedAt) ?? [])]
}

// Snapshot writes accepted before finalization. finalizeDraftWrites seals first, so this set is stable
// against later admissions while cleanup waits.
export function snapshotDraftWrites(file: string): readonly Promise<void>[] | undefined {
  const writes = draftWritesInFlight.get(resolve(file))
  return writes ? [...writes] : undefined
}
