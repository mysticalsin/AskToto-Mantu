import { describe, expect, it } from 'vitest'
import { handleRequest, type Env } from '../index'
import { encryptVault, sha256Hex } from '../crypto'
import { hmacHex } from '../hmac'
import { memoryStore, type IntegrationRow, type SeatRow } from '../store'
import { TEST_INGEST_SECRET, TEST_PROMPT_KEY, TEST_VAULT_KEY } from '../test-fixtures'
import { ingestCanonical, OPERATOR_HMAC_HEADERS } from '../../../src/shared/operator-hmac'

const NOW = 1_725_000_000_000

function env(overrides: Partial<Env> = {}): Env {
  return {
    OPERATOR_INGEST_SECRET: TEST_INGEST_SECRET,
    OPERATOR_PROMPT_KEY: TEST_PROMPT_KEY,
    OPERATOR_SKILL_PRIVATE_KEY: '',
    OPERATOR_VAULT_KEY: TEST_VAULT_KEY,
    ...overrides
  }
}

async function signedGet(path: string, deviceId: string): Promise<Request> {
  const ts = String(NOW)
  const nonce = `nonce-${Math.random().toString(16).slice(2)}`
  const bodyHash = await sha256Hex('')
  const sig = await hmacHex(TEST_INGEST_SECRET, ingestCanonical(ts, nonce, deviceId, bodyHash))
  return new Request(`https://operator.test${path}`, {
    method: 'GET',
    headers: {
      [OPERATOR_HMAC_HEADERS.ts]: ts,
      [OPERATOR_HMAC_HEADERS.nonce]: nonce,
      [OPERATOR_HMAC_HEADERS.device]: deviceId,
      [OPERATOR_HMAC_HEADERS.sig]: sig
    }
  })
}

function seat(overrides: Partial<SeatRow> & Pick<SeatRow, 'device_id'>): SeatRow {
  return {
    seat_hash: 'seat',
    os: 'darwin',
    app_version: '1.8.5',
    first_seen: NOW,
    last_seen: NOW,
    country: 'CA',
    city: 'Longueuil',
    region: null,
    lat: null,
    lon: null,
    last_index_at: null,
    hostname: 'Tonys-MacBook-Pro',
    sso_email: 'twalteur@amaris.com',
    license: 'approved',
    approval: 'approved',
    ...overrides
  }
}

/** `mode` defaults to `'direct'` here (not the column-level `'brokered'` default) so every existing test
 *  below, written before task B2 added the `mode` column, keeps exercising the credential-delivery path
 *  it always has - a test that wants brokered delivery, or the true column default, says so explicitly
 *  (see the "brokered" and "predates the mode column" tests). */
async function integration(
  overrides: Partial<IntegrationRow> & { mode?: string; transport?: string } & Pick<IntegrationRow, 'id'>
): Promise<IntegrationRow> {
  const enc = await encryptVault('crm-secret-token', TEST_VAULT_KEY)
  const { mode = 'direct', transport, ...rowOverrides } = overrides
  return {
    kind: 'hubspot',
    label: 'Hubspot prod',
    base_url: 'https://api.hubapi.com',
    cipher: enc.cipher,
    iv: enc.iv,
    last4: 'oken',
    scope_json: '{}',
    status: 'active',
    created_at: NOW - 1000,
    created_by: 'tony.walteur@gmail.com',
    rotated_at: null,
    revoked_at: null,
    last_used_at: null,
    uses: 0,
    ...rowOverrides,
    mode,
    ...(transport !== undefined ? { transport } : {})
  } as IntegrationRow
}

