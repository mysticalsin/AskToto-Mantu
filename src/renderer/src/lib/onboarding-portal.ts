/**
 * Exclusive-stage portal SFX. Original sci-fi entry and close, precomputed at module load.
 * OPEN and CLOSE are different sounds. Do not synthesize on the click stack.
 * OS mute + onboarding mute chip both zero gain. Not the Goldberg Aria gain.
 */

export const ONBOARDING_PORTAL_OPEN_MS = 1280
export const ONBOARDING_PORTAL_CLOSE_MS = 1220
/** Close wait before onboardingDone. Exclusive exit must not beat the collapse. */
export const ONBOARDING_PORTAL_MS = ONBOARDING_PORTAL_CLOSE_MS
export const ONBOARDING_PORTAL_SAMPLE_RATE = 22050
export const ONBOARDING_PORTAL_OPEN_GAIN = 0.16
export const ONBOARDING_PORTAL_CLOSE_GAIN = 0.12
/** Quieter bar-land after the tour. 0.45× OPEN. Must not kill the Aria. */
export const ONBOARDING_BAR_LAND_GAIN = 0.072
export const ONBOARDING_PORTAL_OPEN_SECONDS = 1.28
export const ONBOARDING_PORTAL_CLOSE_SECONDS = 1.22
export const ONBOARDING_BAR_LAND_SECONDS = 0.56
export const ONBOARDING_BAR_LAND_MS = 560

function tone(freq: number, t: number): number {
  return Math.sin(2 * Math.PI * freq * t)
}

/** Slow rising sci-fi entry: clean shimmer + rising air-tone. Not noise, not a franchise sting. */
function sciFiOpen(seconds: number, sampleRate: number): Float32Array {
  const n = Math.max(1, Math.floor(sampleRate * seconds))
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1 || 1)
    const t = i / sampleRate
    const attack = u < 0.32 ? 0.5 - 0.5 * Math.cos(Math.PI * (u / 0.32)) : 1
    const release = u > 0.78 ? 0.5 + 0.5 * Math.cos(Math.PI * ((u - 0.78) / 0.22)) : 1
    const env = attack * release
    const rise = u * u
    const air = 196 + 588 * rise
    const fifth = 294 + 882 * rise
    const shimmerHz = 3180 + 1640 * rise
    const shimmer = tone(shimmerHz, t) * (0.18 + 0.14 * tone(5.5, t))
    const body = tone(air, t) * 0.62 + tone(fifth, t) * 0.28 + shimmer * 0.22
    out[i] = body * env * 0.55
  }
  return out
}

/** Darker descending close. Different harmonics and envelope than open. Not a reverse whoosh. */
function sciFiClose(seconds: number, sampleRate: number): Float32Array {
  const n = Math.max(1, Math.floor(sampleRate * seconds))
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1 || 1)
    const t = i / sampleRate
    const attack = u < 0.08 ? u / 0.08 : 1
    const fall = u > 0.18 ? 0.5 + 0.5 * Math.cos(Math.PI * ((u - 0.18) / 0.82)) : 1
    const env = attack * fall
    const drop = u * u * (3 - 2 * u)
    const low = 440 - 348 * drop
    const sub = 110 - 68 * drop
    const gate = tone(1680 - 980 * drop, t) * Math.exp(-u * 5.2) * 0.16
    const body = tone(low, t) * 0.58 + tone(sub, t) * 0.34 + gate
    out[i] = body * env * 0.5
  }
  return out
}

/** Built once at import. */
export const PORTAL_OPEN_SAMPLES = sciFiOpen(ONBOARDING_PORTAL_OPEN_SECONDS, ONBOARDING_PORTAL_SAMPLE_RATE)
export const PORTAL_CLOSE_SAMPLES = sciFiClose(ONBOARDING_PORTAL_CLOSE_SECONDS, ONBOARDING_PORTAL_SAMPLE_RATE)

/** Shorter rising slit. Same family as open, not a reverse close, not as long. */
function sciFiBarLand(seconds: number, sampleRate: number): Float32Array {
  const n = Math.max(1, Math.floor(sampleRate * seconds))
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1 || 1)
    const t = i / sampleRate
    const attack = u < 0.18 ? 0.5 - 0.5 * Math.cos(Math.PI * (u / 0.18)) : 1
    const release = u > 0.55 ? 0.5 + 0.5 * Math.cos(Math.PI * ((u - 0.55) / 0.45)) : 1
    const env = attack * release
    const rise = u * u
    const air = 220 + 420 * rise
    const shimmer = tone(2860 + 980 * rise, t) * (0.14 + 0.1 * tone(6.2, t))
    out[i] = (tone(air, t) * 0.58 + shimmer * 0.2) * env * 0.48
  }
  return out
}

export const PORTAL_BAR_LAND_SAMPLES = sciFiBarLand(ONBOARDING_BAR_LAND_SECONDS, ONBOARDING_PORTAL_SAMPLE_RATE)

function playPrecomputed(samples: Float32Array, gain: number, muted: boolean): void {
  if (muted || typeof AudioContext === 'undefined') return
  const Ctor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return
  const ctx = new Ctor()
  const buffer = ctx.createBuffer(1, samples.length, ONBOARDING_PORTAL_SAMPLE_RATE)
  buffer.getChannelData(0).set(samples)
  const src = ctx.createBufferSource()
  src.buffer = buffer
  const g = ctx.createGain()
  g.gain.value = gain
  src.connect(g)
  g.connect(ctx.destination)
  const playing = ctx.resume()
  src.start()
  void playing.catch(() => {})
}

export function playPortalOpen(muted: boolean): void {
  playPrecomputed(PORTAL_OPEN_SAMPLES, ONBOARDING_PORTAL_OPEN_GAIN, muted)
}

export function playPortalClose(muted: boolean): void {
  playPrecomputed(PORTAL_CLOSE_SAMPLES, ONBOARDING_PORTAL_CLOSE_GAIN, muted)
}

export function playBarLand(muted: boolean): void {
  playPrecomputed(PORTAL_BAR_LAND_SAMPLES, ONBOARDING_BAR_LAND_GAIN, muted)
}

export function requestBarLand(): void {
  if (typeof document === 'undefined') return
  document.documentElement.classList.add('metis-bar-land')
  window.setTimeout(() => {
    document.documentElement.classList.remove('metis-bar-land')
  }, ONBOARDING_BAR_LAND_MS + 80)
}

export function requestOnboardingPortalClose(): void {
  if (typeof document === 'undefined') return
  document.querySelector('.onboard-stage')?.classList.add('onboard-stage--portal-close')
}

export function onboardingPortalWaitMs(reducedMotion: boolean): number {
  return reducedMotion ? 0 : ONBOARDING_PORTAL_CLOSE_MS
}

/**
 * Close pill + sci-fi close tone, then resolve. Call this BEFORE patching onboardingDone
 * so exclusive exit cannot beat the animation.
 */
export async function closeOnboardingPortal(muted: boolean, reducedMotion: boolean): Promise<void> {
  playPortalClose(muted)
  requestOnboardingPortalClose()
  const ms = onboardingPortalWaitMs(reducedMotion)
  if (ms <= 0) return
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}
