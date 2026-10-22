import type { RecallReadResult, TranscriptLine } from '@shared/ipc'
import type { RecapStatus } from '@shared/recap-status'
import type { RendererView } from '@shared/renderer-view'
import type { LatestRequestGate } from './latest-request'

/** The saved-meeting snapshot App holds while Review shows a past meeting (read once from recall:read). */
export type PastMeeting = {
  file: string
  title: string
  date: string
  recap: string
  recapStatus?: RecapStatus
  lines: TranscriptLine[]
  startedAt: number
  durationMs?: number
  confidential: boolean
  recovered?: boolean
  /** MQA-092 — the meeting's saved `crm_pushed` fingerprint, so Review knows a recap that already
   *  reached the CRM in an earlier session and does not re-arm the push. */
  crmPushedKey?: string
  /** Q07 — the saved `clickup_pushed` fingerprint and `next_steps_pushed` list (no duplicate tasks after a
   *  relaunch), and the `recap_edited` flag (Regenerate asks before replacing hand-edited notes). */
  clickupPushedKey?: string
  nextStepsPushedKeys?: string[]
  recapEdited?: boolean
}

type PastMeetingMarkers = Pick<PastMeeting, 'crmPushedKey' | 'clickupPushedKey' | 'nextStepsPushedKeys' | 'recapEdited'>

/** The durable markers a meeting read carries, in the shape the snapshot stores. */
export function pastMeetingMarkers(r: RecallReadResult): PastMeetingMarkers {
  return {
    crmPushedKey: r.crmPushedKey,
    clickupPushedKey: r.clickupPushedKey,
    nextStepsPushedKeys: r.nextStepsPushedKeys,
    recapEdited: r.recapEdited === true
  }
}

/** The marker props Review takes, from the open snapshot (a live meeting has none). */
export function reviewMarkerProps(pm: PastMeeting | null): PastMeetingMarkers {
  return pm
    ? pastMeetingMarkers({ ok: true, ...pm })
    : { crmPushedKey: undefined, clickupPushedKey: undefined, nextStepsPushedKeys: undefined, recapEdited: false }
}

/** The snapshot after a generation settled. Main clears `recap_edited` when a generation replaces the notes, and
 *  keeps it when a failed run wrote the edited text straight back (recall.ts, recapEditedAfterWrite). */
export function withGeneratedRecap(prev: PastMeeting, action: { text: string; recapStatus: RecapStatus }): PastMeeting {
  return {
    ...prev,
    recap: action.text,
    recapStatus: action.recapStatus,
    recapEdited: prev.recapEdited === true && action.text === prev.recap
  }
}

/** The snapshot after the person saved an edit to the notes. */
export function withEditedRecap(prev: PastMeeting, recap: string): PastMeeting {
  return { ...prev, recap, recapEdited: true }
}

/** Whether an open that has just been read should still be applied: it is the latest open, and the person is
 *  still on the view they asked from (a download that finishes after they went elsewhere must not pull them
 *  back into a meeting they no longer want). */
export function openedMeetingStillWanted(
  gate: LatestRequestGate,
  token: number,
  startView: RendererView,
  currentView: RendererView
): boolean {
  return gate.isLatest(token) && currentView === startView
}
