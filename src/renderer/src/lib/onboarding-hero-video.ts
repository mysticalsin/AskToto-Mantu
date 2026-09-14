/**
 * Act 1 only: lady looking at space (April 29). The only space shot.
 * Local bundle is the production bed so exclusive onboarding never depends on CloudFront
 * at first paint. Remote URL kept as a documented mirror / future refresh source.
 * Exclusive hero hold (`#05010A`) is last-resort only — poster + local mp4 must show first.
 */
import localHeroUrl from '../assets/onboarding-hero-lady-planet.mp4'
import localPosterUrl from '../assets/onboarding-hero-poster.jpg'

/** Documented CloudFront mirror of the same April 29 clip (not the runtime default). */
export const ONBOARDING_HERO_VIDEO_REMOTE_SRC =
  'https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260429_115139_0fc6bd3d-3631-4d26-ab9b-28293887dcc9.mp4'

/** Runtime Act 1 bed — packaged local asset (lady + planet). */
export const ONBOARDING_HERO_VIDEO_SRC = localHeroUrl

/** Still frame behind / instead of the video so the lady is visible before decode. */
export const ONBOARDING_HERO_POSTER_SRC = localPosterUrl

/**
 * Act-1-mount preload only. Do NOT call from App boot — that contended with WebGL
 * starfield and made exclusive first paint laggy. OnboardingHeroVideo owns the call.
 */
export function preloadOnboardingHeroVideo(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector('link[data-onboarding-hero-preload]')) return
  const link = document.createElement('link')
  link.rel = 'preload'
  link.as = 'video'
  link.href = ONBOARDING_HERO_VIDEO_SRC
  link.setAttribute('data-onboarding-hero-preload', '1')
  document.head.appendChild(link)
}

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
