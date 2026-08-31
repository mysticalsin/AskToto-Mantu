import { afterEach, describe, expect, it } from 'vitest'
import {
  consumeSecurityLimit,
  resetSecurityLimits,
  SECURITY_LIMITS,
  HOT_PATH_LIMITS,
  takeHotPath,
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

  it('does not define a capture or transcript bucket on the blocking outbound limiter', () => {
    expect(SECURITY_LIMITS).not.toHaveProperty('save-transcript')
    expect(SECURITY_LIMITS).not.toHaveProperty('parakeet-feed')
    expect(SECURITY_LIMITS).not.toHaveProperty('arm-audio')
    expect(SECURITY_LIMITS).not.toHaveProperty('asr-feed')
    expect(SECURITY_LIMITS).not.toHaveProperty('capture-screen')
  })
})

describe('takeHotPath', () => {
  it('admits a burst then refuses in the same tick, without waiting', () => {
    const t0 = 5_000_000
    const { burst } = HOT_PATH_LIMITS['asr-feed']
    for (let i = 0; i < burst; i++) expect(takeHotPath('asr-feed', t0)).toBe(true)
    expect(takeHotPath('asr-feed', t0)).toBe(false)
    expect(takeHotPath('asr-feed', t0)).toBe(false)
  })

  it('refills over time so a real meeting is not starved', () => {
    const t0 = 6_000_000
    const { burst, refillPerSec } = HOT_PATH_LIMITS['asr-feed']
    for (let i = 0; i < burst; i++) expect(takeHotPath('asr-feed', t0)).toBe(true)
    expect(takeHotPath('asr-feed', t0)).toBe(false)
    const afterOne = t0 + Math.ceil(1000 / refillPerSec)
    expect(takeHotPath('asr-feed', afterOne)).toBe(true)
  })

  it('keeps kinds independent so an ASR flood cannot block a save', () => {
    const t0 = 7_000_000
    const asrBurst = HOT_PATH_LIMITS['asr-feed'].burst
    for (let i = 0; i < asrBurst; i++) expect(takeHotPath('asr-feed', t0)).toBe(true)
    expect(takeHotPath('asr-feed', t0)).toBe(false)
    expect(takeHotPath('save-transcript', t0)).toBe(true)
    expect(takeHotPath('capture-screen', t0)).toBe(true)
    expect(takeHotPath('arm-audio', t0)).toBe(true)
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
