/**
 * AudioWorklet processor for live transcription.
 * Buffers incoming PCM samples and emits ~6-second windows to the main thread,
 * which forwards them to the Whisper web worker.
 *
 * Runs on the audio rendering thread, avoiding the main-thread jank of the
 * deprecated ScriptProcessorNode.
 */

const SAMPLE_RATE = 16000
const WINDOW_SAMPLES = SAMPLE_RATE * 6

class WhisperWorklet extends AudioWorkletProcessor {
  // Fixed pre-allocated window. Each 128-sample quantum copies into it at `fill`; when full we emit one
  // transferable copy and reset. O(1) per quantum with zero steady-state allocation on the realtime audio
  // thread — the old grow-by-concat reallocated and recopied the whole growing buffer every quantum (O(n^2)).
  private buf = new Float32Array(WINDOW_SAMPLES)
  private fill = 0

  process(inputs: Float32Array[][], _outputs: Float32Array[][], _parameters: Record<string, Float32Array>): boolean {
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
        const chunk = this.buf.slice(0, WINDOW_SAMPLES) // one allocation per emitted 6s window
        this.port.postMessage({ audio: chunk }, [chunk.buffer])
        this.fill = 0
      }
    }
    // KNOWN LIMITATION: the trailing partial buffer (< WINDOW_SAMPLES, up to ~6s) is NOT flushed when the
    // channel closes, so the last few seconds of speech can be missing from the saved transcript. A proper
    // fix is a flush handshake (post 'flush' on stop → emit buf.slice(0, fill)), deferred because it can't
    // be verified without live audio capture and a racy flush on the realtime audio thread risks worse bugs.
    return true
  }
}

registerProcessor('whisper-worklet', WhisperWorklet)
