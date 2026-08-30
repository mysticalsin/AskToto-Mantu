/**
 * Act 1 atmosphere only. The clip is ~43MB, so it is not bundled; the exclusive stage
 * purple wash is the fallback if CloudFront fails or prefers-reduced-motion is on.
 */
export const ONBOARDING_HERO_VIDEO_SRC =
  'https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260714_113715_c7e0daa0-8bdd-4486-a2da-040901f8f0ea.mp4'

/** Must run inside a user click. Autoplay policy will not start the clip from an effect. */
export function playOnboardingVideo(
  el: HTMLVideoElement | null | undefined,
  opts: { restart?: boolean } = {}
): void {
  if (!el) return
  if (opts.restart) el.currentTime = 0
  void el.play().catch(() => {})
}
