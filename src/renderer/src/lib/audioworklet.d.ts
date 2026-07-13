/**
 * Ambient types for the AudioWorklet global scope, which is NOT part of the default DOM lib.
 * Used by the processor emitted from whisper-worklet-src.ts on the audio rendering thread. Keeps `tsc` honest without
 * pulling in the full @types/audioworklet package.
 */
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort
  constructor(options?: unknown)
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean
}

declare function registerProcessor(
  name: string,
  processorCtor: new (options?: unknown) => AudioWorkletProcessor
): void
