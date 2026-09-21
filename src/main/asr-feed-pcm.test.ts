import { describe, expect, it } from 'vitest'
import { coerceFloat32Pcm } from './asr-feed-pcm'

describe('coerceFloat32Pcm', () => {
  it('keeps Float32Array', () => {
    const a = new Float32Array([0.1, -0.2])
    expect(coerceFloat32Pcm(a)).toBe(a)
  })

  it('accepts ArrayBuffer and number[]', () => {
    const a = new Float32Array([0.5, -0.5])
    expect(Array.from(coerceFloat32Pcm(a.buffer)!)).toEqual([0.5, -0.5])
    expect(Array.from(coerceFloat32Pcm([0.25, -0.25])!)).toEqual([0.25, -0.25])
  })

  it('rejects junk', () => {
    expect(coerceFloat32Pcm(null)).toBeNull()
    expect(coerceFloat32Pcm('nope')).toBeNull()
  })
})
