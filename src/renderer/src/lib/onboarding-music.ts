/**
 * Act 1+ onboarding bed — hardware-decoded HTMLAudioElement of a real piano recording.
 * J.S. Bach, Goldberg Variations BWV 988, Aria · Kimiko Ishizaka, Open Goldberg Variations (2012).
 * Composition: public domain. Recording: CC0 1.0. See assets/music/LICENSE.OPEN-GOLDBERG.txt.
 * No Web Audio choir pad. No synthesizeOnboardingPad. Never sends, never calls IPC.
 * OS mute still applies (default destination). Reduced-motion does not mute.
 */

export const ONBOARDING_MUSIC_FILE = 'goldberg-variations-aria.ogg'
export const ONBOARDING_MUSIC_SRC = new URL(
  `../assets/music/${ONBOARDING_MUSIC_FILE}`,
  import.meta.url
).href
export const ONBOARDING_MUSIC_GAIN = 0.22
export const ONBOARDING_MUSIC_FADE_SECONDS = 2.4

/** Mute is silence. Reduced-motion is not a parameter — it must not duck or mute the piano. */
export function onboardingMusicGain(muted: boolean): number {
  return muted ? 0 : ONBOARDING_MUSIC_GAIN
}

/**
 * Cosine (smoothstep-adjacent) envelope at the loop points so the ~5:00 Aria can repeat quietly.
 * File also has baked fades; this is the live volume dip if duration is known.
 */
export function onboardingMusicLoopEnvelope(
  currentTime: number,
  duration: number,
  fadeSeconds = ONBOARDING_MUSIC_FADE_SECONDS
): number {
  if (!Number.isFinite(duration) || duration <= 0) return 1
  const fade = Math.min(fadeSeconds, duration / 2)
  if (currentTime < fade) {
    const u = currentTime / fade
    return 0.5 - 0.5 * Math.cos(Math.PI * u)
  }
  if (currentTime > duration - fade) {
    const u = (duration - currentTime) / fade
    return 0.5 - 0.5 * Math.cos(Math.PI * u)
  }
  return 1
}

/**
 * Must run inside a user click. `play()` is the first media call so the user-gesture
 * token is still live — do not seek, await, or setState first (autoplay policy).
 */
export function playOnboardingAudio(
  el: HTMLAudioElement | null | undefined,
  opts: { restart?: boolean } = {}
): void {
  if (!el) return
  const playing = el.play()
  if (opts.restart) el.currentTime = 0
  void playing.catch(() => {})
}

export interface OnboardingMusicBed {
  element: HTMLAudioElement
  start: (opts?: { restart?: boolean }) => void
  stop: () => void
  setMuted: (muted: boolean) => void
  isMuted: () => boolean
}

export function createOnboardingMusicBed(): OnboardingMusicBed {
  const el = new Audio(ONBOARDING_MUSIC_SRC)
  el.loop = true
  el.preload = 'auto'
  el.volume = ONBOARDING_MUSIC_GAIN
  let muted = false

  const applyVolume = (): void => {
    if (muted) {
      el.volume = 0
      return
    }
    el.volume = ONBOARDING_MUSIC_GAIN * onboardingMusicLoopEnvelope(el.currentTime, el.duration)
  }

  el.addEventListener('timeupdate', applyVolume)

  return {
    element: el,
    start: (opts = {}) => {
      playOnboardingAudio(el, opts)
    },
    stop: () => {
      el.pause()
    },
    setMuted: (next) => {
      muted = next
      applyVolume()
    },
    isMuted: () => muted
  }
}
