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

describe('MQA-238 - mergePass repairs online over-splitting at session end', () => {
  const dim = 16
  // Orthogonal supports: voice A lives in the first half of the dims, voice B in the second — their
  // cosine is ~0 by construction, the way two real voices' embeddings are far apart. (Two sine trains
  // over the same dims are heavily correlated and made this fixture merge everything.)
  const base = (which: 'A' | 'B'): Float32Array => {
    const v = new Float32Array(dim)
    const lo = which === 'A' ? 0 : dim / 2
    for (let i = 0; i < dim / 2; i++) v[lo + i] = 1 + 0.1 * Math.sin(i)
    return v
  }
  const noisy = (b: Float32Array, drift: number, phase: number): Float32Array => {
    const v = new Float32Array(dim)
    for (let i = 0; i < dim; i++) v[i] = b[i] + drift * Math.sin(phase + i * 0.7)
    return v
  }

  it('collapses drift-fragmented clusters of one voice back into one label and relabels densely', () => {
    // Aggressive threshold forces fragmentation the way real compressed audio does.
    const c = createSpeakerClusterer({ threshold: 0.995, alpha: 0.2 })
    const A = base('A')
    const B = base('B') // genuinely different voice
    const labels: string[] = []
    for (let k = 0; k < 6; k++) labels.push(c.assign(noisy(A, 0.15, k)).label)
    for (let k = 0; k < 6; k++) labels.push(c.assign(noisy(B, 0.15, k)).label)
    expect(c.size()).toBeGreaterThan(2) // the defect: one voice split into several
    const mapping = c.mergePass({ mergeThreshold: 0.9, minorityFloor: 1 })
    // Every original label maps somewhere, and the survivors are exactly two, densely numbered.
    const finals = new Set(labels.map((l) => mapping.get(l)))
    expect(finals.size).toBe(2)
    expect([...finals].sort()).toEqual(['Speaker 1', 'Speaker 2'])
    // Same-voice fragments all landed on the same final label.
    const finalsA = new Set(labels.slice(0, 6).map((l) => mapping.get(l)))
    const finalsB = new Set(labels.slice(6).map((l) => mapping.get(l)))
    expect(finalsA.size).toBe(1)
    expect(finalsB.size).toBe(1)
    expect(finalsA).not.toEqual(finalsB)
  })

  it('absorbs minority tail fragments into their nearest survivor even below the merge threshold', () => {
    const c = createSpeakerClusterer({ threshold: 0.9999 })
    const A = base('A')
    c.assign(noisy(A, 0.02, 0))
    c.assign(noisy(A, 0.02, 1))
    c.assign(noisy(A, 0.02, 2))
    c.assign(noisy(A, 0.6, 9)) // a far-drifted one-window fragment of the same voice
    expect(c.size()).toBeGreaterThan(1)
    const mapping = c.mergePass({ mergeThreshold: 0.999, minorityFloor: 2 })
    expect(new Set(mapping.values()).size).toBe(1)
  })

  it('never merges two genuinely distinct, well-populated voices', () => {
    const c = createSpeakerClusterer({ threshold: 0.995 })
    const A = base('A')
    const B = base('B')
    for (let k = 0; k < 5; k++) c.assign(noisy(A, 0.05, k))
    for (let k = 0; k < 5; k++) c.assign(noisy(B, 0.05, k))
    const mapping = c.mergePass({ mergeThreshold: 0.9, minorityFloor: 1 })
    expect(new Set(mapping.values()).size).toBe(2)
  })
})
