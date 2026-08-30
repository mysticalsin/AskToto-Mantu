/**
 * Act 1+ onboarding bed — original Web Audio only. No files, no fetch, no copyrighted recording.
 * Quiet looping pad (stacked fifths, not a quoted melody). Default destination so OS mute applies.
 * Never sends, never calls IPC.
 */

export const ONBOARDING_MUSIC_GAIN = 0.038
export const ONBOARDING_MUSIC_REDUCED_GAIN = 0.014

export function onboardingMusicGain(muted: boolean, reducedMotion: boolean): number {
  if (muted) return 0
  return reducedMotion ? ONBOARDING_MUSIC_REDUCED_GAIN : ONBOARDING_MUSIC_GAIN
}

/** Loop-safe original pad. Cosine window so BufferSource.loop has no click. */
export function synthesizeOnboardingPad(sampleRate: number, seconds = 12): Float32Array {
  const n = Math.max(1, Math.floor(sampleRate * seconds))
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate
    const env = 0.5 - 0.5 * Math.cos((2 * Math.PI * t) / seconds)
    const pad =
      0.42 * Math.sin(2 * Math.PI * 110 * t) +
      0.3 * Math.sin(2 * Math.PI * 164.81 * t + 0.18) +
      0.14 * Math.sin(2 * Math.PI * 220 * t + 0.41) +
      0.08 * Math.sin(2 * Math.PI * 329.63 * t + 0.07)
    const shimmer = 0.035 * Math.sin(2 * Math.PI * 392 * t) * Math.max(0, Math.sin((2 * Math.PI * t) / 6))
    out[i] = (pad + shimmer) * env * 0.32
  }
  return out
}

export interface OnboardingMusicBed {
  start: () => Promise<void>
  stop: () => void
  setMuted: (muted: boolean) => void
  setReducedMotion: (reduced: boolean) => void
  isMuted: () => boolean
}

function audioContextCtor(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null
  return (
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext ||
    null
  )
}

export function createOnboardingMusicBed(): OnboardingMusicBed {
  let ctx: AudioContext | null = null
  let master: GainNode | null = null
  let source: AudioBufferSourceNode | null = null
  let muted = false
  let reduced = false
  let started = false

  const applyGain = (): void => {
    if (!ctx || !master) return
    master.gain.setTargetAtTime(onboardingMusicGain(muted, reduced), ctx.currentTime, 0.04)
  }

  const start = async (): Promise<void> => {
    const Ctor = audioContextCtor()
    if (!Ctor) return
    if (!ctx) ctx = new Ctor()
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {})
    if (started && source) return
    const samples = synthesizeOnboardingPad(ctx.sampleRate, 12)
    const buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate)
    // Typed-array generic: fill the channel from the synthesized pad (ArrayBufferLike-safe).
    buffer.getChannelData(0).set(samples)
    master = ctx.createGain()
    master.gain.value = onboardingMusicGain(muted, reduced)
    source = ctx.createBufferSource()
    source.buffer = buffer
    source.loop = true
    source.connect(master).connect(ctx.destination)
    source.start()
    started = true
  }

  return {
    start,
    stop: () => {
      try {
        source?.stop()
      } catch {
        /* already stopped */
      }
      source?.disconnect()
      master?.disconnect()
      source = null
      master = null
      started = false
      if (ctx) {
        void ctx.close().catch(() => {})
        ctx = null
      }
    },
    setMuted: (next) => {
      muted = next
      applyGain()
    },
    setReducedMotion: (next) => {
      reduced = next
      applyGain()
    },
    isMuted: () => muted
  }
}
