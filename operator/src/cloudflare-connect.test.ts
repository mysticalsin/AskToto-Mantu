import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { reviewedGatewayReply } from './ai-gateway.privacy-fixture'
import { describe, expect, it } from 'vitest'
import {
  CF_CALLBACK_PATH,
  CF_CONNECT_PATH,
  CF_OAUTH_AUTHORIZE,
  CF_OAUTH_COOKIE,
  CF_OAUTH_MISSING,
  CF_OAUTH_TOKEN
} from './cloudflare-connect'
import { d1Store, type D1DatabaseLike } from './d1'
import { handleRequest, type Env } from './index'
import { memoryStore, type OperatorStore } from './store'
import { TEST_INGEST_SECRET, TEST_PROMPT_KEY, TEST_ADMIN_EMAILS, TEST_TEAM_DOMAIN, TEST_VAULT_KEY } from './test-fixtures'
import { hmacHex } from './hmac'
import { sha256Hex } from './crypto'
import { ingestCanonical, OPERATOR_HMAC_HEADERS } from '../../src/shared/operator-hmac'

const NOW = 1_725_000_000_000
const tony = { getIdentity: async () => ({ email: 'owner@example.test' }) }
const TOKEN = 'cf-oauth-access-token-xx42'
const ACCOUNT = '00000000000000000000000000000000'

function env(extra: Partial<Env> = {}): Env {
  return {
    OPERATOR_INGEST_SECRET: TEST_INGEST_SECRET,
    OPERATOR_PROMPT_KEY: TEST_PROMPT_KEY,
    ADMIN_EMAILS: TEST_ADMIN_EMAILS,
    OPERATOR_SKILL_PRIVATE_KEY: 'unused',
    OPERATOR_VAULT_KEY: TEST_VAULT_KEY,
    TEAM_DOMAIN: TEST_TEAM_DOMAIN,
    CF_OAUTH_CLIENT_ID: 'cf-oauth-client-test',
    CF_OAUTH_CLIENT_SECRET: 'cf-oauth-secret-test',
    ...extra
  }
}

function requestUrl(input: RequestInfo | URL): URL {
  return new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
}

/** Drives the connect step alone: GET /cloudflare/connect, then the state cookie and the
 * `state` param a callback needs to prove it belongs to the same OAuth round-trip. */
async function startCloudflareOAuth(store: OperatorStore): Promise<{ cookie: string; state: string }> {
  const start = await handleRequest(
    new Request(`https://operator.test${CF_CONNECT_PATH}`),
    env(),
    { access: tony },
    { store, now: NOW }
  )
  const cookie = (start.headers.get('set-cookie') || '').split(';')[0]
  const state = new URL(start.headers.get('location') || 'https://x.test').searchParams.get('state') || ''
  return { cookie, state }
}

