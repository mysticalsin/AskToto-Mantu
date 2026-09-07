import { createSign, generateKeyPairSync } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleRequest, type Env } from './index'
import { hmacHex, verifyIngestHmac } from './hmac'
import { sha256Hex } from './crypto'
import { verifyAccessJwt } from './access'
import { ingestCanonical, OPERATOR_HMAC_HEADERS } from '../../src/shared/operator-hmac'
import { memoryStore } from './store'
import { TEST_INGEST_SECRET, TEST_PROMPT_KEY, TEST_VAULT_KEY } from './test-fixtures'

/**
 * P0.3 security pass (2026-09-06): the request-plumbing hardening from
 * cursor/metis-security-deep-fable commit f2a96262, ported onto the current route table, plus the CSRF
 * and per-route HMAC bucket work section 10 asks for alongside it. Each block is a fail-closed proof for
 * one fix.
 */

const NOW = 1_725_000_000_000

function env(overrides: Partial<Env> = {}): Env {
  return {
    OPERATOR_INGEST_SECRET: TEST_INGEST_SECRET,
    OPERATOR_PROMPT_KEY: TEST_PROMPT_KEY,
    OPERATOR_SKILL_PRIVATE_KEY: 'unused',
    OPERATOR_VAULT_KEY: TEST_VAULT_KEY,
    ...overrides
  }
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

describe('console and JSON response headers', () => {
  it('serves the admin console with a self-only CSP, no framing, nosniff and no-store', async () => {
    const store = memoryStore()
    const res = await handleRequest(new Request('https://operator.test/'), env(), { access: tonyAccess }, { store, now: NOW })
    expect(res.status).toBe(200)
    const csp = res.headers.get('content-security-policy') ?? ''
    expect(csp).toMatch(/default-src 'self'/)
    expect(csp).toMatch(/frame-ancestors 'none'/)
    expect(csp).toMatch(/connect-src 'self'/)
    expect(csp).not.toMatch(/\*/)
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
  })

  it('every admin JSON response carries the same security headers', async () => {
    const store = memoryStore()
    const res = await handleRequest(
      new Request('https://operator.test/v1/admin/health.json'),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    expect(res.headers.get('x-frame-options')).toBe('DENY')
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

describe('CSRF on every admin POST', () => {
  const body = () => JSON.stringify({ provider: 'anthropic', secret: 'sk-ant-api03-TESTKEYONLY-not-a-real-secret-cs99' })

  it('same-origin (Sec-Fetch-Site) passes', async () => {
    const store = memoryStore()
    const res = await handleRequest(
      new Request('https://operator.test/v1/admin/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
        body: body()
      }),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    )
    expect(res.status).toBe(200)
  })

  it('cross-origin (Sec-Fetch-Site or Origin mismatch) is refused with code csrf', async () => {
    const store = memoryStore()
    const viaSecFetch = await handleRequest(
      new Request('https://operator.test/v1/admin/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
        body: body()
      }),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    )
    expect(viaSecFetch.status).toBe(403)
    expect(await viaSecFetch.json()).toEqual({ ok: false, error: 'cross-site request refused', code: 'csrf' })

    const viaOrigin = await handleRequest(
      new Request('https://operator.test/v1/admin/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
        body: body()
      }),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    )
    expect(viaOrigin.status).toBe(403)
    expect((await store.listVaultMeta()).length).toBe(0)
  })

  it('Bearer session + same-origin passes', async () => {
    const store = memoryStore()
    const home = await handleRequest(new Request('https://operator.test/'), env(), { access: tonyAccess }, { store, now: NOW })
    const token = home.headers.get('X-Metis-Session') || ''
    expect(token).toMatch(/^v1\|/)
    const res = await handleRequest(
      new Request('https://operator.test/v1/admin/keys', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          'sec-fetch-site': 'same-origin'
        },
        body: body()
      }),
      env(),
      {},
      { store, now: NOW }
    )
    expect(res.status).toBe(200)
  })
})

describe('per-route HMAC buckets', () => {
  it('heartbeat is limited at 5/min per device and the 429 carries retryAfterMs', async () => {
    const store = memoryStore()
    let last: Response | null = null
    for (let i = 0; i < 6; i++) {
      const req = await signed('/v1/heartbeat', '{}', { deviceId: 'device-bucket', nonce: `hb-${i}` })
      last = await handleRequest(req, env(), {}, { store, now: NOW })
    }
    expect(last?.status).toBe(429)
    const body = (await last!.json()) as { error?: string; retryAfterMs?: number }
    expect(body.error).toBe('rate limited')
    expect(body.retryAfterMs).toBeGreaterThan(0)
  })

  it('ingest and heartbeat buckets are independent for the same device', async () => {
    const store = memoryStore()
    for (let i = 0; i < 5; i++) {
      const hb = await signed('/v1/heartbeat', '{}', { deviceId: 'device-split', nonce: `split-hb-${i}` })
      expect((await handleRequest(hb, env(), {}, { store, now: NOW })).status).toBe(200)
    }
    const ingest = await signed('/v1/ingest', JSON.stringify({ id: 'split-ask' }), { deviceId: 'device-split', nonce: 'split-ingest' })
    expect((await handleRequest(ingest, env(), {}, { store, now: NOW })).status).toBe(200)
  })
})

describe('admin mutation rate limit', () => {
  const mutationBody = () => JSON.stringify({ provider: 'anthropic', secret: 'sk-ant-api03-TESTKEYONLY-not-a-real-secret-cs99' })
  const mutation = () =>
    new Request('https://operator.test/v1/admin/keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: mutationBody()
    })

  it('limits admin mutations at 60/min per signed-in email; the 61st in the window is 429', async () => {
    const store = memoryStore()
    let last: Response | null = null
    for (let i = 0; i < 61; i++) {
      last = await handleRequest(mutation(), env(), { access: tonyAccess }, { store, now: NOW })
    }
    expect(last?.status).toBe(429)
    const body = (await last!.json()) as { ok: boolean; error: string; code: string; retryAfterMs: number }
    expect(body.ok).toBe(false)
    expect(body.error).toBe('rate limited')
    expect(body.code).toBe('rate')
    expect(body.retryAfterMs).toBeGreaterThan(0)
  })

  it('never limits GET, even once the mutation bucket for that email is exhausted', async () => {
    const store = memoryStore()
    for (let i = 0; i < 61; i++) {
      await handleRequest(mutation(), env(), { access: tonyAccess }, { store, now: NOW })
    }
    const getRes = await handleRequest(
      new Request('https://operator.test/v1/admin/health.json', { headers: { 'sec-fetch-site': 'same-origin' } }),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    )
    expect(getRes.status).toBe(200)
  })
})

