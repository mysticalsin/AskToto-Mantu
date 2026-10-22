import type { CaptureDegraded } from './listen-capture-state'
import { cloudTrackLostMessage, cloudTrackReconnectingMessage, type CaptureSide } from './listen-notes'

/** The two banner slots a cloud track state can write; everything else in Listen state is untouched. */
export type CloudTrackNoteSlots = { error: string | null; captureDegraded: CaptureDegraded | null }

const sideOf = (channel: 'you' | 'them'): CaptureSide => channel

/**
 * Project a main-side cloud track error onto the banner (D2-4). While main is still reconnecting the track
 * the note says so; once its budget is spent the note says the side is lost and a restart reconnects. The
 * degraded slot names the side so compact chrome can mark it, exactly like a lost local capture track.
 */
export function cloudTrackErrorNote(channel: 'you' | 'them', recovering: boolean): CaptureDegraded {
  const side = sideOf(channel)
  return {
    side: channel,
    note: recovering ? cloudTrackReconnectingMessage(side) : cloudTrackLostMessage(side),
    permission: false
  }
}

/** Clear only this track's own reconnecting/lost note; never erase an unrelated banner. */
export function afterCloudTrackRecovered<T extends CloudTrackNoteSlots>(slots: T, channel: 'you' | 'them'): T {
  const side = sideOf(channel)
  const ours = (note: string | null | undefined): boolean =>
    note === cloudTrackReconnectingMessage(side) || note === cloudTrackLostMessage(side)
  const degradedIsOurs = slots.captureDegraded !== null && ours(slots.captureDegraded.note)
  const errorIsOurs = ours(slots.error)
  if (!degradedIsOurs && !errorIsOurs) return slots
  return {
    ...slots,
    error: errorIsOurs ? null : slots.error,
    captureDegraded: degradedIsOurs ? null : slots.captureDegraded
  }
}

/**
 * The two renderer listeners for main's cloud track events, scoped to one capture. `isCurrent` fences a late
 * event from a retired session; `themDegraded` is Listen's independent 'them' cause slot, kept in step so a
 * mic recovery cannot erase a dropped remote track (MQA-156).
 */
export function cloudTrackListeners<T extends CloudTrackNoteSlots>(
  isCurrent: () => boolean,
  themDegraded: { current: CaptureDegraded | null },
  setState: (update: (state: T) => T) => void
): {
  onError: (message: string, info?: { channel: 'you' | 'them'; recovering: boolean }) => void
  onRecovered: (channel: 'you' | 'them') => void
} {
  return {
    onError: (message, info) => {
      if (!isCurrent()) return
      if (!info) return setState((s) => ({ ...s, error: message || s.error }))
      const note = cloudTrackErrorNote(info.channel, info.recovering)
      if (info.channel === 'them') themDegraded.current = note
      setState((s) => ({ ...s, error: note.note, captureDegraded: note }))
    },
    onRecovered: (channel) => {
      if (!isCurrent()) return
      if (channel === 'them' && themDegraded.current?.note === cloudTrackErrorNote('them', true).note)
        themDegraded.current = null
      setState((s) => afterCloudTrackRecovered(s, channel))
    }
  }
}
