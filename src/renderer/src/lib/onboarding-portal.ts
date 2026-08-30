/**
 * Exclusive-stage portal iris SFX. Original short whooshes, precomputed at module load.
 * Do not synthesize on the click stack. OS mute + onboarding mute chip both zero gain.
 */

export const ONBOARDING_PORTAL_MS = 620
export const ONBOARDING_PORTAL_SAMPLE_RATE = 22050
export const ONBOARDING_PORTAL_OPEN_GAIN = 0.26
export const ONBOARDING_PORTAL_CLOSE_GAIN = 0.2

function whoosh(
  seconds: number,
  sampleRate: number,
  startBright: number,
  endBright: number,
  amp: number
): Float32Array {
  const n = Math.max(1, Math.floor(sampleRate * seconds))
  const out = new Float32Array(n)
  let prev = 0
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1 || 1)
    const env = Math.sin(Math.PI * t)
    const fade =
      t < 0.08 ? t / 0.08 : t > 0.82 ? (1 - t) / 0.18 : 1
    const noise = Math.random() * 2 - 1
    const bright = startBright + (endBright - startBright) * t
    const hp = noise - prev * bright
    prev = noise
    out[i] = hp * env * fade * amp
  }
  return out
}

/** Built once at import. Open: brighter rising air. Close: darker, a bit longer. */
export const PORTAL_OPEN_SAMPLES = whoosh(0.16, ONBOARDING_PORTAL_SAMPLE_RATE, 0.28, 0.72, 0.55)
export const PORTAL_CLOSE_SAMPLES = whoosh(0.22, ONBOARDING_PORTAL_SAMPLE_RATE, 0.7, 0.22, 0.42)

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

export function requestOnboardingPortalClose(): void {
  if (typeof document === 'undefined') return
  document.querySelector('.onboard-stage')?.classList.add('onboard-stage--portal-close')
}

export function onboardingPortalWaitMs(reducedMotion: boolean): number {
  return reducedMotion ? 0 : ONBOARDING_PORTAL_MS
}

/**
 * Close iris + whoosh, then resolve. Call this BEFORE patching onboardingDone
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
