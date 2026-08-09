import { describe, it, expect } from 'vitest'
import { classifyExhaustion, parseRetryAfterMs, parseCliUsageReset } from './exhaustion'

// Regression coverage for the exhaustion taxonomy behind these ledger rows (docs/qa/BUG-LEDGER.md):
// MQA-118 (credit/quota classification), MQA-119 (claude-cli usage-cap + reset parse), MQA-121 (Retry-After).

describe('classifyExhaustion — money (quota-exhausted)', () => {
  it('OpenAI insufficient_quota is quota, even carried on a 429', () => {
    const s = classifyExhaustion(
      '429 You exceeded your current quota, please check your plan and billing details. insufficient_quota'
    )
    expect(s?.kind).toBe('quota-exhausted')
    expect(s?.resetAt).toBeNull()
  })

  it('Anthropic "credit balance is too low" (a 400) is quota, not a rate limit', () => {
    const s = classifyExhaustion('400 Your credit balance is too low to access the Anthropic API.')
    expect(s?.kind).toBe('quota-exhausted')
  })

  it('DeepSeek "402 Insufficient Balance" is quota', () => {
    expect(classifyExhaustion('402 Insufficient Balance')?.kind).toBe('quota-exhausted')
  })

  it('a terminal credit message stays quota even when a short Retry-After rides along', () => {
    const s = classifyExhaustion('Your credit balance is too low. Retry-After: 30')
    expect(s?.kind).toBe('quota-exhausted')
  })
})

describe('classifyExhaustion — subscription usage-cap', () => {
  it('claude-cli "Claude AI usage limit reached|<epoch>" is a usage-cap with a parsed reset', () => {
    const future = Math.floor((Date.now() + 3 * 60 * 60 * 1000) / 1000)
    const s = classifyExhaustion(`Claude AI usage limit reached|${future}`)
    expect(s?.kind).toBe('usage-cap')
    expect(s?.resetAt).toBe(future * 1000)
    expect(s?.retryAfterMs).toBeGreaterThan(0)
  })

  it('a 5-hour session cap gets the ~5h window', () => {
    const s = classifyExhaustion('session usage limit reached')
    expect(s?.kind).toBe('usage-cap')
    expect(s?.reason).toMatch(/session/)
    expect(s?.retryAfterMs).toBeGreaterThan(4 * 60 * 60 * 1000)
  })

  it('a weekly cap gets the ~24h window (weekly wording wins over the generic usage-limit phrase)', () => {
    const s = classifyExhaustion("You've reached your weekly usage limit.")
    expect(s?.kind).toBe('usage-cap')
    expect(s?.reason).toMatch(/weekly/)
    expect(s?.retryAfterMs).toBeGreaterThan(20 * 60 * 60 * 1000)
  })

  it('a bare "usage limit reached" defaults to the ~1h window', () => {
    const s = classifyExhaustion('usage limit reached')
    expect(s?.kind).toBe('usage-cap')
    expect(s?.retryAfterMs).toBeGreaterThan(50 * 60 * 1000)
    expect(s?.retryAfterMs).toBeLessThan(70 * 60 * 1000)
  })
})

describe('classifyExhaustion — rate-limit', () => {
  it('a bare 429 is a rate-limit', () => {
    expect(classifyExhaustion('429 Too Many Requests')?.kind).toBe('rate-limit')
  })

  it('Anthropic 529 overloaded behaves like a rate-limit (back off)', () => {
    expect(classifyExhaustion('529 {"type":"overloaded_error"}')?.kind).toBe('rate-limit')
  })

  it('honors a numeric Retry-After on a rate-limit', () => {
    const s = classifyExhaustion('429 Too Many Requests. Retry-After: 30')
    expect(s?.kind).toBe('rate-limit')
    expect(s?.retryAfterMs).toBe(30_000)
  })

  it('honors a Groq-style compact "try again in 5m"', () => {
    const s = classifyExhaustion('rate_limit_exceeded: please try again in 5m')
    expect(s?.kind).toBe('rate-limit')
    expect(s?.retryAfterMs).toBe(5 * 60 * 1000)
  })

  it('classifies by status when the body is terse', () => {
    expect(classifyExhaustion('slow down', 429)?.kind).toBe('rate-limit')
  })
})

describe('classifyExhaustion — NOT an exhaustion signal (leaves auth/transient alone)', () => {
  it.each([
    ['401 Unauthorized'],
    ['invalid api key'],
    ['403 permission denied'],
    ['ECONNRESET'],
    ['500 Internal Server Error'],
    ['fetch failed'],
    [''],
    ['   ']
  ])('%s → null', (msg) => {
    expect(classifyExhaustion(msg)).toBeNull()
  })

  it('a 401 with a status still returns null (auth owns it)', () => {
    expect(classifyExhaustion('Unauthorized', 401)).toBeNull()
  })
})

describe('parseRetryAfterMs', () => {
  it('integer seconds header', () => {
    expect(parseRetryAfterMs('Retry-After: 45')).toBe(45_000)
  })
  it('compact 2h', () => {
    expect(parseRetryAfterMs('back in 2h')).toBe(2 * 60 * 60 * 1000)
  })
  it('does not fall for parseInt("5m") → 5ms', () => {
    expect(parseRetryAfterMs('retry in 5m')).toBe(5 * 60 * 1000)
  })
  it('fractional seconds ("please retry in 38.9s")', () => {
    expect(parseRetryAfterMs('please retry in 38.9s')).toBe(38_900)
  })
  it('null when no window is stated', () => {
    expect(parseRetryAfterMs('429 Too Many Requests')).toBeNull()
  })
})

describe('parseCliUsageReset', () => {
  const now = 1_800_000_000_000 // fixed base so the test is deterministic
  it('parses the claude-cli pipe-epoch (seconds)', () => {
    const epochSec = Math.floor((now + 3 * 60 * 60 * 1000) / 1000)
    expect(parseCliUsageReset(`Claude AI usage limit reached|${epochSec}`, now)).toBe(epochSec * 1000)
  })
  it('parses "resets in 2h30m"', () => {
    expect(parseCliUsageReset('Individual quota reached. Resets in 2h30m0s', now)).toBe(now + 2.5 * 60 * 60 * 1000)
  })
  it('rejects an implausible past/far-future epoch', () => {
    expect(parseCliUsageReset('reached|100', now)).toBeNull() // year 1970
    expect(parseCliUsageReset(`reached|${Math.floor(now / 1000) + 999_999_999}`, now)).toBeNull()
  })
})
