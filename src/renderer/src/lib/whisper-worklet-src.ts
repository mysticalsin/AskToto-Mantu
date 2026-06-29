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
 * ScriptProcessorNode). It buffers PCM into fixed ~6s windows and posts each as a transferable.
 */
export const WHISPER_WORKLET_SRC = `
const SAMPLE_RATE = 16000
const WINDOW_SAMPLES = SAMPLE_RATE * 6
class WhisperWorklet extends AudioWorkletProcessor {
  constructor() {
    super()
    // Fixed pre-allocated window; each 128-sample quantum copies in at \`fill\`, emitting one transferable
    // copy when full — O(1) per quantum, zero steady-state allocation on the realtime audio thread.
    this.buf = new Float32Array(WINDOW_SAMPLES)
    this.fill = 0
  }
  process(inputs) {
    const input = inputs[0]
    if (!input || !input[0] || input[0].length === 0) return true
    const data = input[0]
    let offset = 0
    while (offset < data.length) {
      const take = Math.min(WINDOW_SAMPLES - this.fill, data.length - offset)
      this.buf.set(data.subarray(offset, offset + take), this.fill)
      this.fill += take
      offset += take
      if (this.fill >= WINDOW_SAMPLES) {
        // Skip near-silent windows: Whisper hallucinates caption filler ("you", "thank you") on silence.
        let s = 0
        for (let i = 0; i < WINDOW_SAMPLES; i++) { const v = this.buf[i]; s += v * v }
        const rms = Math.sqrt(s / WINDOW_SAMPLES)
        this.fill = 0
        if (rms >= 0.005) {
          const chunk = this.buf.slice(0, WINDOW_SAMPLES)
          this.port.postMessage({ audio: chunk }, [chunk.buffer])
        }
      }
    }
    return true
  }
}
registerProcessor('whisper-worklet', WhisperWorklet)
`
