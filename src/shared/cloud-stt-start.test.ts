import { describe, expect, it } from 'vitest'
import { cloudSttStartAcknowledgement, resolveCloudSttStartProvider } from './cloud-stt-start'

describe('cloud speech start acknowledgement', () => {
  it('resolves the existing managed profile without enabling an unmanaged unconfigured session', () => {
    expect(resolveCloudSttStartProvider(null, { managed: true, inferenceMode: 'cloud-only' }, 'unconfigured')).toBe('cloudflare-nova3')
    expect(resolveCloudSttStartProvider(null, {}, 'unconfigured')).toBe('unconfigured')
    expect(resolveCloudSttStartProvider(null, {}, 'soniox')).toBe('soniox')
  })
  it('reports only the provider actually selected by main', () => {
    expect(cloudSttStartAcknowledgement({ ok: true }, 'soniox')).toEqual({ ok: true, provider: 'soniox' })
    expect(cloudSttStartAcknowledgement({ ok: true }, 'cloudflare-nova3')).toEqual({
      ok: true,
      provider: 'cloudflare-nova3'
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
