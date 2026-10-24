/**
 * G81 / CAP-34: one RBAC matrix over EVERY registered `auth: 'admin'` route. A route added without a matrix row
 * fails `every auth:admin route from listRoutes() has a matrix row`, so a new admin surface can never ship unreviewed.
 * `role` is the minimum role the route enforces today: 'admin' (any ADMIN_EMAILS identity) or 'owner' (OWNER_EMAILS).
 */
import { describe, expect, it } from 'vitest'
import { handleRequest, type Env } from '../index'
import { hmacHex } from '../hmac'
import { sha256Hex } from '../crypto'
import { memoryStore } from '../store'
import {
  TEST_ADMIN_EMAIL,
  TEST_ADMIN_EMAILS,
  TEST_INGEST_SECRET,
  TEST_OWNER_EMAIL,
  TEST_PROMPT_KEY,
  TEST_TEAM_DOMAIN
} from '../test-fixtures'
import { ingestCanonical, OPERATOR_HMAC_HEADERS } from '../../../src/shared/operator-hmac'
import { listRoutes } from './registry'

const NOW = 1_800_000_000_000
const STRANGER = 'stranger@example.test'
const UUID = '123e4567-e89b-12d3-a456-426614174000'
const KID = '0123456789abcdef'

interface Row {
  method: string
  path: string
  role: 'admin' | 'owner'
  body?: Record<string, unknown>
}

const RBAC_MATRIX: Row[] = [
  // admin-core
  { method: 'GET', path: '/session', role: 'admin' },
  { method: 'GET', path: '/cloudflare/connect', role: 'admin' },
  { method: 'GET', path: '/cloudflare/callback', role: 'admin' },
  { method: 'GET', path: '/', role: 'admin' },
  { method: 'GET', path: '/v1/admin/dashboard', role: 'admin' },
  { method: 'GET', path: '/v1/admin/health.json', role: 'admin' },
  { method: 'GET', path: '/v1/admin/audit.json', role: 'admin' },
  { method: 'GET', path: '/v1/admin/keys', role: 'admin' },
  { method: 'POST', path: '/v1/admin/keys', role: 'admin', body: {} },
  { method: 'POST', path: '/v1/admin/keys/k1/rotate', role: 'admin', body: {} },
  { method: 'POST', path: '/v1/admin/keys/k1/revoke', role: 'admin', body: {} },
  { method: 'GET', path: '/v1/admin/summary', role: 'admin' },
  { method: 'GET', path: '/v1/admin/asks', role: 'admin' },
  { method: 'GET', path: '/v1/admin/asks/a1', role: 'admin' },
  { method: 'POST', path: '/v1/admin/skills/draft', role: 'admin', body: {} },
  { method: 'POST', path: '/v1/admin/skills/s1/approve', role: 'admin', body: {} },
  { method: 'POST', path: '/v1/admin/crm/c1/retry', role: 'admin', body: {} },
  { method: 'POST', path: '/v1/admin/licenses/generate', role: 'admin', body: {} },
  { method: 'GET', path: '/v1/admin/licenses/issued', role: 'admin' },
  { method: 'GET', path: '/v1/admin/licenses', role: 'admin' },
  { method: 'POST', path: '/v1/admin/licenses', role: 'admin', body: {} },
  { method: 'POST', path: '/v1/admin/licenses/l1/approve', role: 'admin', body: {} },
  // events, live, sessions, export
  { method: 'GET', path: '/v1/admin/events.json', role: 'admin' },
  { method: 'GET', path: '/v1/admin/live.json', role: 'admin' },
  { method: 'GET', path: '/v1/admin/realtime.geo.json', role: 'admin' },
  { method: 'GET', path: '/v1/admin/realtime/geo.json', role: 'admin' },
  { method: 'GET', path: '/v1/admin/realtime/live-seats.json', role: 'admin' },
  { method: 'GET', path: '/v1/admin/search.json', role: 'admin' },
  { method: 'GET', path: '/v1/admin/sessions.json', role: 'admin' },
  { method: 'GET', path: '/v1/admin/sessions/s1.json', role: 'admin' },
  { method: 'GET', path: '/v1/admin/export.csv', role: 'admin' },
  { method: 'GET', path: '/v1/admin/export.xlsx', role: 'admin' },
  // groups and tiers
  { method: 'GET', path: '/v1/admin/groups', role: 'admin' },
  { method: 'POST', path: '/v1/admin/groups', role: 'admin', body: {} },
  { method: 'GET', path: '/v1/admin/groups/g1', role: 'admin' },
  { method: 'PATCH', path: '/v1/admin/groups/g1', role: 'admin', body: {} },
  { method: 'DELETE', path: '/v1/admin/groups/g1', role: 'admin' },
  { method: 'POST', path: '/v1/admin/groups/g1/members', role: 'admin', body: {} },
  { method: 'DELETE', path: '/v1/admin/groups/g1/members/m1', role: 'admin' },
  { method: 'POST', path: '/v1/admin/groups/g1/licenses/generate', role: 'admin', body: {} },
  { method: 'GET', path: '/v1/admin/tiers', role: 'admin' },
  { method: 'PATCH', path: '/v1/admin/tiers/t1', role: 'admin', body: {} },
  // integrations and connectors
  { method: 'GET', path: '/v1/admin/connectors/catalog', role: 'admin' },
  { method: 'GET', path: '/v1/admin/integrations', role: 'admin' },
  { method: 'POST', path: '/v1/admin/integrations/test', role: 'admin', body: {} },
  { method: 'POST', path: '/v1/admin/integrations', role: 'admin', body: {} },
  { method: 'PATCH', path: '/v1/admin/integrations/i1', role: 'admin', body: {} },
  { method: 'POST', path: '/v1/admin/integrations/i1/rotate', role: 'admin', body: {} },
  { method: 'POST', path: '/v1/admin/integrations/i1/revoke', role: 'admin', body: {} },
  { method: 'POST', path: '/v1/admin/integrations/i1/test', role: 'admin', body: {} },
  { method: 'DELETE', path: '/v1/admin/integrations/i1', role: 'admin' },
  { method: 'GET', path: '/v1/admin/connectors/github/oauth/start', role: 'admin' },
  { method: 'GET', path: '/v1/admin/connectors/oauth/callback', role: 'admin' },
  // settings (meters/seats/policy): the budget key is owner-only, every other key is any-admin
  { method: 'GET', path: '/v1/admin/settings.json', role: 'admin' },
  { method: 'PATCH', path: '/v1/admin/settings.json', role: 'admin', body: { currency: 'EUR' } },
  { method: 'PATCH', path: '/v1/admin/settings.json', role: 'owner', body: { dailyTokenBudgetPerSeat: 1000 } },
  { method: 'GET', path: '/v1/admin/meters.json', role: 'admin' },
  { method: 'POST', path: '/v1/admin/meters/reconcile', role: 'admin', body: { day: 0 } },
  // fleet model policy
  { method: 'GET', path: '/v1/admin/model-policy.json', role: 'admin' },
  { method: 'PUT', path: '/v1/admin/model-policy.json', role: 'owner', body: {} },
  // enrolment: reads are any-admin, every mutation is owner-only
  { method: 'GET', path: '/v1/admin/enroll-tokens', role: 'admin' },
  { method: 'POST', path: '/v1/admin/enroll-tokens', role: 'owner', body: {} },
  { method: 'POST', path: `/v1/admin/enroll-tokens/${KID}/revoke`, role: 'owner', body: {} },
  { method: 'POST', path: '/v1/admin/settings/enroll', role: 'owner', body: {} },
  // speech route evidence: readiness is any-admin, import/revoke are owner-only
  { method: 'GET', path: '/v1/admin/speech/readiness', role: 'admin' },
  { method: 'POST', path: '/v1/admin/speech/evidence', role: 'owner', body: {} },
  { method: 'POST', path: `/v1/admin/speech/evidence/${UUID}/revoke`, role: 'owner', body: {} }
]

