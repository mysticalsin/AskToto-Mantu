import { describe, expect, it } from 'vitest'
import { proxyTokenCount } from './ask-meter'

describe('R11 exact token counts without invented zeros or rounding', () => {
  for (const value of [NaN, Infinity, -Infinity, -1, 0.1, Number.MAX_SAFE_INTEGER + 1, '30', null, undefined]) {
    it(`keeps invalid usage unknown: ${String(value)}`, () => {
      expect(proxyTokenCount(value)).toBeNull()
    })
  }
  for (const value of [0, -0, 1, 120, Number.MAX_SAFE_INTEGER]) {
    it(`preserves exact non-negative integer ${String(value)}`, () => {
      expect(proxyTokenCount(value)).toBe(value === 0 ? 0 : value)
    })
  }
})
