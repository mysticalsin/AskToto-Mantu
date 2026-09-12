import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ingestCanonical, OPERATOR_HMAC_HEADERS, OPERATOR_LICENSE_HEADER } from '../../src/shared/operator-hmac'
import { generateOperatorLicense } from '../../src/shared/operator-license'
import { encryptVault, sha256Hex } from './crypto'
import { hmacHex } from './hmac'
import { handleRequest, type Env } from './index'
import { memoryStore, type IssuedLicenseRow, type OperatorStore } from './store'
import { TEST_INGEST_SECRET, TEST_PROMPT_KEY, TEST_VAULT_KEY } from './test-fixtures'

const NOW = 1_725_000_000_000
const DEVICE = 'license-device-0001'
const OTHER_DEVICE = 'license-device-0002'
const env: Env = {
  OPERATOR_INGEST_SECRET: TEST_INGEST_SECRET,
  OPERATOR_PROMPT_KEY: TEST_PROMPT_KEY,
  OPERATOR_SKILL_PRIVATE_KEY: '',
  OPERATOR_VAULT_KEY: TEST_VAULT_KEY
}

async function issue(store: OperatorStore, patch: Partial<IssuedLicenseRow> = {}) {
  const minted = await generateOperatorLicense(TEST_INGEST_SECRET, {
    days: 7, now: NOW, jti: patch.jti ?? '1122334455667788'
  })
  await store.putIssuedLicense({
    ...minted.claims,
    key_hash: await sha256Hex(minted.token),
    last4: minted.last4,
    days: 7,
    revoked: 0,
    created_at: NOW,
    created_by: 'test-operator',
    ...patch
  })
  return minted
}

