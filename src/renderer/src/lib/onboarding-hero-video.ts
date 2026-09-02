/**
 * Act 1 only: lady looking at space (April 29). The only space shot.
 * Unmount after Next. Exclusive purple wash is the fallback if CloudFront fails
 * or prefers-reduced-motion is on.
 */
export const ONBOARDING_HERO_VIDEO_SRC =
  'https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260429_115139_0fc6bd3d-3631-4d26-ab9b-28293887dcc9.mp4'

/**
 * Must run inside a user click. `play()` is the first media call so the user-gesture
 * token is still live — do not seek, await, or setState first (autoplay policy).
 */
export function playOnboardingVideo(
  el: HTMLVideoElement | null | undefined,
  opts: { restart?: boolean } = {}
): void {
  if (!el) return
  const playing = el.play()
  if (opts.restart) el.currentTime = 0
  void playing.catch(() => {})
}

/**
 * Combined helper for tests / callers that still want both. Production hero starts the Aria
 * on the portal-open mount (`bed.start()`). Next unmounts the lady clip and lands on KineticGrid.
 */
export function playOnboardingMedia(
  video: HTMLVideoElement | null | undefined,
  audio: HTMLAudioElement | null | undefined,
  opts: { restart?: boolean } = {}
): void {
  const audioPlay = audio?.play()
  const videoPlay = video?.play()
  if (opts.restart) {
    if (audio) audio.currentTime = 0
    if (video) video.currentTime = 0
  }
  void audioPlay?.catch(() => {})
  void videoPlay?.catch(() => {})
}
