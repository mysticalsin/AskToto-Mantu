import { describe, it, expect, beforeEach } from 'vitest'
import {
  HEADROOM_TTL_MS,
  isBudgetExhausted,
  headroomFraction,
  noteHeadroom,
  noteHeadroomFromHeaders,
  resetAllHeadroom
} from './usage-headroom'

beforeEach(() => resetAllHeadroom())

/** A Headers-like backed by a plain map, matching the HeaderBag shape. */
function bag(entries: Record<string, string>): { get: (n: string) => string | null } {
  const lower: Record<string, string> = {}
  for (const [k, v] of Object.entries(entries)) lower[k.toLowerCase()] = v
  return { get: (n) => lower[n.toLowerCase()] ?? null }
}

describe('noteHeadroom / isBudgetExhausted', () => {
  it('fail-open: an unknown provider is never budget-exhausted', () => {
    expect(isBudgetExhausted('openai')).toBe(false)
  })

  it('pre-empts a provider under 2% remaining tokens', () => {
    noteHeadroom('openai', { remaining: 100, limit: 100_000 }) // 0.1%
    expect(isBudgetExhausted('openai')).toBe(true)
  })

  it('does not pre-empt a provider with healthy headroom', () => {
    noteHeadroom('openai', { remaining: 50_000, limit: 100_000 })
    expect(isBudgetExhausted('openai')).toBe(false)
    expect(headroomFraction('openai')).toBeCloseTo(0.5, 5)
  })

  it('a stale snapshot self-heals to eligible after the TTL', () => {
    const t0 = 1_000_000
    noteHeadroom('openai', { remaining: 0, limit: 100_000 }, t0)
    expect(isBudgetExhausted('openai', t0)).toBe(true)
    expect(isBudgetExhausted('openai', t0 + HEADROOM_TTL_MS + 1)).toBe(false)
  })

  it('a snapshot whose window has already reset is void', () => {
    const t0 = 2_000_000
    noteHeadroom('openai', { remaining: 0, limit: 100_000, resetAt: t0 + 5_000 }, t0)
    expect(isBudgetExhausted('openai', t0 + 4_999)).toBe(true)
    expect(isBudgetExhausted('openai', t0 + 5_000)).toBe(false)
  })

  it('ignores a bogus limit (no divide-by-zero, no false positive)', () => {
    noteHeadroom('openai', { remaining: 0, limit: 0 })
    expect(isBudgetExhausted('openai')).toBe(false)
  })
})

describe('noteHeadroomFromHeaders', () => {
  it('reads the OpenAI token family', () => {
    noteHeadroomFromHeaders('groq', bag({ 'x-ratelimit-remaining-tokens': '500', 'x-ratelimit-limit-tokens': '100000' }))
    expect(isBudgetExhausted('groq')).toBe(true)
  })

  it('reads the Anthropic family', () => {
    noteHeadroomFromHeaders(
      'anthropic',
      bag({ 'anthropic-ratelimit-tokens-remaining': '10', 'anthropic-ratelimit-tokens-limit': '100000' })
    )
    expect(isBudgetExhausted('anthropic')).toBe(true)
  })

  it('keeps the MINIMUM fraction across token and request families', () => {
    // tokens healthy (50%), requests nearly spent (1%) → the min (1%) drives pre-emption.
    noteHeadroomFromHeaders(
      'openai',
      bag({
        'x-ratelimit-remaining-tokens': '50000',
        'x-ratelimit-limit-tokens': '100000',
        'x-ratelimit-remaining-requests': '1',
        'x-ratelimit-limit-requests': '100'
      })
    )
    expect(isBudgetExhausted('openai')).toBe(true)
  })

  it('fail-open on missing / malformed headers', () => {
    noteHeadroomFromHeaders('openai', bag({}))
    noteHeadroomFromHeaders('openai', null)
    noteHeadroomFromHeaders('openai', bag({ 'x-ratelimit-remaining-tokens': 'not-a-number' }))
    expect(isBudgetExhausted('openai')).toBe(false)
  })

  it('a bare-millisecond reset ("743ms") is not misread as 743 MINUTES (audit fix MQA-126)', () => {
    // Regression: the compact-duration parser matched "743m" out of "743ms", inflating the reset ~60,000×
    // and pinning the provider budget-exhausted far into the future.
    const t0 = 3_000_000
    // A 200 carrying a near-empty budget + a 743ms reset header.
    noteHeadroomFromHeaders(
      'groq',
      bag({ 'x-ratelimit-remaining-tokens': '0', 'x-ratelimit-limit-tokens': '100000', 'x-ratelimit-reset-tokens': '743ms' }),
      t0
    )
    // ~743ms out, NOT ~12h: the snapshot self-heals well before a minute, not stuck for hours.
    expect(isBudgetExhausted('groq', t0 + 2000)).toBe(false)
  })
})
