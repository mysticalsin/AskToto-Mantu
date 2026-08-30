/**
 * Act 1 atmosphere only. The clip is ~43MB, so it is not bundled; the exclusive stage
 * purple wash is the fallback if CloudFront fails or prefers-reduced-motion is on.
 */
export const ONBOARDING_HERO_VIDEO_SRC =
  'https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260714_113715_c7e0daa0-8bdd-4486-a2da-040901f8f0ea.mp4'

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
 * on the portal-open mount (`bed.start()`). Next uses playOnboardingVideo (play, then seek 0).
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
