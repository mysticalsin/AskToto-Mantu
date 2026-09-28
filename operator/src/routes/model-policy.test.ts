import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { handleRequest, type Env } from '../index'
import { hmacHex } from '../hmac'
import { sha256Hex } from '../crypto'
import type { D1DatabaseLike } from '../d1'
import { memoryStore } from '../store'
import { TEST_INGEST_SECRET, TEST_PROMPT_KEY, TEST_ADMIN_EMAILS, TEST_ADMIN_EMAIL, TEST_OWNER_EMAIL } from '../test-fixtures'
import { ingestCanonical, OPERATOR_HMAC_HEADERS } from '../../../src/shared/operator-hmac'
import { MODEL_POLICY_CAPABILITIES, verifyModelPolicySignature } from '../../../src/shared/model-policy'
import { MODEL_POLICY_MIGRATIONS } from '../model-policy'

const NOW = 1_725_000_000_000

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
  for (const stmt of MODEL_POLICY_MIGRATIONS) db.exec(stmt)
  return db
}

function env(overrides: Partial<Env> = {}): Env {
  return {
    OPERATOR_INGEST_SECRET: TEST_INGEST_SECRET,
    OPERATOR_PROMPT_KEY: TEST_PROMPT_KEY,
    ADMIN_EMAILS: TEST_ADMIN_EMAILS,
    OWNER_EMAILS: TEST_OWNER_EMAIL,
    OPERATOR_SKILL_PRIVATE_KEY: '',
    ...overrides
  }
}

function capabilities(overrides: Record<string, { provider: string; model: string; fallbacks?: unknown[] }> = {}) {
  const base = Object.fromEntries(
    MODEL_POLICY_CAPABILITIES.map((k) => [k, { provider: 'anthropic', model: 'claude-sonnet-4-6', fallbacks: [] }])
  )
  return { ...base, ...overrides }
}

const ownerAccess = { getIdentity: async () => ({ email: TEST_OWNER_EMAIL }) }
const nonOwnerAdminAccess = { getIdentity: async () => ({ email: TEST_ADMIN_EMAIL }) }

async function signedGet(path: string, deviceId: string, secret = TEST_INGEST_SECRET): Promise<Request> {
  const ts = String(NOW)
  const nonce = `nonce-${Math.random().toString(16).slice(2)}`
  const bodyHash = await sha256Hex('')
  const sig = await hmacHex(secret, ingestCanonical(ts, nonce, deviceId, bodyHash))
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

describe('GET/PUT /v1/admin/model-policy.json', () => {
  it('GET returns null policy and isOwner before anyone has set one', async () => {
    const res = await handleRequest(
      new Request('https://operator.test/v1/admin/model-policy.json'),
      { ...env(), DB: sqliteD1(freshDb()) },
      { access: ownerAccess },
      { store: memoryStore(), now: NOW }
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { policy: unknown; isOwner: boolean }
    expect(body.policy).toBeNull()
    expect(body.isOwner).toBe(true)
  })

  it('GET reports isOwner:false for an admin who is not the configured owner', async () => {
    const res = await handleRequest(
      new Request('https://operator.test/v1/admin/model-policy.json'),
      { ...env(), DB: sqliteD1(freshDb()) },
      { access: nonOwnerAdminAccess },
      { store: memoryStore(), now: NOW }
    )
    const body = (await res.json()) as { isOwner: boolean }
    expect(body.isOwner).toBe(false)
  })

  it('reports isOwner:false for every admin when OWNER_EMAILS is not configured (fail closed)', async () => {
    const res = await handleRequest(
      new Request('https://operator.test/v1/admin/model-policy.json'),
      { ...env({ OWNER_EMAILS: undefined }), DB: sqliteD1(freshDb()) },
      { access: ownerAccess },
      { store: memoryStore(), now: NOW }
    )
    const body = (await res.json()) as { isOwner: boolean }
    expect(body.isOwner).toBe(false)
  })

  it('PUT by the owner validates, persists, and audits a before/after snapshot', async () => {
    const db = sqliteD1(freshDb())
    const store = memoryStore()
    const put = await handleRequest(
      new Request('https://operator.test/v1/admin/model-policy.json', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ capabilities: capabilities({ askChat: { provider: 'openai', model: 'gpt-5' } }) })
      }),
      { ...env(), DB: db },
      { access: ownerAccess },
      { store, now: NOW }
    )
    expect(put.status).toBe(200)
    const putBody = (await put.json()) as { policy: { capabilities: { askChat: { provider: string; model: string } } } }
    expect(putBody.policy.capabilities.askChat).toEqual({ provider: 'openai', model: 'gpt-5', fallbacks: [] })

    const auditRows = await store.listAudit(10, { action: 'model-policy.update' })
    expect(auditRows).toHaveLength(1)
    expect(auditRows[0].detail).toContain('openai')

    const get = await handleRequest(
      new Request('https://operator.test/v1/admin/model-policy.json'),
      { ...env(), DB: db },
      { access: ownerAccess },
      { store, now: NOW + 1000 }
    )
    const getBody = (await get.json()) as { policy: { capabilities: { askChat: { provider: string } } } }
    expect(getBody.policy.capabilities.askChat.provider).toBe('openai')
  })

  it('PUT by a non-owner admin is refused with 403 and an audit event, writing nothing', async () => {
    const db = sqliteD1(freshDb())
    const store = memoryStore()
    const res = await handleRequest(
      new Request('https://operator.test/v1/admin/model-policy.json', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ capabilities: capabilities() })
      }),
      { ...env(), DB: db },
      { access: nonOwnerAdminAccess },
      { store, now: NOW }
    )
    expect(res.status).toBe(403)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('not-owner')
    expect(await store.listAudit(10, { action: 'model-policy.denied' })).toHaveLength(1)
    expect(await store.listAudit(10, { action: 'model-policy.update' })).toHaveLength(0)
  })

  it('PUT with an invalid capability shape is rejected with 400, writing nothing', async () => {
    const db = sqliteD1(freshDb())
    const res = await handleRequest(
      new Request('https://operator.test/v1/admin/model-policy.json', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ capabilities: capabilities({ askChat: { provider: '', model: 'x' } }) })
      }),
      { ...env(), DB: db },
      { access: ownerAccess },
      { store: memoryStore(), now: NOW }
    )
    expect(res.status).toBe(400)
  })

  it('requires admin auth for GET and PUT', async () => {
    const denied = { access: { getIdentity: async () => null } }
    const get = await handleRequest(
      new Request('https://operator.test/v1/admin/model-policy.json'),
      env(),
      denied,
      { store: memoryStore(), now: NOW }
    )
    expect(get.status).toBe(401)
    const put = await handleRequest(
      new Request('https://operator.test/v1/admin/model-policy.json', { method: 'PUT', body: '{}' }),
      env(),
      denied,
      { store: memoryStore(), now: NOW }
    )
    expect(put.status).toBe(401)
  })
})

