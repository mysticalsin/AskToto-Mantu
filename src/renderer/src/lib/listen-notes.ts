import { isWindows } from './keys'

// Exact text of the soft "not hearing the other side" note, shared by the watchdog (sets it) and the
// first-'them'-emission handler (clears it) so loopback arriving AFTER the watchdog fired isn't left stuck.
export const THEM_SILENT_MSG = isWindows
  ? 'Not hearing the other side. Check the call volume and that the meeting is playing through your default output device.'
  : 'Not hearing the other side. Check the call volume and that Screen Recording is granted.'
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
