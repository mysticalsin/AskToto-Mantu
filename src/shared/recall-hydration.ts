/**
 * IPC.recallHydration (main → renderer): an explicit History open downloading one cloud-only meeting.
 *
 * Invariants:
 *   - A download that starts ('hydrating') ends in exactly one 'done' or 'failed'; an open that needs no
 *     download sends nothing.
 *   - At most one download runs at a time, so at most one row is 'hydrating'.
 *   - `file` is the meeting's basename, the same key as its History row.
 */
export type RecallHydration =
  | { file: string; state: 'hydrating' }
  | { file: string; state: 'done' }
  | { file: string; state: 'failed'; error: string }
