import { describe, expect, it } from 'vitest'
import { handleRequest, type Env } from '../index'
import { encryptVault } from '../crypto'
import { memoryStore, type IntegrationRow } from '../store'
import { TEST_INGEST_SECRET, TEST_PROMPT_KEY, TEST_VAULT_KEY } from '../test-fixtures'
import { readIntegrationExtra } from '../connectors/data'

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

const tony = { getIdentity: async () => ({ email: 'tony.walteur@gmail.com' }) }

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://operator.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...headers },
    body: JSON.stringify(body)
  })
}

function patch(path: string, body: unknown): Request {
  return new Request(`https://operator.test${path}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify(body)
  })
}

function del(path: string): Request {
  return new Request(`https://operator.test${path}`, { method: 'DELETE', headers: { 'sec-fetch-site': 'same-origin' } })
}

function get(path: string): Request {
  return new Request(`https://operator.test${path}`)
}

async function addHubspot(store: ReturnType<typeof memoryStore>, overrides: Record<string, unknown> = {}) {
  const res = await handleRequest(
    post('/v1/admin/integrations', { kind: 'hubspot', label: 'Hubspot prod', credential: 'pat-na1-secret-value-123', ...overrides }),
    env(),
    { access: tony },
    { store, now: NOW }
  )
  return (await res.json()) as { ok: boolean; integration?: { id: string; last4?: string; kind: string } }
}

describe('GET /v1/admin/connectors/catalog', () => {
  it('lists every kind with fields, never a probe URL or body template', async () => {
    const store = memoryStore()
    const res = await handleRequest(get('/v1/admin/connectors/catalog'), env(), { access: tony }, { store, now: NOW })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; catalog: { kind: string; fields: unknown[] }[] }
    expect(body.ok).toBe(true)
    expect(body.catalog.find((c) => c.kind === 'hubspot')?.fields.length).toBeGreaterThan(0)
    const text = JSON.stringify(body.catalog)
    expect(text).not.toContain('access-token-info')
    expect(text).not.toContain('bodyTemplate')
  })
})

describe('unauth and CSRF', () => {
  it('401s every admin integrations route without Access identity', async () => {
    const store = memoryStore()
    const catalog = await handleRequest(get('/v1/admin/connectors/catalog'), env(), {}, { store, now: NOW })
    expect(catalog.status).toBe(401)
    const list = await handleRequest(get('/v1/admin/integrations'), env(), {}, { store, now: NOW })
    expect(list.status).toBe(401)
    const add = await handleRequest(post('/v1/admin/integrations', { kind: 'hubspot' }), env(), {}, { store, now: NOW })
    expect(add.status).toBe(401)
  })

  it('403s a cross-site POST with code csrf', async () => {
    const store = memoryStore()
    const res = await handleRequest(
      post('/v1/admin/integrations', { kind: 'hubspot', credential: 'x' }, { 'sec-fetch-site': 'cross-site' }),
      env(),
      { access: tony },
      { store, now: NOW }
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ ok: false, error: 'cross-site request refused', code: 'csrf' })
  })
})

describe('POST /v1/admin/integrations', () => {
  it('refuses an unknown kind', async () => {
    const store = memoryStore()
    const res = await handleRequest(post('/v1/admin/integrations', { kind: 'not-a-kind', credential: 'x' }), env(), { access: tony }, { store, now: NOW })
    expect(res.status).toBe(400)
    expect((await res.json()) as { code: string }).toMatchObject({ code: 'unknown-kind' })
  })

  it('refuses a needs-oauth kind with code needs-oauth', async () => {
    const store = memoryStore()
    const res = await handleRequest(
      post('/v1/admin/integrations', { kind: 'salesforce', label: 'SF', credential: 'x' }),
      env(),
      { access: tony },
      { store, now: NOW }
    )
    expect(res.status).toBe(400)
    expect((await res.json()) as { code: string }).toMatchObject({ code: 'needs-oauth' })
    expect((await store.listIntegrationRows()).length).toBe(0)
  })

  it('503s with code vault-unbound when the vault key is missing', async () => {
    const store = memoryStore()
    const res = await handleRequest(
      post('/v1/admin/integrations', { kind: 'hubspot', label: 'Hubspot prod', credential: 'pat-na1-x' }),
      env({ OPERATOR_VAULT_KEY: undefined }),
      { access: tony },
      { store, now: NOW }
    )
    expect(res.status).toBe(503)
    expect((await res.json()) as { code: string }).toMatchObject({ code: 'vault-unbound' })
  })

  it('rejects a required field missing (e.g. Jira without a site)', async () => {
    const store = memoryStore()
    const res = await handleRequest(
      post('/v1/admin/integrations', { kind: 'jira', label: 'Jira', credential: 'tok', config: { email: 'a@b.com' } }),
      env(),
      { access: tony },
      { store, now: NOW }
    )
    expect(res.status).toBe(400)
  })

  it('adds a connection and returns last4 only, never the credential or cipher', async () => {
    const store = memoryStore()
    const secret = 'pat-na1-super-secret-value-9999'
    const res = await handleRequest(
      post('/v1/admin/integrations', { kind: 'hubspot', label: 'Hubspot prod', credential: secret }),
      env(),
      { access: tony },
      { store, now: NOW }
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; integration: Record<string, unknown> }
    expect(body.ok).toBe(true)
    expect(body.integration.last4).toBe('9999')
    expect(body.integration).not.toHaveProperty('credential')
    expect(body.integration).not.toHaveProperty('cipher')
    expect(body.integration).not.toHaveProperty('iv')
    const text = JSON.stringify(body)
    expect(text).not.toContain(secret)

    const rows = await store.listIntegrationRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].last4).toBe('9999')
    const extra = readIntegrationExtra(rows[0] as unknown as Record<string, unknown>)
    expect(extra.mode).toBe('brokered')
    expect(extra.auth_kind).toBe('bearer')

    const audit = await store.listAudit(10)
    const entry = audit.find((a) => a.action === 'integration-add')
    expect(entry).toBeTruthy()
    expect(entry!.detail).not.toContain(secret)
  })

  it('defaults to direct mode only when the caller explicitly asks for it', async () => {
    const store = memoryStore()
    const res = await handleRequest(
      post('/v1/admin/integrations', { kind: 'hubspot', label: 'Hubspot prod', credential: 'pat-na1-abcd', mode: 'direct' }),
      env(),
      { access: tony },
      { store, now: NOW }
    )
    const body = (await res.json()) as { integration: { mode: string } }
    expect(body.integration.mode).toBe('direct')
  })
})

