/**
 * Continuous cloud-only capture worklet. Unlike the VAD window worklet it never emits overlapping
 * prefixes: it yields fixed 100 ms frames plus one bounded final remainder when sealed.
 */
import { PCM_16K_RESAMPLER_SRC } from './pcm-format'

export const CLOUD_CAPTURE_WORKLET_SRC = `
const TARGET_RATE = 16000
const FRAME_SAMPLES = 1600
const MAX_RESAMPLED_BLOCK = 4096
const Pcm16kResampler = ${PCM_16K_RESAMPLER_SRC}

class CloudCaptureWorklet extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const requestedRate = options?.processorOptions?.sourceSampleRate
    this.sourceRate = requestedRate === sampleRate ? requestedRate : sampleRate
    this.resampler = new Pcm16kResampler(this.sourceRate, TARGET_RATE)
    this.resampled = new Float32Array(MAX_RESAMPLED_BLOCK)
    this.frame = new Float32Array(FRAME_SAMPLES)
    this.fill = 0
    this.sequence = 0
    this.totalSamples = 0
    this.sealed = false
    this.port.onmessage = (event) => {
      const message = event.data
      if (this.sealed || message?.type !== 'seal-and-flush' || typeof message.requestId !== 'string') return
      this.sealed = true
      if (this.fill > 0) this.emit(this.fill)
      this.port.postMessage({
        type: 'flush-ack',
        requestId: message.requestId,
        finalSequence: this.sequence,
        finalSampleOffset: this.totalSamples
      })
    }
  }
  emit(count) {
    const chunk = this.frame.slice(0, count)
    this.port.postMessage({
      type: 'pcm-frame',
      sequence: this.sequence + 1,
      sampleOffset: this.totalSamples,
      sampleRate: TARGET_RATE,
      audio: chunk
    }, [chunk.buffer])
    this.sequence += 1
    this.totalSamples += count
    this.fill = 0
  }
  process(inputs) {
    if (this.sealed || !this.resampler.valid) return true
    const input = inputs[0]
    if (!input || input.length !== 1 || !input[0] || input[0].length === 0) return true
    const written = this.resampler.write(input[0], this.resampled)
    if (written === 0) return true
    let offset = 0
    while (offset < written) {
      const take = Math.min(FRAME_SAMPLES - this.fill, written - offset)
      this.frame.set(this.resampled.subarray(offset, offset + take), this.fill)
      this.fill += take
      offset += take
      if (this.fill === FRAME_SAMPLES) this.emit(FRAME_SAMPLES)
    }
    return true
  }
}
registerProcessor('cloud-capture-worklet', CloudCaptureWorklet)
`
