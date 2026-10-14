import { describe, expect, it } from 'vitest'
import type { SpeechCapability } from './cloud-stt/broker-client'
import type { ModelPolicyDocument, ModelPolicyEntry } from '../shared/model-policy'
import {
  resolveSpeechBrokerAuthority,
  resolveSpeechBrokerPolicy,
  type VerifiedSpeechPolicySnapshot
} from './speech-broker-policy'

const now = 1_893_456_000_000
type ReadySpeechCapability = Extract<SpeechCapability, { ready: true }>
const identity = {
  origin: 'https://operator.example',
  credentialDigest: 'a'.repeat(64),
  deviceIdHash: '0123456789abcdef0123456789abcdef'
}

function policy(stt: ModelPolicyEntry): ModelPolicyDocument {
  return {
    version: 8,
    updatedAt: now - 1_000,
    updatedBy: 'synthetic-test',
    localSpeechPack: 'offered',
    capabilities: {
      askChat: stt,
      commandAgent: stt,
      recap: stt,
      stt,
      tts: stt,
      embeddings: stt,
      localModel: stt
    }
  }
}

function snapshot(stt: ModelPolicyEntry): VerifiedSpeechPolicySnapshot {
  return {
    ...identity,
    verifiedAt: now - 1_000,
    revision: 'synthetic-policy-revision-8',
    policy: policy(stt)
  }
}

function capability(
  routeId: ReadySpeechCapability['routeId'] = 'deepgram-via-gateway',
  modelId: ReadySpeechCapability['modelId'] = 'nova-3',
  languages = ['multi', 'en']
): SpeechCapability {
  return {
    ok: true,
    protocolVersion: 1,
    selected: { routeId, modelId },
    allowed: [{ routeId, modelId }],
    ready: true,
    routeId,
    modelId,
    languages,
    format: { encoding: 'pcm_s16le', sampleRate: 16_000, channels: 1 },
    validUntil: now + 60_000,
    limits: {
      maxStreamMs: 60_000,
      drainWindowMs: 5_000,
      maxInputBytesPerTrack: 1_920_000,
      maxClientFrameBytes: 65_536,
      maxOutputBytesPerTrack: 1_048_576
    }
  }
}

function resolve(
  options: Partial<Parameters<typeof resolveSpeechBrokerPolicy>[0]> = {}
): ReturnType<typeof resolveSpeechBrokerPolicy> {
  return resolveSpeechBrokerPolicy({
    profile: { transport: 'broker-v1', engine: 'deepgram-nova3' },
    snapshot: snapshot({ provider: 'deepgram-nova3', model: 'nova-3', fallbacks: [] }),
    currentIdentity: identity,
    managedProviders: { state: 'absent' },
    capability: capability(),
    language: 'multi',
    now,
    ...options
  })
}

function resolveAuthority(
  options: Partial<Parameters<typeof resolveSpeechBrokerAuthority>[0]> = {}
): ReturnType<typeof resolveSpeechBrokerAuthority> {
  return resolveSpeechBrokerAuthority({
    profile: { transport: 'broker-v1', engine: 'deepgram-nova3' },
    snapshot: snapshot({ provider: 'deepgram-nova3', model: 'nova-3', fallbacks: [] }),
    currentIdentity: identity,
    managedProviders: { state: 'absent' },
    now,
    ...options
  })
}

