/**
 * Subtle UI sound cues (WebAudio, no asset files). Kept very quiet and short — Apple-like, not gamey.
 * Each cue spins up a short-lived AudioContext and closes it right after, so nothing stays resident.
 * Call sites gate on the user's `soundCues` setting; this module just plays when asked.
 */
type Cue = 'ready' | 'send' | 'error'

// Master gate for ALL interface sounds (click feedback + cues). Synced from the `uiSounds` setting by the
// app; when off, every sound in this module stays silent regardless of call site. Default on.
let soundsOn = true
export function setSoundsEnabled(on: boolean): void {
  soundsOn = on
}

// One reused AudioContext for click feedback. Creating a fresh context per click would quickly hit
// Chromium's ~6-live-context cap on rapid clicking; a single shared context avoids that entirely.
let clickCtx: AudioContext | null = null

/** Tactile tap contract — not an 880Hz sine beep. Body stays under 500Hz. */
export const CLICK_BODY_HZ = 210
export const CLICK_OVERTONE_RATIO = 2.4
export const CLICK_DURATION_S = 0.055
export const CLICK_PEAK = 0.032

/** Quiet, dark, tactile tap (trackpad / iPhone keyboard energy). Gated by the master setting. */
export function playClick(): void {
  if (!soundsOn) return
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AudioCtx) return
    if (!clickCtx) clickCtx = new AudioCtx()
    const ctx = clickCtx
    if (ctx.state === 'suspended') void ctx.resume()
    const t0 = ctx.currentTime
    const dur = CLICK_DURATION_S
    const peak = CLICK_PEAK

    const noiseLen = Math.max(1, Math.floor(ctx.sampleRate * 0.012))
    const buf = ctx.createBuffer(1, noiseLen, ctx.sampleRate)
    const data = buf.getChannelData(0)
    for (let i = 0; i < noiseLen; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / noiseLen)
    const noise = ctx.createBufferSource()
    noise.buffer = buf
    const noiseGain = ctx.createGain()
    noiseGain.gain.setValueAtTime(peak * 0.28, t0)
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.018)
    noise.connect(noiseGain).connect(ctx.destination)
    noise.start(t0)

    const body = ctx.createOscillator()
    body.type = 'triangle'
    body.frequency.value = CLICK_BODY_HZ
    const bodyGain = ctx.createGain()
    bodyGain.gain.setValueAtTime(0.0001, t0)
    bodyGain.gain.linearRampToValueAtTime(peak * 0.7, t0 + 0.004)
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
    body.connect(bodyGain).connect(ctx.destination)
    body.start(t0)
    body.stop(t0 + dur + 0.01)

    const over = ctx.createOscillator()
    over.type = 'sine'
    over.frequency.value = CLICK_BODY_HZ * CLICK_OVERTONE_RATIO
    const overGain = ctx.createGain()
    overGain.gain.setValueAtTime(0.0001, t0)
    overGain.gain.linearRampToValueAtTime(peak * 0.15, t0 + 0.003)
    overGain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur * 0.7)
    over.connect(overGain).connect(ctx.destination)
    over.start(t0)
    over.stop(t0 + dur)
  } catch {
    /* audio unavailable — stay silent */
  }
}

export function playCue(kind: Cue): void {
  if (!soundsOn) return
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AudioCtx) return
    const ctx = new AudioCtx()
    const t0 = ctx.currentTime

    const tone = (freq: number, start: number, dur: number, peak: number): void => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0.0001, t0 + start)
      gain.gain.linearRampToValueAtTime(peak, t0 + start + 0.012)
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + start + dur)
      osc.connect(gain).connect(ctx.destination)
      osc.start(t0 + start)
      osc.stop(t0 + start + dur + 0.02)
    }

    if (kind === 'ready') {
      // soft two-note rise — "your answer is ready"
      tone(659.25, 0, 0.13, 0.05)
      tone(987.77, 0.075, 0.17, 0.045)
    } else if (kind === 'send') {
      tone(523.25, 0, 0.07, 0.03)
    } else {
      // gentle descending pair — non-alarming error cue
      tone(311.13, 0, 0.18, 0.045)
      tone(233.08, 0.085, 0.2, 0.045)
    }

    // Close shortly after the longest cue (~0.28s) so the context never lingers.
    setTimeout(() => void ctx.close().catch(() => {}), 500)
  } catch {
    /* audio unavailable — stay silent */
  }
}
