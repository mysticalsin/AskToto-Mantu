import { describe, expect, it } from 'vitest'
import {
  CLOUD_STT_CREDENTIALS_MISSING,
  DEFAULT_CLOUD_STT_GATEWAY_ID,
  parseCloudflareAccountId,
  resolveCloudflareAccountId,
  resolveCloudSttCredentials,
  resolveCloudSttGatewayId,
  resolveSonioxApiKey,
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

describe('resolveCloudflareAccountId', () => {
  it('prefers account id from account-scoped base URL', () => {
    expect(
      resolveCloudflareAccountId({
        cloudflareBaseUrl:
          'https://api.cloudflare.com/client/v4/accounts/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/ai/v1',
        cloudflareAccountId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
      })
    ).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
  })
  it('uses seated accountId when base URL is Worker proxy (no /accounts/ path)', () => {
    expect(
      resolveCloudflareAccountId({
        cloudflareBaseUrl: 'https://metis-ai.example.workers.dev/v1',
        cloudflareAccountId: 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC'
      })
    ).toBe('cccccccccccccccccccccccccccccccc')
  })
  it('rejects non-32-hex account ids', () => {
    expect(
      resolveCloudflareAccountId({
        cloudflareBaseUrl: 'https://metis-ai.example.workers.dev/v1',
        cloudflareAccountId: 'not-an-account'
      })
    ).toBeNull()
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

  it("defaults gateway to 'default' when token+account present and gateway blank", () => {
    const r = resolveCloudSttCredentials({
      provider: 'cloudflare-nova3',
      cloudflareToken: 'cf-token',
      cloudflareBaseUrl:
        'https://api.cloudflare.com/client/v4/accounts/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/ai/v1',
      gatewayId: null
    })
    expect(r).toEqual({
      ok: true,
      provider: 'cloudflare-nova3',
      token: 'cf-token',
      accountId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      gatewayId: DEFAULT_CLOUD_STT_GATEWAY_ID
    })
  })

  it('resolves Nova with seated accountId when base URL is not account-scoped', () => {
    const r = resolveCloudSttCredentials({
      provider: 'cloudflare-nova3',
      cloudflareToken: 'cf-token',
      cloudflareBaseUrl: 'https://metis-cloudflare-proxy.example.workers.dev/v1',
      cloudflareAccountId: 'dddddddddddddddddddddddddddddddd',
      gatewayId: ''
    })
    expect(r).toEqual({
      ok: true,
      provider: 'cloudflare-nova3',
      token: 'cf-token',
      accountId: 'dddddddddddddddddddddddddddddddd',
      gatewayId: DEFAULT_CLOUD_STT_GATEWAY_ID
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

  it('reads gateway id: settings, then env, then default', () => {
    expect(resolveCloudSttGatewayId(' from-settings ')).toBe('from-settings')
    expect(resolveCloudSttGatewayId('', { CF_AI_GATEWAY_ID: ' from-cf ' } as NodeJS.ProcessEnv)).toBe(
      'from-cf'
    )
    expect(
      resolveCloudSttGatewayId(null, { METIS_CF_AI_GATEWAY_ID: 'from-metis' } as NodeJS.ProcessEnv)
    ).toBe('from-metis')
    expect(resolveCloudSttGatewayId('', {} as NodeJS.ProcessEnv)).toBe(DEFAULT_CLOUD_STT_GATEWAY_ID)
    expect(resolveCloudSttGatewayId()).toBe(DEFAULT_CLOUD_STT_GATEWAY_ID)
  })

  it('prefers seated Soniox key over env', () => {
    expect(resolveSonioxApiKey(' seated ', { SONIOX_API_KEY: 'env-key' } as NodeJS.ProcessEnv)).toBe(
      'seated'
    )
    expect(resolveSonioxApiKey('', { SONIOX_API_KEY: 'env-key' } as NodeJS.ProcessEnv)).toBe('env-key')
    expect(resolveSonioxApiKey(null, {} as NodeJS.ProcessEnv)).toBeNull()
  })

  it('CREDENTIALS copy points to in-app Keys and treats Soniox as optional', () => {
    expect(CLOUD_STT_CREDENTIALS_MISSING).toMatch(/Settings/)
    expect(CLOUD_STT_CREDENTIALS_MISSING).toMatch(/optional/i)
    expect(CLOUD_STT_CREDENTIALS_MISSING).not.toMatch(/—/)
  })
})
