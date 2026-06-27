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
  private buffer = new Float32Array(0)

  process(inputs: Float32Array[][], _outputs: Float32Array[][], _parameters: Record<string, Float32Array>): boolean {
    const input = inputs[0]
    if (!input || !input[0] || input[0].length === 0) return true

    const data = input[0]
    const next = new Float32Array(this.buffer.length + data.length)
    next.set(this.buffer)
    next.set(data, this.buffer.length)
    this.buffer = next

    while (this.buffer.length >= WINDOW_SAMPLES) {
      const chunk = this.buffer.slice(0, WINDOW_SAMPLES)
      this.port.postMessage({ audio: chunk }, [chunk.buffer])
      this.buffer = this.buffer.slice(WINDOW_SAMPLES)
    }
    return true
  }
}

registerProcessor('whisper-worklet', WhisperWorklet)
