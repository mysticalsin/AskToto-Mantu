/**
 * Onset trigger for the tap worklet — the ONLY judgment that runs on the audio thread.
 *
 * Same contract as makeVad: a pure, self-contained factory (Math + literals only) that is both
 * unit-tested here and embedded into the worklet source string via `.toString()`, so the tested code
 * and the realtime code are one definition. It answers exactly one cheap question per ~128-sample
 * quantum: "did energy just JUMP well clear of the ambient floor?" Everything smarter (attack shape,
 * sustain, spectra) happens on the main thread against the captured buffer — see gates.ts.
 *
 * The floor is an asymmetric EMA: it RISES slowly (a tap must not inflate its own baseline before the
 * trigger compares against it) but FALLS fast (after a loud event the detector re-arms quickly).
 */
export function makeTapOnset(sampleRate: number): {
  /** Feed one quantum's RMS + sample count. True exactly once per detected onset. */
  step: (rms: number, n: number) => boolean
  /** Ambient floor estimate at this instant — shipped with the capture for the pre-quiet gate. */
  floor: () => number
  /** 0..1 UI sensitivity → trigger ratio (log-linear 16×..4× — lower ratio = more sensitive). */
  setSensitivity: (s: number) => void
  reset: () => void
} {
  const FLOOR_ALPHA_UP = 0.02 // per-quantum EMA when energy is ABOVE the floor (rise slowly)
  const FLOOR_ALPHA_DOWN = 0.2 // …when BELOW (fall fast — quick re-arm after loud events)
  const FLOOR_INIT = 0.002
  const TRIGGER_MIN_RMS = 0.005 // absolute minimum: a silent room's tiny floor must not make breathing fire
  const RATIO_MAX = 16 // sensitivity 0 → need a 16× jump (least sensitive)
  const RATIO_MIN = 4 // sensitivity 1 → 4× jump (most sensitive)
  const REFRACTORY_S = 0.25 // one trigger per physical tap, incl. board bounce; > the 180ms capture
  let floor = FLOOR_INIT
  let ratio = 8 // sensitivity 0.5 default: sqrt(16·4) = 8 on the log-linear scale
  let holdoff = 0 // samples remaining before the next trigger is allowed
  return {
    step(rms, n) {
      if (holdoff > 0) {
        holdoff = Math.max(0, holdoff - n)
        // Keep the floor tracking during holdoff so the estimate stays honest through the tap's ring.
        const a = rms > floor ? FLOOR_ALPHA_UP : FLOOR_ALPHA_DOWN
        floor = floor + a * (rms - floor)
        return false
      }
      const fired = rms >= Math.max(floor * ratio, TRIGGER_MIN_RMS)
      if (fired) {
        holdoff = Math.round(REFRACTORY_S * sampleRate)
      } else {
        const a = rms > floor ? FLOOR_ALPHA_UP : FLOOR_ALPHA_DOWN
        floor = floor + a * (rms - floor)
      }
      return fired
    },
    floor() {
      return floor
    },
    setSensitivity(s) {
      const t = Math.min(1, Math.max(0, s))
      ratio = Math.exp(Math.log(RATIO_MAX) + t * (Math.log(RATIO_MIN) - Math.log(RATIO_MAX)))
    },
    reset() {
      floor = FLOOR_INIT
      holdoff = 0
    }
  }
}
