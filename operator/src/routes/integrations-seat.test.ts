import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { handleRequest, type Env } from '../index'
import { decryptVault, encryptVault, sha256Hex } from '../crypto'
import { d1Store, type D1DatabaseLike } from '../d1'
import { verifyGatewayToken } from '../connectors/gateway-token'
import { readIntegrationExtra, INTEGRATION_ALTERS } from '../connectors/data'
import { hmacHex } from '../hmac'
import { memoryStore, type IntegrationRow, type SeatRow } from '../store'
import { TEST_INGEST_SECRET, TEST_PROMPT_KEY, TEST_VAULT_KEY } from '../test-fixtures'
import { ingestCanonical, OPERATOR_HMAC_HEADERS } from '../../../src/shared/operator-hmac'
import { handleIntegrationsSeat, refreshDirectOAuthCredential } from './integrations-seat'

/** Same shim `connectors/data.test.ts` and `d1.store.test.ts` use: real SQLite underneath so the HIGH
 *  fix (item 2) exercises the actual `INSERT OR REPLACE` vs. targeted-`UPDATE` distinction between
 *  `store.putIntegration` and `writeIntegrationExtraColumns`, not a mock that can't tell them apart. */
function sqliteD1(db: DatabaseSync): D1DatabaseLike {
  return {
    prepare(sql: string) {
      const stmt = db.prepare(sql)
      let bound: unknown[] = []
      const wrapper = {
        bind(...values: unknown[]) {
          bound = values
          return wrapper
        },
        async first<T>() {
          const row = stmt.get(...(bound as never[]))
          return (row as T) ?? null
        },
        async all<T>() {
          return { results: stmt.all(...(bound as never[])) as T[] }
        },
        async run() {
          return stmt.run(...(bound as never[]))
        }
      }
      return wrapper
    }
  }
}

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  const schema = readFileSync(join(__dirname, '..', '..', 'schema.sql'), 'utf8')
  db.exec(schema)
  for (const stmt of INTEGRATION_ALTERS) db.exec(stmt)
  return db
}

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
  it('401s with missing HMAC headers when unsigned (Worker HMAC gate, not Access)', async () => {
    const store = memoryStore()
    const res = await handleRequest(new Request('https://operator.test/v1/integrations'), env(), {}, { store, now: NOW })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ ok: false, error: 'missing HMAC headers' })
  })

  it('delivers the decrypted credential to an approved, entitled seat and audits the delivery', async () => {
    const store = memoryStore()
    await store.upsertSeat(seat({ device_id: 'device-a-0001' }))
    await store.putIntegration(await integration({ id: 'int-1' }))

    const res = await handleRequest(await signedGet('/v1/integrations', 'device-a-0001'), env(), {}, { store, now: NOW })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; version: number; integrations: { id: string; credential: string; kind: string }[] }
    expect(body.ok).toBe(true)
    expect(body.integrations).toHaveLength(1)
    expect(body.integrations[0]).toMatchObject({ id: 'int-1', kind: 'hubspot', credential: 'crm-secret-token' })
    expect(body.version).toBe(NOW - 1000)

    const grants = await store.listIntegrationGrants('int-1', 10)
    expect(grants).toHaveLength(1)
    expect(grants[0].device_id).toBe('device-a-0001')
    const audit = await store.listAudit(10)
    expect(audit.some((a) => a.action === 'integration-delivered' && a.actor === 'device-a-0001')).toBe(true)
  })

  it('never leaks the raw ciphertext, only the decrypted credential', async () => {
    const store = memoryStore()
    await store.upsertSeat(seat({ device_id: 'device-a-0001' }))
    const row = await integration({ id: 'int-1' })
    await store.putIntegration(row)
    const res = await handleRequest(await signedGet('/v1/integrations', 'device-a-0001'), env(), {}, { store, now: NOW })
    const text = await res.text()
    expect(text).not.toContain(row.cipher)
    expect(text).not.toContain(row.iv!)
  })

  it('excludes an integration scoped to a different tier', async () => {
    const store = memoryStore()
    await store.upsertSeat(seat({ device_id: 'device-a-0001' }))
    await store.putIntegration(await integration({ id: 'int-1', scope_json: JSON.stringify({ tiers: ['metis-light'] }) }))
    const res = await handleRequest(await signedGet('/v1/integrations', 'device-a-0001'), env(), {}, { store, now: NOW })
    const body = (await res.json()) as { ok: boolean; integrations: unknown[] }
    expect(body.ok).toBe(true)
    expect(body.integrations).toHaveLength(0)
  })

  it('403s a seat that is not approved and has no active license', async () => {
    const store = memoryStore()
    await store.upsertSeat(seat({ device_id: 'device-a-0001', approval: 'pending', license: null }))
    await store.putIntegration(await integration({ id: 'int-1' }))
    const res = await handleRequest(await signedGet('/v1/integrations', 'device-a-0001'), env(), {}, { store, now: NOW })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ ok: false, error: 'seat not entitled', code: 'not-entitled' })
  })

  it("403s an entitled seat whose tier lacks the 'integrations' entitlement", async () => {
    const store = memoryStore()
    await store.upsertSeat(seat({ device_id: 'device-a-0001' }))
    await store.putTier({ id: 'metis', label: 'Métis', entitlements_json: JSON.stringify(['ask']), updated_at: NOW })
    await store.putIntegration(await integration({ id: 'int-1' }))
    const res = await handleRequest(await signedGet('/v1/integrations', 'device-a-0001'), env(), {}, { store, now: NOW })
    expect(res.status).toBe(403)
  })

  it('503s when the vault key is unbound', async () => {
    const store = memoryStore()
    await store.upsertSeat(seat({ device_id: 'device-a-0001' }))
    const res = await handleRequest(await signedGet('/v1/integrations', 'device-a-0001'), env({ OPERATOR_VAULT_KEY: undefined }), {}, { store, now: NOW })
    expect(res.status).toBe(503)
  })

  it('rejects a POST (GET-only route, like manifest)', async () => {
    const store = memoryStore()
    await store.upsertSeat(seat({ device_id: 'device-a-0001' }))
    // Same signature as the GET (computed over an empty body): only the method changes, so the
    // request still clears HMAC verification and reaches the GET-only check inside the route.
    const req = await signedGet('/v1/integrations', 'device-a-0001')
    const asPost = new Request(req.url, { method: 'POST', headers: req.headers })
    const res = await handleRequest(asPost, env(), {}, { store, now: NOW })
    expect(res.status).toBe(405)
  })

  it('delivers a brokered connection without a credential, using the gateway endpoint shape', async () => {
    const store = memoryStore()
    await store.upsertSeat(seat({ device_id: 'device-a-0001' }))
    await store.putIntegration(await integration({ id: 'int-1', mode: 'brokered', transport: 'mcp' }))
    const res = await handleRequest(await signedGet('/v1/integrations', 'device-a-0001'), env(), {}, { store, now: NOW })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; integrations: Record<string, unknown>[] }
    expect(body.ok).toBe(true)
    expect(body.integrations).toHaveLength(1)
    const { gatewayToken, ...rest } = body.integrations[0] as { gatewayToken: string; [key: string]: unknown }
    expect(rest).toEqual({
      id: 'int-1',
      kind: 'hubspot',
      label: 'Hubspot prod',
      transport: 'mcp',
      mode: 'brokered',
      endpoint: '/v1/mcp/int-1',
      scopes: {}
    })
    // task B3: a gateway token, verifiable against the same ingest secret, bound to this device and connection.
    expect(typeof gatewayToken).toBe('string')
    const verified = await verifyGatewayToken(TEST_INGEST_SECRET, gatewayToken, NOW)
    expect(verified.ok).toBe(true)
    if (verified.ok) {
      expect(verified.claims.device).toBe('device-a-0001')
      expect(verified.claims.connection).toBe('int-1')
    }
    const text = JSON.stringify(body.integrations)
    expect(text).not.toContain('crm-secret-token')
    expect(text).not.toContain('"credential"')
    expect(text).not.toContain('baseUrl')
  })

  it('defaults to brokered delivery when a row predates the mode column', async () => {
    const store = memoryStore()
    await store.upsertSeat(seat({ device_id: 'device-a-0001' }))
    const row = (await integration({ id: 'int-1' })) as Record<string, unknown>
    delete row.mode
    await store.putIntegration(row as unknown as IntegrationRow)
    const res = await handleRequest(await signedGet('/v1/integrations', 'device-a-0001'), env(), {}, { store, now: NOW })
    const body = (await res.json()) as { ok: boolean; integrations: { mode?: string }[] }
    expect(body.ok).toBe(true)
    expect(body.integrations).toHaveLength(1)
    expect(body.integrations[0].mode).toBe('brokered')
    expect(body.integrations[0]).not.toHaveProperty('credential')
  })
})

