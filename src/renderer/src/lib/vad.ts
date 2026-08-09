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
  const RUN_FRAMES = 6 // 0.3s held above the bed = real speech (the same floor makeVad endpoints on)
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
  const sorted = rms.slice().sort((a, b) => a - b) // order statistics on a copy; the run scan below needs time order
  const lo = sorted[Math.floor(m * 0.1)]
  const hi = sorted[Math.floor(m * 0.9)]
  if (hi < 1e-6) return true // effectively silent — the emit-side RMS floor owns that case
  if (hi / Math.max(lo, 1e-6) >= SPREAD) return true
  // p90/p10 asks whether the window is MOSTLY modulated, which a brief remote reply cannot be: a window
  // that opened seconds before the far end spoke (a bed emits nothing, so the buffer runs to the endpoint
  // or the 6s cap) is >90% bed, the p90 frame lands on the bed, and the ratio judges the whole window —
  // real utterance included — non-speech. A sustained run above the bed is speech no matter how little of
  // the window it fills; a steady bed has no such run by definition, so this cannot readmit one.
  const gate = Math.max(lo, 1e-6) * SPREAD
  let held = 0
  for (let f = 0; f < m; f++) {
    held = rms[f] >= gate ? held + 1 : 0
    if (held >= RUN_FRAMES) return true
  }
  return false
}

export function makeVad(): { step: (rms: number, n: number) => boolean; reset: () => void } {
  const SR = 16000
  const ENDPOINT = Math.round(SR * 0.6) // continuous trailing silence that ends a turn (~0.6s). Tuned for
  // low turn-detection latency: still 2× a typical inter-word gap (~0.3s) so it never cuts mid-sentence,
  // but ~0.2s snappier than a conservative 0.8s — the dominant slice of perceived live-caption lag.
  const MIN_SPEECH = Math.round(SR * 0.3) // real speech needed in-window before we'll endpoint (rejects transients)
  const ON = 0.012 // per-quantum RMS to ENTER the speech state
  const OFF = 0.006 // per-quantum RMS to EXIT it (ON > OFF = hysteresis, no flicker at the boundary)
  // ON/OFF are the FLOOR of an adaptive pair, not the whole rule. Absolute alone, the exit cannot end a
  // turn on the 3.0×-boosted 'them' channel: a far-end bed (conference comfort noise, hold music, a fan)
  // lands at or above OFF, so once real speech has set the flag every quantum keeps it set, `silence` is
  // zeroed forever, and the endpoint below can never fire — remote turns were cut only by the worklet's 6s
  // hard cap (up to 6s of turn-detection lag, sentences sliced mid-word). Scaling by a tracked noise floor
  // makes the exit mean "back down to the room", which is what the end of a turn physically is.
  const OFF_K = 1.4 // exit 1.4× above the floor — clear of a steady bed's own quantum-to-quantum ripple
  const ON_K = 2.0 // enter 6dB above it, so hysteresis survives at every floor level (ON_K > OFF_K)
  // The floor must estimate the BED and never the voice. It tracks freely while the VAD is idle (down fast
  // so a bed that stops is forgotten within ~0.2s, up over ~0.8s so it settles between turns) but is held
  // to a ~10s creep while the speech state is set: otherwise a monologue drags the floor up to its own
  // level and endpoints itself mid-sentence. That creep is also the only way out of a bed already above ON
  // when capture started — the VAD latches on the bed itself there, so the idle path never gets to run.
  const UP_IDLE = 1.25 // per second
  const DOWN_IDLE = 6
  const UP_HELD = 0.1
  let floor = 0
  let active = false
  let silence = 0
  let speech = 0
  return {
    // Feed one quantum (its RMS + sample count). Returns true when the window should be emitted now.
    step(rms, n) {
      const rate = active ? (rms > floor ? UP_HELD : 0) : rms > floor ? UP_IDLE : DOWN_IDLE
      floor += (rms - floor) * Math.min(1, (n / SR) * rate) // clamped: one long quantum must not overshoot
      const off = Math.max(OFF, floor * OFF_K)
      const on = Math.max(ON, floor * ON_K)
      if (active) {
        if (rms < off) active = false
      } else if (rms >= on) {
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
      // `floor` deliberately survives: it describes the channel's background, not the turn. The worklet
      // resets on every emit, so re-learning it each window would re-latch on the bed once per window.
      active = false
      silence = 0
      speech = 0
    }
  }
}
