import { isWindows } from './keys'

// Exact text of the soft "not hearing the other side" note, shared by the watchdog (sets it) and the
// first-'them'-emission handler (clears it) so loopback arriving AFTER the watchdog fired isn't left stuck.
// The macOS copy covers both causes (a quiet far side or Screen Recording off) because the watchdog arms at
// channel open and fires even when the permission is granted and nobody has spoken yet (D2-12).
export function themSilentMessage(windows: boolean): string {
  return windows
    ? 'Not hearing the other side. Check the call volume and that the meeting is playing through your default output device.'
    : "No audio from the other side yet. If they're speaking, check the call volume and that Screen Recording is on."
}
export const THEM_SILENT_MSG = themSilentMessage(isWindows)
// Silent-capture-death recovery notes. A Bluetooth headset disconnect, default-device change, or
// lid-close sleep kills a capture track with no error anywhere — the UI kept saying "Listening" while
// a whole side of the meeting was silently lost. Matched by exact string (same contract as the notes above).
export const MIC_LOST_MSG = 'Microphone input stopped (device disconnected or sleep); reconnecting automatically…'
export const THEM_LOST_MSG =
  'System-audio capture stopped (display sleep or a device change); reconnecting automatically…'
// Backpressure became user-visible truncation: transcription fell behind capture long enough that
// audio windows were discarded. Exact-string contract like the other sticky notes.
export const DROPPED_MSG = 'Transcription fell behind, so some audio was skipped. The transcript may have gaps.'
// Exact text of the "offline, waiting to reconnect" / "reconnected, restarting" notes, shared by
// armNetworkRetry (sets them) and the worker's 'ready' handler (clears them once recovery succeeds) —
// matched by exact string so other sticky notes (THEM_SILENT_MSG, the Parakeet-fallback footnote) are
// never accidentally cleared by a network recovery that has nothing to do with them.
export const OFFLINE_MSG =
  "No internet connection. The speech model is paused and will restart automatically once you're back online."
export const RECONNECTING_MSG = 'Back online. Restarting the speech model…'
// A model-load failure that looks connectivity-related (DNS/fetch/ECONNREFUSED-style messages
// transformers.js/fetch surface), so it can be distinguished from a genuine non-network load failure
// (e.g. a missing bundled file) — which should surface as-is instead of wrongly claiming "you're offline".
const NETWORK_ERR =
  /network|fetch failed|enotfound|econnrefused|getaddrinfo|offline|dns|failed to fetch|err_internet_disconnected/i

/** Exported for unit testing — the pure decision behind armNetworkRetry (see useListen below). */
export function looksLikeNetworkError(message: string, online: boolean): boolean {
  return !online || NETWORK_ERR.test(message)
}

/**
 * Exported for unit testing — which live-banner note survives a window that decoded successfully.
 * A Whisper decode failure is per-window, not per-session (the very next window normally transcribes
 * fine), yet its note used to sit in the danger banner for the rest of the meeting because nothing ever
 * retracted it. `decodeNote` is the exact text the failing window put up, so the retraction is an
 * exact-string match — the same contract as OFFLINE_MSG/THEM_SILENT_MSG above, and the reason a fuzzy
 * "clear anything engine-shaped" rule is wrong: it would erase MIC_LOST_MSG/THEM_LOST_MSG/DROPPED_MSG,
 * which describe conditions a decoded window says nothing about.
 */
export function noteAfterDecodedWindow(current: string | null, decodeNote: string | null): string | null {
  return decodeNote !== null && current === decodeNote ? null : current
}

// ---- Q03: honest capture copy (D2-2, D2-3, D2-4, D2-6, D2-7, D2-8, D2-11, D7-4, D7-13) ----
// Exact-string contract like the notes above: the live banner clears or keeps a note by comparing text.

/** Mic recovery used up its retry budget; the only way back is a device change or a restart. */
export const MIC_RECOVERY_FAILED_MSG =
  'Microphone input stopped and could not reconnect. Connect or choose a microphone, and Métis will try again.'

export type CaptureSide = 'you' | 'them'

const sideLabel = (side: CaptureSide): string => (side === 'you' ? 'your microphone' : 'the other side')

/** A cloud transcription track dropped mid-meeting; main is reconnecting it. */
export const cloudTrackReconnectingMessage = (side: CaptureSide): string =>
  `Cloud transcription for ${sideLabel(side)} dropped. Reconnecting…`
