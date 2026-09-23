/**
 * Streaming, allocation-free mono PCM conversion for the realtime capture path.
 *
 * AudioContext's requested sample rate is only a preference.  The worklet must
 * therefore convert its actual input rate before passing frames to the 16 kHz
 * VAD and ASR pipeline.  A box filter is deliberately used here: it keeps the
 * exact cumulative duration for arbitrary Web Audio render quanta without
 * retaining a per-frame buffer or allocating on the audio thread.
 */
export class Pcm16kResampler {
  readonly valid: boolean
  private readonly sourceRate: number
  private readonly targetRate: number
  private outputRemaining: number
  private sum = 0

  constructor(sourceSampleRate: number, targetSampleRate = 16000) {
    this.sourceRate = sourceSampleRate
    this.targetRate = targetSampleRate
    this.valid =
      Number.isInteger(sourceSampleRate) &&
      Number.isInteger(targetSampleRate) &&
      targetSampleRate === 16000 &&
      sourceSampleRate >= targetSampleRate &&
      sourceSampleRate <= 192000
    this.outputRemaining = this.valid ? sourceSampleRate : 0
  }

  /** Writes complete 16 kHz samples into a caller-owned buffer; malformed input writes nothing. */
  write(input: Float32Array, output: Float32Array): number {
    if (!this.valid || !(input instanceof Float32Array) || !(output instanceof Float32Array)) return 0
    for (let i = 0; i < input.length; i++) if (!Number.isFinite(input[i])) return 0

    const pendingUnits = this.sourceRate - this.outputRemaining
    const required = Math.floor((pendingUnits + input.length * this.targetRate) / this.sourceRate)
    if (output.length < required) return 0

    let remaining = this.outputRemaining
    let sum = this.sum
    let written = 0
    for (let i = 0; i < input.length; i++) {
      const sample = input[i]
      let sourceUnits = this.targetRate
      while (sourceUnits > 0) {
        const units = Math.min(sourceUnits, remaining)
        sum += sample * units
        sourceUnits -= units
        remaining -= units
        if (remaining === 0) {
          output[written++] = sum / this.sourceRate
          sum = 0
          remaining = this.sourceRate
        }
      }
    }
    this.outputRemaining = remaining
    this.sum = sum
    return written
  }
}

// The AudioWorklet is built from a Blob and cannot import the renderer module.
// Keep its implementation derived from this tested class rather than copying it.
export const PCM_16K_RESAMPLER_SRC = Pcm16kResampler.toString()
