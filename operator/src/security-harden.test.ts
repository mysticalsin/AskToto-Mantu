import { createSign, generateKeyPairSync } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleRequest, type Env } from './index'
import { hmacHex } from './hmac'
import { sha256Hex } from './crypto'
import { verifyAccessJwt } from './access'
import { ingestCanonical, OPERATOR_HMAC_HEADERS } from '../../src/shared/operator-hmac'
import { memoryStore } from './store'
import { TEST_INGEST_SECRET, TEST_PROMPT_KEY } from './test-fixtures'

/**
 * Deep security pass (2026-09-06, .rocket-fuel/METIS-SECURITY-DEEP-RECEIPT.md, board row 2): the Worker
 * hardening that PR148 did not cover. Each block is a fail-closed proof for one fix.
 */

const NOW = 1_725_000_000_000

function env(overrides: Partial<Env> = {}): Env {
  return { OPERATOR_INGEST_SECRET: TEST_INGEST_SECRET, OPERATOR_PROMPT_KEY: TEST_PROMPT_KEY, ...overrides }
}

async function signed(
  path: string,
  bodyText: string,
  opts: { nonce?: string; deviceId?: string; sig?: string; headers?: Record<string, string>; method?: string } = {}
): Promise<Request> {
  const ts = String(NOW)
  const nonce = opts.nonce ?? `n-${Math.random().toString(16).slice(2)}`
  const deviceId = opts.deviceId ?? 'device-a'
  const sig = opts.sig ?? (await hmacHex(TEST_INGEST_SECRET, ingestCanonical(ts, nonce, deviceId, await sha256Hex(bodyText))))
  const method = opts.method ?? 'POST'
  return new Request(`https://operator.test${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      [OPERATOR_HMAC_HEADERS.ts]: ts,
      [OPERATOR_HMAC_HEADERS.nonce]: nonce,
      [OPERATOR_HMAC_HEADERS.device]: deviceId,
      [OPERATOR_HMAC_HEADERS.sig]: sig,
      ...(opts.headers ?? {})
    },
    body: method === 'GET' ? undefined : bodyText
  })
}

const tonyAccess = { getIdentity: async () => ({ email: 'tony.walteur@gmail.com' }) }

describe('nonce is consumed only after the signature verifies', () => {
  it('a forged request cannot burn a nonce that a real request then presents', async () => {
    const store = memoryStore()
    const body = JSON.stringify({ id: 'ask-nonce' })
    const forged = await signed('/v1/ingest', body, { nonce: 'shared-nonce', sig: 'ab'.repeat(32) })
    expect((await handleRequest(forged, env(), {}, { store, now: NOW })).status).toBe(401)
    const real = await signed('/v1/ingest', body, { nonce: 'shared-nonce' })
    expect((await handleRequest(real, env(), {}, { store, now: NOW })).status).toBe(200)
    // and the real one is still replay-protected
    const replay = await signed('/v1/ingest', body, { nonce: 'shared-nonce' })
    expect((await handleRequest(replay, env(), {}, { store, now: NOW })).status).toBe(401)
  })
})

describe('body size is bounded before anything is parsed or encrypted', () => {
  it('refuses a declared oversize with 413 and never reads it', async () => {
    const store = memoryStore()
    const req = await signed('/v1/ingest', JSON.stringify({ id: 'big' }), { headers: { 'content-length': '999999' } })
    const res = await handleRequest(req, env(), {}, { store, now: NOW })
    expect(res.status).toBe(413)
    expect(await store.getAsk('big')).toBeNull()
  })

  it('refuses an undeclared oversize after reading it, and caps the stored question', async () => {
    const store = memoryStore()
    const huge = await signed('/v1/ingest', JSON.stringify({ id: 'big2', question: 'x'.repeat(70_000) }))
    expect((await handleRequest(huge, env(), {}, { store, now: NOW })).status).toBe(413)
    expect(await store.getAsk('big2')).toBeNull()
    const long = await signed('/v1/ingest', JSON.stringify({ id: 'long', question: 'y'.repeat(20_000) }))
    expect((await handleRequest(long, env(), {}, { store, now: NOW })).status).toBe(200)
    const row = await store.getAsk('long')
    expect(row?.prompt_cipher).toBeTruthy()
    // AES-GCM ciphertext of a 4000-char question is far below 20k chars of base64.
    expect((row?.prompt_cipher ?? '').length).toBeLessThan(8000)
  })
})

describe('a device may only touch its own rows', () => {
  it('device B cannot replace or rate device A ask', async () => {
    const store = memoryStore()
    const a = await signed('/v1/ingest', JSON.stringify({ id: 'ask-a', mode: 'sales', question: 'mine' }), { deviceId: 'device-a' })
    expect((await handleRequest(a, env(), {}, { store, now: NOW })).status).toBe(200)
    const overwrite = await signed('/v1/ingest', JSON.stringify({ id: 'ask-a', mode: 'interview' }), { deviceId: 'device-b' })
    expect((await handleRequest(overwrite, env(), {}, { store, now: NOW })).status).toBe(403)
    const rate = await signed('/v1/ingest', JSON.stringify({ id: 'ask-a', event: 'rating', rating: 'down' }), { deviceId: 'device-b' })
    expect((await handleRequest(rate, env(), {}, { store, now: NOW })).status).toBe(403)
    const row = await store.getAsk('ask-a')
    expect(row?.device_id).toBe('device-a')
    expect(row?.mode).toBe('sales')
    expect(row?.rating).toBeNull()
    const own = await signed('/v1/ingest', JSON.stringify({ id: 'ask-a', event: 'rating', rating: 'down' }), { deviceId: 'device-a' })
    expect((await handleRequest(own, env(), {}, { store, now: NOW })).status).toBe(200)
    expect((await store.getAsk('ask-a'))?.rating).toBe('down')
  })

  it('device B cannot take over device A CRM row, on the single event or the heartbeat list', async () => {
    const store = memoryStore()
    const crm = { id: 'crm-a', event: 'crm', status: 'failed', title: 'Send to CRM' }
    const a = await signed('/v1/ingest', JSON.stringify(crm), { deviceId: 'device-a' })
    expect((await handleRequest(a, env(), {}, { store, now: NOW })).status).toBe(200)
    const steal = await signed('/v1/ingest', JSON.stringify({ ...crm, status: 'success' }), { deviceId: 'device-b' })
    expect((await handleRequest(steal, env(), {}, { store, now: NOW })).status).toBe(403)
    const viaHeartbeat = await signed('/v1/heartbeat', JSON.stringify({ crm: [{ ...crm, status: 'success' }] }), { deviceId: 'device-b' })
    expect((await handleRequest(viaHeartbeat, env(), {}, { store, now: NOW })).status).toBe(200)
    const row = await store.getCrm('crm-a')
    expect(row?.device_id).toBe('device-a')
    expect(row?.status).toBe('failed')
  })
})

describe('seat labels are bounded', () => {
  it('drops oversize or markup-looking os / appVersion / seatHash values', async () => {
    const store = memoryStore()
    const req = await signed(
      '/v1/heartbeat',
      JSON.stringify({ os: '<img src=x onerror=alert(1)>', appVersion: '1.8.5'.padEnd(500, '9'), seatHash: 'abc123' })
    )
    expect((await handleRequest(req, env(), {}, { store, now: NOW })).status).toBe(200)
    const seat = (await store.listSeats())[0]
    expect(seat.os).toBe('unknown')
    expect(seat.app_version).toHaveLength(64)
    expect(seat.seat_hash).toBe('abc123')
  })
})

describe('per-address ceiling', () => {
  it('a secret holder rotating device ids still hits the address limit', async () => {
    const store = memoryStore()
    let last = 200
    for (let i = 0; i < 601; i++) {
      const req = await signed('/v1/heartbeat', '{}', { deviceId: `rotating-${i}`, headers: { 'cf-connecting-ip': '203.0.113.9' } })
      last = (await handleRequest(req, env(), {}, { store, now: NOW })).status
      if (last === 429) break
    }
    expect(last).toBe(429)
  })
})

describe('console response headers', () => {
  it('serves the admin page with a CSP, no framing, nosniff and no-store', async () => {
    const store = memoryStore()
    const res = await handleRequest(new Request('https://operator.test/'), env(), { access: tonyAccess }, { store, now: NOW })
    expect(res.status).toBe(200)
    const csp = res.headers.get('content-security-policy') ?? ''
    expect(csp).toMatch(/default-src 'none'/)
    expect(csp).toMatch(/frame-ancestors 'none'/)
    expect(csp).toMatch(/connect-src 'self'/)
    expect(csp).not.toMatch(/\*/)
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('cache-control')).toBe('no-store')
  })
})

describe('Cloudflare Access JWT fallback checks the time claims', () => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = { ...(pair.publicKey.export({ format: 'jwk' }) as JsonWebKey), kid: 'k1', alg: 'RS256', use: 'sig' }
  const TEAM = 'https://mantu.cloudflareaccess.com'
  const AUD = 'aud-123'
  const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url')
  function mint(claims: Record<string, unknown>, kid = 'k1'): string {
    const head = b64({ alg: 'RS256', kid })
    const body = b64(claims)
    const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(pair.privateKey).toString('base64url')
    return `${head}.${body}.${sig}`
  }
  const nowSec = Math.floor(NOW / 1000)
  const good = { aud: AUD, email: 'Tony.Walteur@gmail.com', iss: TEAM, iat: nowSec - 60, exp: nowSec + 600 }

  afterEach(() => vi.unstubAllGlobals())

  function stubJwks(): void {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ keys: [jwk] })))
  }

  it('accepts a live token and lowercases the email', async () => {
    stubJwks()
    expect(await verifyAccessJwt(mint(good), TEAM, AUD, NOW)).toBe('tony.walteur@gmail.com')
  })

  it('rejects expired, not-yet-valid, missing-exp, wrong-issuer and wrong-audience tokens', async () => {
    stubJwks()
    expect(await verifyAccessJwt(mint({ ...good, exp: nowSec - 1 }), TEAM, AUD, NOW)).toBeNull()
    expect(await verifyAccessJwt(mint({ ...good, nbf: nowSec + 60 }), TEAM, AUD, NOW)).toBeNull()
    const { exp: _drop, ...noExp } = good
    expect(await verifyAccessJwt(mint(noExp), TEAM, AUD, NOW)).toBeNull()
    expect(await verifyAccessJwt(mint({ ...good, iss: 'https://other.cloudflareaccess.com' }), TEAM, AUD, NOW)).toBeNull()
    expect(await verifyAccessJwt(mint({ ...good, aud: 'someone-else' }), TEAM, AUD, NOW)).toBeNull()
  })

  it('rejects a token signed by an unknown key, a non-RS256 header, or a tampered payload', async () => {
    stubJwks()
    expect(await verifyAccessJwt(mint(good, 'k2'), TEAM, AUD, NOW)).toBeNull()
    const [h, p, s] = mint(good).split('.')
    const noneHead = Buffer.from(JSON.stringify({ alg: 'none', kid: 'k1' })).toString('base64url')
    expect(await verifyAccessJwt(`${noneHead}.${p}.${s}`, TEAM, AUD, NOW)).toBeNull()
    const tampered = Buffer.from(JSON.stringify({ ...good, email: 'attacker@example.com' })).toString('base64url')
    expect(await verifyAccessJwt(`${h}.${tampered}.${s}`, TEAM, AUD, NOW)).toBeNull()
  })

  it('fetches the JWKS once within the cache window', async () => {
    stubJwks()
    const f = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    // A team domain no earlier test in this file has warmed.
    const fresh = 'https://fresh-team.cloudflareaccess.com'
    await verifyAccessJwt(mint({ ...good, iss: fresh }), fresh, AUD, NOW)
    await verifyAccessJwt(mint({ ...good, iss: fresh }), fresh, AUD, NOW + 1000)
    expect(f).toHaveBeenCalledTimes(1)
  })
})
