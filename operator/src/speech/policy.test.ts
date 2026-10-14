import { describe, expect, it } from 'vitest'
import { resolveSpeechPolicy, type SpeechPolicyEnv } from './policy'

const configured: SpeechPolicyEnv = {
  SPEECH_TENANT_ID: 'metis-test-tenant',
  SPEECH_AUDIENCE: 'operator-staging',
  SPEECH_POLICY_VERSION: 'policy-1',
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
    expect(result).toMatchObject({ ok: false, code: 'TRANSPORT_UNAVAILABLE' })
  })

  it('keeps Route A and Route B identifiers distinct and non-ready until evidence exists', () => {
    expect(resolveSpeechPolicy({ ...configured, SPEECH_ROUTE_ID: 'deepgram-via-gateway' })).toMatchObject({
      ok: false,
      code: 'ROUTE_NOT_READY'
    })
    expect(resolveSpeechPolicy({ ...configured, SPEECH_ROUTE_ID: 'workers-ai-nova3' })).toMatchObject({
      ok: false,
      code: 'ROUTE_NOT_READY'
    })
  })
})