describe('PATCH /v1/admin/integrations/:id', () => {
  it('never accepts a credential and updates label/notes/scope', async () => {
    const store = memoryStore()
    const added = await addHubspot(store)
    const id = added.integration!.id
    const res = await handleRequest(
      patch(`/v1/admin/integrations/${id}`, { label: 'Renamed', notes: 'careful', credential: 'sneaky', scope: { tiers: ['metis'] } }),
      env(),
      { access: tony },
      { store, now: NOW + 1 }
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { integration: { label: string; notes: string; scope: unknown } }
    expect(body.integration.label).toBe('Renamed')
    expect(body.integration.notes).toBe('careful')
    expect(body.integration.scope).toEqual({ tiers: ['metis'] })

    const row = await store.getIntegration(id)
    expect(row!.last4).toBe(added.integration!.last4) // PATCH never touches the credential
    const text = JSON.stringify(body)
    expect(text).not.toContain('sneaky')
  })

  it('404s an unknown id', async () => {
    const store = memoryStore()
    const res = await handleRequest(patch('/v1/admin/integrations/missing', { label: 'x' }), env(), { access: tony }, { store, now: NOW })
    expect(res.status).toBe(404)
  })
})

describe('rotate / revoke / delete', () => {
  it('rotate changes last4 and re-encrypts, leaving status alone', async () => {
    const store = memoryStore()
    const added = await addHubspot(store)
    const id = added.integration!.id
    const res = await handleRequest(post(`/v1/admin/integrations/${id}/rotate`, { credential: 'pat-na1-newvalue-7777' }), env(), { access: tony }, { store, now: NOW + 1 })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { last4: string; status: string }
    expect(body.last4).toBe('7777')
    expect(body.status).toBe('active')
    const row = await store.getIntegration(id)
    expect(row!.last4).toBe('7777')
    expect(row!.rotated_at).toBe(NOW + 1)
  })

  it('rotate 400s a revoked connection', async () => {
    const store = memoryStore()
    const added = await addHubspot(store)
    const id = added.integration!.id
    await handleRequest(post(`/v1/admin/integrations/${id}/revoke`, {}), env(), { access: tony }, { store, now: NOW })
    const res = await handleRequest(post(`/v1/admin/integrations/${id}/rotate`, { credential: 'x' }), env(), { access: tony }, { store, now: NOW + 1 })
    expect(res.status).toBe(400)
  })

  it('revoke clears the cipher/iv and sets status revoked', async () => {
    const store = memoryStore()
    const added = await addHubspot(store)
    const id = added.integration!.id
    const res = await handleRequest(post(`/v1/admin/integrations/${id}/revoke`, {}), env(), { access: tony }, { store, now: NOW + 2 })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, id, status: 'revoked' })
    const row = await store.getIntegration(id)
    expect(row!.status).toBe('revoked')
    expect(row!.cipher).toBeNull()
    expect(row!.iv).toBeNull()
    expect(row!.revoked_at).toBe(NOW + 2)
  })

  it('delete refuses a non-revoked connection, and answers honestly (501) with no D1 bound even once revoked', async () => {
    const store = memoryStore()
    const added = await addHubspot(store)
    const id = added.integration!.id
    const beforeRevoke = await handleRequest(del(`/v1/admin/integrations/${id}`), env(), { access: tony }, { store, now: NOW })
    expect(beforeRevoke.status).toBe(400)

    await handleRequest(post(`/v1/admin/integrations/${id}/revoke`, {}), env(), { access: tony }, { store, now: NOW })
    const afterRevoke = await handleRequest(del(`/v1/admin/integrations/${id}`), env(), { access: tony }, { store, now: NOW })
    expect(afterRevoke.status).toBe(501)
    expect((await afterRevoke.json()) as { code: string }).toMatchObject({ code: 'no-db' })
  })
})

