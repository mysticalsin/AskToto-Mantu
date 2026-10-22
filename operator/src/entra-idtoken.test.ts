import { createSign, generateKeyPairSync, createHmac, type KeyObject } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ENTRA_MAX_IAT_AGE_SEC,
  entraIssuer,
  entraJwksUrl,
  ssoConfigFromEnv,
  verifyEntraIdToken,
  type SsoConfig
} from './entra-idtoken'
import { createJwksCache, type JwksFetch } from './jwt-rs256'

const TENANT = '11111111-2222-4333-8444-555555555555'
const CLIENT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const OID = '99999999-8888-4777-8666-555555555555'
const NOW = 1_800_000_000_000
const NOW_SEC = NOW / 1000

const cfg: SsoConfig = { tenantId: TENANT, clientIds: [CLIENT], domains: ['example.test'] }

const keyA = generateKeyPairSync('rsa', { modulusLength: 2048 })
const keyB = generateKeyPairSync('rsa', { modulusLength: 2048 })

function jwkOf(pair: { publicKey: KeyObject }, kid: string): Record<string, unknown> {
  return { ...(pair.publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid, alg: 'RS256', use: 'sig' }
}

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')

function goodClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: entraIssuer(TENANT),
    aud: CLIENT,
    tid: TENANT,
    oid: OID,
    sub: 'subject-1',
    preferred_username: 'Sam.Lee@Example.test',
    uti: 'uti-0001',
    iat: NOW_SEC - 30,
    nbf: NOW_SEC - 30,
    exp: NOW_SEC + 3000,
    ...overrides
  }
}

function sign(claims: Record<string, unknown>, opts: { kid?: string; alg?: string; key?: KeyObject } = {}): string {
  const head = b64({ alg: opts.alg ?? 'RS256', typ: 'JWT', kid: opts.kid ?? 'k1' })
  const body = b64(claims)
  const signer = createSign('RSA-SHA256')
  signer.update(`${head}.${body}`)
  return `${head}.${body}.${signer.sign(opts.key ?? keyA.privateKey).toString('base64url')}`
}

function stubFetch(keys: Array<Record<string, unknown>>): { fetchImpl: JwksFetch; calls: string[] } {
  const calls: string[] = []
  const fetchImpl: JwksFetch = async (url) => {
    calls.push(url)
    return Response.json({ keys })
  }
  return { fetchImpl, calls }
}

const freshCache = () => createJwksCache({ ttlMs: 60 * 60 * 1000, forcedRefetchMinMs: 5 * 60 * 1000 })

describe('ssoConfigFromEnv', () => {
  it('parses the three Worker secrets and lowercases them', () => {
    expect(
      ssoConfigFromEnv({
        ENROLL_SSO_TENANT_ID: TENANT.toUpperCase(),
        ENROLL_SSO_CLIENT_IDS: ` ${CLIENT} , ${CLIENT.toUpperCase()}`,
        ENROLL_SSO_ALLOWED_DOMAINS: '@Example.test, other.test'
      })
    ).toEqual({ tenantId: TENANT, clientIds: [CLIENT], domains: ['example.test', 'other.test'] })
  })

  it('is null when any secret is missing or malformed, never a permissive default', () => {
    const base = {
      ENROLL_SSO_TENANT_ID: TENANT,
      ENROLL_SSO_CLIENT_IDS: CLIENT,
      ENROLL_SSO_ALLOWED_DOMAINS: 'example.test'
    }
    expect(ssoConfigFromEnv(base)).not.toBeNull()
    expect(ssoConfigFromEnv({ ...base, ENROLL_SSO_TENANT_ID: undefined })).toBeNull()
    expect(ssoConfigFromEnv({ ...base, ENROLL_SSO_TENANT_ID: 'common' })).toBeNull()
    expect(ssoConfigFromEnv({ ...base, ENROLL_SSO_CLIENT_IDS: '' })).toBeNull()
    expect(ssoConfigFromEnv({ ...base, ENROLL_SSO_CLIENT_IDS: 'not-a-guid' })).toBeNull()
    expect(ssoConfigFromEnv({ ...base, ENROLL_SSO_ALLOWED_DOMAINS: '' })).toBeNull()
    expect(ssoConfigFromEnv({ ...base, ENROLL_SSO_ALLOWED_DOMAINS: 'bad domain' })).toBeNull()
    expect(ssoConfigFromEnv({ ...base, ENROLL_SSO_ALLOWED_DOMAINS: '*' })).toBeNull()
  })
})

