import { describe, it, expect } from 'vitest'
import { chunkAudio, IMPORT_CHUNK_SEC, IMPORT_SAMPLE_RATE } from './import-audio'

describe('chunkAudio', () => {
  it('splits into fixed ~30s windows with a shorter final chunk', () => {
    const samples = new Float32Array(IMPORT_SAMPLE_RATE * 75) // 30s, 30s, 15s
    const chunks = chunkAudio(samples)
    expect(chunks.length).toBe(3)
    expect(chunks[0].length).toBe(IMPORT_SAMPLE_RATE * IMPORT_CHUNK_SEC)
    expect(chunks[1].length).toBe(IMPORT_SAMPLE_RATE * IMPORT_CHUNK_SEC)
    expect(chunks[2].length).toBe(IMPORT_SAMPLE_RATE * 15)
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
    const samples = new Float32Array(IMPORT_SAMPLE_RATE * 60) // exactly 2 windows
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

  it('chunks are copies with their own backing buffer, not views (slice, not subarray) — each chunk crosses IPC alone, and a shared-buffer view would serialize the whole recording per chunk', () => {
    const samples = new Float32Array(IMPORT_SAMPLE_RATE * 40)
    samples[0] = 42
    const chunks = chunkAudio(samples)
    expect(chunks[0].buffer).not.toBe(samples.buffer)
    expect(chunks[0].buffer.byteLength).toBe(chunks[0].length * Float32Array.BYTES_PER_ELEMENT)
    expect(chunks[0][0]).toBe(42)
  })
})
