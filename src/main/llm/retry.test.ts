import { describe, it, expect } from 'vitest'
import { isTransient, nextBackoff } from './retry'

describe('isTransient', () => {
  it('classifies connection/transport failures as transient', () => {
    expect(isTransient(new Error('fetch failed'))).toBe(true)
    expect(isTransient({ message: 'Unexpected network error from DustAPI: fetch failed' })).toBe(true)
    expect(isTransient({ code: 'ECONNRESET' })).toBe(true)
    expect(isTransient({ code: 'ETIMEDOUT' })).toBe(true)
    expect(isTransient({ cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } })).toBe(true)
    expect(isTransient({ message: 'Connect Timeout Error', cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } })).toBe(true)
    expect(isTransient('socket hang up')).toBe(true)
  })

  it('classifies 5xx and 429 as transient, other 4xx as permanent', () => {
    expect(isTransient({ status: 500 })).toBe(true)
    expect(isTransient({ status: 503 })).toBe(true)
    expect(isTransient({ statusCode: 502 })).toBe(true)
    expect(isTransient({ status: 429 })).toBe(true)
    expect(isTransient({ status: 400 })).toBe(false)
    expect(isTransient({ status: 404 })).toBe(false)
  })

  it('never treats auth failures as transient (they self-heal via refresh, not retry)', () => {
    expect(isTransient({ status: 401 })).toBe(false)
    expect(isTransient({ type: 'expired_oauth_token_error', message: 'The request does not have valid authentication credentials.' })).toBe(false)
    expect(isTransient(new Error('unauthorized'))).toBe(false)
  })

  it('never treats aborts as transient', () => {
    expect(isTransient({ name: 'AbortError', message: 'The operation was aborted' })).toBe(false)
    expect(isTransient(new Error('aborted'))).toBe(false)
  })

  it('is false for empty/permanent errors', () => {
    expect(isTransient(null)).toBe(false)
    expect(isTransient(undefined)).toBe(false)
    expect(isTransient(new Error('model not found'))).toBe(false)
  })
})

describe('nextBackoff', () => {
  it('grows exponentially and stays within [capped/2, capped]', () => {
    // rand=0 → floor (capped/2); rand≈1 → ceil (capped). base 500.
    expect(nextBackoff(0, { rand: () => 0 })).toBe(250) // 500/2
    expect(nextBackoff(1, { rand: () => 0 })).toBe(500) // 1000/2
    expect(nextBackoff(2, { rand: () => 0 })).toBe(1000) // 2000/2
    expect(nextBackoff(0, { rand: () => 1 })).toBe(500) // full 500
    expect(nextBackoff(2, { rand: () => 1 })).toBe(2000) // full 2000
  })

  it('caps at maxMs before jitter', () => {
    const d = nextBackoff(20, { baseMs: 500, maxMs: 8000, rand: () => 1 })
    expect(d).toBe(8000)
    expect(nextBackoff(20, { baseMs: 500, maxMs: 8000, rand: () => 0 })).toBe(4000)
  })

  it('honors Retry-After as a floor', () => {
    // Computed jittered delay would be small; Retry-After wins.
    expect(nextBackoff(0, { retryAfterMs: 5000, rand: () => 0 })).toBe(5000)
    // When the computed delay exceeds Retry-After, the computed delay wins.
    expect(nextBackoff(10, { retryAfterMs: 100, maxMs: 8000, rand: () => 1 })).toBe(8000)
  })
})
