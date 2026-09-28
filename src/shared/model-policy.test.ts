import { describe, expect, it } from 'vitest'
import {
  canonicalModelPolicyPayload,
  emptyModelPolicyEntry,
  isModelPolicyCapability,
  MODEL_POLICY_CAPABILITIES,
  ModelPolicyDocumentSchema,
  narrowAllowedProvidersForCapability,
  pinManagedModel,
  resolveModelPolicyCandidates,
  resolveModelPolicyChoice,
  SignedModelPolicySchema,
  type ModelPolicyDocument
} from './model-policy'

function policyWith(overrides: Partial<ModelPolicyDocument['capabilities']> = {}, updatedAt = 1000): ModelPolicyDocument {
  const base = Object.fromEntries(
    MODEL_POLICY_CAPABILITIES.map((k) => [k, emptyModelPolicyEntry('anthropic', 'claude-sonnet-4-6')])
  ) as ModelPolicyDocument['capabilities']
  return {
    version: updatedAt,
    updatedAt,
    updatedBy: 'owner@example.com',
    capabilities: { ...base, ...overrides }
  }
}

describe('ModelPolicyDocumentSchema', () => {
  it('accepts a fully specified document', () => {
    const doc = policyWith({
      askChat: { provider: 'anthropic', model: 'claude-sonnet-4-6', fallbacks: [{ provider: 'openai', model: 'gpt-5' }] }
    })
    expect(ModelPolicyDocumentSchema.safeParse(doc).success).toBe(true)
  })

  it('rejects a document missing a capability', () => {
    const doc = policyWith()
    const { localModel: _drop, ...rest } = doc.capabilities
    void _drop
    expect(ModelPolicyDocumentSchema.safeParse({ ...doc, capabilities: rest }).success).toBe(false)
  })

  it('rejects an entry with an empty provider or model', () => {
    const doc = policyWith({ askChat: { provider: '', model: 'x', fallbacks: [] } })
    expect(ModelPolicyDocumentSchema.safeParse(doc).success).toBe(false)
  })

  it('caps fallbacks at 8', () => {
    const fallbacks = Array.from({ length: 9 }, (_, i) => ({ provider: 'openai', model: `m${i}` }))
    const doc = policyWith({ askChat: { provider: 'anthropic', model: 'x', fallbacks } })
    expect(ModelPolicyDocumentSchema.safeParse(doc).success).toBe(false)
  })

  it('SignedModelPolicySchema requires a real-looking signature', () => {
    const doc = policyWith()
    expect(SignedModelPolicySchema.safeParse({ policy: doc, signature: 'short' }).success).toBe(false)
    expect(SignedModelPolicySchema.safeParse({ policy: doc, signature: 'a'.repeat(64) }).success).toBe(true)
  })
})

describe('isModelPolicyCapability', () => {
  it('accepts every declared capability and rejects anything else', () => {
    for (const c of MODEL_POLICY_CAPABILITIES) expect(isModelPolicyCapability(c)).toBe(true)
    expect(isModelPolicyCapability('askchat')).toBe(false)
    expect(isModelPolicyCapability(42)).toBe(false)
  })
})

describe('canonicalModelPolicyPayload', () => {
  it('is stable for the same document constructed via a different key order', () => {
    const a = policyWith({ askChat: { provider: 'anthropic', model: 'claude-sonnet-4-6', fallbacks: [] } })
    const bCapabilities = { ...a.capabilities }
    const b: ModelPolicyDocument = { updatedBy: a.updatedBy, version: a.version, updatedAt: a.updatedAt, capabilities: bCapabilities }
    expect(canonicalModelPolicyPayload(a)).toBe(canonicalModelPolicyPayload(b))
  })

  it('changes when any field changes', () => {
    const a = policyWith()
    const b = policyWith({ askChat: { provider: 'openai', model: 'gpt-5', fallbacks: [] } })
    expect(canonicalModelPolicyPayload(a)).not.toBe(canonicalModelPolicyPayload(b))
    const c = policyWith(undefined, 2000)
    expect(canonicalModelPolicyPayload(a)).not.toBe(canonicalModelPolicyPayload(c))
  })

  it('matches the exact wire format native-app/MetisKit/Sources/MetisKit/ModelPolicy.swift must reproduce byte-for-byte', () => {
    const doc = policyWith()
    expect(canonicalModelPolicyPayload(doc)).toBe(
      'metis-model-policy.v1.1000.1000.owner@example.com.' +
        'askChat=anthropic:claude-sonnet-4-6[]|' +
        'commandAgent=anthropic:claude-sonnet-4-6[]|' +
        'recap=anthropic:claude-sonnet-4-6[]|' +
        'stt=anthropic:claude-sonnet-4-6[]|' +
        'tts=anthropic:claude-sonnet-4-6[]|' +
        'embeddings=anthropic:claude-sonnet-4-6[]|' +
        'localModel=anthropic:claude-sonnet-4-6[]'
    )
  })

  it('changes when a fallback list changes', () => {
    const a = policyWith({ askChat: { provider: 'anthropic', model: 'x', fallbacks: [{ provider: 'openai', model: 'gpt-5' }] } })
    const b = policyWith({ askChat: { provider: 'anthropic', model: 'x', fallbacks: [] } })
    expect(canonicalModelPolicyPayload(a)).not.toBe(canonicalModelPolicyPayload(b))
  })
})

