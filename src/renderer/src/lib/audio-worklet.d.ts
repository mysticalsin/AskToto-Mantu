/**
 * Minimal type declarations for the AudioWorklet global scope.
 * The standard DOM lib does not include these because AudioWorklet runs on a
 * separate thread with its own globals.
 */
declare class AudioWorkletProcessor {
  readonly port: MessagePort
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean
}

declare function registerProcessor(name: string, processorCtor: typeof AudioWorkletProcessor): void
