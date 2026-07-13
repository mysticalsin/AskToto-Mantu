/**
 * Inlined AudioWorklet processor source for live transcription, loaded at runtime via a Blob URL.
 *
 * Why a string + Blob instead of a separate worklet module loaded with `new URL(...)`: that pattern is
 * transpiled by the Vite dev server but is NOT emitted as a fetchable asset in the packaged Electron
 * build, so `audioWorklet.addModule()` failed in production with "The user aborted a request." and the
 * microphone never captured. A Blob URL works identically in dev and prod, and `blob:` is allowed by the
 * renderer CSP (`script-src`/`worker-src`).
 *
 * This is plain JS run on the audio rendering thread (no main-thread jank of the deprecated
 * ScriptProcessorNode). It buffers PCM and emits a window at END-OF-TURN (a short trailing silence after
 * speech) rather than on a fixed clock, so a spoken question reaches the model ~1s after the speaker stops
 * instead of whenever a 6s boundary happens to land — much lower turn-detection latency. A 6s hard cap
 * still force-emits during long monologues, and near-silent windows are dropped (ASR hallucinates on them).
 *
 * The endpoint decision (speech-onset hysteresis + transient rejection) is the `makeVad` factory from
 * ./vad — embedded here via `.toString()` so the unit-tested logic and the realtime logic are ONE source.
 */
import { makeVad } from './vad'

export const WHISPER_WORKLET_SRC = `
const SAMPLE_RATE = 16000
const MAX_SAMPLES = SAMPLE_RATE * 6   // hard cap per window (long monologue → forced cut)
const EMIT_RMS = 0.005                // whole-window energy below this → drop (silence; ASR hallucinates on it)
const makeVad = ${makeVad.toString()}
class WhisperWorklet extends AudioWorkletProcessor {
  constructor() {
    super()
    // Pre-allocated window; each ~128-sample quantum copies in at \`fill\`. A per-instance VAD decides when
    // the turn has ended; we then emit one transferable copy — O(1) per quantum, zero steady-state alloc.
    this.buf = new Float32Array(MAX_SAMPLES)
    this.fill = 0
    this.vad = makeVad()
    this.port.onmessage = (e) => {
      if (e.data === 'flush') this.emit() // stop(): flush whatever's buffered before teardown
    }
  }
  emit() {
    const n = this.fill
    this.fill = 0
    this.vad.reset()
    if (n === 0) return
    // Drop near-silent windows: Whisper/Parakeet hallucinate caption filler ("you", "thank you") on silence.
    let s = 0
    for (let i = 0; i < n; i++) { const v = this.buf[i]; s += v * v }
    if (Math.sqrt(s / n) < EMIT_RMS) return
    const chunk = this.buf.slice(0, n)
    this.port.postMessage({ audio: chunk }, [chunk.buffer])
  }
  process(inputs) {
    const input = inputs[0]
    if (!input || !input[0] || input[0].length === 0) return true
    const data = input[0]
    // Energy of this quantum (~128 samples ≈ 8ms) → drives the VAD's speech/silence endpointing.
    let fs = 0
    for (let i = 0; i < data.length; i++) { const v = data[i]; fs += v * v }
    const rms = Math.sqrt(fs / data.length)

    let offset = 0
    while (offset < data.length) {
      const take = Math.min(MAX_SAMPLES - this.fill, data.length - offset)
      this.buf.set(data.subarray(offset, offset + take), this.fill)
      this.fill += take
      offset += take
      if (this.fill >= MAX_SAMPLES) this.emit() // hard cap → force-cut a long monologue
    }

    if (this.vad.step(rms, data.length)) this.emit() // end of turn
    return true
  }
}
registerProcessor('whisper-worklet', WhisperWorklet)
`
