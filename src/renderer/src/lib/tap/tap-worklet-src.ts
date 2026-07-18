/**
 * Inlined AudioWorklet source for desk-tap capture, loaded via a Blob URL — same packaged-Electron
 * constraint as whisper-worklet-src.ts (a `new URL()` worklet module is not emitted as a fetchable
 * asset in the production build; a Blob URL works identically in dev and prod and is CSP-allowed).
 *
 * The audio-thread job is deliberately minimal: keep a ring buffer of the last PRE+WIN+POST ms, run
 * the cheap makeTapOnset trigger per quantum, and when it fires, wait until the post-roll has been
 * recorded and post ONE transferable copy of the linearized capture. All accept/reject intelligence
 * (gates.ts) and classification run on the main thread. `makeTapOnset` is embedded via `.toString()`
 * so the unit-tested factory and the realtime code are one definition (the makeVad pattern).
 *
 * Port protocol:  in → { sensitivity: 0..1 }   out → { pcm: Float32Array, floorRms, sampleRate }
 */
import { PRE_MS, WIN_MS, POST_MS } from './gates'
import { makeTapOnset } from './onset'

export const TAP_WORKLET_SRC = `
const PRE_MS = ${PRE_MS}
const WIN_MS = ${WIN_MS}
const POST_MS = ${POST_MS}
const makeTapOnset = ${makeTapOnset.toString()}
class TapWorklet extends AudioWorkletProcessor {
  constructor() {
    super()
    // sampleRate is an AudioWorkletGlobalScope global — the context's real rate.
    this.total = Math.round(((PRE_MS + WIN_MS + POST_MS) / 1000) * sampleRate)
    // One quantum of slack: quanta land in 128-sample chunks, so the post-roll OVERSHOOTS the exact
    // WIN+POST end by up to 127 samples. Without slack that overshoot slid the whole capture, bleeding
    // strike energy into the PRE segment — which false-trips the pre-quiet gate on genuine taps.
    this.slack = 128
    this.size = this.total + this.slack
    this.ring = new Float32Array(this.size)
    this.w = 0            // ring write index
    this.filled = 0       // total samples ever written (ring validity)
    this.pending = -1     // samples still to record after a trigger; -1 = no capture in flight
    this.floorAtTrigger = 0
    this.onset = makeTapOnset(sampleRate)
    this.port.onmessage = (e) => {
      if (e.data && typeof e.data.sensitivity === 'number') this.onset.setSensitivity(e.data.sensitivity)
    }
  }
  emit(overshoot) {
    // The capture must END exactly WIN+POST after the onset — i.e. \`overshoot\` samples BEFORE the
    // current write position. Linearize the \`total\` samples ending there: PRE of ambient context,
    // the strike at the PRE boundary, then WIN+POST of aftermath.
    const out = new Float32Array(this.total)
    let idx = (this.w - overshoot - this.total + 2 * this.size) % this.size
    for (let i = 0; i < this.total; i++) {
      out[i] = this.ring[idx]
      idx = (idx + 1) % this.size
    }
    this.port.postMessage({ pcm: out, floorRms: this.floorAtTrigger, sampleRate }, [out.buffer])
  }
  process(inputs) {
    const input = inputs[0]
    if (!input || !input[0] || input[0].length === 0) return true
    const data = input[0]
    let fs = 0
    for (let i = 0; i < data.length; i++) { const v = data[i]; fs += v * v }
    const rms = Math.sqrt(fs / data.length)

    // Write the quantum into the ring (quanta are 128 samples — far smaller than the ring).
    for (let i = 0; i < data.length; i++) {
      this.ring[this.w] = data[i]
      this.w = (this.w + 1) % this.size
    }
    this.filled += data.length

    if (this.pending >= 0) {
      this.pending -= data.length
      if (this.pending <= 0) {
        this.emit(-this.pending)
        this.pending = -1
      }
    } else if (this.onset.step(rms, data.length) && this.filled >= this.size) {
      // Trigger: the onset sits at the START of this quantum. The capture must end WIN+POST after it,
      // and the quantum just written already covers part of that.
      this.floorAtTrigger = this.onset.floor()
      this.pending = Math.round(((WIN_MS + POST_MS) / 1000) * sampleRate) - data.length
      if (this.pending <= 0) { this.emit(-this.pending); this.pending = -1 }
    }
    return true
  }
}
registerProcessor('tap-worklet', TapWorklet)
`
