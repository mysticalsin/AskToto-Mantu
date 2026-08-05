import { describe, it, expect } from 'vitest'
import { chunkAudio, IMPORT_CHUNK_SEC, IMPORT_SAMPLE_RATE, MAX_DECODED_BYTES, assertDecodedSizeWithinBound } from './import-audio'

describe('chunkAudio', () => {
  it('splits into fixed windows with a shorter final chunk', () => {
    // Derived from IMPORT_CHUNK_SEC (not a hardcoded duration) so this stays correct if the shared
    // decode-window constant ever changes again. tailSec < IMPORT_CHUNK_SEC keeps the last chunk short.
    const tailSec = Math.max(1, Math.floor(IMPORT_CHUNK_SEC / 2))
    const samples = new Float32Array(IMPORT_SAMPLE_RATE * (IMPORT_CHUNK_SEC * 2 + tailSec))
    const chunks = chunkAudio(samples)
    expect(chunks.length).toBe(3)
    expect(chunks[0].length).toBe(IMPORT_SAMPLE_RATE * IMPORT_CHUNK_SEC)
    expect(chunks[1].length).toBe(IMPORT_SAMPLE_RATE * IMPORT_CHUNK_SEC)
    expect(chunks[2].length).toBe(IMPORT_SAMPLE_RATE * tailSec)
  })

  it('returns exactly one chunk when the audio is shorter than one window', () => {
    const samples = new Float32Array(IMPORT_SAMPLE_RATE * 5)
    const chunks = chunkAudio(samples)
    expect(chunks.length).toBe(1)
    expect(chunks[0].length).toBe(samples.length)
  })

  it('returns exactly one (empty) chunk for empty audio, so a session still gets one done:true call', () => {
    const chunks = chunkAudio(new Float32Array(0))
    expect(chunks.length).toBe(1)
    expect(chunks[0].length).toBe(0)
  })

  it('produces exact-multiple windows without a trailing empty chunk', () => {
    const samples = new Float32Array(IMPORT_SAMPLE_RATE * IMPORT_CHUNK_SEC * 2) // exactly 2 windows
    const chunks = chunkAudio(samples)
    expect(chunks.length).toBe(2)
    expect(chunks.every((c) => c.length === IMPORT_SAMPLE_RATE * IMPORT_CHUNK_SEC)).toBe(true)
  })

  it('honors a custom chunk duration', () => {
    const samples = new Float32Array(IMPORT_SAMPLE_RATE * 10)
    const chunks = chunkAudio(samples, 4, IMPORT_SAMPLE_RATE)
    expect(chunks.map((c) => c.length)).toEqual([
      IMPORT_SAMPLE_RATE * 4,
      IMPORT_SAMPLE_RATE * 4,
      IMPORT_SAMPLE_RATE * 2
    ])
  })

  it('chunks own their buffers so IPC does not clone the full recording for every window', () => {
    const samples = new Float32Array(IMPORT_SAMPLE_RATE * 40)
    samples[0] = 42
    const chunks = chunkAudio(samples)
    expect(chunks[0].buffer).not.toBe(samples.buffer)
    expect(chunks[0][0]).toBe(42)
  })
})

describe('assertDecodedSizeWithinBound', () => {
  it('allows decoded PCM at or under the bound', () => {
    const framesAtBound = Math.floor(MAX_DECODED_BYTES / Float32Array.BYTES_PER_ELEMENT)
    expect(() => assertDecodedSizeWithinBound(framesAtBound, 1)).not.toThrow()
  })

  it('rejects decoded PCM one byte over the bound', () => {
    const framesOverBound = Math.floor(MAX_DECODED_BYTES / Float32Array.BYTES_PER_ELEMENT) + 1
    expect(() => assertDecodedSizeWithinBound(framesOverBound, 1)).toThrow(/too large/i)
  })

  it('accounts for channel count, not just frame count', () => {
    // A stereo decode with half as many frames still hits the same byte total.
    const framesAtBoundMono = Math.floor(MAX_DECODED_BYTES / Float32Array.BYTES_PER_ELEMENT)
    expect(() => assertDecodedSizeWithinBound(Math.floor(framesAtBoundMono / 2) + 1, 2)).toThrow(/too large/i)
  })

  it('treats a zero/negative channel count as at least one channel', () => {
    const framesAtBound = Math.floor(MAX_DECODED_BYTES / Float32Array.BYTES_PER_ELEMENT)
    expect(() => assertDecodedSizeWithinBound(framesAtBound, 0)).not.toThrow()
  })
})
