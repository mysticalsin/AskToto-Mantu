import { describe, expect, it } from 'vitest'
import {
  allowLocalSttFallback,
  normalizeCloudSttTokens,
  planCloudSttSession,
  CLOUD_STT_UNCONFIGURED,
  CLOUD_ONLY_LOCAL_FALLBACK_BLOCKED
} from './adapter'
import { resolveEnterpriseLiveProfile } from '../../shared/enterprise-live-profile'

describe('planCloudSttSession', () => {
  const cloudOnly = resolveEnterpriseLiveProfile({
    managed: true,
    inferenceMode: 'cloud-only',
    summaryOnly: true
  })

  it('blocks unconfigured cloud STT under CLOUD_ONLY with honest error', () => {
    const r = planCloudSttSession({ provider: 'unconfigured', profile: cloudOnly })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('UNCONFIGURED')
      expect(r.error).toBe(CLOUD_STT_UNCONFIGURED)
    }
  })

  it('accepts configured Nova-3 under CLOUD_ONLY', () => {
    const r = planCloudSttSession({ provider: 'cloudflare-nova3', profile: cloudOnly })
    expect(r).toEqual({ ok: true, provider: 'cloudflare-nova3', cloudOnly: true })
  })
})

describe('allowLocalSttFallback', () => {
  it('refuses local fallback when CLOUD_ONLY', () => {
    const r = allowLocalSttFallback(
      resolveEnterpriseLiveProfile({ managed: true, inferenceMode: 'cloud-only' })
    )
    expect(r).toEqual({ allowed: false, error: CLOUD_ONLY_LOCAL_FALLBACK_BLOCKED })
  })

  it('allows local fallback on legacy', () => {
    expect(allowLocalSttFallback(resolveEnterpriseLiveProfile({})).allowed).toBe(true)
  })
})

describe('normalizeCloudSttTokens', () => {
  it('groups consecutive same-cluster finals and keeps interim separate', () => {
    const out = normalizeCloudSttTokens([
      { text: 'Hel', startMs: 0, endMs: 100, isFinal: false },
      { text: 'Hello ', startMs: 0, endMs: 400, isFinal: true, cluster: '1', language: 'en' },
      { text: 'world', startMs: 400, endMs: 800, isFinal: true, cluster: '1', language: 'en' },
      { text: 'Hi', startMs: 900, endMs: 1100, isFinal: true, cluster: '2', language: 'en' }
    ])
    expect(out.interimText).toBe('Hel')
    expect(out.finals).toHaveLength(2)
    expect(out.finals[0]).toMatchObject({ text: 'Hello world', cluster: '1' })
    expect(out.finals[1]).toMatchObject({ text: 'Hi', cluster: '2' })
  })
})