/** Main gave up reconnecting the track; the meeting keeps listening on the other side. */
export const cloudTrackLostMessage = (side: CaptureSide): string =>
  `Cloud transcription for ${sideLabel(side)} stopped. Stop and start listening to reconnect.`

/** A language change while a cloud session is live: the socket is not reopened until the next start. */
export const CLOUD_LANGUAGE_NEXT_START_MSG = 'The new speech language applies the next time you start listening.'

/** Windows queued while the speech model was still loading and the queue overflowed (not "fell behind"). */
export const LOADING_DROPPED_MSG = 'The speech model is still loading, so early audio was skipped.'

const device = (windows: boolean): string => (windows ? 'PC' : 'Mac')

/** User copy for a main-initiated forced end of the meeting capture. */
export function revokedCaptureMessage(reason: string | null | undefined, windows: boolean): string {
  switch (reason) {
    case 'screen-locked':
      return `Listening stopped when your ${device(windows)} locked.`
    case 'system-suspend':
      return `Listening stopped when your ${device(windows)} went to sleep.`
    case 'sign-out':
    case 'auth-revoked':
      return 'Listening stopped because your sign-in ended.'
    default:
      return 'Listening stopped.'
  }
}

/** True when a forced end leaves a transcript worth saving (a save needs a signed-in session). */
export function revokeReasonAllowsSave(reason: string | null | undefined): boolean {
  return reason !== 'sign-out' && reason !== 'auth-revoked'
}

/** Appended to the banner only after the revoke-time save has actually resolved. */
export const TRANSCRIPT_SAVED_SUFFIX = ' Your transcript is saved.'

/** Main denied the start-time admission (activation missing or expired). */
export const ADMISSION_DENIED_MSG = "Métis couldn't start listening. Try again."

export type CaptureStartFailureInput = {
  source: 'mic' | 'system' | 'both'
  /** `DOMException.name` from the failed microphone acquisition, when there was one. */
  micErrorName?: string | null
  sysPermDenied: boolean
  windows: boolean
}

function micFailureDetail(name: string | null | undefined, windows: boolean): string {
  if (name === 'NotReadableError' || name === 'AbortError')
    return "Couldn't start the microphone because another app is using it. Close that app or choose another microphone in Settings → Audio, then try again."
  if (name === 'NotFoundError' || name === 'OverconstrainedError')
    return 'No microphone was found. Connect one or choose another in Settings → Audio, then try again.'
  return windows
    ? 'Could not start the microphone. Check that Windows microphone access is allowed for Métis and that a mic is connected.'
    : "Couldn't start the microphone. Check Microphone access in System Settings → Privacy & Security → Microphone."
}

function systemFailureMessage(sysPermDenied: boolean, windows: boolean): string {
  if (windows)
    return 'Could not capture system audio. Make sure the meeting plays through your default output device and no other app has it exclusively, or switch Listen to your microphone in Settings, Audio tab.'
  return sysPermDenied
    ? 'System audio needs Screen Recording permission. Grant it in System Settings → Privacy & Security → Screen Recording, then restart Listen.'
    : "Couldn't capture system audio. Grant Screen Recording in System Settings, or switch Listen to your microphone in Settings → Audio."
}

/** Banner for a start where nothing came up, classified by cause instead of always blaming permissions. */
export function captureStartFailureMessage(input: CaptureStartFailureInput): string {
  if (input.source === 'system') return systemFailureMessage(input.sysPermDenied, input.windows)
  const mic = micFailureDetail(input.micErrorName, input.windows)
  if (input.source === 'mic') return mic
  const system = input.windows ? '' : input.sysPermDenied ? ' System audio also needs Screen Recording permission.' : ''
  return `Couldn't start the microphone or system audio. ${mic}${system}`
}

/** Fixed copy for a cloud connect failure; the raw transport text stays in the log. */
export function cloudSpeechStartMessage(code: string | null | undefined): string {
  switch (code) {
    case 'CONNECT':
    case 'EGRESS':
      return "Couldn't reach the cloud speech service. Check your connection and try again, or choose on-device speech in Settings → Audio."
    case 'CREDENTIALS':
    case 'UNCONFIGURED':
      return "Cloud speech isn't set up on this device. Choose on-device speech in Settings → Audio, or ask your administrator."
    case 'CLOUD_ONLY':
      return "Your organization requires cloud speech, and it isn't available right now. Try again later."
    default:
      return "Cloud speech couldn't start. Try again, or choose on-device speech in Settings → Audio."
  }
}
