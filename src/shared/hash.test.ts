import { describe, it, expect } from 'vitest'
import { fnv1a, transcriptStateKey } from './hash'
import { fnv1a as mainFnv1a } from '../main/screen-preprocess'

describe('fnv1a', () => {
  it('is deterministic and distinguishes different content', () => {
    expect(fnv1a('Them: what is the status?')).toBe(fnv1a('Them: what is the status?'))
    expect(fnv1a('Them: a')).not.toBe(fnv1a('Them: b'))
    expect(fnv1a('')).toBe(0x811c9dc5)
  })

  it('agrees byte-for-byte with the main-process implementation (cross-process key parity)', () => {
    for (const s of ['', 'a', 'Them: send the DPO note', 'x'.repeat(6000)]) {
      expect(fnv1a(s)).toBe(mainFnv1a(s))
    }
  })
})

describe('transcriptStateKey', () => {
  it('keys only on the last maxChars — a change fully outside the window does not move the key', () => {
    // The differing bytes must land entirely in the truncated-away prefix. With a window of 6000 and a
    // shared 6000-char body, a 1-char prefix difference is exactly what slice(-6000) drops.
    const body = 'S'.repeat(6000)
    expect(transcriptStateKey('A' + body)).toBe(transcriptStateKey('B' + body))
  })

  it('moves when the recent conversation changes (adopt-vs-regenerate signal)', () => {
    expect(transcriptStateKey('Them: what is the status?')).not.toBe(
      transcriptStateKey('Them: what is the status? ME: it ships Friday.')
    )
  })
})
