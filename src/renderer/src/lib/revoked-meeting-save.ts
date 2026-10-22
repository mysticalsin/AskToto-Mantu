import { useEffect, useRef, useState } from 'react'
import { TRANSCRIPT_SAVED_SUFFIX, revokeReasonAllowsSave } from './listen-notes'

type Ref<T> = { current: T }

/** The one meeting ownership the App holds, read at call time so a stale effect can never save a successor. */
export type RevokedSaveOwnership = {
  meetingStartRef: Ref<number>
  discardedMeetingRef: Ref<string | null>
  discardPendingOwnerRef: Ref<string | null>
  claimedSavesRef: Ref<Set<string>>
  savedRef: Ref<string>
}

export type RevokedMeetingEnd = { reason: string; startedAt: number }

/**
 * Save the transcript of a meeting that main force-ended (lock, sleep), exactly once (D2-6).
 * Resolves to the owner id only after `persist` settled AND the transcript is durably claimed or saved, so
 * the banner never says "saved" ahead of the save. A sign-in that ended cannot save (it would throw
 * 'Not signed in.'), a discarded owner is never resurrected, and a successor meeting is never touched.
 */
export async function saveRevokedMeeting(input: {
  ended: RevokedMeetingEnd | null
  lineCount: number
  handled: Ref<string | null>
  ownership: RevokedSaveOwnership
  persist: () => Promise<void>
}): Promise<string | null> {
  const { ended, ownership } = input
  if (!ended || input.lineCount === 0 || !revokeReasonAllowsSave(ended.reason)) return null
  const ownerId = String(ended.startedAt)
  if (input.handled.current === ownerId || String(ownership.meetingStartRef.current) !== ownerId) return null
  if (ownership.discardedMeetingRef.current === ownerId || ownership.discardPendingOwnerRef.current === ownerId)
    return null
  input.handled.current = ownerId
  try {
    await input.persist()
  } catch {
    return null
  }
  return ownership.claimedSavesRef.current.has(ownerId) || ownership.savedRef.current === ownerId ? ownerId : null
}

/** Appends the saved note to the live banner once the revoke-time save resolved for that exact meeting. */
export function errorWithSavedNote(
  error: string | null,
  ended: RevokedMeetingEnd | null,
  savedOwner: string | null
): string | null {
  return error && ended && savedOwner === String(ended.startedAt) ? `${error}${TRANSCRIPT_SAVED_SUFFIX}` : error
}

/** Runs the revoke-time save when Listen reports a forced end; returns the banner text to display. */
export function useRevokedMeetingSave(
  listen: { endedBy: RevokedMeetingEnd | null; lines: readonly unknown[]; error: string | null },
  ownership: RevokedSaveOwnership,
  persist: () => Promise<void>
): string | null {
  const handled = useRef<string | null>(null)
  const latest = useRef({ ownership, persist })
  latest.current = { ownership, persist }
  const [savedOwner, setSavedOwner] = useState<string | null>(null)
  const { endedBy } = listen
  const lineCount = listen.lines.length
  useEffect(() => {
    void saveRevokedMeeting({
      ended: endedBy,
      lineCount,
      handled,
      ownership: latest.current.ownership,
      persist: () => latest.current.persist()
    }).then((owner) => {
      if (owner) setSavedOwner(owner)
    })
  }, [endedBy, lineCount])
  return errorWithSavedNote(listen.error, endedBy, savedOwner)
}
