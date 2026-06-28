/**
 * Subtle UI sound cues (WebAudio, no asset files). Kept very quiet and short — Apple-like, not gamey.
 * Each cue spins up a short-lived AudioContext and closes it right after, so nothing stays resident.
 * Call sites gate on the user's `soundCues` setting; this module just plays when asked.
 */
type Cue = 'ready' | 'send' | 'error'

export function playCue(kind: Cue): void {
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