describe('GET /v1/integrations (seat delivery)', () => {
  it('delivers the decrypted credential to an approved, entitled seat and audits the delivery', async () => {
    const store = memoryStore()
    await store.upsertSeat(seat({ device_id: 'dev-a' }))
    await store.putIntegration(await integration({ id: 'int-1' }))

    const res = await handleRequest(await signedGet('/v1/integrations', 'dev-a'), env(), {}, { store, now: NOW })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; version: number; integrations: { id: string; credential: string; kind: string }[] }
    expect(body.ok).toBe(true)
    expect(body.integrations).toHaveLength(1)
    expect(body.integrations[0]).toMatchObject({ id: 'int-1', kind: 'hubspot', credential: 'crm-secret-token' })
    expect(body.version).toBe(NOW - 1000)

    const grants = await store.listIntegrationGrants('int-1', 10)
    expect(grants).toHaveLength(1)
    expect(grants[0].device_id).toBe('dev-a')
    const audit = await store.listAudit(10)
    expect(audit.some((a) => a.action === 'integration-delivered' && a.actor === 'dev-a')).toBe(true)
  })

  it('never leaks the raw ciphertext, only the decrypted credential', async () => {
    const store = memoryStore()
    await store.upsertSeat(seat({ device_id: 'dev-a' }))
    const row = await integration({ id: 'int-1' })
    await store.putIntegration(row)
    const res = await handleRequest(await signedGet('/v1/integrations', 'dev-a'), env(), {}, { store, now: NOW })
    const text = await res.text()
    expect(text).not.toContain(row.cipher)
    expect(text).not.toContain(row.iv!)
  })

  it('excludes an integration scoped to a different tier', async () => {
    const store = memoryStore()
    await store.upsertSeat(seat({ device_id: 'dev-a' }))
    await store.putIntegration(await integration({ id: 'int-1', scope_json: JSON.stringify({ tiers: ['metis-light'] }) }))
    const res = await handleRequest(await signedGet('/v1/integrations', 'dev-a'), env(), {}, { store, now: NOW })
    const body = (await res.json()) as { ok: boolean; integrations: unknown[] }
    expect(body.ok).toBe(true)
    expect(body.integrations).toHaveLength(0)
  })

  it('403s a seat that is not approved and has no active license', async () => {
    const store = memoryStore()
    await store.upsertSeat(seat({ device_id: 'dev-a', approval: 'pending', license: null }))
    await store.putIntegration(await integration({ id: 'int-1' }))
    const res = await handleRequest(await signedGet('/v1/integrations', 'dev-a'), env(), {}, { store, now: NOW })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ ok: false, error: 'seat not entitled', code: 'not-entitled' })
  })

  it("403s an entitled seat whose tier lacks the 'integrations' entitlement", async () => {
    const store = memoryStore()
    await store.upsertSeat(seat({ device_id: 'dev-a' }))
    await store.putTier({ id: 'metis', label: 'Métis', entitlements_json: JSON.stringify(['ask']), updated_at: NOW })
    await store.putIntegration(await integration({ id: 'int-1' }))
    const res = await handleRequest(await signedGet('/v1/integrations', 'dev-a'), env(), {}, { store, now: NOW })
    expect(res.status).toBe(403)
  })

  it('503s when the vault key is unbound', async () => {
    const store = memoryStore()
    await store.upsertSeat(seat({ device_id: 'dev-a' }))
    const res = await handleRequest(await signedGet('/v1/integrations', 'dev-a'), env({ OPERATOR_VAULT_KEY: undefined }), {}, { store, now: NOW })
    expect(res.status).toBe(503)
  })

  it('rejects a POST (GET-only route, like manifest)', async () => {
    const store = memoryStore()
    await store.upsertSeat(seat({ device_id: 'dev-a' }))
    // Same signature as the GET (computed over an empty body): only the method changes, so the
    // request still clears HMAC verification and reaches the GET-only check inside the route.
    const req = await signedGet('/v1/integrations', 'dev-a')
    const asPost = new Request(req.url, { method: 'POST', headers: req.headers })
    const res = await handleRequest(asPost, env(), {}, { store, now: NOW })
    expect(res.status).toBe(405)
  })

  it('delivers a brokered connection without a credential, using the gateway endpoint shape', async () => {
    const store = memoryStore()
    await store.upsertSeat(seat({ device_id: 'dev-a' }))
    await store.putIntegration(await integration({ id: 'int-1', mode: 'brokered', transport: 'mcp' }))
    const res = await handleRequest(await signedGet('/v1/integrations', 'dev-a'), env(), {}, { store, now: NOW })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; integrations: Record<string, unknown>[] }
    expect(body.ok).toBe(true)
    expect(body.integrations).toEqual([
      {
        id: 'int-1',
        kind: 'hubspot',
        label: 'Hubspot prod',
        transport: 'mcp',
        mode: 'brokered',
        endpoint: '/v1/mcp/int-1',
        scopes: {}
      }
    ])
    const text = JSON.stringify(body.integrations)
    expect(text).not.toContain('crm-secret-token')
    expect(text).not.toContain('credential')
    expect(text).not.toContain('baseUrl')
  })

  it('defaults to brokered delivery when a row predates the mode column', async () => {
    const store = memoryStore()
    await store.upsertSeat(seat({ device_id: 'dev-a' }))
    const row = (await integration({ id: 'int-1' })) as Record<string, unknown>
    delete row.mode
    await store.putIntegration(row as unknown as IntegrationRow)
    const res = await handleRequest(await signedGet('/v1/integrations', 'dev-a'), env(), {}, { store, now: NOW })
    const body = (await res.json()) as { ok: boolean; integrations: { mode?: string }[] }
    expect(body.ok).toBe(true)
    expect(body.integrations).toHaveLength(1)
    expect(body.integrations[0].mode).toBe('brokered')
    expect(body.integrations[0]).not.toHaveProperty('credential')
  })
})

