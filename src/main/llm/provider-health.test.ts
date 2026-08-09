import { describe, it, expect, beforeEach } from 'vitest'
import {
  AUTH_FAILURES_BEFORE_UNHEALTHY,
  COOLDOWN_MS,
  QUOTA_COOLDOWN_MS,
  RATE_LIMIT_COOLDOWN_MS,
  isAuthFailure,
  isCoolingDown,
  recordAuthFailure,
  recordExhausted,
  recordRateLimited,
  recordSuccess,
  resetAllProviderHealth,
  resetProviderHealth,
  unhealthyProviders
} from './provider-health'

/**
 * MQA-003 / MQA-004 / MQA-021 (docs/qa/BUG-LEDGER.md). MQA-021 is the same missing circuit breaker,
 * found independently by the 16-domain audit after MQA-003 had already been fixed here — kept as its own
 * ledger row (ids are never reused) and pinned by these same tests.
 *
 * Measured against a live app with a revoked DeepSeek key:
 * three consecutive suggest asks each re-walked the dead provider first (6.5s / 9.3s / 9.2s against a
 * 15s live-suggest budget), and the settings snapshot still reported `providerReady: true` throughout.
 * These tests pin the memory that makes both behaviors impossible.
 */
beforeEach(() => {
  resetAllProviderHealth()
})

describe('isAuthFailure — only credential rejections are remembered (MQA-004)', () => {
  it.each([
    '401 Authentication Fails, Your api key: ****0000 is invalid',
    '403 status code (no body)',
    'Unauthorized',
    'invalid_api_key: the key was revoked',
    'Your API key has expired',
    'permission denied for this model'
  ])('classifies %j as an auth failure', (msg) => {
    expect(isAuthFailure(msg)).toBe(true)
  })

  it.each([
    '503 Service Unavailable',
    '429 Too Many Requests',
    'fetch failed',
    'ECONNRESET',
    'socket hang up',
    'model not found',
    // Credit / quota exhaustion is NOT an auth failure — exhaustion.ts owns it now, so it gets a 1h
    // "out of credit" cooldown + message instead of the wrong "re-enter your key" treatment.
    '402 Insufficient Balance',
    'insufficient credit remaining',
    ''
  ])('does NOT classify %j as an auth failure', (msg) => {
    expect(isAuthFailure(msg)).toBe(false)
  })

  it('never treats a 5xx as a credential problem even when it mentions auth', () => {
    // A server erroring out while logging the word "authentication" is the provider having a bad
    // minute — demoting the user's perfectly good key for 10 minutes over it would be its own bug.
    expect(isAuthFailure('500 internal error in authentication service')).toBe(false)
  })
})

describe('cooldown lifecycle (MQA-003)', () => {
  it('tolerates a single rejection — one 401 can be a token mid-refresh', () => {
    recordAuthFailure('deepseek', '401 invalid key')
    expect(isCoolingDown('deepseek')).toBe(false)
    expect(unhealthyProviders()).toEqual([])
  })

  it('trips after consecutive rejections and reports the provider as unhealthy', () => {
    for (let i = 0; i < AUTH_FAILURES_BEFORE_UNHEALTHY; i++) recordAuthFailure('deepseek', '401 invalid key')
    expect(isCoolingDown('deepseek')).toBe(true)
    expect(unhealthyProviders().map((p) => p.provider)).toEqual(['deepseek'])
    expect(unhealthyProviders()[0].error).toContain('401')
  })

  it('is scoped per provider — a dead DeepSeek key never demotes NVIDIA', () => {
    for (let i = 0; i < AUTH_FAILURES_BEFORE_UNHEALTHY; i++) recordAuthFailure('deepseek', '401')
    expect(isCoolingDown('deepseek')).toBe(true)
    expect(isCoolingDown('nvidia')).toBe(false)
  })

  it('expires on its own so a restored key recovers without an app restart', () => {
    const t0 = 1_000_000
    for (let i = 0; i < AUTH_FAILURES_BEFORE_UNHEALTHY; i++) recordAuthFailure('deepseek', '401', t0)
    expect(isCoolingDown('deepseek', t0 + COOLDOWN_MS - 1)).toBe(true)
    expect(isCoolingDown('deepseek', t0 + COOLDOWN_MS)).toBe(false)
    expect(unhealthyProviders(t0 + COOLDOWN_MS)).toEqual([])
  })

  it('a successful answer clears the verdict immediately', () => {
    for (let i = 0; i < AUTH_FAILURES_BEFORE_UNHEALTHY; i++) recordAuthFailure('deepseek', '401')
    recordSuccess('deepseek')
    expect(isCoolingDown('deepseek')).toBe(false)
    expect(unhealthyProviders()).toEqual([])
  })

  it('changing the key clears the verdict — pasting a working key must feel like it fixed it', () => {
    for (let i = 0; i < AUTH_FAILURES_BEFORE_UNHEALTHY; i++) recordAuthFailure('deepseek', '401')
    expect(isCoolingDown('deepseek')).toBe(true)
    resetProviderHealth('deepseek')
    expect(isCoolingDown('deepseek')).toBe(false)
  })

  it('a success between rejections resets the streak rather than accumulating toward a trip', () => {
    recordAuthFailure('deepseek', '401')
    recordSuccess('deepseek')
    recordAuthFailure('deepseek', '401')
    expect(isCoolingDown('deepseek')).toBe(false)
  })

  it('an untouched provider is never cooling down', () => {
    expect(isCoolingDown('anthropic')).toBe(false)
    expect(unhealthyProviders()).toEqual([])
  })
})

