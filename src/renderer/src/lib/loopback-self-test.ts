import { acquireLoopback } from './listen'

/**
 * M2-0429: onboarding's real meeting-audio check. Arms the loopback, acquires it exactly the way Listen does,
 * and passes only when a live system-audio track came back. Unlike a Listen session nothing consumes the
 * stream, so every track is stopped and the arm released on every path: nothing keeps capturing afterwards.
 */
export async function runLoopbackSelfTest(): Promise<boolean> {
  let sys: MediaStream | null = null
  try {
    await window.toto.armAudio(true)
    sys = await acquireLoopback()
    return sys.getAudioTracks().some((t) => t.readyState === 'live')
  } catch {
    return false
  } finally {
    sys?.getTracks().forEach((t) => t.stop())
    await window.toto.armAudio(false).catch(() => {})
  }
}
