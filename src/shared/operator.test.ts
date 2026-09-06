import { describe, expect, it } from 'vitest'
import {
  cacheBadge,
  cloudflareConnectHref,
  DEFAULT_OPERATOR_URL,
  resolveOperatorBaseUrl,
  estimateCacheCost,
  formatUsdEstimate,
  mapAnthropicUsage,
  mapOpenAIUsage,
  operatorUrlConfigured,
  shouldSendAskText,
  unsupportedCacheUsage
} from './operator'

describe('mapAnthropicUsage', () => {
  it('treats input_tokens as the uncached remainder and keeps a real 0', () => {
    const u = mapAnthropicUsage(
      {
        input_tokens: 40,
        output_tokens: 12,
        cache_read_input_tokens: 800,
        cache_creation_input_tokens: 200
      },
      '1h'
    )
    expect(u.cacheRead).toBe(800)
    expect(u.cacheWrite).toBe(200)
    expect(u.cacheUncached).toBe(40)
    expect(u.inputTokens).toBe(1040)
    expect(u.cacheStatus).toBe('hit')
    expect(u.cacheTtl).toBe('1h')
  })

  it('leaves missing cache fields undefined and marks not-reported', () => {
    const u = mapAnthropicUsage({ output_tokens: 9 })
    expect(u.cacheRead).toBeUndefined()
    expect(u.cacheWrite).toBeUndefined()
    expect(u.cacheUncached).toBeUndefined()
    expect(u.cacheStatus).toBe('not-reported')
  })

  it('keeps a literal 0 from the provider', () => {
    const u = mapAnthropicUsage({
      input_tokens: 100,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0
    })
    expect(u.cacheRead).toBe(0)
    expect(u.cacheWrite).toBe(0)
    expect(u.cacheUncached).toBe(100)
  })
})

describe('mapOpenAIUsage', () => {
  it('maps cached_tokens and does not invent a write', () => {
    const u = mapOpenAIUsage({
      prompt_tokens: 1000,
      completion_tokens: 20,
      prompt_tokens_details: { cached_tokens: 900 }
    })
    expect(u.cacheRead).toBe(900)
    expect(u.cacheUncached).toBe(100)
    expect(u.cacheWrite).toBeUndefined()
    expect(u.cacheStatus).toBe('hit')
  })

  it('does not mint 0 when cache details are missing', () => {
    const u = mapOpenAIUsage({ prompt_tokens: 1000, completion_tokens: 10 })
    expect(u.cacheRead).toBeUndefined()
    expect(u.cacheWrite).toBeUndefined()
    expect(u.cacheUncached).toBeUndefined()
    expect(u.cacheStatus).toBe('not-reported')
  })

  it('unsupported usage is not-reported, never a fake hit', () => {
    const u = unsupportedCacheUsage(50, 10)
    expect(u.cacheStatus).toBe('not-reported')
    expect(u.cacheRead).toBeUndefined()
  })
})

describe('estimateCacheCost', () => {
  it('returns null when fields were not reported so the UI can hide, not show $0', () => {
    expect(estimateCacheCost({ cacheStatus: 'not-reported' }, 'claude-sonnet-4-6', 'anthropic')).toBeNull()
    expect(estimateCacheCost({ cacheStatus: 'n/a' }, 'claude-sonnet-4-6', 'anthropic')).toBeNull()
    expect(estimateCacheCost({}, 'claude-sonnet-4-6', 'anthropic')).toBeNull()
  })

  it('labels a real estimate as estimate, list price', () => {
    const est = estimateCacheCost(
      { cacheRead: 1_000_000, cacheWrite: 0, cacheUncached: 0, cacheStatus: 'hit', cacheTtl: '1h' },
      'claude-sonnet-4-6',
      'anthropic'
    )
    expect(est).toBeTruthy()
    expect(est!.label).toBe('estimate, list price')
    expect(est!.usd).toBeGreaterThan(0)
    expect(formatUsdEstimate(est!.usd)).toMatch(/^≈\$/)
  })
})