function env(overrides: Partial<Env> = {}): Env {
  return {
    OPERATOR_INGEST_SECRET: TEST_INGEST_SECRET,
    OPERATOR_PROMPT_KEY: TEST_PROMPT_KEY,
    ADMIN_EMAILS: TEST_ADMIN_EMAILS,
    OWNER_EMAILS: TEST_OWNER_EMAIL,
    TEAM_DOMAIN: TEST_TEAM_DOMAIN,
    OPERATOR_SKILL_PRIVATE_KEY: '',
    ...overrides
  }
}

const as = (email: string | null) => ({ getIdentity: async () => (email ? { email } : null) })

function request(row: Row, headers: Record<string, string> = {}, bodyText?: string): Request {
  const hasBody = row.method !== 'GET' && row.method !== 'DELETE'
  return new Request(`https://operator.test${row.path}`, {
    method: row.method,
    headers: { ...(hasBody ? { 'content-type': 'application/json' } : {}), ...headers },
    body: hasBody ? (bodyText ?? JSON.stringify(row.body ?? {})) : undefined
  })
}

async function call(row: Row, email: string | null): Promise<Response> {
  return handleRequest(request(row), env(), { access: as(email) }, { store: memoryStore(), now: NOW })
}

async function callAsSeat(row: Row): Promise<Response> {
  const bodyText = row.method === 'GET' || row.method === 'DELETE' ? '' : JSON.stringify(row.body ?? {})
  const nonce = `rbac-${Math.random().toString(16).slice(2)}`
  const device = 'rbac-seat-device-0001'
  const sig = await hmacHex(TEST_INGEST_SECRET, ingestCanonical(String(NOW), nonce, device, await sha256Hex(bodyText)))
  const headers = {
    [OPERATOR_HMAC_HEADERS.ts]: String(NOW),
    [OPERATOR_HMAC_HEADERS.nonce]: nonce,
    [OPERATOR_HMAC_HEADERS.device]: device,
    [OPERATOR_HMAC_HEADERS.sig]: sig
  }
  return handleRequest(request(row, headers, bodyText), env(), { access: as(null) }, { store: memoryStore(), now: NOW })
}

