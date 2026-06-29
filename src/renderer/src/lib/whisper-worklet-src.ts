/**
 * Inlined AudioWorklet processor source for live transcription, loaded at runtime via a Blob URL.
 *
 * Why a string + Blob instead of `new URL('./whisper-worklet.ts', import.meta.url)`: that pattern is
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
 */
export const WHISPER_WORKLET_SRC = `
const SAMPLE_RATE = 16000
const MAX_SAMPLES = SAMPLE_RATE * 6                       // hard cap per window (long monologue → forced cut)
const ENDPOINT_SAMPLES = Math.round(SAMPLE_RATE * 0.8)   // ~0.8s trailing silence after speech ends a turn
const MIN_UTTERANCE_SAMPLES = Math.round(SAMPLE_RATE * 0.5) // don't endpoint windows shorter than this
const SPEECH_RMS = 0.01                                   // per-quantum energy at/above this counts as speech
const EMIT_RMS = 0.005                                    // whole-window energy below this → drop (silence)
class WhisperWorklet extends AudioWorkletProcessor {
  constructor() {
    super()
    // Pre-allocated window; each ~128-sample quantum copies in at \`fill\`. We track trailing silence and
    // whether the window has held any speech, and emit one transferable copy on end-of-turn or at the cap —
    // O(1) per quantum, zero steady-state allocation on the realtime audio thread.
    this.buf = new Float32Array(MAX_SAMPLES)
    this.fill = 0
    this.silence = 0       // consecutive trailing silent samples
    this.hasSpeech = false // has the current window contained any speech?
    this.port.onmessage = (e) => {
      if (e.data === 'flush') this.emit() // stop(): flush whatever's buffered before teardown
    }
  }
  emit() {
    const n = this.fill
    this.fill = 0
    this.silence = 0
    this.hasSpeech = false
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
    // Energy of this quantum (~128 samples ≈ 8ms) → drives speech/silence endpointing.
    let fs = 0
    for (let i = 0; i < data.length; i++) { const v = data[i]; fs += v * v }
    const speech = Math.sqrt(fs / data.length) >= SPEECH_RMS

    let offset = 0
    while (offset < data.length) {
      const take = Math.min(MAX_SAMPLES - this.fill, data.length - offset)
      this.buf.set(data.subarray(offset, offset + take), this.fill)
      this.fill += take
      offset += take
      if (this.fill >= MAX_SAMPLES) this.emit() // hard cap → force-cut a long monologue
    }

    if (speech) { this.hasSpeech = true; this.silence = 0 }
    else { this.silence += data.length }

    // End of turn: speech occurred, then >=0.8s of silence, and the window is long enough to be real speech.
    if (this.hasSpeech && this.silence >= ENDPOINT_SAMPLES && this.fill >= MIN_UTTERANCE_SAMPLES) {
      this.emit()
    }
    return true
  }
}
registerProcessor('whisper-worklet', WhisperWorklet)
`
