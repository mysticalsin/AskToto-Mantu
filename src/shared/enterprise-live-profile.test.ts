import { describe, expect, it } from 'vitest'
import {
  assertCloudOnlyAllowsEngine,
  CLOUD_ONLY_LOCAL_FALLBACK_BLOCKED,
  isCloudOnlyProfile,
  isSummaryOnlyProfile,
  resolveEnterpriseLiveProfile
} from './enterprise-live-profile'

describe('resolveEnterpriseLiveProfile', () => {
  it('defaults to legacy unmanaged', () => {
    expect(resolveEnterpriseLiveProfile(undefined)).toEqual({
      managed: false,
      inferenceMode: 'legacy',
      summaryOnly: false
    })
  })

  it('reads nested enterpriseLive', () => {
    const p = resolveEnterpriseLiveProfile({
      enterpriseLive: { managed: true, inferenceMode: 'cloud-only', summaryOnly: true }
    })
    expect(isCloudOnlyProfile(p)).toBe(true)
    expect(isSummaryOnlyProfile(p)).toBe(true)
  })

  it('reads flat managed-config keys', () => {
    const p = resolveEnterpriseLiveProfile({
      managed: true,
      inferenceMode: 'cloud-only',
      summaryOnly: true
    })
    expect(p.managed).toBe(true)
    expect(p.inferenceMode).toBe('cloud-only')
  })
})

describe('CLOUD_ONLY local fallback', () => {
  const cloud = resolveEnterpriseLiveProfile({
    managed: true,
    inferenceMode: 'cloud-only',
    summaryOnly: false
  })

  it('blocks whisper/parakeet/apple', () => {
    for (const engine of ['whisper', 'parakeet', 'apple'] as const) {
      const r = assertCloudOnlyAllowsEngine(cloud, engine)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toBe(CLOUD_ONLY_LOCAL_FALLBACK_BLOCKED)
    }
  })

  it('allows cloud adapter id', () => {
    expect(assertCloudOnlyAllowsEngine(cloud, 'cloud').ok).toBe(true)
  })

  it('does not block legacy unmanaged profiles', () => {
    const legacy = resolveEnterpriseLiveProfile({})
    expect(assertCloudOnlyAllowsEngine(legacy, 'parakeet').ok).toBe(true)
  })
})