describe('heartbeat integrationsVersion', () => {
  it('carries the max rotated_at/created_at of the seat entitled integrations, 0 with none', async () => {
    const store = memoryStore()
    await store.upsertSeat(seat({ device_id: 'dev-a' }))
    const ts = String(NOW)
    const nonce = 'hb-nonce-1'
    const bodyText = JSON.stringify({ os: 'darwin', appVersion: '1.8.5' })
    const bodyHash = await sha256Hex(bodyText)
    const sig = await hmacHex(TEST_INGEST_SECRET, ingestCanonical(ts, nonce, 'dev-a', bodyHash))
    const req = new Request('https://operator.test/v1/heartbeat', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [OPERATOR_HMAC_HEADERS.ts]: ts,
        [OPERATOR_HMAC_HEADERS.nonce]: nonce,
        [OPERATOR_HMAC_HEADERS.device]: 'dev-a',
        [OPERATOR_HMAC_HEADERS.sig]: sig
      },
      body: bodyText
    })
    const zero = await handleRequest(req, env(), {}, { store, now: NOW })
    expect(((await zero.json()) as { integrationsVersion: number }).integrationsVersion).toBe(0)

    await store.putIntegration(await integration({ id: 'int-1', rotated_at: NOW - 500, created_at: NOW - 1000 }))
    const ts2 = String(NOW + 1)
    const nonce2 = 'hb-nonce-2'
    const sig2 = await hmacHex(TEST_INGEST_SECRET, ingestCanonical(ts2, nonce2, 'dev-a', bodyHash))
    const req2 = new Request('https://operator.test/v1/heartbeat', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [OPERATOR_HMAC_HEADERS.ts]: ts2,
        [OPERATOR_HMAC_HEADERS.nonce]: nonce2,
        [OPERATOR_HMAC_HEADERS.device]: 'dev-a',
        [OPERATOR_HMAC_HEADERS.sig]: sig2
      },
      body: bodyText
    })
    const withVersion = await handleRequest(req2, env(), {}, { store, now: NOW + 1 })
    expect(((await withVersion.json()) as { integrationsVersion: number }).integrationsVersion).toBe(NOW - 500)
  })
})
