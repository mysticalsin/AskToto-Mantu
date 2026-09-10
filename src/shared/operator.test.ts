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
  projectOperatorIngestMetadata,
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

  it('never sends Ask text, including persisted legacy opt-ins and managed explicit URLs', () => {
    const url = { operatorUrl: 'https://metis-operator.example.workers.dev' }
    expect(shouldSendAskText(url)).toBe(false)
    expect(shouldSendAskText({ ...url, sendAskText: true })).toBe(false)
    expect(shouldSendAskText({ ...url, sendAskText: false })).toBe(false)
    expect(shouldSendAskText({ sendAskText: true })).toBe(false)
    expect(shouldSendAskText({})).toBe(false)
    expect(shouldSendAskText({ operatorUrl: '   ', sendAskText: true })).toBe(false)
  })
})

describe('projectOperatorIngestMetadata', () => {
  it('projects an Ask through a positive metadata schema and classifies raw errors', () => {
    const projected = projectOperatorIngestMetadata({
      id: 'ask-123',
      ts: 123,
      mode: 'answer',
      skillId: 'how-to',
      skillVersion: '2.1.0',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      ttftMs: 42,
      totalMs: 91,
      inputTokens: 10,
      outputTokens: 4,
      cacheRead: 7,
      cacheWrite: 2,
      cacheUncached: 1,
      cacheStatus: 'hit',
      cacheTtl: '1h',
      outcome: 'error',
      questionType: 'how-to',
      error: '401 from https://private.example/customer/acme',
      seatHash: 'seat-abc',
      os: 'darwin',
      appVersion: '1.8.9',
      hostname: 'tonys-mac',
      ssoEmail: 'tony@example.com',
      license: 'licensed',
      licenseId: 'abcdef0123456789',
      licenseLast4: 'Z9Z9',
      lastIndexAt: 100,
      question: 'private acquisition plan',
      transcript: 'private meeting transcript',
      screenshot: { text: 'private screen' },
      body: { messages: [{ content: 'nested private words' }] },
      arbitrary: { secret: 'nested poison' }
    })

    expect(projected).toEqual({
      id: 'ask-123',
      ts: 123,
      mode: 'answer',
      skillId: 'how-to',
      skillVersion: '2.1.0',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      ttftMs: 42,
      totalMs: 91,
      inputTokens: 10,
      outputTokens: 4,
      cacheRead: 7,
      cacheWrite: 2,
      cacheUncached: 1,
      cacheStatus: 'hit',
      cacheTtl: '1h',
      outcome: 'error',
      questionType: 'how-to',
      error: 'auth',
      seatHash: 'seat-abc',
      os: 'darwin',
      appVersion: '1.8.9',
      hostname: 'tonys-mac',
      ssoEmail: 'tony@example.com',
      license: 'licensed',
      licenseId: 'abcdef0123456789',
      licenseLast4: 'Z9Z9',
      lastIndexAt: 100
    })
    expect(JSON.stringify(projected)).not.toContain('private')
  })

  it('keeps CRM operational status/counts but drops all customer record references', () => {
    expect(
      projectOperatorIngestMetadata({
        event: 'crm',
        id: 'crm-123',
        ts: 456,
        status: 'failed',
        connector: 'plane',
        attempt: 2,
        latencyMs: 78,
        credentialSource: 'operator',
        error: 'timeout posting Customer Alpha to https://crm.example/record/42',
        title: 'Customer Alpha renewal',
        meetingHash: 'abcdef0123456789',
        action: 'create Customer Alpha opportunity',
        remoteId: 'record-42',
        remoteUrl: 'https://crm.example/record/42',
        payload: { description: 'customer notes' }
      })
    ).toEqual({
      event: 'crm',
      id: 'crm-123',
      ts: 456,
      status: 'failed',
      connector: 'plane',
      attempt: 2,
      latencyMs: 78,
      credentialSource: 'operator',
      error: 'transient'
    })
  })

  it('fails closed for unsupported events and malformed required identifiers', () => {
    expect(projectOperatorIngestMetadata({ event: 'future-event', id: 'future-1', body: 'private' })).toBeNull()
    expect(projectOperatorIngestMetadata({ event: 'rating', id: 'contains private words', rating: 'up' })).toBeNull()
    expect(projectOperatorIngestMetadata({ event: 'crm', id: 'crm-1', status: 'made-up' })).toBeNull()
    expect(projectOperatorIngestMetadata({ id: 'ask-unknown-error', outcome: 'error', error: 'Customer Alpha failed' })).toMatchObject({
      id: 'ask-unknown-error',
      error: 'unknown'
    })
  })
})

describe('cacheBadge', () => {
  it('does not treat missing as a hit', () => {
    expect(cacheBadge({ cacheStatus: 'not-reported' })).toBe('not-reported')
    expect(cacheBadge({ cacheRead: 10 })).toBe('hit')
  })
})