describe('POST /v1/admin/integrations/test (draft) and /:id/test (stored)', () => {
  it('draft test runs the probe and stores nothing', async () => {
    const store = memoryStore()
    const fakeFetch = (async () =>
      // Real shape of GET /account-info/v3/details (the verified HubSpot endpoint): portalId, not hubId.
      new Response(JSON.stringify({ portalId: 42424242 }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
    const res = await handleRequest(
      post('/v1/admin/integrations/test', { kind: 'hubspot', credential: 'pat-na1-draft-secret' }),
      env(),
      { access: tony },
      { store, now: NOW, providerFetch: fakeFetch }
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; result: { ok: boolean; summary: string } }
    expect(body.result.ok).toBe(true)
    expect(body.result.summary).toContain('42424242')
    expect(await store.listIntegrationRows()).toHaveLength(0)
    const audit = await store.listAudit(10)
    expect(audit.some((a) => a.action === 'integration-test-draft')).toBe(true)
  })

  it('draft test refuses a needs-oauth kind', async () => {
    const store = memoryStore()
    const res = await handleRequest(post('/v1/admin/integrations/test', { kind: 'zoho', credential: 'x' }), env(), { access: tony }, { store, now: NOW })
    expect(res.status).toBe(400)
    expect((await res.json()) as { code: string }).toMatchObject({ code: 'needs-oauth' })
  })

  it('stored test runs an MCP handshake, saves the tool list, and flips status on failure', async () => {
    const store = memoryStore()
    const enc = await encryptVault('mcp-secret-token', TEST_VAULT_KEY)
    const row: IntegrationRow = {
      id: 'int-mcp',
      kind: 'custom-mcp',
      label: 'My MCP server',
      base_url: 'https://mcp.example.com',
      cipher: enc.cipher,
      iv: enc.iv,
      last4: 'oken',
      scope_json: '{}',
      status: 'active',
      created_at: NOW,
      created_by: 'tony.walteur@gmail.com',
      rotated_at: null,
      revoked_at: null,
      last_used_at: null,
      uses: 0
    }
    await store.putIntegration({ ...row, mode: 'brokered', transport: 'mcp', config_json: JSON.stringify({ baseUrl: 'https://mcp.example.com' }) } as unknown as IntegrationRow)

    let call = 0
    const fakeFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      call += 1
      const bodyText = typeof init?.body === 'string' ? init.body : '{}'
      const parsed = JSON.parse(bodyText) as { method?: string }
      if (parsed.method === 'initialize') {
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'Test MCP' } } }),
          { status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' } }
        )
      }
      if (parsed.method === 'notifications/initialized') {
        return new Response(null, { status: 202 })
      }
      if (parsed.method === 'tools/list') {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            result: {
              tools: [
                { name: 'list_things', description: 'List things', annotations: { readOnlyHint: true } },
                { name: 'create_thing', description: 'Create a thing' }
              ]
            }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }
      throw new Error(`unexpected call ${call}: ${bodyText}`)
    }) as typeof fetch

    const res = await handleRequest(
      post('/v1/admin/integrations/int-mcp/test', {}),
      env(),
      { access: tony },
      { store, now: NOW + 5, providerFetch: fakeFetch }
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { result: { ok: boolean; tools: { name: string; write: boolean }[] } }
    expect(body.result.ok).toBe(true)
    expect(body.result.tools).toEqual([
      { name: 'list_things', description: 'List things', write: false },
      { name: 'create_thing', description: 'Create a thing', write: true }
    ])

    const stored = await store.getIntegration('int-mcp')
    expect(stored!.status).toBe('active')
    const extra = readIntegrationExtra(stored as unknown as Record<string, unknown>)
    expect(extra.last_test_at).toBe(NOW + 5)
    expect(JSON.parse(extra.tools_json!)).toEqual(body.result.tools)
    expect(JSON.stringify(extra.last_test_json)).not.toContain('mcp-secret-token')
  })

  it('a failed test sets status failing (not the seat-delivery status active)', async () => {
    const store = memoryStore()
    const added = await addHubspot(store)
    const id = added.integration!.id
    const fakeFetch = (async () => new Response('nope', { status: 401 })) as typeof fetch
    const res = await handleRequest(post(`/v1/admin/integrations/${id}/test`, {}), env(), { access: tony }, { store, now: NOW + 9, providerFetch: fakeFetch })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { result: { ok: boolean } }
    expect(body.result.ok).toBe(false)
    const row = await store.getIntegration(id)
    expect(row!.status).toBe('failing')
  })
})