/** Denied = 401/403, or the Access login redirect for a console GET. Never a 2xx and never a handler 4xx/5xx. */
function denied(res: Response): boolean {
  return res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400)
}

async function ownerRefusal(res: Response): Promise<boolean> {
  if (res.status !== 403) return false
  const body = (await res
    .clone()
    .json()
    .catch(() => ({}))) as { error?: string; code?: string }
  return body.error === 'OWNER_REQUIRED' || body.code === 'OWNER_REQUIRED' || body.code === 'not-owner'
}

function matches(route: { method: string; pattern: RegExp | string }, row: Row): boolean {
  if (route.method !== row.method) return false
  return typeof route.pattern === 'string' ? route.pattern === row.path : route.pattern.test(row.path)
}

describe('RBAC matrix over every admin route (G81, CAP-34)', () => {
  const adminRoutes = () => listRoutes().filter((r) => r.auth === 'admin')

  it('every auth:admin route from listRoutes() has a matrix row', () => {
    expect(adminRoutes().length).toBeGreaterThan(60)
    const uncovered = adminRoutes().filter((route) => !RBAC_MATRIX.some((row) => matches(route, row)))
    expect(uncovered.map((r) => `${r.method} ${String(r.pattern)}`)).toEqual([])
  })

  it('every matrix row maps to a registered admin route (no stale rows)', () => {
    const stale = RBAC_MATRIX.filter((row) => !adminRoutes().some((route) => matches(route, row)))
    expect(stale.map((r) => `${r.method} ${r.path}`)).toEqual([])
  })

  it('anonymous is denied on every admin route', async () => {
    for (const row of RBAC_MATRIX) {
      const res = await call(row, null)
      expect(denied(res), `${row.method} ${row.path} -> ${res.status}`).toBe(true)
    }
  })

  it('a non-admin Access identity is denied', async () => {
    for (const row of RBAC_MATRIX) {
      const res = await call(row, STRANGER)
      expect(denied(res), `${row.method} ${row.path} -> ${res.status}`).toBe(true)
    }
  })

  it('a valid HMAC seat cannot reach /v1/admin/*', async () => {
    for (const row of RBAC_MATRIX) {
      const res = await callAsSeat(row)
      expect(denied(res), `${row.method} ${row.path} -> ${res.status}`).toBe(true)
    }
  })

  it('admin is not 401/403 on admin-role rows', async () => {
    for (const row of RBAC_MATRIX.filter((r) => r.role === 'admin')) {
      const res = await call(row, TEST_ADMIN_EMAIL)
      expect(res.status, `${row.method} ${row.path}`).not.toBe(401)
      expect(await ownerRefusal(res), `${row.method} ${row.path} must not be owner-gated`).toBe(false)
    }
  })

  it('admin gets 403 on owner-role rows', async () => {
    for (const row of RBAC_MATRIX.filter((r) => r.role === 'owner')) {
      const res = await call(row, TEST_ADMIN_EMAIL)
      expect(res.status, `${row.method} ${row.path}`).toBe(403)
      expect(await ownerRefusal(res), `${row.method} ${row.path}`).toBe(true)
    }
  })

  it('owner passes owner-role rows', async () => {
    for (const row of RBAC_MATRIX.filter((r) => r.role === 'owner')) {
      const res = await call(row, TEST_OWNER_EMAIL)
      expect(res.status, `${row.method} ${row.path}`).not.toBe(401)
      expect(await ownerRefusal(res), `${row.method} ${row.path}`).toBe(false)
    }
  })

  it('owner-role rows fail closed when OWNER_EMAILS is unset', async () => {
    for (const row of RBAC_MATRIX.filter((r) => r.role === 'owner')) {
      const res = await handleRequest(
        request(row),
        env({ OWNER_EMAILS: undefined }),
        { access: as(TEST_OWNER_EMAIL) },
        { store: memoryStore(), now: NOW }
      )
      expect(res.status, `${row.method} ${row.path}`).toBe(403)
    }
  })
})
