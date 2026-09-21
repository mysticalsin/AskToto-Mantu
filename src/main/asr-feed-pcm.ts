/**
 * Electron IPC may deliver PCM as Float32Array, ArrayBuffer, or a TypedArray view.
 * Cap2 ear / Listen must not silently drop windows when instanceof Float32Array fails.
 */
export function coerceFloat32Pcm(samples: unknown): Float32Array | null {
  if (samples instanceof Float32Array) return samples
  if (samples instanceof ArrayBuffer) return new Float32Array(samples)
  if (ArrayBuffer.isView(samples)) {
    const view = samples as ArrayBufferView
    return new Float32Array(view.buffer, view.byteOffset, Math.floor(view.byteLength / 4))
  }
  if (Array.isArray(samples) && samples.every((n) => typeof n === 'number')) {
    return Float32Array.from(samples as number[])
  }
  return null
}