describe('device id format is enforced before the signature check (B11)', () => {
  // A real device id is hashOperatorId(getMachineId()) (src/main/operator-hmac-sign.ts): a 32-character
  // lowercase hex string. DEVICE_ID_RE (operator/src/hmac.ts) is deliberately wider than that (letters
  // both cases, digits, `. _ -`, 8 to 128 chars) so a future id scheme has room, while still rejecting
  // anything that could carry a newline, HTML, or an unbounded length into a nonce key, a rate-bucket
  // key, an audit row, or a D1 primary key.
  const REAL_DEVICE_ID = 'f47ac10b58cc4372a5670e02b2c3d479'

  it('rejects an oversized device id and one with HTML-shaped characters, with code device-id, and never burns the nonce', async () => {
    const store = memoryStore()
    const sharedNonce = 'nonce-not-burned-by-a-bad-device-id'

    const oversized = await signed('/v1/ingest', JSON.stringify({ id: 'ask-badid-1' }), {
      deviceId: 'a'.repeat(200),
      nonce: sharedNonce
    })
    const res1 = await handleRequest(oversized, env(), {}, { store, now: NOW })
    expect(res1.status).toBe(401)
    expect(((await res1.json()) as { ok: boolean; code?: string }).code).toBe('device-id')

    const htmlShaped = await signed('/v1/ingest', JSON.stringify({ id: 'ask-badid-2' }), {
      deviceId: 'weird<script>device',
      nonce: 'nonce-html-shaped'
    })
    const res2 = await handleRequest(htmlShaped, env(), {}, { store, now: NOW })
    expect(res2.status).toBe(401)
    expect(((await res2.json()) as { ok: boolean; code?: string }).code).toBe('device-id')

    // Neither rejected request burned `sharedNonce`: a real, well-formed request can still present it.
    const real = await signed('/v1/ingest', JSON.stringify({ id: 'ask-good' }), {
      deviceId: REAL_DEVICE_ID,
      nonce: sharedNonce
    })
    const res3 = await handleRequest(real, env(), {}, { store, now: NOW })
    expect(res3.status).toBe(200)
  })

  it('rejects a device id containing a raw newline', async () => {
    // The Fetch Headers implementation refuses to store a literal CR/LF in a header value (a real
    // client, or workerd's own HTTP parsing, would never let one reach application code), so this
    // exercises verifyIngestHmac's format check directly rather than through handleRequest/Headers.
    const seenNonce = vi.fn(async () => false)
    const headerMap = new Map<string, string>([
      [OPERATOR_HMAC_HEADERS.ts, String(NOW)],
      [OPERATOR_HMAC_HEADERS.nonce, 'n-newline'],
      [OPERATOR_HMAC_HEADERS.device, 'weird\ndevice-id'],
      [OPERATOR_HMAC_HEADERS.sig, 'irrelevant-format-fails-first']
    ])
    const fakeRequest = { headers: { get: (name: string) => headerMap.get(name) ?? null } } as unknown as Request

    const result = await verifyIngestHmac(fakeRequest, '{}', TEST_INGEST_SECRET, NOW, seenNonce)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(401)
      expect(result.code).toBe('device-id')
    }
    expect(seenNonce).not.toHaveBeenCalled()
  })

  it('accepts a real-shaped device id', async () => {
    const store = memoryStore()
    const req = await signed('/v1/ingest', JSON.stringify({ id: 'ask-realid' }), { deviceId: REAL_DEVICE_ID, nonce: 'n-real' })
    const res = await handleRequest(req, env(), {}, { store, now: NOW })
    expect(res.status).toBe(200)
  })
})