describe('cloudflareConnectHref', () => {
  it('defaults to the live Operator connect path', () => {
    expect(cloudflareConnectHref({}, {})).toBe(`${DEFAULT_OPERATOR_URL}/cloudflare/connect`)
  })

  it('uses Settings operatorUrl when https', () => {
    expect(cloudflareConnectHref({ operatorUrl: 'https://op.example.workers.dev/' }, {})).toBe(
      'https://op.example.workers.dev/cloudflare/connect'
    )
  })

  it('refuses http', () => {
    expect(cloudflareConnectHref({ operatorUrl: 'http://localhost:8787' }, {})).toBeNull()
  })
})

describe('resolveOperatorBaseUrl', () => {
  it('falls back to DEFAULT when Settings and env are empty or whitespace', () => {
    expect(resolveOperatorBaseUrl({}, {})).toBe(DEFAULT_OPERATOR_URL)
    expect(resolveOperatorBaseUrl({ operatorUrl: '' }, {})).toBe(DEFAULT_OPERATOR_URL)
    expect(resolveOperatorBaseUrl({ operatorUrl: '   ' }, {})).toBe(DEFAULT_OPERATOR_URL)
    expect(resolveOperatorBaseUrl({}, { METIS_OPERATOR_URL: '   ' })).toBe(DEFAULT_OPERATOR_URL)
  })

  it('prefers Settings, then METIS_OPERATOR_URL, and strips a trailing slash', () => {
    expect(resolveOperatorBaseUrl({ operatorUrl: 'https://op.example.workers.dev/' }, {})).toBe(
      'https://op.example.workers.dev'
    )
    expect(resolveOperatorBaseUrl({}, { METIS_OPERATOR_URL: 'https://env.example.workers.dev/' })).toBe(
      'https://env.example.workers.dev'
    )
  })

  it('refuses an explicit http override instead of falling back to DEFAULT', () => {
    expect(resolveOperatorBaseUrl({ operatorUrl: 'http://localhost:8787' }, {})).toBe('')
    expect(resolveOperatorBaseUrl({}, { METIS_OPERATOR_URL: 'http://localhost:8787' })).toBe('')
  })
})

describe('operatorUrlConfigured', () => {
  it('falls back to DEFAULT_OPERATOR_URL so seats can heartbeat without Settings', () => {
    expect(resolveOperatorBaseUrl({}, {})).toBe(DEFAULT_OPERATOR_URL)
    expect(operatorUrlConfigured({})).toBe(true)
    expect(operatorUrlConfigured({ operatorUrl: '' })).toBe(true)
    expect(operatorUrlConfigured({ operatorUrl: '   ' })).toBe(true)
    expect(operatorUrlConfigured({ operatorUrl: 'http://localhost' })).toBe(false)
    expect(operatorUrlConfigured({ operatorUrl: 'https://metis-operator.example.workers.dev' })).toBe(true)
    expect(operatorUrlConfigured({}, { METIS_OPERATOR_URL: 'https://op.example.workers.dev' })).toBe(true)
    expect(operatorUrlConfigured({}, { METIS_OPERATOR_URL: '   ' })).toBe(true)
  })

  it('sends Ask text only once an explicit URL is set (not bare DEFAULT or whitespace)', () => {
    const url = { operatorUrl: 'https://metis-operator.example.workers.dev' }
    expect(shouldSendAskText(url)).toBe(true)
    expect(shouldSendAskText({ ...url, sendAskText: false })).toBe(false)
    expect(shouldSendAskText({ sendAskText: true })).toBe(false)
    expect(shouldSendAskText({})).toBe(false)
    expect(shouldSendAskText({ operatorUrl: '   ', sendAskText: true })).toBe(false)
  })
})

describe('cacheBadge', () => {
  it('does not treat missing as a hit', () => {
    expect(cacheBadge({ cacheStatus: 'not-reported' })).toBe('not-reported')
    expect(cacheBadge({ cacheRead: 10 })).toBe('hit')
  })
})