describe('GET /v1/model-policy (device-authenticated)', () => {
  it('returns policy:null (not managed) when no policy has been set', async () => {
    const req = await signedGet('/v1/model-policy', 'a'.repeat(32))
    const res = await handleRequest(req, { ...env(), DB: sqliteD1(freshDb()) }, {}, { store: memoryStore(), now: NOW })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; policy: unknown }
    expect(body.ok).toBe(true)
    expect(body.policy).toBeNull()
  })

  it('returns a signed policy a device can verify with the same secret it authenticated with', async () => {
    const db = sqliteD1(freshDb())
    await db.prepare('INSERT INTO model_policy (id, policy_json, updated_at, updated_by) VALUES (?, ?, ?, ?)').bind(
      'fleet',
      JSON.stringify({ version: NOW, updatedAt: NOW, updatedBy: 'owner@example.test', capabilities: capabilities() }),
      NOW,
      'owner@example.test'
    ).run()
    const req = await signedGet('/v1/model-policy', 'a'.repeat(32))
    const res = await handleRequest(req, { ...env(), DB: db }, {}, { store: memoryStore(), now: NOW })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; policy: { version: number }; signature: string }
    expect(body.ok).toBe(true)
    expect(body.policy.version).toBe(NOW)
    expect(await verifyModelPolicySignature(TEST_INGEST_SECRET, body.policy as never, body.signature)).toBe(true)
  })

  it('rejects an unauthenticated (unsigned) request the same way every other device route does', async () => {
    const res = await handleRequest(
      new Request('https://operator.test/v1/model-policy'),
      { ...env(), DB: sqliteD1(freshDb()) },
      {},
      { store: memoryStore(), now: NOW }
    )
    expect(res.status).toBe(401)
  })

  it('rejects a request signed with the wrong secret', async () => {
    const db = sqliteD1(freshDb())
    await db.prepare('INSERT INTO model_policy (id, policy_json, updated_at, updated_by) VALUES (?, ?, ?, ?)').bind(
      'fleet',
      JSON.stringify({ version: NOW, updatedAt: NOW, updatedBy: 'owner@example.test', capabilities: capabilities() }),
      NOW,
      'owner@example.test'
    ).run()
    const req = await signedGet('/v1/model-policy', 'a'.repeat(32), 'wrong-secret')
    const res = await handleRequest(req, { ...env(), DB: db }, {}, { store: memoryStore(), now: NOW })
    expect(res.status).toBe(401)
  })
})
