import { describe, expect, it } from 'vitest'
import { ALPHA2_TO_NUMERIC, NUMERIC_TO_ALPHA2 } from './iso'

describe('NUMERIC_TO_ALPHA2', () => {
  it('carries all 249 currently assigned ISO 3166-1 codes', () => {
    expect(Object.keys(NUMERIC_TO_ALPHA2).length).toBe(249)
  })

  it('every key is a zero-padded 3-digit numeric string, every value a 2-letter code', () => {
    for (const [numeric, alpha2] of Object.entries(NUMERIC_TO_ALPHA2)) {
      expect(numeric).toMatch(/^\d{3}$/)
      expect(alpha2).toMatch(/^[A-Z]{2}$/)
    }
  })

  it('has no duplicate numeric keys or duplicate alpha-2 values', () => {
    const alpha2s = Object.values(NUMERIC_TO_ALPHA2)
    expect(new Set(alpha2s).size).toBe(alpha2s.length)
  })

  it('covers major countries at their well-known numeric ids', () => {
    expect(NUMERIC_TO_ALPHA2['840']).toBe('US')
    expect(NUMERIC_TO_ALPHA2['124']).toBe('CA')
    expect(NUMERIC_TO_ALPHA2['076']).toBe('BR')
    expect(NUMERIC_TO_ALPHA2['826']).toBe('GB')
    expect(NUMERIC_TO_ALPHA2['250']).toBe('FR')
    expect(NUMERIC_TO_ALPHA2['276']).toBe('DE')
  })
})

describe('ALPHA2_TO_NUMERIC', () => {
  it('is the exact reverse of NUMERIC_TO_ALPHA2', () => {
    expect(Object.keys(ALPHA2_TO_NUMERIC).length).toBe(Object.keys(NUMERIC_TO_ALPHA2).length)
    for (const [numeric, alpha2] of Object.entries(NUMERIC_TO_ALPHA2)) {
      expect(ALPHA2_TO_NUMERIC[alpha2]).toBe(numeric)
    }
  })
})
