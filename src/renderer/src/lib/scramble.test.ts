import { describe, expect, it } from 'vitest'
import { scrambleFrame } from './scramble'

/** Deterministic "random": always picks charset index 0, so resolved output is fully predictable. */
const zero = (): number => 0

describe('MQA-276 — scrambleFrame (Act 1 Welcome wordmark reveal)', () => {
  it('is fully resolved at progress 1, regardless of the RNG', () => {
    expect(scrambleFrame('Métis', 1, { random: zero })).toBe('Métis')
    expect(scrambleFrame('Métis', 1, { random: Math.random })).toBe('Métis')
  })

  it('is fully scrambled at progress 0 for a fixed RNG, and never equals the target letter-for-letter', () => {
    const out = scrambleFrame('Métis', 0, { random: zero, charset: 'X' })
    expect(out).toBe('XXXXX')
    expect(out).not.toBe('Métis')
  })

  it('clamps out-of-range progress instead of throwing or overshooting', () => {
    expect(scrambleFrame('Métis', -5, { random: zero, charset: 'X' })).toBe('XXXXX')
    expect(scrambleFrame('Métis', 5, { random: zero })).toBe('Métis')
  })

  it('resolves characters left-to-right as progress crosses each one\'s own threshold', () => {
    // length 5 -> per-char reveal thresholds are 0.2, 0.4, 0.6, 0.8, 1.0.
    expect(scrambleFrame('Métis', 0.2, { random: zero, charset: 'X' })).toBe('MXXXX')
    expect(scrambleFrame('Métis', 0.4, { random: zero, charset: 'X' })).toBe('MéXXX')
    expect(scrambleFrame('Métis', 0.6, { random: zero, charset: 'X' })).toBe('MétXX')
    expect(scrambleFrame('Métis', 0.8, { random: zero, charset: 'X' })).toBe('MétiX')
    expect(scrambleFrame('Métis', 1.0, { random: zero, charset: 'X' })).toBe('Métis')
  })

  it('never scrambles whitespace, so a multi-word target keeps its shape throughout', () => {
    expect(scrambleFrame('a b', 0, { random: zero, charset: 'X' })).toBe('X X')
  })

  it('is a pure per-frame projection: the same progress with a different RNG draw can look different ' +
      '(this is what produces the flicker when a caller re-invokes it every animation frame)', () => {
    const first = scrambleFrame('Métis', 0.2, { random: () => 0, charset: 'AB' })
    const second = scrambleFrame('Métis', 0.2, { random: () => 0.9, charset: 'AB' })
    expect(first).not.toBe(second)
    // ...but the already-resolved prefix ('M') is identical either way — only the UNRESOLVED tail flickers.
    expect(first[0]).toBe('M')
    expect(second[0]).toBe('M')
  })

  it('returns the target unchanged for an empty string or an empty charset (no infinite/NaN index)', () => {
    expect(scrambleFrame('', 0)).toBe('')
    expect(scrambleFrame('Métis', 0, { charset: '' })).toBe('Métis')
  })
})