function cfFetch(input: RequestInfo | URL): Promise<Response> {
  const url = requestUrl(input)
  if (url.href === CF_OAUTH_TOKEN || url.pathname.endsWith('/oauth2/token')) {
    return Promise.resolve(
      new Response(JSON.stringify({ access_token: TOKEN, token_type: 'bearer' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    )
  }
  if (url.pathname === '/client/v4/accounts' || url.pathname.endsWith('/accounts')) {
    return Promise.resolve(
      new Response(JSON.stringify({ result: [{ id: ACCOUNT, name: 'Tony' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    )
  }
  if (url.pathname.includes('/ai-gateway/gateways')) {
    return Promise.resolve(reviewedGatewayReply())
  }
  if (url.pathname.endsWith('/ai/v1/chat/completions')) {
    return Promise.resolve(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'ok from AI Gateway' } }],
          usage: { prompt_tokens: 2, completion_tokens: 3 }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    )
  }
  return Promise.resolve(new Response('{"success":false}', { status: 404 }))
}

describe('Cloudflare AI Gateway plug-and-play', () => {
  it('identity GET /cloudflare/connect 302s to Cloudflare OAuth, not a paste form', async () => {
    const res = await handleRequest(
      new Request(`https://operator.test${CF_CONNECT_PATH}`),
      env(),
      { access: tony },
      { store: memoryStore(), now: NOW }
    )
    expect(res.status).toBe(302)
    const loc = res.headers.get('location') || ''
    expect(loc.startsWith(CF_OAUTH_AUTHORIZE)).toBe(true)
    expect(loc).toContain('client_id=cf-oauth-client-test')
    expect(loc).toContain(encodeURIComponent('https://operator.test/cloudflare/callback'))
    expect(loc).toContain('response_type=code')
    expect(res.headers.get('set-cookie') || '').toContain(`${CF_OAUTH_COOKIE}=`)
    const body = await res.text()
    expect(body).not.toContain('Account ID')
    expect(body).not.toContain(TOKEN)
  })

  it('requests only the scopes a named Cloudflare call site needs', async () => {
    // The call-site-to-scope mapping is documented once, on CF_OAUTH_SCOPES in
    // cloudflare-connect.ts. EXPECTED_SCOPES is a separate, hand-written list — not derived
    // from that constant — so a scope added there without a call site still fails here.
    const EXPECTED_SCOPES = ['account:read', 'ai-gateway:read', 'd1:read', 'workers-ai:run', 'workers:read']
    const res = await handleRequest(
      new Request(`https://operator.test${CF_CONNECT_PATH}`),
      env(),
      { access: tony },
      { store: memoryStore(), now: NOW }
    )
    const loc = res.headers.get('location') || ''
    const scope = new URL(loc).searchParams.get('scope') || ''
    expect(scope.split(' ').filter(Boolean).sort()).toEqual(EXPECTED_SCOPES)
  })

  it('fails loud when the OAuth client is missing', async () => {
    const res = await handleRequest(
      new Request(`https://operator.test${CF_CONNECT_PATH}`),
      env({ CF_OAUTH_CLIENT_ID: '', CF_OAUTH_CLIENT_SECRET: '' }),
      { access: tony },
      { store: memoryStore(), now: NOW }
    )
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ ok: false, error: CF_OAUTH_MISSING })
  })

  it('callback exchanges the code and writes AI Gateway + account keys, last4 only', async () => {
    const store = memoryStore()
    const { cookie, state } = await startCloudflareOAuth(store)
    const cb = await handleRequest(
      new Request(`https://operator.test${CF_CALLBACK_PATH}?code=auth-code-1&state=${state}`, {
        headers: { cookie }
      }),
      env(),
      { access: tony },
      { store, now: NOW, cfFetch }
    )
    expect(cb.status).toBe(303)
    expect(cb.headers.get('location')).toBe('/?cf=connected#keys')
    const vault = await store.listVaultMeta()
    expect(vault.map((v) => v.provider).sort()).toEqual(['cloudflare', 'cloudflare-account'])
    expect(vault.every((v) => v.last4 === 'xx42' && v.status === 'active')).toBe(true)
    expect(JSON.stringify(vault)).not.toContain(TOKEN)
    expect(JSON.stringify(await store.listEvents(10))).not.toContain(TOKEN)
  })

  it('reads the gateway privacy check exactly once while provisioning both vault rows', async () => {
    const store = memoryStore()
    const { cookie, state } = await startCloudflareOAuth(store)
    let gatewayGets = 0
    const countingCfFetch: typeof fetch = async (input) => {
      if (requestUrl(input).pathname.includes('/ai-gateway/gateways')) gatewayGets += 1
      return cfFetch(input)
    }
    const cb = await handleRequest(
      new Request(`https://operator.test${CF_CALLBACK_PATH}?code=auth-code-count&state=${state}`, {
        headers: { cookie }
      }),
      env(),
      { access: tony },
      { store, now: NOW, cfFetch: countingCfFetch }
    )
    expect(cb.status).toBe(303)
    expect(cb.headers.get('location')).toBe('/?cf=connected#keys')
    expect(gatewayGets).toBe(1)
    expect((await store.listVaultMeta()).map((v) => v.provider).sort()).toEqual(['cloudflare', 'cloudflare-account'])
  })

  for (const [label, gatewayReply] of [
    ['the gateway is missing (404)', () => new Response('{"success":false}', { status: 404 })],
    ['logging is left on', () => new Response(JSON.stringify({
      success: true, result: { id: 'default', collect_logs: true, cache_ttl: 0, logpush: false }
    }), { status: 200, headers: { 'content-type': 'application/json' } })]
  ] as const) {
    it(`callback redirects to the keys page and writes no vault row when ${label}`, async () => {
      const store = memoryStore()
      const { cookie, state } = await startCloudflareOAuth(store)
      const unsafeCfFetch: typeof fetch = async (input) => {
        if (requestUrl(input).pathname.includes('/ai-gateway/gateways')) return gatewayReply()
        return cfFetch(input)
      }
      const cb = await handleRequest(
        new Request(`https://operator.test${CF_CALLBACK_PATH}?code=auth-code-unsafe&state=${state}`, {
          headers: { cookie }
        }),
        env(),
        { access: tony },
        { store, now: NOW, cfFetch: unsafeCfFetch }
      )
      expect(cb.status).toBe(303)
      expect(cb.headers.get('location')).toBe('/?cf=failed#keys')
      // The OAuth state cookie is cleared on every redirect out of the callback, including this one.
      expect(cb.headers.get('set-cookie') || '').toContain(`${CF_OAUTH_COOKIE}=;`)
      expect(await store.listVaultMeta()).toEqual([])
    })
  }

  it('authorized seat can /v1/use cloudflare after the provisioned key', async () => {
    const store = memoryStore()
    const { cookie, state } = await startCloudflareOAuth(store)
    await handleRequest(
      new Request(`https://operator.test${CF_CALLBACK_PATH}?code=auth-code-2&state=${state}`, {
        headers: { cookie }
      }),
      env(),
      { access: tony },
      { store, now: NOW, cfFetch }
    )
    await store.upsertSeat({
      device_id: 'device-aig',
      seat_hash: 'device-aig',
      os: 'darwin',
      app_version: '1.8.3',
      first_seen: NOW,
      last_seen: NOW,
      country: 'CA',
      city: 'Longueuil',
      lat: 45.5,
      lon: -73.5,
      last_index_at: null,
      hostname: 'Tonys-MacBook-Pro',
      sso_email: 'owner@example.test',
      license: 'licensed',
      approval: 'approved'
    })
    const useBody = JSON.stringify({
      provider: 'cloudflare',
      model: '@cf/meta/llama-4-scout-17b-16e-instruct',
      messages: [{ role: 'user', content: 'hi' }]
    })
    const ts = String(NOW)
    const nonce = 'use-aig'
    const deviceId = 'device-aig'
    const res = await handleRequest(
      new Request('https://operator.test/v1/use', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [OPERATOR_HMAC_HEADERS.ts]: ts,
          [OPERATOR_HMAC_HEADERS.nonce]: nonce,
          [OPERATOR_HMAC_HEADERS.device]: deviceId,
          [OPERATOR_HMAC_HEADERS.sig]: await hmacHex(
            TEST_INGEST_SECRET,
            ingestCanonical(ts, nonce, deviceId, await sha256Hex(useBody))
          )
        },
        body: useBody
      }),
      env(),
      {},
      { store, now: NOW, providerFetch: cfFetch }
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { ok: boolean; text?: string }
    expect(json).toEqual({ ok: true, text: 'ok from AI Gateway', inputTokens: 2, outputTokens: 3 })
    expect(JSON.stringify(json)).not.toContain(TOKEN)
  })

  it('Keys HTML keeps optional OAuth login and paste fields for cloudflare', async () => {
    const html = await handleRequest(
      new Request('https://operator.test/'),
      env(),
      { access: tony },
      { store: memoryStore(), now: NOW }
    ).then((r) => r.text())
    expect(html).toContain('id="cf-connect"')
    expect(html).toContain('data-cf-aig-connect')
    expect(html).toContain('href="/cloudflare/connect"')
    expect(html).toContain('Log in to Cloudflare')
    expect(html).toContain('Cloudflare · AI Gateway')
    expect(html).toContain('Generate license')
    expect(html).not.toContain('data-cf-oauth-missing')
    expect(html).toContain('value="cloudflare"')
    expect(html).toContain('name="accountId"')
    expect(html).toContain('placeholder="API token"')
    expect(html).not.toContain('id="cf-add"')
  })
})

/** A real (in-memory) D1 that fails the `failOnNthMatch`-th statement whose SQL satisfies `match`,
 *  inside whatever D1 transaction it runs in — `failOnNthMatch <= 0` never fails. Lets a test prove
 *  what a D1 batch either commits or rolls back together, the same way
 *  pulse-session-integrity.test.ts does, for any statement the batch contains (a vault_keys insert,
 *  its audit row, or its event). */
function sqliteD1WithOneFailedStatement(
  db: DatabaseSync,
  match: (sql: string) => boolean,
  failOnNthMatch: number
): D1DatabaseLike {
  let matches = 0
  return {
    prepare(sql) {
      const stmt = db.prepare(sql)
      let bound: unknown[] = []
      const wrapper = {
        bind(...values: unknown[]) { bound = values; return wrapper },
        async first<T>() { return (stmt.get(...(bound as never[])) as T) ?? null },
        async all<T>() { return { results: stmt.all(...(bound as never[])) as T[] } },
        async run() {
          if (match(sql) && ++matches === failOnNthMatch) {
            throw new Error('transient vault write failure')
          }
          const result = stmt.run(...(bound as never[]))
          return { success: true, meta: { changes: Number(result.changes) } }
        }
      }
      return wrapper
    },
    async batch(statements) {
      db.exec('BEGIN')
      try {
        const results = []
        for (const statement of statements) results.push(await statement.run() as { success: boolean })
        db.exec('COMMIT')
        return results
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    }
  }
}

const matchesVaultInsert = (sql: string): boolean => sql.includes('INTO vault_keys')
const matchesAuditInsert = (sql: string): boolean => sql.includes('INTO audit')
const matchesEventInsert = (sql: string): boolean => sql.includes('INTO events')

function d1StoreWithSchema(
  db: DatabaseSync,
  failure: { match: (sql: string) => boolean; nth: number } = { match: matchesVaultInsert, nth: 0 }
): OperatorStore {
  db.exec(readFileSync(join(__dirname, '..', 'schema.sql'), 'utf8'))
  return d1Store(sqliteD1WithOneFailedStatement(db, failure.match, failure.nth))
}

/** The provisioning's own audit/event rows, isolated from anything else a test wrote. */
async function vaultWriteAuditAndEvents(store: OperatorStore): Promise<{ audits: unknown[]; events: unknown[] }> {
  return {
    audits: await store.listAudit(20, { action: 'vault-write' }),
    events: (await store.listEvents(20)).filter((e) => e.kind === 'vault')
  }
}

describe('Cloudflare AI Gateway provisioning is atomic against D1', () => {
  it('provisions both cloudflare vault rows together against a real D1 schema, with one audit row and one event', async () => {
    const db = new DatabaseSync(':memory:')
    try {
      const store = d1StoreWithSchema(db)
      const { cookie, state } = await startCloudflareOAuth(store)
      const cb = await handleRequest(
        new Request(`https://operator.test${CF_CALLBACK_PATH}?code=auth-code-d1&state=${state}`, {
          headers: { cookie }
        }),
        env(),
        { access: tony },
        { store, now: NOW, cfFetch }
      )
      expect(cb.status).toBe(303)
      expect(cb.headers.get('location')).toBe('/?cf=connected#keys')
      expect((await store.listVaultMeta()).map((v) => v.provider).sort()).toEqual(['cloudflare', 'cloudflare-account'])

      // AC2: the provisioning writes both rows and exactly one audit row and one event, not one
      // of each per row.
      const { audits, events } = await vaultWriteAuditAndEvents(store)
      expect(audits).toHaveLength(1)
      expect(audits[0]).toMatchObject({ actor: 'owner@example.test' })
      expect((audits[0] as { detail: string }).detail).toContain('cloudflare ·')
      expect((audits[0] as { detail: string }).detail).toContain('cloudflare-account ·')
      expect(events).toHaveLength(1)
      expect((events[0] as { detail: string | null }).detail).toBe('write cloudflare, cloudflare-account')
    } finally {
      db.close()
    }
  })

  it('a write failure on the account row leaves no cloudflare vault row, audit row or event behind', async () => {
    const db = new DatabaseSync(':memory:')
    try {
      // The 2nd INSERT INTO vault_keys is the account row; the gateway row is the 1st.
      const store = d1StoreWithSchema(db, { match: matchesVaultInsert, nth: 2 })
      const { cookie, state } = await startCloudflareOAuth(store)
      const cb = handleRequest(
        new Request(`https://operator.test${CF_CALLBACK_PATH}?code=auth-code-fail&state=${state}`, {
          headers: { cookie }
        }),
        env(),
        { access: tony },
        { store, now: NOW, cfFetch }
      )
      await expect(cb).rejects.toThrow('transient vault write failure')
      // Invariant: both rows, the audit row and the event commit in one D1 transaction. A failure
      // on any of them rolls back every statement in the batch, so nothing is ever left committed
      // on its own — no orphaned vault row and no audit/event recording a write that never happened.
      expect(await store.listVaultMeta()).toEqual([])
      const { audits, events } = await vaultWriteAuditAndEvents(store)
      expect(audits).toEqual([])
      expect(events).toEqual([])
    } finally {
      db.close()
    }
  })

  it('a failed reconnect rolls back its own supersede, leaving the previous rows, audit row and event untouched', async () => {
    const db = new DatabaseSync(':memory:')
    try {
      // The 4th INSERT INTO vault_keys overall is the reconnect's account row (1st connect: 2
      // inserts; reconnect: gateway insert, then this one).
      const store = d1StoreWithSchema(db, { match: matchesVaultInsert, nth: 4 })
      const first = await startCloudflareOAuth(store)
      await handleRequest(
        new Request(`https://operator.test${CF_CALLBACK_PATH}?code=auth-code-first&state=${first.state}`, {
          headers: { cookie: first.cookie }
        }),
        env(),
        { access: tony },
        { store, now: NOW, cfFetch }
      )
      const before = await store.listVaultRows()
      expect(before).toHaveLength(2)
      expect(before.every((row) => row.status === 'active' && row.cipher && row.iv)).toBe(true)
      const beforeAuditAndEvents = await vaultWriteAuditAndEvents(store)
      expect(beforeAuditAndEvents.audits).toHaveLength(1)
      expect(beforeAuditAndEvents.events).toHaveLength(1)

      const second = await startCloudflareOAuth(store)
      const reconnect = handleRequest(
        new Request(`https://operator.test${CF_CALLBACK_PATH}?code=auth-code-second&state=${second.state}`, {
          headers: { cookie: second.cookie }
        }),
        env(),
        { access: tony },
        { store, now: NOW + 1, cfFetch }
      )
      await expect(reconnect).rejects.toThrow('transient vault write failure')

      // The reconnect's batch supersedes the previous gateway row before its account insert fails;
      // the rollback must undo that supersede too, or a crashed reconnect would wipe the working
      // secret without ever completing the new one. Its would-be audit row and event never commit.
      expect(await store.listVaultRows()).toEqual(before)
      expect(await vaultWriteAuditAndEvents(store)).toEqual(beforeAuditAndEvents)
    } finally {
      db.close()
    }
  })

  describe.each([
    ['audit', matchesAuditInsert],
    ['event', matchesEventInsert]
  ] as const)('a %s-insert failure fails the whole vault-write batch', (kind, matchStatement) => {
    it('leaves no cloudflare vault row behind on the first connect', async () => {
      const db = new DatabaseSync(':memory:')
      try {
        // The provisioning's own audit/event insert is the 1st (and only) match.
        const store = d1StoreWithSchema(db, { match: matchStatement, nth: 1 })
        const { cookie, state } = await startCloudflareOAuth(store)
        const cb = handleRequest(
          new Request(`https://operator.test${CF_CALLBACK_PATH}?code=auth-code-${kind}-fail&state=${state}`, {
            headers: { cookie }
          }),
          env(),
          { access: tony },
          { store, now: NOW, cfFetch }
        )
        await expect(cb).rejects.toThrow('transient vault write failure')
        expect(await store.listVaultMeta()).toEqual([])
        const { audits, events } = await vaultWriteAuditAndEvents(store)
        expect(audits).toEqual([])
        expect(events).toEqual([])
      } finally {
        db.close()
      }
    })

    it('leaves the previous rows, audit row and event untouched on a failed reconnect', async () => {
      const db = new DatabaseSync(':memory:')
      try {
        // The 1st connect's own audit/event insert is the 1st match; the reconnect's is the 2nd.
        const store = d1StoreWithSchema(db, { match: matchStatement, nth: 2 })
        const first = await startCloudflareOAuth(store)
        await handleRequest(
          new Request(`https://operator.test${CF_CALLBACK_PATH}?code=auth-code-${kind}-first&state=${first.state}`, {
            headers: { cookie: first.cookie }
          }),
          env(),
          { access: tony },
          { store, now: NOW, cfFetch }
        )
        const before = await store.listVaultRows()
        expect(before).toHaveLength(2)
        const beforeAuditAndEvents = await vaultWriteAuditAndEvents(store)
        expect(beforeAuditAndEvents.audits).toHaveLength(1)
        expect(beforeAuditAndEvents.events).toHaveLength(1)

        const second = await startCloudflareOAuth(store)
        const reconnect = handleRequest(
          new Request(`https://operator.test${CF_CALLBACK_PATH}?code=auth-code-${kind}-second&state=${second.state}`, {
            headers: { cookie: second.cookie }
          }),
          env(),
          { access: tony },
          { store, now: NOW + 1, cfFetch }
        )
        await expect(reconnect).rejects.toThrow('transient vault write failure')

        expect(await store.listVaultRows()).toEqual(before)
        expect(await vaultWriteAuditAndEvents(store)).toEqual(beforeAuditAndEvents)
      } finally {
        db.close()
      }
    })
  })

  it('a successful reconnect leaves exactly one active row per provider, with the previous rows superseded', async () => {
    const db = new DatabaseSync(':memory:')
    try {
      const store = d1StoreWithSchema(db)
      const first = await startCloudflareOAuth(store)
      await handleRequest(
        new Request(`https://operator.test${CF_CALLBACK_PATH}?code=auth-code-first&state=${first.state}`, {
          headers: { cookie: first.cookie }
        }),
        env(),
        { access: tony },
        { store, now: NOW, cfFetch }
      )
      const before = await store.listVaultRows()
      expect(before).toHaveLength(2)
      const previousIds = new Set(before.map((row) => row.id))

      const second = await startCloudflareOAuth(store)
      const cb = await handleRequest(
        new Request(`https://operator.test${CF_CALLBACK_PATH}?code=auth-code-second&state=${second.state}`, {
          headers: { cookie: second.cookie }
        }),
        env(),
        { access: tony },
        { store, now: NOW + 1, cfFetch }
      )
      expect(cb.status).toBe(303)
      expect(cb.headers.get('location')).toBe('/?cf=connected#keys')

      const rows = await store.listVaultRows()
      expect(rows).toHaveLength(4)
      for (const provider of ['cloudflare', 'cloudflare-account']) {
        const active = rows.filter((row) => row.provider === provider && row.status === 'active')
        expect(active).toHaveLength(1)
      }
      const superseded = rows.filter((row) => previousIds.has(row.id))
      expect(superseded).toHaveLength(2)
      expect(superseded.every((row) => row.status === 'superseded' && row.cipher === '' && row.iv === '')).toBe(true)

      // One audit row and one event per successful call: two calls, two of each, never one per row.
      const { audits, events } = await vaultWriteAuditAndEvents(store)
      expect(audits).toHaveLength(2)
      expect(events).toHaveLength(2)
    } finally {
      db.close()
    }
  })
})