describe('kind-aware cooldown — rate-limit / quota / usage-cap (OmniRoute integration)', () => {
  it('a rate limit cools IMMEDIATELY (one signal), unlike the 2-strike auth path', () => {
    const t0 = 1_000_000
    recordRateLimited('anthropic', undefined, t0)
    expect(isCoolingDown('anthropic', t0)).toBe(true)
    const u = unhealthyProviders(t0)[0]
    expect(u.provider).toBe('anthropic')
    expect(u.reason).toBe('rate-limit')
    // default 60s window when the server declared no Retry-After
    expect(u.until).toBe(t0 + RATE_LIMIT_COOLDOWN_MS)
    expect(isCoolingDown('anthropic', t0 + RATE_LIMIT_COOLDOWN_MS)).toBe(false)
  })

  it('a rate limit honors the server Retry-After as the cooldown window', () => {
    const t0 = 2_000_000
    recordRateLimited('openai', 5 * 60_000, t0)
    expect(isCoolingDown('openai', t0 + 4 * 60_000)).toBe(true)
    expect(isCoolingDown('openai', t0 + 5 * 60_000)).toBe(false)
  })

  it('credit exhaustion cools for ~1h and reads as reason "quota-exhausted"', () => {
    const t0 = 3_000_000
    recordExhausted('deepseek', 'quota-exhausted', { message: 'Out of credit.' }, t0)
    const u = unhealthyProviders(t0)[0]
    expect(u.reason).toBe('quota-exhausted')
    expect(u.until).toBe(t0 + QUOTA_COOLDOWN_MS)
    expect(u.error).toBe('Out of credit.')
  })

  it('a usage-cap cools until the stated reset instant', () => {
    const t0 = 4_000_000
    const resetAt = t0 + 5 * 60 * 60 * 1000 // a 5h session reset
    recordExhausted('claude-cli', 'usage-cap', { resetAt, message: 'Usage limit reached.' }, t0)
    expect(unhealthyProviders(t0)[0].reason).toBe('usage-cap')
    expect(isCoolingDown('claude-cli', resetAt - 1)).toBe(true)
    // Checked last: isCoolingDown at the expiry instant self-heals by deleting the record.
    expect(isCoolingDown('claude-cli', resetAt)).toBe(false)
  })

  it('a success clears a rate-limit / quota verdict the same as an auth one', () => {
    recordRateLimited('anthropic')
    recordSuccess('anthropic')
    expect(isCoolingDown('anthropic')).toBe(false)
    expect(unhealthyProviders()).toEqual([])
  })

  it('a bogus far-future reset can never lock a provider out beyond the safety cap', () => {
    const t0 = 5_000_000
    const insane = t0 + 3650 * 24 * 60 * 60 * 1000 // ten years
    recordExhausted('nvidia', 'usage-cap', { resetAt: insane }, t0)
    // bounded to ≤ ~8 days, so it self-heals rather than dead-locking the provider forever
    expect(isCoolingDown('nvidia', t0 + 9 * 24 * 60 * 60 * 1000)).toBe(false)
  })
})
