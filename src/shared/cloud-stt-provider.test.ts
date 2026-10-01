import { describe, expect, it } from 'vitest'
import { resolveEnterpriseLiveProfile } from './enterprise-live-profile'
import {
  DEFAULT_CLOUD_ONLY_STT_PROVIDER,
  effectiveCloudSttProvider,
  enforceSttPolicy,
  resolveCloudSttProvider,
  shouldUseCloudSttEngine
} from './cloud-stt-provider'
import type { ModelPolicyDocument } from './model-policy'

describe('resolveCloudSttProvider', () => {
  it('accepts approved ids only', () => {
    expect(resolveCloudSttProvider('cloudflare-nova3')).toBe('cloudflare-nova3')
    expect(resolveCloudSttProvider('soniox')).toBe('soniox')
    expect(resolveCloudSttProvider('whisper')).toBe('unconfigured')
    expect(resolveCloudSttProvider(undefined)).toBe('unconfigured')
  })
})

describe('effectiveCloudSttProvider', () => {
  const cloud = resolveEnterpriseLiveProfile({
    managed: true,
    inferenceMode: 'cloud-only',
    summaryOnly: true
  })
  const legacy = resolveEnterpriseLiveProfile({})

  it('defaults CLOUD_ONLY unconfigured to Nova-3', () => {
    expect(effectiveCloudSttProvider(cloud, 'unconfigured')).toBe(DEFAULT_CLOUD_ONLY_STT_PROVIDER)
    expect(effectiveCloudSttProvider(cloud, undefined)).toBe('cloudflare-nova3')
  })

  it('keeps explicit Soniox under CLOUD_ONLY', () => {
    expect(effectiveCloudSttProvider(cloud, 'soniox')).toBe('soniox')
  })

  it('does not invent a cloud default for legacy profiles', () => {
    expect(effectiveCloudSttProvider(legacy, 'unconfigured')).toBe('unconfigured')
  })
})

describe('enforceSttPolicy (M2-0412)', () => {
  const entry = (provider: string, fallbacks: { provider: string; model: string }[] = []) => ({
    provider,
    model: 'm',
    fallbacks
  })
  const policyWithStt = (stt: ReturnType<typeof entry>): ModelPolicyDocument => ({
    version: 1,
    updatedAt: 1,
    updatedBy: 'owner@example.test',
    capabilities: {
      askChat: entry('anthropic'),
      commandAgent: entry('anthropic'),
      recap: entry('anthropic'),
      stt,
      tts: entry('anthropic'),
      embeddings: entry('anthropic'),
      localModel: entry('local')
    }
  })

  it('leaves the choice alone when there is no policy', () => {
    expect(enforceSttPolicy(null, 'soniox')).toBe('soniox')
  })

  it('a policy pinning nova3 turns a user setting of soniox into nova3', () => {
    expect(enforceSttPolicy(policyWithStt(entry('cloudflare-nova3')), 'soniox')).toBe('cloudflare-nova3')
  })

  it('keeps a user choice the policy permits as primary or fallback', () => {
    const policy = policyWithStt(entry('cloudflare-nova3', [{ provider: 'soniox', model: 'm' }]))
    expect(enforceSttPolicy(policy, 'soniox')).toBe('soniox')
    expect(enforceSttPolicy(policy, 'cloudflare-nova3')).toBe('cloudflare-nova3')
  })

  it('refuses (unconfigured) when the policy names a provider this app cannot start', () => {
    expect(enforceSttPolicy(policyWithStt(entry('some-other-stt')), 'soniox')).toBe('unconfigured')
  })

  it('never turns cloud speech on by itself', () => {
    expect(enforceSttPolicy(policyWithStt(entry('cloudflare-nova3')), 'unconfigured')).toBe('unconfigured')
  })
})

describe('shouldUseCloudSttEngine', () => {
  it('is true only for managed cloud-only', () => {
    expect(
      shouldUseCloudSttEngine(
        { managed: true, inferenceMode: 'cloud-only', summaryOnly: false },
        'unconfigured'
      )
    ).toBe(true)
    expect(shouldUseCloudSttEngine({}, 'cloudflare-nova3')).toBe(false)
  })
})
