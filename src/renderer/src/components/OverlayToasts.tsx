import { useEffect, useRef, useState } from 'react'
import { MeetingOpenErrorToast } from './MeetingOpenErrorToast'
import { NewMeetingToast } from './NewMeetingToast'
import { OperatorGateToast } from './OperatorGateToast'
import { RecoveredDraftToast } from './RecoveredDraftToast'
import { RecordingConsentReminder } from './RecordingConsentReminder'
import { ShortcutFailureToast, useShortcutFailureToast } from './ShortcutFailureToast'
import { UpdateReadyToast } from './UpdateReadyToast'
import { SuggestionCarousel } from '../features/suggestions/SuggestionCarousel'
import { VisibilityToast, type VisibilityToastState } from './VisibilityToast'
import type { UpdateReadyState } from '../lib/update-ready'
import type { QuietDeferredBatch, QuietPolicy } from '@shared/quiet-mode-settings'

/** Contract-tested inventory of the overlay toasts that can arrive without a current owner request. */
export const QUIET_TOAST_COMPONENTS = [
  'SuggestionCarousel',
  'UpdateReadyToast',
  'RecoveredDraftToast',
  'ShortcutFailureToast'
] as const
export const DIRECT_TOAST_COMPONENTS = [
  'NewMeetingToast',
  'VisibilityToast',
  'MeetingOpenErrorToast',
  'OperatorGateToast',
  'RecordingConsentReminder'
] as const

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
  /** The shortcut-conflict toast's action: opens Settings on the tab that lists the keyboard shortcuts. */
  onOpenShortcuts: () => void
}

/** Every transient toast of the overlay, in one stable wrapper that widens the minimized pill's window. */
export function OverlayToasts(props: OverlayToastsProps): JSX.Element {
  const { updateReady } = props
  const shortcutToast = useShortcutFailureToast()
  const [quietPolicy, setQuietPolicy] = useState<QuietPolicy | null>(null)
  const [deferredBatch, setDeferredBatch] = useState<QuietDeferredBatch | null>(null)
  const offeredWhileQuiet = useRef(false)
  useEffect(() => {
    let live = true
    const refresh = (): void => {
      void window.toto
        .getQuietPolicy()
        .then((policy) => live && setQuietPolicy(policy))
        .catch(() => {})
    }
    refresh()
    const timer = setInterval(refresh, 1000)
    const offSettings = window.toto.onSettingsChanged(refresh)
    const offReleased = window.toto.onQuietOutputReleased((batch) => {
      if (
        live &&
        batch.channels.includes('toast') &&
        !batch.channels.some((channel) => channel === 'proactiveSuggestion' || channel === 'autoAnswerCard')
      )
        setDeferredBatch(batch)
    })
    return () => {
      live = false
      clearInterval(timer)
      offSettings()
      offReleased()
    }
  }, [])
  const hasUnsolicited = updateReady.open || props.recoveredDraftCount > 0 || !!shortcutToast.message
  const quiet = !quietPolicy || quietPolicy.toast !== 'allow'
  useEffect(() => {
    if (!hasUnsolicited) offeredWhileQuiet.current = false
    else if (quiet && !offeredWhileQuiet.current) {
      offeredWhileQuiet.current = true
      void window.toto.quietOutputOffer('toast').catch(() => {})
    }
  }, [hasUnsolicited, quiet])
  const nextQuietToast = !quiet
    ? updateReady.open
      ? 'update'
      : props.recoveredDraftCount > 0
        ? 'recovered'
        : shortcutToast.message
          ? 'shortcut'
          : null
    : null
  useEffect(() => {
    if (deferredBatch && hasUnsolicited) setDeferredBatch(null)
  }, [deferredBatch, hasUnsolicited])
  const toasts = (
    <>
      <SuggestionCarousel mode="overlay" quietPolicy={quietPolicy} suspended={props.minimized} />
      <UpdateReadyToast
        open={nextQuietToast === 'update'}
        version={updateReady.version}
        notes={updateReady.notes}
        percent={updateReady.percent}
        onRestart={props.onRestartForUpdate}
        onDismiss={props.onDismissUpdate}
      />
      <NewMeetingToast open={props.newMeetingToast} onDismiss={props.onDismissNewMeeting} />
      <RecoveredDraftToast
        count={nextQuietToast === 'recovered' ? props.recoveredDraftCount : 0}
        onOpenHistory={props.onOpenRecoveredHistory}
        onDismiss={props.onDismissRecoveredDrafts}
      />
      <VisibilityToast state={props.visibilityToast} onDismiss={props.onDismissVisibility} />
      <MeetingOpenErrorToast message={props.openMeetingError} onDismiss={props.onDismissOpenMeetingError} />
      <OperatorGateToast message={props.operatorGateNotice} onDismiss={props.onDismissOperatorGate} />
      <ShortcutFailureToast
        message={nextQuietToast === 'shortcut' ? shortcutToast.message : null}
        onOpenShortcuts={props.onOpenShortcuts}
        onDismiss={shortcutToast.dismiss}
      />
      <RecordingConsentReminder
        listening={props.listening}
        lastReminderAt={props.lastConsentReminderAt}
        requireIndicator={props.requireConsentIndicator}
        onOpenChange={props.onConsentReminderOpenChange}
        onAck={props.onAckConsentReminder}
      />
      {deferredBatch && !quiet && !hasUnsolicited && (
        <div role="status" aria-live="polite" className="fade-up glass-strong rounded-[14px] px-3.5 py-2.5">
          Métis held background updates while quiet. They are ready now.
          <button
            type="button"
            onClick={() => setDeferredBatch(null)}
            className="ml-3 text-[color:var(--color-accent-2)]"
          >
            Dismiss
          </button>
        </div>
      )}
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
    (!!nextQuietToast ||
      !!deferredBatch ||
      props.newMeetingToast ||
      props.recoveredDraftCount > 0 ||
      props.consentReminderOpen ||
      !!props.visibilityToast ||
      !!props.openMeetingError ||
      !!props.operatorGateNotice ||
      !!shortcutToast.message)
  return (
    <div
      data-hug-width={widen || undefined}
      className={widen ? 'mx-auto flex w-[500px] flex-col gap-2 px-1.5' : 'contents'}
    >
      {toasts}
    </div>
  )
}
