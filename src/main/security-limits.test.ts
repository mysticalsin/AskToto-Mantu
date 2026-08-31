import { afterEach, describe, expect, it } from 'vitest'
import {
  consumeSecurityLimit,
  resetSecurityLimits,
  SECURITY_LIMITS,
  shouldSampleIpcDeny,
  RATE_LIMIT_USER_MESSAGE
} from './security-limits'

afterEach(() => {
  resetSecurityLimits()
})

describe('consumeSecurityLimit', () => {
  it('allows up to the bucket max inside the window, then refuses', () => {
    const t0 = 1_000_000
    const { max } = SECURITY_LIMITS['license-activate']
    for (let i = 0; i < max; i++) {
      expect(consumeSecurityLimit('license-activate', t0 + i).ok).toBe(true)
    }
    const denied = consumeSecurityLimit('license-activate', t0 + max)
    expect(denied.ok).toBe(false)
    if (!denied.ok) expect(denied.retryAfterMs).toBeGreaterThan(0)
  })

  it('resets after the window elapses', () => {
    const t0 = 2_000_000
    const { max, windowMs } = SECURITY_LIMITS['mcp-outbound']
    for (let i = 0; i < max; i++) expect(consumeSecurityLimit('mcp-outbound', t0).ok).toBe(true)
    expect(consumeSecurityLimit('mcp-outbound', t0).ok).toBe(false)
    expect(consumeSecurityLimit('mcp-outbound', t0 + windowMs).ok).toBe(true)
  })

  it('keeps buckets independent so a Graph flood cannot starve license activate', () => {
    const t0 = 3_000_000
    const graphMax = SECURITY_LIMITS['graph-calendar'].max
    for (let i = 0; i < graphMax; i++) expect(consumeSecurityLimit('graph-calendar', t0).ok).toBe(true)
    expect(consumeSecurityLimit('graph-calendar', t0).ok).toBe(false)
    expect(consumeSecurityLimit('license-activate', t0).ok).toBe(true)
  })

  it('does not define a capture or transcript bucket', () => {
    expect(SECURITY_LIMITS).not.toHaveProperty('save-transcript')
    expect(SECURITY_LIMITS).not.toHaveProperty('parakeet-feed')
    expect(SECURITY_LIMITS).not.toHaveProperty('arm-audio')
  })
})

describe('shouldSampleIpcDeny', () => {
  it('admits the first deny and swallows the rest of a 2s burst', () => {
    const t0 = 4_000_000
    expect(shouldSampleIpcDeny(t0)).toBe(true)
    expect(shouldSampleIpcDeny(t0 + 500)).toBe(false)
    expect(shouldSampleIpcDeny(t0 + 1_999)).toBe(false)
    expect(shouldSampleIpcDeny(t0 + 2_000)).toBe(true)
  })
})

describe('RATE_LIMIT_USER_MESSAGE', () => {
  it('is a generic sentence with no path, stack, or key material', () => {
    expect(RATE_LIMIT_USER_MESSAGE).toBe('Too many attempts. Try again in a moment.')
    expect(RATE_LIMIT_USER_MESSAGE).not.toMatch(/Error|stack|ATK-|sk-|Bearer/i)
  })
})
