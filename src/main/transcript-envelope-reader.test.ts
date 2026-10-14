import { describe, expect, it } from 'vitest'
import { readEnvelopeLocalKey } from './transcript-envelope-reader'

describe('ATKENC2 local key reader', () => {
  it('extracts only the bounded local key from an envelope with a large ciphertext field', () => {
    const envelope = Buffer.from(
      JSON.stringify({ v: 2, iv: 'i'.repeat(16), tag: 't'.repeat(24), ct: 'c'.repeat(1_000_000), kLocal: 'F:wrapped' }),
      'utf8'
    )
    expect(readEnvelopeLocalKey(envelope)).toBe('F:wrapped')
  })

  it('rejects missing, duplicated, malformed and oversized local key fields', () => {
    expect(() => readEnvelopeLocalKey(Buffer.from('{"v":2}'))).toThrow(/malformed/)
    expect(() => readEnvelopeLocalKey(Buffer.from('{"kLocal":"a","kLocal":"b"}'))).toThrow(/malformed/)
    expect(() => readEnvelopeLocalKey(Buffer.from('{"kLocal":2}'))).toThrow(/malformed/)
    expect(() => readEnvelopeLocalKey(Buffer.from(JSON.stringify({ kLocal: 'x'.repeat(16_385) })))).toThrow(/malformed/)
  })

  it('bounds whitespace and unterminated-string scans from the descriptor start', () => {
    const padded = Buffer.from(`{"kLocal"${' '.repeat(16_384)}:"wrapped"}`)
    const unterminated = Buffer.from(`{"kLocal":"${'x'.repeat(16_384)}`)
    expect(() => readEnvelopeLocalKey(padded)).toThrow(/malformed/)
    expect(() => readEnvelopeLocalKey(unterminated)).toThrow(/malformed/)
  })
})