async function oauthIntegration(overrides: Partial<IntegrationRow> & Pick<IntegrationRow, 'id'>, payload: Record<string, unknown>): Promise<IntegrationRow> {
  const enc = await encryptVault(JSON.stringify(payload), TEST_VAULT_KEY)
  return {
    kind: 'googledrive',
    label: 'Google Drive',
    base_url: null,
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
    ...overrides,
    mode: 'direct'
  } as unknown as IntegrationRow
}

describe('GET /v1/integrations: auth-code OAuth direct-mode delivery refreshes an expiring token', () => {
  // Calls handleIntegrationsSeat directly (not through handleRequest/signedGet): the refresh's
  // token-endpoint fetch is injected as this function's own last argument, which index.ts's existing
  // 4-argument call site does not thread through HandleOpts.providerFetch (see the doc comment on
  // handleIntegrationsSeat for why). The HMAC layer above it is exercised by every other test in this
  // file; these two are specifically about the refresh wiring.
  it('refreshes an access token within 5 minutes of expiry, delivers the new one, and persists the new ciphertext', async () => {
    const store = memoryStore()
    await store.upsertSeat(seat({ device_id: 'device-oauth-1' }))
    await store.putIntegration(
      await oauthIntegration({ id: 'int-oauth-1' }, { accessToken: 'old-access', refreshToken: 'refresh-abc', expiresAt: NOW + 60_000 })
    )
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ access_token: 'new-access', expires_in: 3600, token_type: 'Bearer' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })) as typeof fetch
    const res = await handleIntegrationsSeat(
      store,
      env({ OAUTH_GOOGLEDRIVE_CLIENT_ID: 'id', OAUTH_GOOGLEDRIVE_CLIENT_SECRET: 'secret' } as Partial<Env>),
      'device-oauth-1',
      NOW,
      fakeFetch
    )
    const body = (await res.json()) as { integrations: { credential?: string }[] }
    expect(body.integrations).toHaveLength(1)
    expect(body.integrations[0].credential).toBe('new-access')

    const stored = await store.getIntegration('int-oauth-1')
    const decrypted = await decryptVault(stored!.cipher!, stored!.iv!, TEST_VAULT_KEY)
    expect(JSON.parse(decrypted)).toMatchObject({ accessToken: 'new-access', refreshToken: 'refresh-abc' })

    const audit = await store.listAudit(10)
    expect(audit.some((a) => a.action === 'integration-oauth-refreshed')).toBe(true)
  })

  it('a failing refresh never deletes the row, marks last_test_json failing, and still delivers the old (expiring) token rather than nothing', async () => {
    const store = memoryStore()
    await store.upsertSeat(seat({ device_id: 'device-oauth-2' }))
    await store.putIntegration(
      await oauthIntegration({ id: 'int-oauth-2' }, { accessToken: 'still-old-access', refreshToken: 'refresh-xyz', expiresAt: NOW + 60_000 })
    )
    const fakeFetch = (async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })) as typeof fetch
    const res = await handleIntegrationsSeat(
      store,
      env({ OAUTH_GOOGLEDRIVE_CLIENT_ID: 'id', OAUTH_GOOGLEDRIVE_CLIENT_SECRET: 'secret' } as Partial<Env>),
      'device-oauth-2',
      NOW,
      fakeFetch
    )
    const body = (await res.json()) as { integrations: { credential?: string }[] }
    expect(body.integrations).toHaveLength(1)
    expect(body.integrations[0].credential).toBe('still-old-access')

    const stored = await store.getIntegration('int-oauth-2')
    expect(stored).not.toBeNull() // never deleted
    expect(stored!.status).toBe('active')
    const extra = readIntegrationExtra(stored as unknown as Record<string, unknown>)
    expect(JSON.parse(extra.last_test_json!)).toMatchObject({ ok: false })

    const audit = await store.listAudit(10)
    expect(audit.some((a) => a.action === 'integration-oauth-refresh-failed')).toBe(true)
  })
})

