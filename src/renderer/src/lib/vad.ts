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
export function makeVad(): { step: (rms: number, n: number) => boolean; reset: () => void } {
  const SR = 16000
  const ENDPOINT = Math.round(SR * 0.8) // continuous trailing silence that ends a turn (~0.8s)
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
