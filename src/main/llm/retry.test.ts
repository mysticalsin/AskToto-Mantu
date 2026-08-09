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

  it('retries real SDK error MESSAGE STRINGS (production path — onError passes a string, not an object)', () => {
    // Anthropic overloaded (HTTP 529) as the SDK stringifies it.
    expect(isTransient('529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}')).toBe(true)
    // OpenAI rate limit.
    expect(isTransient('429 Too Many Requests')).toBe(true)
    expect(isTransient('Rate limit reached for requests')).toBe(true)
    // 5xx as a bare status string.
    expect(isTransient('500 Internal Server Error')).toBe(true)
    expect(isTransient('503 Service Unavailable')).toBe(true)
    // Still not fooled by auth or permanent errors arriving as strings.
    expect(isTransient('401 Unauthorized')).toBe(false)
    expect(isTransient('400 invalid_request_error: bad model')).toBe(false)
  })

  it('MQA-061: retries the bare "Connection error." both SDKs throw when the machine is offline', () => {
    // APIConnectionError is constructed with no message for an ordinary transport failure, so this exact
    // literal — with the undici cause already dropped by errMsg — is all the offline path ever produces.
    expect(isTransient('Connection error.')).toBe(true)
    expect(isTransient(new Error('Connection error.'))).toBe(true)
    // A 401 that happens to mention a connection is still auth, never a blind retry.
    expect(isTransient({ status: 401, message: 'Connection error.' })).toBe(false)
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