describe('resolveModelPolicyCandidates / resolveModelPolicyChoice', () => {
  const doc = policyWith({
    askChat: {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      fallbacks: [{ provider: 'openai', model: 'gpt-5' }, { provider: 'cloudflare', model: '@cf/x' }]
    }
  })

  it('returns the primary first when unrestricted', () => {
    expect(resolveModelPolicyChoice(doc, 'askChat', null)).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      source: 'policy'
    })
  })

  it('falls through to the first allowed fallback when the primary is narrowed out', () => {
    expect(resolveModelPolicyChoice(doc, 'askChat', ['openai', 'cloudflare'])).toEqual({
      provider: 'openai',
      model: 'gpt-5',
      source: 'policy-fallback'
    })
  })

  it('returns null (blocked) when every candidate is narrowed out', () => {
    expect(resolveModelPolicyChoice(doc, 'askChat', ['dust'])).toBeNull()
    expect(resolveModelPolicyCandidates(doc, 'askChat', ['dust'])).toEqual([])
  })

  it('a capability with no fallbacks resolves to just the primary', () => {
    expect(resolveModelPolicyChoice(doc, 'recap', null)?.provider).toBe('anthropic')
  })
})

describe('narrowAllowedProvidersForCapability', () => {
  const doc = policyWith({
    askChat: { provider: 'anthropic', model: 'x', fallbacks: [{ provider: 'openai', model: 'y' }] }
  })

  it('returns the input unchanged when there is no policy', () => {
    expect(narrowAllowedProvidersForCapability(['anthropic', 'openai'], null, 'askChat')).toEqual(['anthropic', 'openai'])
    expect(narrowAllowedProvidersForCapability(null, null, 'askChat')).toBeNull()
  })

  it('with a policy and no prior allowlist, returns exactly the policy set plus alwaysAllow', () => {
    const result = narrowAllowedProvidersForCapability(null, doc, 'askChat', ['claude-cli', 'local'])
    expect(new Set(result)).toEqual(new Set(['anthropic', 'openai', 'claude-cli', 'local']))
  })

  it('intersects an existing allowlist with the policy set', () => {
    const result = narrowAllowedProvidersForCapability(['anthropic', 'openai', 'dust'], doc, 'askChat')
    expect(new Set(result)).toEqual(new Set(['anthropic', 'openai']))
  })

  it('never drops alwaysAllow entries even when the policy never names them', () => {
    const result = narrowAllowedProvidersForCapability(['anthropic', 'claude-cli', 'local'], doc, 'askChat', ['claude-cli', 'local'])
    expect(new Set(result)).toEqual(new Set(['anthropic', 'claude-cli', 'local']))
  })

  it('can narrow an allowlist down to empty when the policy and the allowlist disagree entirely', () => {
    expect(narrowAllowedProvidersForCapability(['dust'], doc, 'askChat')).toEqual([])
  })
})

describe('pinManagedModel', () => {
  const doc = policyWith({
    askChat: {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      fallbacks: [{ provider: 'openai', model: 'gpt-5' }]
    }
  })

  it('returns the current model unchanged when there is no policy', () => {
    expect(pinManagedModel(null, 'askChat', 'anthropic', 'whatever')).toBe('whatever')
  })

  it('pins the primary provider to the policy model', () => {
    expect(pinManagedModel(doc, 'askChat', 'anthropic', 'claude-haiku-4-5-20251001')).toBe('claude-sonnet-4-6')
  })

  it('pins a fallback provider to its own policy model', () => {
    expect(pinManagedModel(doc, 'askChat', 'openai', 'gpt-4o')).toBe('gpt-5')
  })

  it('leaves an ungoverned provider unchanged', () => {
    expect(pinManagedModel(doc, 'askChat', 'claude-cli', 'whatever-the-cli-uses')).toBe('whatever-the-cli-uses')
  })
})