async function signed(token: string | null, opts: {
  device?: string
  nonce?: string
  path?: string
  body?: Record<string, unknown>
  timestamp?: number
  secret?: string
  method?: string
} = {}): Promise<Request> {
  const device = opts.device ?? DEVICE
  const nonce = opts.nonce ?? crypto.randomUUID()
  const timestamp = String(opts.timestamp ?? NOW)
  const method = opts.method ?? 'POST'
  const body = method === 'GET' ? '' : JSON.stringify(opts.body ?? { os: 'win32', appVersion: '1.8.9' })
  return new Request(`https://operator.test${opts.path ?? '/v1/heartbeat'}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { [OPERATOR_LICENSE_HEADER]: token }),
      [OPERATOR_HMAC_HEADERS.device]: device,
      [OPERATOR_HMAC_HEADERS.ts]: timestamp,
      [OPERATOR_HMAC_HEADERS.nonce]: nonce,
      [OPERATOR_HMAC_HEADERS.sig]: await hmacHex(
        opts.secret ?? token ?? TEST_INGEST_SECRET,
        ingestCanonical(timestamp, nonce, device, await sha256Hex(body))
      )
    },
    ...(method === 'GET' ? {} : { body })
  })
}

describe('licence-authenticated device requests', () => {
  let store: OperatorStore
  beforeEach(() => { store = memoryStore() })
  const call = (request: Request, now = NOW) => handleRequest(request, env, {}, { store, now })

  it('activates with the licence alone, binds one device and replaces body-supplied licence claims', async () => {
    const minted = await issue(store)
    const response = await call(await signed(minted.token, {
      body: { os: 'win32', appVersion: '1.8.9', licenseId: 'aabbccddeeff0011', licenseLast4: 'FAKE', license: 'approved' }
    }))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, approved: true, tier: 'metis', fundedProviders: [] })
    expect(await store.getSeat(DEVICE)).toMatchObject({
      license_jti: minted.claims.jti,
      license: `licensed · ${minted.last4}`,
      approval: 'pending'
    })
    expect(await store.getIssuedLicense(minted.claims.jti)).toMatchObject({ activated_device: DEVICE, activated_at: NOW })
    expect(JSON.stringify(await store.listSeats())).not.toContain(minted.token)
    expect(JSON.stringify(await store.listIssuedLicenses())).not.toContain(minted.token)
  })

  it('uses a funded provider after activation without giving the device the fleet secret', async () => {
    const minted = await issue(store)
    const encrypted = await encryptVault('provider-test-key', TEST_VAULT_KEY)
    await store.putVaultKey({
      id: 'vault-anthropic', provider: 'anthropic', label: 'test', last4: '-key',
      cipher: encrypted.cipher, iv: encrypted.iv, status: 'active', created_at: NOW,
      created_by: 'test-operator', rotated_at: null, revoked_at: null
    })
    const activation = await call(await signed(minted.token))
    expect(activation.status).toBe(200)
    expect(await activation.json()).toMatchObject({ approved: true, fundedProviders: ['anthropic'] })
    const providerFetch = vi.fn(async () => new Response(JSON.stringify({
      content: [{ type: 'text', text: 'Meeting next steps are ready.' }],
      usage: { input_tokens: 8, output_tokens: 6 }
    }), { headers: { 'content-type': 'application/json' } }))
    const response = await handleRequest(await signed(minted.token, {
      path: '/v1/use',
      body: { provider: 'anthropic', model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'List the next steps.' }] }
    }), env, {}, { store, now: NOW, providerFetch: providerFetch as typeof fetch })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, text: 'Meeting next steps are ready.' })
    expect(providerFetch).toHaveBeenCalledOnce()
  })

  it.each([
    { patch: { key_hash: 'wrong-hash' }, code: 'license-invalid' },
    { patch: { revoked: 1 }, code: 'license-revoked' },
    { patch: { exp: NOW / 1000 }, code: 'license-expired' },
    { patch: { activated_device: OTHER_DEVICE }, code: 'license-device' }
  ])('refuses an issued record with $code before writing a seat', async ({ patch, code }) => {
    const minted = await issue(store, patch)
    const response = await call(await signed(minted.token))
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(await response.json()).toMatchObject({ ok: false, code })
    expect(await store.listSeats()).toEqual([])
    expect(await store.listPulses(0)).toEqual([])
  })

  it('refuses a validly signed but unissued token', async () => {
    const minted = await generateOperatorLicense(TEST_INGEST_SECRET, { days: 7, now: NOW })
    const response = await call(await signed(minted.token))
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ code: 'license-invalid' })
    expect(await store.listSeats()).toEqual([])
  })

  it('refuses a token after its signed expiry', async () => {
    const minted = await issue(store)
    const expiredAt = minted.claims.exp * 1000
    const response = await call(await signed(minted.token, { timestamp: expiredAt }), expiredAt)
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: 'license-expired' })
  })

  it.each(['', 'METIS-OP-1.invalid'])('does not downgrade an invalid licence header to legacy auth: %s', async (token) => {
    const response = await call(await signed(token, { secret: TEST_INGEST_SECRET }))
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ code: 'license-invalid' })
    expect(await store.listSeats()).toEqual([])
  })

  it('retains legacy HMAC for installs that do not present a licence header', async () => {
    expect((await call(await signed(null))).status).toBe(200)
  })

  it('verifies with the same trimmed minting secret used by the licence generator', async () => {
    const minted = await issue(store)
    const response = await handleRequest(await signed(minted.token), {
      ...env, OPERATOR_INGEST_SECRET: ` ${TEST_INGEST_SECRET}\n`
    }, {}, { store, now: NOW })
    expect(response.status).toBe(200)
  })

  it('reports a temporary service error if licence verification is not configured', async () => {
    const minted = await issue(store)
    const response = await handleRequest(await signed(minted.token), {
      ...env, OPERATOR_INGEST_SECRET: ''
    }, {}, { store, now: NOW })
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ code: 'license-unavailable' })
    expect(await store.listSeats()).toEqual([])
  })

  it('does not burn a nonce or bind a device when the body signature is forged', async () => {
    const minted = await issue(store)
    const nonce = 'shared-valid-nonce'
    const forged = await call(await signed(minted.token, { nonce, secret: 'incorrect-token-secret' }))
    expect(forged.status).toBe(401)
    expect((await store.getIssuedLicense(minted.claims.jti))?.activated_device).toBeFalsy()
    expect((await call(await signed(minted.token, { nonce }))).status).toBe(200)
    const replay = await call(await signed(minted.token, { nonce }))
    expect(replay.status).toBe(401)
    expect(await replay.json()).toMatchObject({ error: 'replay nonce' })
  })

  it('rejects stale request signatures before binding the device', async () => {
    const minted = await issue(store)
    const response = await call(await signed(minted.token, { timestamp: NOW - 10 * 60_000 }))
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ error: 'timestamp skew' })
    expect((await store.getIssuedLicense(minted.claims.jti))?.activated_device).toBeFalsy()
  })

  it('allows only one of two devices activating the same licence concurrently', async () => {
    const minted = await issue(store)
    const requests = await Promise.all([signed(minted.token), signed(minted.token, { device: OTHER_DEVICE })])
    const responses = await Promise.all(requests.map((request) => call(request)))
    expect(responses.map((response) => response.status).sort()).toEqual([200, 403])
    const seats = await store.listSeats()
    expect(seats).toHaveLength(1)
    expect((await store.getIssuedLicense(minted.claims.jti))?.activated_device).toBe(seats[0].device_id)
  })

  it('cannot reactivate a device revoked by an administrator', async () => {
    const minted = await issue(store)
    expect((await call(await signed(minted.token))).status).toBe(200)
    await store.updateSeatApproval(DEVICE, 'revoked')
    const response = await call(await signed(minted.token))
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: 'seat-revoked' })
    expect((await store.getSeat(DEVICE))?.approval).toBe('revoked')
    expect(await store.listPulses(0)).toHaveLength(1)
  })

  it.each(['licence', 'seat'] as const)('preserves %s revocation between lookup and binding', async (revoked) => {
    const minted = await issue(store)
    const bind = store.bindIssuedLicense.bind(store)
    store.bindIssuedLicense = async (...args) => {
      if (revoked === 'licence') {
        await store.revokeIssuedLicense(minted.claims.jti, NOW)
      } else {
        await store.upsertSeat({
          device_id: DEVICE, seat_hash: DEVICE, os: 'win32', app_version: '1.8.9',
          first_seen: NOW, last_seen: NOW, country: null, city: null, lat: null, lon: null,
          last_index_at: null, hostname: null, sso_email: null, license: null, approval: 'revoked'
        })
      }
      return bind(...args)
    }
    const response = await call(await signed(minted.token))
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: revoked === 'licence' ? 'license-revoked' : 'seat-revoked' })
    expect((await store.getIssuedLicense(minted.claims.jti))?.activated_device).toBeFalsy()
    expect(await store.listPulses(0)).toHaveLength(0)
  })

  it('does not let legacy metadata claim a licence bound to another device', async () => {
    const minted = await issue(store, { activated_device: OTHER_DEVICE })
    const response = await call(await signed(null, {
      body: { os: 'win32', appVersion: '1.8.9', licenseId: minted.claims.jti }
    }))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ approved: false, fundedProviders: [] })
    expect((await store.getIssuedLicense(minted.claims.jti))?.activated_device).toBe(OTHER_DEVICE)
  })

  it.each([
    { path: '/v1/ingest', method: 'POST' },
    { path: '/v1/use', method: 'POST' },
    { path: '/v1/ask', method: 'POST' },
    { path: '/v1/skills/manifest', method: 'GET' },
    { path: '/v1/integrations', method: 'GET' }
  ])('rejects a previous licence on $path after this device activates a different licence', async ({ path, method }) => {
    const old = await issue(store)
    expect((await call(await signed(old.token))).status).toBe(200)
    const current = await issue(store, { jti: 'aabbccddeeff0011', tier: 'advanced' })
    expect((await call(await signed(current.token))).status).toBe(200)
    const response = await call(await signed(old.token, { path, method }))
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: 'license-device' })
    expect((await store.getSeat(DEVICE))?.license_jti).toBe(current.claims.jti)
    expect((await call(await signed(current.token, { path: '/v1/skills/manifest', method: 'GET' }))).status).toBe(200)
  })
})
