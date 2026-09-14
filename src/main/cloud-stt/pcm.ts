/**
 * Float32 (-1..1) mono PCM @ 16 kHz → little-endian Int16 for Nova-3 / Soniox linear16 streams.
 */
export function float32ToPcm16le(samples: Float32Array): Buffer {
  const out = Buffer.allocUnsafe(samples.length * 2)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!))
    const v = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff)
    out.writeInt16LE(v, i * 2)
  }
  return out
}
