import { describe, expect, it } from 'vitest'
import { parseMetisProduct, productLabel, METIS_PRODUCTS } from './product'

describe('Metis product allowlist', () => {
  it('accepts every known Métis client id', () => {
    for (const id of METIS_PRODUCTS) {
      expect(parseMetisProduct(id)).toBe(id)
      expect(productLabel(id)).not.toBe('Unknown')
    }
  })

  it('rejects unknown or secret-looking values', () => {
    expect(parseMetisProduct('shoey')).toBeNull()
    expect(parseMetisProduct('metis-android')).toBeNull()
    expect(parseMetisProduct('sk-ant-api03-abcdef')).toBeNull()
    expect(parseMetisProduct('')).toBeNull()
    expect(parseMetisProduct(null)).toBeNull()
    expect(productLabel(null)).toBe('Unknown')
  })

  it('normalizes casing and trim', () => {
    expect(parseMetisProduct('  Metis-Desktop  ')).toBe('metis-desktop')
    expect(productLabel('metis-overlay')).toBe('Overlay')
  })
})
