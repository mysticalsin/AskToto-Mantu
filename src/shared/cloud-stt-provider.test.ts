import { describe, expect, it } from 'vitest'
import { resolveEnterpriseLiveProfile } from './enterprise-live-profile'
import {
  DEFAULT_CLOUD_ONLY_STT_PROVIDER,
  effectiveCloudSttProvider,
  resolveCloudSttProvider,
  shouldUseCloudSttEngine
} from './cloud-stt-provider'

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
