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
 * still force-emits during long monologues, and near-silent windows are dropped (ASR hallucinates on them),
 * as are steady non-speech windows — boosted loopback background (hold music, fans) that rides above the
 * VAD floor but has none of speech's syllabic envelope modulation (see isSpeechLikeWindow in ./vad).
 *
 * The endpoint decision (speech-onset hysteresis + transient rejection) is the `makeVad` factory from
 * ./vad — embedded here via `.toString()` so the unit-tested logic and the realtime logic are ONE source.
 */
import { makeVad, isSpeechLikeWindow } from './vad'
import { FIRST_PARTIAL_SAMPLES } from '@shared/asr-latency'

export const WHISPER_WORKLET_SRC = `
const SAMPLE_RATE = 16000
const MAX_SAMPLES = SAMPLE_RATE * 6   // hard cap per window (long monologue → forced cut)
const PARTIAL_SAMPLES = ${FIRST_PARTIAL_SAMPLES} // first caption before the 6s cap (docs/asr/QUALITY.md)
const PARTIAL_COOLDOWN_SAMPLES = SAMPLE_RATE * 0.4 // re-score a rejected partial a few times a second, not per quantum
const EMIT_RMS = 0.005                // whole-window energy below this → drop (silence; ASR hallucinates on it)
const makeVad = ${makeVad.toString()}
const isSpeechLikeWindow = ${isSpeechLikeWindow.toString()}
class WhisperWorklet extends AudioWorkletProcessor {
  constructor() {
    super()
    // Pre-allocated window; each ~128-sample quantum copies in at \`fill\`. A per-instance VAD decides when
    // the turn has ended; we then emit one transferable copy. Per quantum this is O(128) plus the VAD;
    // the only O(fill) work is the partial score, rate-limited by PARTIAL_COOLDOWN_SAMPLES.
    this.buf = new Float32Array(MAX_SAMPLES)
    this.fill = 0
    this.partialSent = false
    // Sample offset before which emitPartial() must not re-scan. A rejected partial (silence, a steady
    // non-speech bed) used to be re-scored on EVERY 128-sample quantum with an O(fill) energy pass plus
    // isSpeechLikeWindow's sort and allocations, on the realtime audio thread. Cooldown 0.4 s instead.
    this.nextPartialAt = 0
    this.vad = makeVad()
    this.port.onmessage = (e) => {
      if (e.data === 'flush') this.emit() // stop(): flush whatever's buffered before teardown
    }
  }
  keepable(n) {
    if (n === 0) return false
    let s = 0
    for (let i = 0; i < n; i++) { const v = this.buf[i]; s += v * v }
    if (Math.sqrt(s / n) < EMIT_RMS) return false
    return isSpeechLikeWindow(this.buf, n)
  }
  emitPartial() {
    if (this.partialSent || this.fill < PARTIAL_SAMPLES || this.fill < this.nextPartialAt) return
    if (!this.keepable(this.fill)) { this.nextPartialAt = this.fill + PARTIAL_COOLDOWN_SAMPLES; return }
    this.partialSent = true
    const chunk = this.buf.slice(0, this.fill)
    this.port.postMessage({ audio: chunk, partial: true }, [chunk.buffer])
  }
  emit() {
    const n = this.fill
    this.fill = 0
    this.partialSent = false
    this.nextPartialAt = 0
    this.vad.reset()
    if (!this.keepable(n)) return
    const chunk = this.buf.slice(0, n)
    this.port.postMessage({ audio: chunk, partial: false }, [chunk.buffer])
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

    if (!this.partialSent && this.fill >= PARTIAL_SAMPLES) this.emitPartial()
    if (this.vad.step(rms, data.length)) this.emit() // end of turn
    return true
  }
}
registerProcessor('whisper-worklet', WhisperWorklet)
`
