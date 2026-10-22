import { describe, expect, it } from 'vitest'
import { cloudSttStartAcknowledgement, resolveCloudSttStartProvider } from './cloud-stt-start'
import type { ModelPolicyDocument } from './model-policy'

function policyWithStt(provider: string, fallbacks: { provider: string; model: string }[] = []): ModelPolicyDocument {
  const entry = (selected: string, entryFallbacks: { provider: string; model: string }[] = []) => ({
    provider: selected,
    model: 'm',
    fallbacks: entryFallbacks
  })
  return {
    version: 1,
    updatedAt: 1,
    updatedBy: 'owner@example.test',
    localSpeechPack: 'offered',
    capabilities: {
      askChat: entry('anthropic'),
      commandAgent: entry('anthropic'),
      recap: entry('anthropic'),
      stt: entry(provider, fallbacks),
      tts: entry('anthropic'),
      embeddings: entry('anthropic'),
      localModel: entry('local')
    }
  }
}

describe('cloud speech start acknowledgement', () => {
  it('resolves the existing managed profile without enabling an unmanaged unconfigured session', () => {
    expect(resolveCloudSttStartProvider(null, { managed: true, inferenceMode: 'cloud-only' }, 'unconfigured')).toBe(
      'cloudflare-nova3'
    )
    expect(resolveCloudSttStartProvider(null, {}, 'unconfigured')).toBe('unconfigured')
    expect(resolveCloudSttStartProvider(null, {}, 'soniox')).toBe('soniox')
  })
  it('enforces the real STT policy and never enables an unconfigured unmanaged choice', () => {
    const policy = policyWithStt('soniox')
    expect(resolveCloudSttStartProvider(policy, {}, 'cloudflare-nova3')).toBe('soniox')
    expect(resolveCloudSttStartProvider(policy, {}, 'unconfigured')).toBe('unconfigured')

    const fallbackPolicy = policyWithStt('cloudflare-nova3', [{ provider: 'soniox', model: 'fallback' }])
    expect(resolveCloudSttStartProvider(fallbackPolicy, {}, 'soniox')).toBe('soniox')
    expect(resolveCloudSttStartProvider(fallbackPolicy, {}, 'unconfigured')).toBe('unconfigured')
  })
  it('reports only the provider actually selected by main', () => {
    expect(cloudSttStartAcknowledgement({ ok: true }, 'soniox')).toEqual({ ok: true, provider: 'soniox' })
    const identity = { provider: 'soniox', transport: 'direct-token', account: 'soniox-key', model: null } as const
    expect(cloudSttStartAcknowledgement({ ok: true, identity }, 'soniox')).toEqual({
      ok: true,
      provider: 'soniox',
      resolvedIdentity: identity
    })
    expect(cloudSttStartAcknowledgement({ ok: true }, 'cloudflare-nova3')).toEqual({
      ok: true,
      provider: 'cloudflare-nova3'
    })
  })
  it('refuses an identity that names a different provider than the one acknowledged', () => {
    const identity = { provider: 'cloudflare-nova3', transport: 'direct-token', account: 'x', model: null } as const
    expect(cloudSttStartAcknowledgement({ ok: true, identity }, 'soniox')).toEqual({
      ok: false,
      error: 'Cloud speech provider was not acknowledged.',
      code: 'INVALID_PROVIDER'
    })
  })
  it('never acknowledges an unconfigured or unknown successful provider', () => {
    for (const provider of [undefined, 'unconfigured', 'arbitrary', null, {}]) {
      expect(cloudSttStartAcknowledgement({ ok: true }, provider)).toEqual({
        ok: false,
        error: 'Cloud speech provider was not acknowledged.',
        code: 'INVALID_PROVIDER'
      })
    }
  })
  it('preserves a failed start without turning a policy choice into success', () => {
    const failure = { ok: false, error: 'Cloud speech session was replaced.', code: 'STALE' }
    expect(cloudSttStartAcknowledgement(failure, 'soniox')).toBe(failure)
  })
})