describe('refreshDirectOAuthCredential: a failing refresh never clobbers a concurrent successful refresh (HIGH fix)', () => {
  it('when D1 is bound, the failure branch writes only last_test_json/last_test_at - a concurrent success\'s fresh cipher/iv survives', async () => {
    const db = sqliteD1(freshDb())
    const store = d1Store(db)
    const staleRow = await oauthIntegration({ id: 'int-race' }, { accessToken: 'old-access', refreshToken: 'refresh-old', expiresAt: NOW + 60_000 })
    await store.putIntegration(staleRow)
    const payload = { accessToken: 'old-access', refreshToken: 'refresh-old', expiresAt: NOW + 60_000 }

    // Two overlapping requests for this same connection would each independently read `staleRow` off
    // the store before either has written back - that is why both calls below are handed the same
    // `staleRow` object, not a re-read of the row, exactly mirroring what two concurrent
    // `handleIntegrationsSeat` calls would each capture. Call A's vendor round trip succeeds first and
    // persists a fresh cipher/iv.
    const fetchSuccess = (async () =>
      new Response(JSON.stringify({ access_token: 'new-access-A', refresh_token: 'refresh-A', expires_in: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })) as typeof fetch
    await refreshDirectOAuthCredential(
      store,
      { OPERATOR_VAULT_KEY: TEST_VAULT_KEY, DB: db, OAUTH_GOOGLEDRIVE_CLIENT_ID: 'id', OAUTH_GOOGLEDRIVE_CLIENT_SECRET: 'secret' } as unknown as Env,
      staleRow,
      payload,
      '{}',
      NOW,
      fetchSuccess
    )

    const afterSuccess = await store.getIntegration('int-race')
    expect(afterSuccess!.cipher).not.toBe(staleRow.cipher) // fresh ciphertext persisted by call A

    // Call B: read the same stale row as call A (it never saw call A's write), but its vendor round
    // trip fails and its write lands after call A's - the exact scenario the old code corrupted.
    const fetchFail = (async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })) as typeof fetch
    await refreshDirectOAuthCredential(store, { OPERATOR_VAULT_KEY: TEST_VAULT_KEY, DB: db }, staleRow, payload, '{}', NOW, fetchFail)

    const afterFailure = await store.getIntegration('int-race')
    expect(afterFailure!.cipher).toBe(afterSuccess!.cipher) // still call A's fresh ciphertext
    expect(afterFailure!.iv).toBe(afterSuccess!.iv)
    const decrypted = await decryptVault(afterFailure!.cipher!, afterFailure!.iv!, TEST_VAULT_KEY)
    expect(JSON.parse(decrypted)).toMatchObject({ accessToken: 'new-access-A', refreshToken: 'refresh-A' })

    // The failure itself is still recorded - item 2 only asks that it stop destroying cipher/iv.
    const extra = readIntegrationExtra(afterFailure as unknown as Record<string, unknown>)
    expect(JSON.parse(extra.last_test_json!)).toMatchObject({ ok: false })
  })

  it('without D1 bound, the failure branch falls back to store.putIntegration (memory store has no targeted-update primitive; single-threaded test/dev use only, nothing to race)', async () => {
    const store = memoryStore()
    const staleRow = await oauthIntegration({ id: 'int-mem' }, { accessToken: 'old-access', refreshToken: 'refresh-old', expiresAt: NOW + 60_000 })
    await store.putIntegration(staleRow)
    const payload = { accessToken: 'old-access', refreshToken: 'refresh-old', expiresAt: NOW + 60_000 }
    const fetchFail = (async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })) as typeof fetch
    await refreshDirectOAuthCredential(store, { OPERATOR_VAULT_KEY: TEST_VAULT_KEY }, staleRow, payload, '{}', NOW, fetchFail)
    const after = await store.getIntegration('int-mem')
    expect(after!.cipher).toBe(staleRow.cipher) // no successful refresh happened here, so nothing to preserve or destroy
  })
})