describe('resolveSpeechBrokerAuthority', () => {
  it('resolves exact selected and allowed engine/route/model pairs without a remote capability', () => {
    expect(resolveAuthority()).toEqual({
      ok: true,
      engine: 'deepgram-nova3',
      selected: { engine: 'deepgram-nova3', routeId: 'deepgram-via-gateway', modelId: 'nova-3' },
      allowed: [{ engine: 'deepgram-nova3', routeId: 'deepgram-via-gateway', modelId: 'nova-3' }]
    })
  })

  it('includes only signed policy fallbacks permitted by managed provider policy', () => {
    const signedPolicy = snapshot({
      provider: 'deepgram-nova3',
      model: 'nova-3',
      fallbacks: [{ provider: 'cloudflare-nova3', model: '@cf/deepgram/nova-3' }]
    })
    expect(resolveAuthority({ snapshot: signedPolicy })).toMatchObject({
      ok: true,
      allowed: [
        { engine: 'deepgram-nova3', routeId: 'deepgram-via-gateway', modelId: 'nova-3' },
        { engine: 'cloudflare-nova3', routeId: 'workers-ai-nova3', modelId: '@cf/deepgram/nova-3' }
      ]
    })
    expect(
      resolveAuthority({ snapshot: signedPolicy, managedProviders: { state: 'valid', providers: ['deepgram-nova3'] } })
    ).toMatchObject({
      ok: true,
      allowed: [{ engine: 'deepgram-nova3', routeId: 'deepgram-via-gateway', modelId: 'nova-3' }]
    })
  })

  it('refuses signed policy denials, unknown provider/model aliases, and invalid managed policy', () => {
    expect(resolveAuthority({ profile: { transport: 'broker-v1', engine: 'deepgram-nova3', extra: true } })).toEqual({
      ok: false,
      code: 'PROFILE_INVALID'
    })
    expect(
      resolveAuthority({
        snapshot: snapshot({ provider: 'cloudflare-nova3', model: '@cf/deepgram/nova-3', fallbacks: [] })
      })
    ).toEqual({
      ok: false,
      code: 'STT_NOT_ALLOWED'
    })
    expect(resolveAuthority({ snapshot: snapshot({ provider: 'deepgram', model: 'nova-3', fallbacks: [] }) })).toEqual({
      ok: false,
      code: 'STT_NOT_ALLOWED'
    })
    const validSnapshot = snapshot({ provider: 'deepgram-nova3', model: 'nova-3', fallbacks: [] })
    expect(
      resolveAuthority({
        snapshot: { ...validSnapshot, policy: { ...validSnapshot.policy, extra: true } as ModelPolicyDocument }
      })
    ).toEqual({ ok: false, code: 'POLICY_INVALID' })
    expect(resolveAuthority({ managedProviders: { state: 'invalid' } })).toEqual({
      ok: false,
      code: 'PROVIDER_POLICY_INVALID'
    })
    expect(resolveAuthority({ managedProviders: { state: 'valid', providers: [] } })).toEqual({
      ok: false,
      code: 'PROVIDER_DENIED'
    })
  })

  it('requires the current identity and fresh verified policy snapshot', () => {
    expect(resolveAuthority({ snapshot: null })).toEqual({ ok: false, code: 'POLICY_UNAVAILABLE' })
    expect(resolveAuthority({ currentIdentity: { ...identity, deviceIdHash: 'f'.repeat(32) } })).toEqual({
      ok: false,
      code: 'POLICY_IDENTITY'
    })
    expect(
      resolveAuthority({
        snapshot: {
          ...snapshot({ provider: 'deepgram-nova3', model: 'nova-3', fallbacks: [] }),
          verifiedAt: now - 60_001
        }
      })
    ).toEqual({ ok: false, code: 'POLICY_STALE' })
  })
})

