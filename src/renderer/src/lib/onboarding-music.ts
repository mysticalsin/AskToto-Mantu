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
export const ONBOARDING_MUSIC_GAIN = 0.3
export const ONBOARDING_MUSIC_FADE_SECONDS = 2.4
/** First samples are audible under portal OPEN (0.16). Mute still zeros. Loop still dips. */
export const ONBOARDING_MUSIC_ENVELOPE_FLOOR = 0.48

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
  let raw = 1
  if (currentTime < fade) {
    const u = currentTime / fade
    raw = 0.5 - 0.5 * Math.cos(Math.PI * u)
  } else if (currentTime > duration - fade) {
    const u = (duration - currentTime) / fade
    raw = 0.5 - 0.5 * Math.cos(Math.PI * u)
  }
  return Math.max(ONBOARDING_MUSIC_ENVELOPE_FLOOR, raw)
}

/**
 * `play()` is the first media call — do not seek, await, or setState first.
 * Called on the portal-open mount (Electron usually allows autoplay). If play()
 * rejects, the caller retries on the next user gesture.
 */
export function playOnboardingAudio(
  el: HTMLAudioElement | null | undefined,
  opts: { restart?: boolean } = {}
): Promise<void> | undefined {
  if (!el) return
  const playing = el.play()
  if (opts.restart) el.currentTime = 0
  void playing.catch(() => {})
  return playing
}

export interface OnboardingMusicBed {
  element: HTMLAudioElement
  start: (opts?: { restart?: boolean }) => Promise<void> | undefined
  stop: () => void
  setMuted: (muted: boolean) => void
  isMuted: () => boolean
}

/** Close-path events that must halt the tour bed. Fail-closed: leftover loop is a bug. */
export const ONBOARDING_MUSIC_CLOSE_EVENTS = [
  'pagehide',
  'beforeunload',
  'visibilitychange',
  'keydown'
] as const

/** Known HTMLAudioElement beds created by this module. `new Audio()` is not in the DOM. */
const knownOnboardingBeds = new Set<HTMLAudioElement>()
const knownBedStops = new Set<() => void>()

let closeHooksInstalled = false

/** True when the tour is no longer on screen: tab/window hide, overlay hide, or Escape. */
export function shouldStopOnboardingMusicOnEvent(e: {
  type: string
  key?: string
  visibilityState?: string
}): boolean {
  if (e.type === 'pagehide' || e.type === 'beforeunload') return true
  if (e.type === 'visibilitychange') return e.visibilityState === 'hidden'
  if (e.type === 'keydown') return e.key === 'Escape'
  return false
}

/** Ends playback for real. Pause alone left the Aria running after quit. */
export function haltOnboardingAudio(el: HTMLAudioElement | null | undefined): void {
  if (!el) return
  el.autoplay = false
  el.loop = false
  try {
    el.pause()
  } catch {
    /* already dead */
  }
  try {
    el.currentTime = 0
  } catch {
    /* detached / empty src */
  }
  el.volume = 0
  el.removeAttribute('src')
  el.src = ''
  try {
    el.load()
  } catch {
    /* empty src load is the teardown */
  }
}

function onGlobalCloseEvent(e: Event): void {
  const vis = typeof document !== 'undefined' ? document.visibilityState : undefined
  const key = typeof (e as KeyboardEvent).key === 'string' ? (e as KeyboardEvent).key : undefined
  if (shouldStopOnboardingMusicOnEvent({ type: e.type, key, visibilityState: vis })) {
    haltAllOnboardingAudio()
  }
}

function ensureOnboardingAudioCloseHooks(): void {
  if (closeHooksInstalled || typeof window === 'undefined') return
  closeHooksInstalled = true
  window.addEventListener('pagehide', onGlobalCloseEvent)
  window.addEventListener('beforeunload', onGlobalCloseEvent)
  window.addEventListener('keydown', onGlobalCloseEvent)
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onGlobalCloseEvent)
  }
}

/**
 * Module-level singleton halt. Replay remounts without killing leftover `new Audio()`
 * beds; querySelectorAll misses those, so known refs are required too.
 * Call BEFORE `patch({ onboardingDone: true })` and BEFORE `patch({ onboardingDone: false })`.
 */
export function haltAllOnboardingAudio(): void {
  const stops = [...knownBedStops]
  knownBedStops.clear()
  for (const stop of stops) {
    try {
      stop()
    } catch {
      /* already dead */
    }
  }
  const found = new Set<HTMLAudioElement>(knownOnboardingBeds)
  if (typeof document !== 'undefined' && typeof document.querySelectorAll === 'function') {
    document.querySelectorAll('audio').forEach((node) => {
      found.add(node)
    })
  }
  for (const el of found) {
    haltOnboardingAudio(el)
  }
  knownOnboardingBeds.clear()
}

export function createOnboardingMusicBed(): OnboardingMusicBed {
  ensureOnboardingAudioCloseHooks()
  const el = new Audio(ONBOARDING_MUSIC_SRC)
  knownOnboardingBeds.add(el)
  el.loop = true
  el.preload = 'auto'
  el.autoplay = true
  el.setAttribute('playsinline', '')
  el.volume = ONBOARDING_MUSIC_GAIN
  let muted = false
  let stopped = false

  const applyVolume = (): void => {
    if (muted || stopped) {
      el.volume = 0
      return
    }
    el.volume = ONBOARDING_MUSIC_GAIN * onboardingMusicLoopEnvelope(el.currentTime, el.duration)
  }

  const onCloseEvent = (e: Event): void => {
    const vis = typeof document !== 'undefined' ? document.visibilityState : undefined
    const key = typeof (e as KeyboardEvent).key === 'string' ? (e as KeyboardEvent).key : undefined
    if (shouldStopOnboardingMusicOnEvent({ type: e.type, key, visibilityState: vis })) stop()
  }

  const stop = (): void => {
    if (stopped) return
    stopped = true
    muted = true
    knownOnboardingBeds.delete(el)
    knownBedStops.delete(stop)
    haltOnboardingAudio(el)
    el.removeEventListener('timeupdate', applyVolume)
    if (typeof window !== 'undefined') {
      window.removeEventListener('pagehide', onCloseEvent)
      window.removeEventListener('beforeunload', onCloseEvent)
      window.removeEventListener('keydown', onCloseEvent)
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onCloseEvent)
    }
  }

  el.addEventListener('timeupdate', applyVolume)
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', onCloseEvent)
    window.addEventListener('beforeunload', onCloseEvent)
    window.addEventListener('keydown', onCloseEvent)
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onCloseEvent)
  }
  knownBedStops.add(stop)

  return {
    element: el,
    start: (opts = {}) => {
      if (stopped) return
      return playOnboardingAudio(el, opts)
    },
    stop,
    setMuted: (next) => {
      muted = next
      applyVolume()
    },
    isMuted: () => muted
  }
}
