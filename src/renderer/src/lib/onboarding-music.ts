/**
 * Act 1+ onboarding bed — original Web Audio only. No files, no fetch, no copyrighted recording.
 * Quiet looping choir / high strings (A3 and above, stacked fifths and octaves, odd-harmonic color).
 * Not a quoted melody. Default destination so OS mute applies. Never sends, never calls IPC.
 */

export const ONBOARDING_MUSIC_GAIN = 0.034
export const ONBOARDING_MUSIC_REDUCED_GAIN = 0.012
export const ONBOARDING_MUSIC_PAD_SECONDS = 22

export function onboardingMusicGain(muted: boolean, reducedMotion: boolean): number {
  if (muted) return 0
  return reducedMotion ? ONBOARDING_MUSIC_REDUCED_GAIN : ONBOARDING_MUSIC_GAIN
}

/** One odd-harmonic choir voice. No even harmonics — that is the church-choir color. */
function choirVoice(hz: number, t: number, phase: number): number {
  return (
    Math.sin(2 * Math.PI * hz * t + phase) +
    0.2 * Math.sin(2 * Math.PI * hz * 3 * t + phase * 1.31) +
    0.09 * Math.sin(2 * Math.PI * hz * 5 * t + phase * 0.67) +
    0.04 * Math.sin(2 * Math.PI * hz * 7 * t + phase * 1.73)
  )
}

/**
 * Loop-safe original pad. High register (A3=220 and above), slow attack, stacked fifths/octaves.
 * Cosine fades at both ends so BufferSource.loop has no click.
 */
export function synthesizeOnboardingPad(
  sampleRate: number,
  seconds = ONBOARDING_MUSIC_PAD_SECONDS
): Float32Array {
  const n = Math.max(1, Math.floor(sampleRate * seconds))
  const out = new Float32Array(n)
  const fade = Math.min(3.2, seconds * 0.18)
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate
    let env = 1
    if (t < fade) {
      const u = t / fade
      env = u * u * (3 - 2 * u)
    } else if (t > seconds - fade) {
      const u = (seconds - t) / fade
      env = u * u * (3 - 2 * u)
    }
    // A3, E4, A4, E5, A5 — fifths and octaves. ±6 cents on the pair = slow chorus, not a tune.
    const pad =
      0.2 * choirVoice(220, t, 0.11) +
      0.18 * choirVoice(220 * Math.pow(2, 6 / 1200), t, 0.37) +
      0.24 * choirVoice(329.63, t, 0.19) +
      0.26 * choirVoice(440, t, 0.08) +
      0.16 * choirVoice(440 * Math.pow(2, -6 / 1200), t, 0.52) +
      0.14 * choirVoice(659.25, t, 0.27) +
      0.1 * choirVoice(880, t, 0.41)
    const air = 0.03 * Math.sin(2 * Math.PI * 1320 * t + 0.2) * (0.55 + 0.45 * Math.sin((2 * Math.PI * t) / 9))
    out[i] = (pad + air) * env * 0.18
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
  let delay: DelayNode | null = null
  let feedback: GainNode | null = null
  let wet: GainNode | null = null
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
    const samples = synthesizeOnboardingPad(ctx.sampleRate, ONBOARDING_MUSIC_PAD_SECONDS)
    const buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate)
    // Typed-array generic: fill the channel from the synthesized pad (ArrayBufferLike-safe).
    buffer.getChannelData(0).set(samples)
    master = ctx.createGain()
    master.gain.value = onboardingMusicGain(muted, reduced)
    delay = ctx.createDelay(0.9)
    delay.delayTime.value = 0.28
    feedback = ctx.createGain()
    feedback.gain.value = 0.22
    wet = ctx.createGain()
    wet.gain.value = 0.2
    source = ctx.createBufferSource()
    source.buffer = buffer
    source.loop = true
    source.connect(master)
    source.connect(delay)
    delay.connect(feedback)
    feedback.connect(delay)
    delay.connect(wet)
    wet.connect(master)
    master.connect(ctx.destination)
    source.start()
    started = true
  }

  const disconnect = (node: AudioNode | null): void => {
    try {
      node?.disconnect()
    } catch {
      /* already disconnected */
    }
  }

  return {
    start,
    stop: () => {
      try {
        source?.stop()
      } catch {
        /* already stopped */
      }
      disconnect(source)
      disconnect(delay)
      disconnect(feedback)
      disconnect(wet)
      disconnect(master)
      source = null
      delay = null
      feedback = null
      wet = null
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
