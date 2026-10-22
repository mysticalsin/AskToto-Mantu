import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { readModuleSource } from '../test-helpers/module-source'
import { BrokerSpeechSettingsSchema } from './broker-speech-settings'
import { CloudSpeechEngineSchema, CloudSpeechStartResultSchema } from './cloud-speech'
import { CLOUD_STT_PROVIDERS, directTokenBlockedForManagedProfile, legacyDirectTokenGated } from './cloud-stt-provider'
import { SpeechEngineIdSchema } from './contracts/capability'
import {
  BROKERED_STT_PROVIDER_IDS,
  DIRECT_STT_PROVIDER_IDS,
  STT_CLOUD_PROVIDER_IDS,
  SttResolvedIdentitySchema,
  sttResolvedIdentity
} from './contracts/stt-provider'

const here = dirname(fileURLToPath(import.meta.url))

describe('one STT provider enum', () => {
  it('derives every provider list from the single canonical list', () => {
    expect([...STT_CLOUD_PROVIDER_IDS]).toEqual(['deepgram-nova3', 'cloudflare-nova3', 'soniox'])
    for (const id of BROKERED_STT_PROVIDER_IDS) expect(STT_CLOUD_PROVIDER_IDS).toContain(id)
    for (const id of DIRECT_STT_PROVIDER_IDS) expect(STT_CLOUD_PROVIDER_IDS).toContain(id)
    expect([...CloudSpeechEngineSchema.options]).toEqual([...BROKERED_STT_PROVIDER_IDS])
    expect([...CLOUD_STT_PROVIDERS]).toEqual([...DIRECT_STT_PROVIDER_IDS, 'unconfigured'])
    expect(BrokerSpeechSettingsSchema.shape.engine.options).toEqual(['unconfigured', ...BROKERED_STT_PROVIDER_IDS])
    expect(SpeechEngineIdSchema.options.slice(0, STT_CLOUD_PROVIDER_IDS.length)).toEqual([...STT_CLOUD_PROVIDER_IDS])
  })

  it('keeps the persisted and wire values unchanged', () => {
    expect([...CloudSpeechEngineSchema.options]).toEqual(['deepgram-nova3', 'cloudflare-nova3'])
    expect([...CLOUD_STT_PROVIDERS]).toEqual(['cloudflare-nova3', 'soniox', 'unconfigured'])
    expect([...SpeechEngineIdSchema.options]).toEqual([
      'deepgram-nova3',
      'cloudflare-nova3',
      'soniox',
      'parakeet',
      'whisper',
      'apple'
    ])
  })

  it.each([
    './broker-speech-settings',
    './cloud-speech',
    './cloud-stt-provider',
    './contracts/capability'
  ])('redeclares no provider-id enum in %s', (specifier) => {
    const { text } = readModuleSource(here, specifier)
    expect(text).not.toMatch(/z\s*\.enum\(\s*\[[^\]]*'(?:deepgram-nova3|cloudflare-nova3|soniox)'/)
    expect(text).not.toMatch(/\[\s*'(?:cloudflare-nova3|deepgram-nova3)'\s*,\s*'(?:soniox|cloudflare-nova3)'/)
  })
})

describe('resolvedIdentity', () => {
  it('names provider, account, transport and model for a brokered route', () => {
    const identity = sttResolvedIdentity({
      provider: 'cloudflare-nova3',
      transport: 'broker-v1',
      account: 'operator-seat:0123456789ab'
    })
    expect(identity).toEqual({
      provider: 'cloudflare-nova3',
      transport: 'broker-v1',
      account: 'operator-seat:0123456789ab',
      model: '@cf/deepgram/nova-3'
    })
    expect(SttResolvedIdentitySchema.safeParse(identity).success).toBe(true)
  })

  it('keeps the two Nova-3 routes distinct and names no guessed Soniox model', () => {
    expect(sttResolvedIdentity({ provider: 'deepgram-nova3', transport: 'broker-v1', account: null }).model).toBe(
      'nova-3'
    )
    expect(sttResolvedIdentity({ provider: 'soniox', transport: 'direct-token', account: null }).model).toBeNull()
  })

  it('rejects unknown keys and an unknown transport', () => {
    expect(
      SttResolvedIdentitySchema.safeParse({
        provider: 'soniox',
        transport: 'direct-token',
        account: null,
        model: null,
        token: 'x'
      }).success
    ).toBe(false)
    expect(
      SttResolvedIdentitySchema.safeParse({ provider: 'soniox', transport: 'legacy', account: null, model: null })
        .success
    ).toBe(false)
  })

  it('is optional on the brokered start result and validated when present', () => {
    const base = {
      ok: true,
      captureId: '11111111-1111-4111-8111-111111111111',
      captureGeneration: 1,
      engine: 'cloudflare-nova3',
      streams: [{ track: 'microphone', streamEpoch: 1 }],
      limits: { frameBytes: 3200, maxPendingFrames: 20, maxPendingBytes: 65536, maxPendingAudioMs: 2000 }
    }
    expect(CloudSpeechStartResultSchema.safeParse(base).success).toBe(true)
    const identity = sttResolvedIdentity({ provider: 'cloudflare-nova3', transport: 'broker-v1', account: null })
    expect(CloudSpeechStartResultSchema.safeParse({ ...base, resolvedIdentity: identity }).success).toBe(true)
    expect(
      CloudSpeechStartResultSchema.safeParse({ ...base, resolvedIdentity: { ...identity, transport: 'x' } }).success
    ).toBe(false)
  })
})

describe('legacy direct-token gate', () => {
  it('blocks the direct Cloudflare token on a managed profile only', () => {
    expect(directTokenBlockedForManagedProfile('cloudflare-nova3', true)).toBe(true)
    expect(directTokenBlockedForManagedProfile('cloudflare-nova3', false)).toBe(false)
  })

  it('does not gate the provider key seat or an unconfigured provider (ASSUMED: Soniox has no brokered route)', () => {
    expect(directTokenBlockedForManagedProfile('soniox', true)).toBe(false)
    expect(directTokenBlockedForManagedProfile('unconfigured', true)).toBe(false)
  })
})

describe('when the legacy direct token is gated', () => {
  const managed = { managed: true, inferenceMode: 'cloud-only' as const }

  it('stays open for a managed profile on the legacy transport, so Listen keeps working until the licensed route is selected', () => {
    expect(legacyDirectTokenGated({ enterpriseLive: managed, brokerSpeech: { transport: 'legacy' } })).toBe(false)
    expect(legacyDirectTokenGated({ enterpriseLive: managed })).toBe(false)
  })

  it('closes for a managed profile once the licensed broker transport is selected', () => {
    expect(legacyDirectTokenGated({ enterpriseLive: managed, brokerSpeech: { transport: 'broker-v1' } })).toBe(true)
  })

  it('never gates an unmanaged profile or an invalid broker profile', () => {
    expect(legacyDirectTokenGated({ enterpriseLive: {}, brokerSpeech: { transport: 'broker-v1' } })).toBe(false)
    expect(legacyDirectTokenGated({ enterpriseLive: managed, brokerSpeech: { transport: 'refused' } })).toBe(false)
  })
})
