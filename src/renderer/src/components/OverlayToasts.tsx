import { MeetingOpenErrorToast } from './MeetingOpenErrorToast'
import { NewMeetingToast } from './NewMeetingToast'
import { OperatorGateToast } from './OperatorGateToast'
import { RecoveredDraftToast } from './RecoveredDraftToast'
import { RecordingConsentReminder } from './RecordingConsentReminder'
import { UpdateReadyToast } from './UpdateReadyToast'
import { VisibilityToast, type VisibilityToastState } from './VisibilityToast'
import type { UpdateReadyState } from '../lib/update-ready'

export interface OverlayToastsProps {
  /** The overlay is collapsed to the floating control pill. */
  minimized: boolean
  updateReady: UpdateReadyState
  onRestartForUpdate: () => void
  onDismissUpdate: () => void
  newMeetingToast: boolean
  onDismissNewMeeting: () => void
  recoveredDraftCount: number
  onOpenRecoveredHistory: () => void
  onDismissRecoveredDrafts: () => void
  visibilityToast: VisibilityToastState
  onDismissVisibility: () => void
  openMeetingError: string | null
  onDismissOpenMeetingError: () => void
  operatorGateNotice: string | null
  onDismissOperatorGate: () => void
  /** Recording chrome is showing (the consent reminder only arms while it is). */
  listening: boolean
  lastConsentReminderAt: number
  requireConsentIndicator: boolean
  /** Mirrors the consent banner's own open state; the caller keeps it for its auto-hide rules. */
  consentReminderOpen: boolean
  onConsentReminderOpenChange: (open: boolean) => void
  onAckConsentReminder: () => void
}

/** Every transient toast of the overlay, in one stable wrapper that widens the minimized pill's window. */
export function OverlayToasts(props: OverlayToastsProps): JSX.Element {
  const { updateReady } = props
  const toasts = (
    <>
      <UpdateReadyToast
        open={updateReady.open}
        version={updateReady.version}
        notes={updateReady.notes}
        percent={updateReady.percent}
        onRestart={props.onRestartForUpdate}
        onDismiss={props.onDismissUpdate}
      />
      <NewMeetingToast open={props.newMeetingToast} onDismiss={props.onDismissNewMeeting} />
      <RecoveredDraftToast
        count={props.recoveredDraftCount}
        onOpenHistory={props.onOpenRecoveredHistory}
        onDismiss={props.onDismissRecoveredDrafts}
      />
      <VisibilityToast state={props.visibilityToast} onDismiss={props.onDismissVisibility} />
      <MeetingOpenErrorToast message={props.openMeetingError} onDismiss={props.onDismissOpenMeetingError} />
      <OperatorGateToast message={props.operatorGateNotice} onDismiss={props.onDismissOperatorGate} />
      <RecordingConsentReminder
        listening={props.listening}
        lastReminderAt={props.lastConsentReminderAt}
        requireIndicator={props.requireConsentIndicator}
        onOpenChange={props.onConsentReminderOpenChange}
        onAck={props.onAckConsentReminder}
      />
    </>
  )
  // These toasts render even while minimized (the control pill is a separate, narrower window
  // width). Without this, a toast opening while minimized had to squeeze into the ~200px pill
  // width and the whole layout crushed. Widen the window to fit a toast via the same
  // data-hug-width contract the pill itself uses (useAutoResize picks the FIRST [data-hug-width]
  // match in document order, so this wrapper — rendered before the pill below — wins while a
  // toast is open, and control reverts to the pill's own report the instant the toast closes and
  // this wrapper unmounts).
  //
  // The wrapper element itself stays a single, stable <div> across both states — only its
  // data-hug-width attribute and className toggle. Switching between a bare fragment and a real
  // div here (as this used to do) changes the element type React sees in this slot, so it
  // unmounts and remounts every toast underneath the instant one flips `open`, restarting its
  // fade-in mid-animation. `contents` keeps the non-widened case layout-equivalent to the old
  // bare-fragment render.
  const widen =
    props.minimized &&
    (updateReady.open ||
      props.newMeetingToast ||
      props.recoveredDraftCount > 0 ||
      props.consentReminderOpen ||
      !!props.visibilityToast ||
      !!props.openMeetingError ||
      !!props.operatorGateNotice)
  return (
    <div
      data-hug-width={widen || undefined}
      className={widen ? 'mx-auto flex w-[500px] flex-col gap-2 px-1.5' : 'contents'}
    >
      {toasts}
    </div>
  )
}