describe('verifyEntraIdToken', () => {
  let cache: ReturnType<typeof freshCache>
  let jwks: ReturnType<typeof stubFetch>
  beforeEach(() => {
    cache = freshCache()
    jwks = stubFetch([jwkOf(keyA, 'k1')])
  })
  const verify = (token: string, now = NOW) => verifyEntraIdToken(token, cfg, { now, fetchImpl: jwks.fetchImpl, cache })

  it('accepts a valid token and returns the verified identity and a single-use key', async () => {
    const result = await verify(sign(goodClaims()))
    expect(result).toEqual({
      ok: true,
      oid: OID,
      email: 'sam.lee@example.test',
      tid: TENANT,
      aud: CLIENT,
      replayKey: 'uti-0001'
    })
    expect(jwks.calls).toEqual([entraJwksUrl(TENANT)])
  })

  it('falls back to jti, then to a hash of the token, for the single-use key', async () => {
    const withJti = await verify(sign(goodClaims({ uti: undefined, jti: 'jti-7' })))
    expect(withJti).toMatchObject({ ok: true, replayKey: 'jti-7' })
    const token = sign(goodClaims({ uti: undefined }))
    const hashed = await verify(token)
    expect(hashed.ok && hashed.replayKey).toMatch(/^[0-9a-f]{64}$/)
    expect(hashed.ok && hashed.replayKey).not.toContain(token.slice(0, 20))
  })

  it('uses email when preferred_username is absent', async () => {
    expect(await verify(sign(goodClaims({ preferred_username: undefined, email: 'a@example.test' })))).toMatchObject({
      ok: true,
      email: 'a@example.test'
    })
  })

  it('refuses a token signed by a key that is not in the tenant JWKS', async () => {
    expect(await verify(sign(goodClaims(), { key: keyB.privateKey }))).toEqual({ ok: false, code: 'sso-invalid' })
  })

  it('refuses a tampered payload', async () => {
    const [h, , s] = sign(goodClaims()).split('.')
    expect(await verify(`${h}.${b64(goodClaims({ oid: '00000000-0000-4000-8000-000000000000' }))}.${s}`)).toEqual({
      ok: false,
      code: 'sso-invalid'
    })
  })

  it('refuses alg none, HS256 (key confusion with the public JWK) and any non-RS256 alg', async () => {
    const body = b64(goodClaims())
    const none = `${b64({ alg: 'none', kid: 'k1' })}.${body}.`
    expect(await verify(none)).toEqual({ ok: false, code: 'sso-invalid' })
    const hsHead = b64({ alg: 'HS256', kid: 'k1' })
    const hsSig = createHmac('sha256', JSON.stringify(jwkOf(keyA, 'k1')))
      .update(`${hsHead}.${body}`)
      .digest('base64url')
    expect(await verify(`${hsHead}.${body}.${hsSig}`)).toEqual({ ok: false, code: 'sso-invalid' })
    expect(await verify(sign(goodClaims(), { alg: 'RS512' }))).toEqual({ ok: false, code: 'sso-invalid' })
    expect(await verify(sign(goodClaims(), { alg: 'rs256' }))).toEqual({ ok: false, code: 'sso-invalid' })
  })

  it('refuses a wrong issuer, audience or tenant', async () => {
    expect(await verify(sign(goodClaims({ iss: 'https://login.microsoftonline.com/other/v2.0' })))).toEqual({
      ok: false,
      code: 'sso-invalid'
    })
    expect(await verify(sign(goodClaims({ iss: `https://login.microsoftonline.com/${TENANT}/` })))).toEqual({
      ok: false,
      code: 'sso-invalid'
    })
    expect(await verify(sign(goodClaims({ aud: '00000000-0000-4000-8000-000000000001' })))).toEqual({
      ok: false,
      code: 'sso-invalid'
    })
    expect(await verify(sign(goodClaims({ aud: [CLIENT] })))).toEqual({ ok: false, code: 'sso-invalid' })
    expect(await verify(sign(goodClaims({ tid: '00000000-0000-4000-8000-000000000002' })))).toEqual({
      ok: false,
      code: 'sso-tenant'
    })
    expect(await verify(sign(goodClaims({ tid: undefined })))).toEqual({ ok: false, code: 'sso-tenant' })
  })

  it('accepts the tenant claim case-insensitively', async () => {
    expect(await verify(sign(goodClaims({ tid: TENANT.toUpperCase() })))).toMatchObject({ ok: true })
  })

  it('refuses an e-mail outside the allowed domains, including look-alike suffixes', async () => {
    for (const email of [
      'sam@other.test',
      'sam@evil-example.test',
      'sam@example.test.evil.test',
      'sam@sub.example.test',
      'no-at-sign'
    ]) {
      expect(await verify(sign(goodClaims({ preferred_username: email })))).toEqual({ ok: false, code: 'sso-domain' })
    }
    expect(await verify(sign(goodClaims({ preferred_username: undefined })))).toEqual({ ok: false, code: 'sso-domain' })
  })

  it('refuses a token with no oid or a malformed oid', async () => {
    expect(await verify(sign(goodClaims({ oid: undefined })))).toEqual({ ok: false, code: 'sso-invalid' })
    expect(await verify(sign(goodClaims({ oid: 'not-a-guid' })))).toEqual({ ok: false, code: 'sso-invalid' })
  })

  it('refuses an expired token and one whose nbf is in the future', async () => {
    expect(await verify(sign(goodClaims({ exp: NOW_SEC - 1 })))).toEqual({ ok: false, code: 'sso-stale' })
    expect(await verify(sign(goodClaims({ exp: NOW_SEC })))).toEqual({ ok: false, code: 'sso-stale' })
    expect(await verify(sign(goodClaims({ exp: undefined })))).toEqual({ ok: false, code: 'sso-stale' })
    expect(await verify(sign(goodClaims({ nbf: NOW_SEC + 61 })))).toEqual({ ok: false, code: 'sso-invalid' })
    expect(await verify(sign(goodClaims({ nbf: NOW_SEC + 60 })))).toMatchObject({ ok: true })
  })

  it('enforces iat freshness: older than 10 minutes is stale even when exp is far ahead', async () => {
    expect(await verify(sign(goodClaims({ iat: NOW_SEC - ENTRA_MAX_IAT_AGE_SEC })))).toMatchObject({ ok: true })
    expect(await verify(sign(goodClaims({ iat: NOW_SEC - ENTRA_MAX_IAT_AGE_SEC - 1 })))).toEqual({
      ok: false,
      code: 'sso-stale'
    })
    expect(await verify(sign(goodClaims({ iat: NOW_SEC - 3600 })))).toEqual({ ok: false, code: 'sso-stale' })
    expect(await verify(sign(goodClaims({ iat: undefined })))).toEqual({ ok: false, code: 'sso-invalid' })
    expect(await verify(sign(goodClaims({ iat: NOW_SEC + 3600 })))).toEqual({ ok: false, code: 'sso-invalid' })
  })

  it('refuses malformed tokens without fetching anything for them', async () => {
    for (const token of ['', 'a.b', 'a.b.c.d', 'not a jwt', `${b64('x')}.${b64({})}.sig`, 'x'.repeat(9000)]) {
      expect(await verify(token)).toEqual({ ok: false, code: 'sso-invalid' })
    }
    expect(jwks.calls).toEqual([])
  })

  it('refuses a token with no kid', async () => {
    const head = b64({ alg: 'RS256' })
    const body = b64(goodClaims())
    const signer = createSign('RSA-SHA256')
    signer.update(`${head}.${body}`)
    expect(await verify(`${head}.${body}.${signer.sign(keyA.privateKey).toString('base64url')}`)).toEqual({
      ok: false,
      code: 'sso-invalid'
    })
  })

  it('serves the JWKS from cache for an hour, then refetches', async () => {
    await verify(sign(goodClaims()))
    await verify(sign(goodClaims({ uti: 'uti-2' })), NOW + 59 * 60_000)
    expect(jwks.calls).toHaveLength(1)
    await verify(sign(goodClaims({ uti: 'uti-3', iat: (NOW + 61 * 60_000) / 1000 - 30 })), NOW + 61 * 60_000)
    expect(jwks.calls).toHaveLength(2)
  })

  it('refetches once for an unknown kid (key rotation) and then accepts the rotated key', async () => {
    await verify(sign(goodClaims()))
    expect(jwks.calls).toHaveLength(1)
    jwks = stubFetch([jwkOf(keyA, 'k1'), jwkOf(keyB, 'k2')])
    const rotated = await verifyEntraIdToken(
      sign(goodClaims({ uti: 'uti-rot' }), { kid: 'k2', key: keyB.privateKey }),
      cfg,
      {
        now: NOW,
        fetchImpl: jwks.fetchImpl,
        cache
      }
    )
    expect(rotated).toMatchObject({ ok: true })
    expect(jwks.calls).toHaveLength(1)
  })

  it('throttles forced refetches: repeated unknown kids cost the issuer one request per 5 minutes', async () => {
    await verify(sign(goodClaims()))
    const base = jwks.calls.length
    for (let i = 0; i < 5; i++) {
      expect(await verify(sign(goodClaims(), { kid: `ghost-${i}` }), NOW + i * 1000)).toEqual({
        ok: false,
        code: 'sso-invalid'
      })
    }
    expect(jwks.calls.length - base).toBe(1)
    expect(await verify(sign(goodClaims(), { kid: 'ghost-late' }), NOW + 6 * 60_000)).toEqual({
      ok: false,
      code: 'sso-invalid'
    })
    expect(jwks.calls.length - base).toBe(2)
  })

  it('reports sso-unavailable (retry later) when the issuer keys cannot be fetched', async () => {
    const down: JwksFetch = async () => new Response('nope', { status: 503 })
    expect(
      await verifyEntraIdToken(sign(goodClaims()), cfg, { now: NOW, fetchImpl: down, cache: freshCache() })
    ).toEqual({
      ok: false,
      code: 'sso-unavailable'
    })
    const boom: JwksFetch = async () => {
      throw new Error('network')
    }
    expect(
      await verifyEntraIdToken(sign(goodClaims()), cfg, { now: NOW, fetchImpl: boom, cache: freshCache() })
    ).toEqual({
      ok: false,
      code: 'sso-unavailable'
    })
  })

  it('ignores a JWKS entry that is not an RSA signing key', async () => {
    const wrongUse = { ...jwkOf(keyA, 'k1'), use: 'enc' }
    const c = freshCache()
    const f = stubFetch([wrongUse])
    expect(await verifyEntraIdToken(sign(goodClaims()), cfg, { now: NOW, fetchImpl: f.fetchImpl, cache: c })).toEqual({
      ok: false,
      code: 'sso-invalid'
    })
  })

  it('uses the global fetch when none is injected (stubbed here, no network)', async () => {
    const spy = vi.fn(async () => Response.json({ keys: [jwkOf(keyA, 'k1')] }))
    vi.stubGlobal('fetch', spy)
    try {
      const result = await verifyEntraIdToken(sign(goodClaims()), cfg, { now: NOW, cache: freshCache() })
      expect(result).toMatchObject({ ok: true })
      expect(spy).toHaveBeenCalledTimes(1)
      expect(String((spy.mock.calls as unknown[][])[0][0])).toBe(entraJwksUrl(TENANT))
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
