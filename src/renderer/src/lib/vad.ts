/**
 * Voice-activity endpointing for the live-transcription worklet.
 *
 * Written as a pure, self-contained factory for ONE reason: the exact same logic is both unit-tested
 * (vad.test.ts) AND embedded into the AudioWorklet source string (whisper-worklet-src.ts) via
 * `makeVad.toString()`. One definition → zero drift between the tested code and the code that actually runs
 * on the audio thread. It must reference nothing outside itself (only `Math` + literals), so it transplants
 * cleanly into the realtime worklet global scope.
 *
 * Decision: emit the window when there has been enough REAL speech (rejects coughs/clicks) followed by a
 * continuous trailing silence (end of turn). Hysteresis (ON > OFF) keeps the speech flag from flickering at
 * the threshold; per-word gaps are far shorter than the endpoint, so they never cut a sentence early.
 */
/**
 * Window-level speech-likeness gate, applied at emit time (after the whole-window RMS floor).
 *
 * Why it exists: the 'them' channel boosts quiet system-loopback 3.0× to lift un-AGC'd call speech over
 * the fixed VAD/EMIT thresholds — but that boost also lifts steady background sound (hold music, a fan,
 * street noise) above them, so during quiet stretches the VAD never leaves the speech state and the 6s
 * hard cap force-emits non-speech windows to the ASR continuously. Whisper hallucinates captions on
 * exactly those windows, and text-side phantom/repetition filters only catch some of the fallout.
 *
 * The discriminator is temporal envelope spread, not spectral flatness or model no-speech probability:
 * speech carries 3–8 Hz syllabic modulation, so its 50ms-frame RMS spans ≥8 dB (inter-word/syllable dips)
 * even over a loud music bed, while a steady bed stays within ~3 dB. Spectral flatness can't make this
 * cut (music is tonal — low flatness, the same side as speech), and Whisper's no_speech_prob is neither
 * exposed by the transformers.js pipeline() API nor on the Apple-ASR path at all. A p90/p10 RMS ratio is
 * also scale-invariant, so the 3.0× channel gain cancels exactly — one threshold serves both channels.
 *
 * Fail-open by design: windows too short to judge pass, borderline ratios pass, and a bed that STOPS
 * mid-window (its trailing endpoint silence widens the ratio) passes — one leaked window per music-stop
 * beats eating short steady vocalizations ("mmm", a held "yes"). Downstream text filters stay as backstop.
 *
 * Same transplant contract as makeVad: pure, self-contained (Math + literals only), embedded into the
 * AudioWorklet source string via `.toString()` and unit-tested here as ONE definition.
 */
export function isSpeechLikeWindow(buf: Float32Array, n: number): boolean {
  const FRAME = 800 // 50ms @ 16kHz — syllable-scale envelope resolution
  const MIN_FRAMES = 8 // < 0.4s of audio → too little envelope to judge; fail open
  const SPREAD = 2.5 // p90/p10 frame-RMS ratio (~8 dB): speech exceeds it, a steady bed never does
  const m = Math.floor(n / FRAME)
  if (m < MIN_FRAMES) return true
  const rms: number[] = []
  for (let f = 0; f < m; f++) {
    let sum = 0
    let sq = 0
    for (let i = f * FRAME; i < (f + 1) * FRAME; i++) {
      const v = buf[i]
      sum += v
      sq += v * v
    }
    // Mean-removed RMS: a loopback driver's DC offset would otherwise inflate every frame equally and
    // compress the spread toward 1, silently turning the gate against real speech.
    const mean = sum / FRAME
    rms.push(Math.sqrt(Math.max(0, sq / FRAME - mean * mean)))
  }
  rms.sort((a, b) => a - b)
  const lo = rms[Math.floor(m * 0.1)]
  const hi = rms[Math.floor(m * 0.9)]
  if (hi < 1e-6) return true // effectively silent — the emit-side RMS floor owns that case
  return hi / Math.max(lo, 1e-6) >= SPREAD
}

export function makeVad(): { step: (rms: number, n: number) => boolean; reset: () => void } {
  const SR = 16000
  const ENDPOINT = Math.round(SR * 0.6) // continuous trailing silence that ends a turn (~0.6s). Tuned for
  // low turn-detection latency: still 2× a typical inter-word gap (~0.3s) so it never cuts mid-sentence,
  // but ~0.2s snappier than a conservative 0.8s — the dominant slice of perceived live-caption lag.
  const MIN_SPEECH = Math.round(SR * 0.3) // real speech needed in-window before we'll endpoint (rejects transients)
  const ON = 0.012 // per-quantum RMS to ENTER the speech state
  const OFF = 0.006 // per-quantum RMS to EXIT it (ON > OFF = hysteresis, no flicker at the boundary)
  let active = false
  let silence = 0
  let speech = 0
  return {
    // Feed one quantum (its RMS + sample count). Returns true when the window should be emitted now.
    step(rms, n) {
      if (active) {
        if (rms < OFF) active = false
      } else if (rms >= ON) {
        active = true
      }
      if (active) {
        speech += n
        silence = 0
      } else {
        silence += n
      }
      return speech >= MIN_SPEECH && silence >= ENDPOINT
    },
    reset() {
      active = false
      silence = 0
      speech = 0
    }
  }
}
