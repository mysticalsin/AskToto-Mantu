/**
 * History's view of explicit-open downloads (IPC.recallHydration) and each row's status chip.
 *
 * Invariants:
 *   - A row has a hydration entry only while its download runs or after it failed; 'done' removes it, and
 *     the refreshed listing then shows the real meeting instead of the 'Not downloaded' row.
 *   - A download's state wins over the row's own flags: a 'Not downloaded' row being opened reads
 *     'Downloading…', and a failed one keeps the reason until the next attempt.
 */
import type { MeetingSummary } from '@shared/ipc'
import type { RecallHydration } from '@shared/recall-hydration'

export type RowHydration = { state: 'hydrating' } | { state: 'failed'; error: string }
/** Keyed by meeting basename, the same key as the History row. */
export type Hydrations = Readonly<Record<string, RowHydration>>

export function applyHydration(current: Hydrations, event: RecallHydration): Hydrations {
  const next = { ...current }
  if (event.state === 'done') delete next[event.file]
  else next[event.file] = event.state === 'hydrating' ? { state: 'hydrating' } : { state: 'failed', error: event.error }
  return next
}

export interface RowStatus {
  label: string
  /** The pointer tooltip and the chip's accessible description. */
  title: string
  tone: 'muted' | 'accent' | 'danger'
  /** Announced to assistive tech as it changes (a download in progress or its failure). */
  live: boolean
}

export function rowStatus(meeting: Pick<MeetingSummary, 'locked' | 'notDownloaded'>, hydration: RowHydration | undefined): RowStatus | null {
  if (hydration?.state === 'hydrating') {
    return { label: 'Downloading…', title: 'Downloading this meeting from the cloud', tone: 'accent', live: true }
  }
  if (hydration?.state === 'failed') return { label: 'Download failed', title: hydration.error, tone: 'danger', live: true }
  if (meeting.notDownloaded) {
    return { label: 'Not downloaded', title: 'Stored only in the cloud. Open it to download it to this device.', tone: 'muted', live: false }
  }
  // A real encrypted meeting that couldn't be decrypted on this device: shown so it isn't silently
  // missing; opening it surfaces the existing "couldn't be decrypted" error.
  if (meeting.locked) return { label: 'Locked', title: "Encrypted, can't be opened on this device", tone: 'muted', live: false }
  return null
}
