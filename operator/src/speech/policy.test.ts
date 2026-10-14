import { describe, expect, it } from 'vitest'
import { resolveSpeechPolicy, type SpeechPolicyEnv } from './policy'

const configured: SpeechPolicyEnv = {
  SPEECH_TENANT_ID: 'metis-test-tenant',
  SPEECH_AUDIENCE: 'operator-staging',
  SPEECH_POLICY_VERSION: 'policy-1',
  SPEECH_ROUTE_ID: 'workers-ai-nova3',
  SPEECH_MODEL_ID: '@cf/deepgram/nova-3',
  SPEECH_CONFIG_VERSION: 'route-config-1',
  SPEECH_ALLOWED_LANGUAGES: 'en,en-US',
  SPEECH_MAX_CONCURRENT_SESSIONS: '2',
  SPEECH_MAX_CONCURRENT_TRACKS: '4',
  SPEECH_BUDGET_WINDOW_MS: '3600000',
  SPEECH_BUDGET_MAX_MS: '1800000',
  SPEECH_MAX_SESSION_MS: '300000'
}

describe('speech policy resolution', () => {
  it('fails closed without deployment identity and finite budget limits', () => {
    expect(resolveSpeechPolicy({}).ok).toBe(false)
    expect(resolveSpeechPolicy({ ...configured, SPEECH_BUDGET_MAX_MS: 'unlimited' }).ok).toBe(false)
    expect(resolveSpeechPolicy({ ...configured, SPEECH_MAX_CONCURRENT_SESSIONS: '0' }).ok).toBe(false)
  })

  it('does not accept client evidence as route privacy or consumer capability', () => {
    const result = resolveSpeechPolicy(configured)
    expect(result).toMatchObject({ ok: false, code: 'PRIVACY_UNVERIFIED' })
  })

  it('keeps Route A and Route B identifiers distinct and refuses evidence from another route', () => {
    expect(resolveSpeechPolicy({ ...configured, SPEECH_ROUTE_ID: 'deepgram-via-gateway', SPEECH_MODEL_ID: 'nova-3' })).toMatchObject({
      ok: false,
      code: 'PRIVACY_UNVERIFIED'
    })
    expect(resolveSpeechPolicy({ ...configured, SPEECH_ROUTE_ID: 'workers-ai-nova3' })).toMatchObject({
      ok: false,
      code: 'PRIVACY_UNVERIFIED'
    })
  })

  it('accepts only route, config, tenant, and audience matched evidence', () => {
    const evidence = {
      routeId: 'workers-ai-nova3' as const,
      modelId: '@cf/deepgram/nova-3',
      configVersion: 'route-config-1',
      tenantId: 'metis-test-tenant',
      audience: 'operator-staging',
      privacy: 'VERIFIED' as const,
      transportConsumer: 'REGISTERED' as const,
      synthetic: true as const
    }
    expect(resolveSpeechPolicy(configured, evidence).ok).toBe(true)
    expect(resolveSpeechPolicy(configured, { ...evidence, audience: 'other' })).toMatchObject({ ok: false, code: 'PRIVACY_UNVERIFIED' })
    expect(resolveSpeechPolicy(configured, { ...evidence, transportConsumer: 'UNAVAILABLE' })).toMatchObject({ ok: false, code: 'TRANSPORT_UNAVAILABLE' })
  })
})
