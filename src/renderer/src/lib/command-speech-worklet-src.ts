import { COMMAND_SPEECH_MAX_SECONDS } from '@shared/command-speech'
import { PCM_16K_RESAMPLER_SRC } from './pcm-format'

export const COMMAND_SPEECH_WORKLET_SRC = `
const SAMPLE_RATE = 16000
const FRAME_SAMPLES = 2048
const MAX_SAMPLES = SAMPLE_RATE * ${COMMAND_SPEECH_MAX_SECONDS}
const Pcm16kResampler = ${PCM_16K_RESAMPLER_SRC}
class CommandSpeechWorklet extends AudioWorkletProcessor {
  constructor() {
    super()
    this.resampler = new Pcm16kResampler(sampleRate, SAMPLE_RATE)
    this.converted = new Float32Array(8192)
    this.frame = new Float32Array(FRAME_SAMPLES)
    this.fill = 0
    this.total = 0
    this.sequence = 0
    this.sealed = false
    this.port.onmessage = (event) => {
      if (event.data === 'seal') this.seal()
    }
  }
  emitFrame() {
    if (!this.fill) return
    const samples = this.frame.slice(0, this.fill)
    const sequence = this.sequence++
    this.port.postMessage({ type: 'frame', sequence, samples }, [samples.buffer])
    this.fill = 0
  }
  seal() {
    if (this.sealed) return
    this.sealed = true
    this.emitFrame()
    this.port.postMessage({ type: 'sealed' })
  }
  process(inputs) {
    if (this.sealed) return true
    const input = inputs[0]
    if (!input || input.length !== 1 || !input[0] || !this.resampler.valid) return true
    const count = this.resampler.write(input[0], this.converted)
    for (let i = 0; i < count; i++) {
      this.frame[this.fill++] = this.converted[i]
      this.total++
      if (this.fill === FRAME_SAMPLES) this.emitFrame()
      if (this.total >= MAX_SAMPLES) {
        this.seal()
        this.port.postMessage({ type: 'limit' })
        break
      }
    }
    return true
  }
}
registerProcessor('command-speech-worklet', CommandSpeechWorklet)
`