describe('heartbeat integrationsVersion', () => {
  it('carries the max rotated_at/created_at of the seat entitled integrations, 0 with none', async () => {
    const store = memoryStore()
    await store.upsertSeat(seat({ device_id: 'device-a-0001' }))
    const ts = String(NOW)
    const nonce = 'hb-nonce-1'
    const bodyText = JSON.stringify({ os: 'darwin', appVersion: '1.8.5' })
    const bodyHash = await sha256Hex(bodyText)
    const sig = await hmacHex(TEST_INGEST_SECRET, ingestCanonical(ts, nonce, 'device-a-0001', bodyHash))
    const req = new Request('https://operator.test/v1/heartbeat', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [OPERATOR_HMAC_HEADERS.ts]: ts,
        [OPERATOR_HMAC_HEADERS.nonce]: nonce,
        [OPERATOR_HMAC_HEADERS.device]: 'device-a-0001',
        [OPERATOR_HMAC_HEADERS.sig]: sig
      },
      body: bodyText
    })
    const zero = await handleRequest(req, env(), {}, { store, now: NOW })
    expect(((await zero.json()) as { integrationsVersion: number }).integrationsVersion).toBe(0)

    await store.putIntegration(await integration({ id: 'int-1', rotated_at: NOW - 500, created_at: NOW - 1000 }))
    const ts2 = String(NOW + 1)
    const nonce2 = 'hb-nonce-2'
    const sig2 = await hmacHex(TEST_INGEST_SECRET, ingestCanonical(ts2, nonce2, 'device-a-0001', bodyHash))
    const req2 = new Request('https://operator.test/v1/heartbeat', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [OPERATOR_HMAC_HEADERS.ts]: ts2,
        [OPERATOR_HMAC_HEADERS.nonce]: nonce2,
        [OPERATOR_HMAC_HEADERS.device]: 'device-a-0001',
        [OPERATOR_HMAC_HEADERS.sig]: sig2
      },
      body: bodyText
    })
    const withVersion = await handleRequest(req2, env(), {}, { store, now: NOW + 1 })
    expect(((await withVersion.json()) as { integrationsVersion: number }).integrationsVersion).toBe(NOW - 500)
  })
})
