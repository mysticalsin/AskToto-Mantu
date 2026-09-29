/**
 * Delay before the next Windows system-audio retry, given how many have already failed back-to-back.
 * Doubles from the watcher's 3 s tick and holds at a 30 s ceiling — bounded work, but NEVER terminal.
 *
 * Both halves matter. A machine where WASAPI loopback cannot start at all (VDI/RDP with no render
 * endpoint, every output disabled, an app holding the endpoint exclusively) used to pay a full
 * getDisplayMedia acquisition every 3 s for the whole meeting — and each attempt that falls through to
 * the video-bound form runs up to 3 desktopCapturer.getSources screen enumerations, which is the exact
 * screen-grabbing path the audio-only attempt exists to avoid. Giving up entirely is not the answer
 * either: the headline case in the watcher's own comment (another app holding the render endpoint) emits
 * no 'devicechange', so nothing else would ever re-arm and the meeting stays mic-only — MQA-041.
 */
export function sysRetryDelayMs(consecutiveFailures: number): number {
  return Math.min(3000 * 2 ** consecutiveFailures, 30_000)
}