describe('resolveSpeechBrokerPolicy', () => {
  it('maps only the exact Deepgram pair and requires equality with ready broker selection', () => {
    expect(resolve()).toEqual({
      ok: true,
      engine: 'deepgram-nova3',
      selected: { routeId: 'deepgram-via-gateway', modelId: 'nova-3', language: 'multi' },
      allowed: [{ routeId: 'deepgram-via-gateway', modelId: 'nova-3' }]
    })
  })

  it('maps the exact Cloudflare pair only when explicitly selected and policy-permitted', () => {
    const result = resolve({
      profile: { transport: 'broker-v1', engine: 'cloudflare-nova3' },
      snapshot: snapshot({ provider: 'cloudflare-nova3', model: '@cf/deepgram/nova-3', fallbacks: [] }),
      capability: capability('workers-ai-nova3', '@cf/deepgram/nova-3', ['en']),
      language: 'en'
    })
    expect(result).toMatchObject({
      ok: true,
      engine: 'cloudflare-nova3',
      selected: { routeId: 'workers-ai-nova3', modelId: '@cf/deepgram/nova-3', language: 'en' }
    })
  })

  it('includes an explicitly listed fallback pair without automatically selecting it', () => {
    const result = resolve({
      profile: { transport: 'broker-v1', engine: 'cloudflare-nova3' },
      snapshot: snapshot({
        provider: 'deepgram-nova3',
        model: 'nova-3',
        fallbacks: [{ provider: 'cloudflare-nova3', model: '@cf/deepgram/nova-3' }]
      }),
      capability: capability('workers-ai-nova3', '@cf/deepgram/nova-3', ['en']),
      language: 'en'
    })
    expect(result).toMatchObject({ ok: true, selected: { routeId: 'workers-ai-nova3' } })
  })

  it('rejects null policy, mismatched identity, and expired verified snapshots', () => {
    expect(resolve({ snapshot: null })).toEqual({ ok: false, code: 'POLICY_UNAVAILABLE' })
    expect(resolve({ currentIdentity: { ...identity, credentialDigest: 'b'.repeat(64) } })).toEqual({
      ok: false,
      code: 'POLICY_IDENTITY'
    })
    expect(
      resolve({
        snapshot: {
          ...snapshot({ provider: 'deepgram-nova3', model: 'nova-3', fallbacks: [] }),
          verifiedAt: now - 60_001
        }
      })
    ).toEqual({
      ok: false,
      code: 'POLICY_STALE'
    })
  })

  it('rejects unmanaged aliases and does not authorize by provider name alone', () => {
    for (const stt of [
      { provider: 'cloudflare', model: 'nova3', fallbacks: [] },
      { provider: 'deepgram-nova3', model: 'different-model', fallbacks: [] }
    ]) {
      expect(resolve({ snapshot: snapshot(stt) })).toEqual({ ok: false, code: 'STT_NOT_ALLOWED' })
    }
  })

  it('intersects explicit MDM provider restrictions and treats empty as deny-all', () => {
    expect(resolve({ managedProviders: { state: 'valid', providers: [] } })).toEqual({
      ok: false,
      code: 'PROVIDER_DENIED'
    })
    expect(resolve({ managedProviders: { state: 'invalid' } })).toEqual({
      ok: false,
      code: 'PROVIDER_POLICY_INVALID'
    })
    expect(resolve({ managedProviders: { state: 'valid', providers: ['soniox'] } })).toEqual({
      ok: false,
      code: 'PROVIDER_DENIED'
    })
  })

  it('refuses legacy, malformed, unconfigured, not-ready, mismatched, and unsupported-language states', () => {
    expect(resolve({ profile: { transport: 'legacy', engine: 'deepgram-nova3' } })).toEqual({
      ok: false,
      code: 'LEGACY_TRANSPORT'
    })
    expect(resolve({ profile: { transport: 'broker-v1', engine: 'unconfigured', extra: true } })).toEqual({
      ok: false,
      code: 'PROFILE_INVALID'
    })
    expect(resolve({ profile: { transport: 'broker-v1', engine: 'unconfigured' } })).toEqual({
      ok: false,
      code: 'ENGINE_UNCONFIGURED'
    })
    expect(resolve({ capability: { ...capability(), ready: false } as SpeechCapability })).toEqual({
      ok: false,
      code: 'CAPABILITY_UNREADY'
    })
    expect(resolve({ capability: capability('workers-ai-nova3', '@cf/deepgram/nova-3') })).toEqual({
      ok: false,
      code: 'CAPABILITY_SELECTION'
    })
    expect(resolve({ language: 'fr' })).toEqual({ ok: false, code: 'LANGUAGE_UNAVAILABLE' })
  })
})
