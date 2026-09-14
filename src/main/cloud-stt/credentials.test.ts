import { describe, expect, it } from 'vitest'
import {
  CLOUD_STT_CREDENTIALS_MISSING,
  parseCloudflareAccountId,
  resolveCloudSttCredentials,
  resolveCloudSttGatewayId,
  SONIOX_DEFAULT_WS_URL
} from './credentials'
import { CLOUD_STT_UNCONFIGURED } from './adapter'

describe('parseCloudflareAccountId', () => {
  it('extracts 32-hex account id from Workers AI base URL', () => {
    expect(
      parseCloudflareAccountId(
        'https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/v1'
      )
    ).toBe('0123456789abcdef0123456789abcdef')
  })
  it('returns null for Worker proxy URLs (no account path)', () => {
    expect(parseCloudflareAccountId('https://metis-ai.example.workers.dev/v1')).toBeNull()
  })
})

describe('resolveCloudSttCredentials', () => {
  it('honest UNCONFIGURED when provider unset', () => {
    const r = resolveCloudSttCredentials({ provider: 'unconfigured' })
    expect(r).toEqual({ ok: false, error: CLOUD_STT_UNCONFIGURED, code: 'UNCONFIGURED' })
  })

  it('honest CREDENTIALS when Nova pieces missing', () => {
    const r = resolveCloudSttCredentials({
      provider: 'cloudflare-nova3',
      cloudflareToken: 'tok',
      cloudflareBaseUrl: 'https://metis-ai.example.workers.dev/v1',
      gatewayId: 'gw'
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('CREDENTIALS')
      expect(r.error).toBe(CLOUD_STT_CREDENTIALS_MISSING)
    }
  })

  it('resolves Nova when token + account URL + gateway present', () => {
    const r = resolveCloudSttCredentials({
      provider: 'cloudflare-nova3',
      cloudflareToken: 'cf-token',
      cloudflareBaseUrl:
        'https://api.cloudflare.com/client/v4/accounts/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/ai/v1',
      gatewayId: 'metis-gw'
    })
    expect(r).toEqual({
      ok: true,
      provider: 'cloudflare-nova3',
      token: 'cf-token',
      accountId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      gatewayId: 'metis-gw'
    })
  })

  it('resolves Soniox when API key present', () => {
    const r = resolveCloudSttCredentials({ provider: 'soniox', sonioxApiKey: 'sx-key' })
    expect(r).toEqual({
      ok: true,
      provider: 'soniox',
      apiKey: 'sx-key',
      wsUrl: SONIOX_DEFAULT_WS_URL
    })
  })

  it('reads gateway id from env helper', () => {
    expect(resolveCloudSttGatewayId({ CF_AI_GATEWAY_ID: ' from-cf ' } as NodeJS.ProcessEnv)).toBe(
      'from-cf'
    )
    expect(
      resolveCloudSttGatewayId({ METIS_CF_AI_GATEWAY_ID: 'from-metis' } as NodeJS.ProcessEnv)
    ).toBe('from-metis')
  })
})
