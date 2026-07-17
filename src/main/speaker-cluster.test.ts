import { describe, it, expect } from 'vitest'
import { cosineSimilarity, meanEmbedding, createSpeakerClusterer } from './speaker-cluster'

/** Deterministic pseudo-voice: a unit-ish vector pointing mostly along `axis`, with small seeded jitter
 *  so same-speaker samples cluster tightly and different-speaker samples stay near-orthogonal. */
function voice(axis: number, jitterSeed: number, dim = 16): Float32Array {
  const v = new Float32Array(dim)
  v[axis] = 1
  for (let i = 0; i < dim; i++) {
    // FNV-ish deterministic jitter in [-0.05, 0.05]
    const h = Math.imul((jitterSeed + 1) * 2654435761, i + 17) >>> 0
    v[i] += ((h % 1000) / 1000 - 0.5) * 0.1
  }
  return v
}

describe('cosineSimilarity', () => {
  it('is 1 for identical, ~0 for orthogonal, and never NaN for zero vectors', () => {
    const a = voice(0, 1)
    expect(cosineSimilarity(a, a)).toBeCloseTo(1, 5)
    expect(Math.abs(cosineSimilarity(voice(0, 1), voice(8, 2)))).toBeLessThan(0.3)
    expect(cosineSimilarity(new Float32Array(16), a)).toBe(0) // silent/broken window
    expect(cosineSimilarity(new Float32Array(0), new Float32Array(0))).toBe(0)
    expect(cosineSimilarity(voice(0, 1), new Float32Array(8))).toBe(0) // dim mismatch
  })
})

describe('meanEmbedding', () => {
  it('averages same-dim embeddings and refuses mixed dims or empty input', () => {
    const m = meanEmbedding([Float32Array.from([1, 0]), Float32Array.from([0, 1])])
    expect(Array.from(m!)).toEqual([0.5, 0.5])
    expect(meanEmbedding([])).toBeNull()
    expect(meanEmbedding([new Float32Array(2), new Float32Array(3)])).toBeNull()
  })
})

describe('createSpeakerClusterer', () => {
  it('groups same-voice turns under one stable label and separates distinct voices', () => {
    const c = createSpeakerClusterer({ threshold: 0.5 })
    const a1 = c.assign(voice(0, 1))
    expect(a1).toMatchObject({ label: 'Speaker 1', isNew: true })
    const a2 = c.assign(voice(0, 2)) // same speaker, different turn
    expect(a2.label).toBe('Speaker 1')
    expect(a2.isNew).toBe(false)
    expect(a2.similarity).toBeGreaterThan(0.5)
    const b1 = c.assign(voice(8, 3)) // a different voice
    expect(b1).toMatchObject({ label: 'Speaker 2', isNew: true })
    // Interleaved turns keep their assignments (the meeting back-and-forth case).
    expect(c.assign(voice(0, 4)).label).toBe('Speaker 1')
    expect(c.assign(voice(8, 5)).label).toBe('Speaker 2')
    expect(c.size()).toBe(2)
  })

  it('EMA drifts a centroid toward recent voice instead of freezing the first impression', () => {
    const c = createSpeakerClusterer({ threshold: 0.5, alpha: 0.5 })
    c.assign(voice(0, 1))
    const before = c.centroid('Speaker 1')!
    c.assign(voice(0, 99))
    const after = c.centroid('Speaker 1')!
    expect(cosineSimilarity(before, after)).toBeLessThan(1) // moved
    expect(cosineSimilarity(before, after)).toBeGreaterThan(0.9) // but not replaced
  })

  it('caps distinct speakers: past maxSpeakers, an outlier joins the nearest cluster instead', () => {
    const c = createSpeakerClusterer({ threshold: 0.99, maxSpeakers: 2 }) // hostile threshold: everything wants a new cluster
    c.assign(voice(0, 1))
    c.assign(voice(4, 2))
    const third = c.assign(voice(8, 3))
    expect(third.isNew).toBe(false) // forced into nearest — noise never invents Speaker 9
    expect(c.size()).toBe(2)
  })

  it('reset() clears the session (meeting boundary)', () => {
    const c = createSpeakerClusterer()
    c.assign(voice(0, 1))
    c.reset()
    expect(c.size()).toBe(0)
    expect(c.assign(voice(0, 2)).label).toBe('Speaker 1') // numbering restarts
  })

  it('centroid() returns a defensive copy, never a live reference', () => {
    const c = createSpeakerClusterer()
    c.assign(voice(0, 1))
    const snap = c.centroid('Speaker 1')!
    snap[0] = 999
    expect(c.centroid('Speaker 1')![0]).not.toBe(999)
    expect(c.centroid('nope')).toBeNull()
  })
})
