import { describe, expect, it } from 'vitest'
import { mintSessionToken, SESSION_COOKIE, verifySessionToken } from './access'
import { handleRequest, type Env } from './index'
import { memoryStore } from './store'
import { TEST_INGEST_SECRET, TEST_PROMPT_KEY, TEST_ADMIN_EMAILS, TEST_VAULT_KEY } from './test-fixtures'

const NOW = 1_725_000_000_000
const HOUR_MS = 60 * 60 * 1000
const SESSION_TTL_MS = 12 * HOUR_MS
const SESSION_SECRET = 'synthetic-operator-session-secret'
const sessionIat = NOW - 2 * HOUR_MS

function sessionEnv(): Env {
  return {
    OPERATOR_INGEST_SECRET: TEST_INGEST_SECRET,
    OPERATOR_PROMPT_KEY: TEST_PROMPT_KEY,
    OPERATOR_SESSION_SECRET: SESSION_SECRET,
    ADMIN_EMAILS: TEST_ADMIN_EMAILS,
    OPERATOR_SKILL_PRIVATE_KEY: 'unused',
    OPERATOR_VAULT_KEY: TEST_VAULT_KEY
  }
}

async function existingSession(iat = sessionIat): Promise<string> {
  return mintSessionToken('owner@example.test', iat, SESSION_SECRET)
}

async function request(
  path: string,
  headers: Record<string, string>,
  now: number,
  access?: { getIdentity: () => Promise<{ email: string }> }
): Promise<Response> {
  return handleRequest(
    new Request(`https://operator.test${path}`, { headers }),
    sessionEnv(),
    access ? { access } : {},
    { store: memoryStore(), now }
  )
}

const ownerAccess = { getIdentity: async () => ({ email: 'owner@example.test' }) }

describe('Operator app sessions have an absolute 12-hour lifetime', () => {
  it('preserves the original issue time through a rolling /session cookie and Bearer chain', async () => {
    const originalToken = await existingSession()
    const checkpoints = [
      { now: sessionIat + HOUR_MS + 1, transport: 'cookie' },
      { now: sessionIat + 2 * HOUR_MS + 1, transport: 'bearer' },
      { now: sessionIat + 11 * HOUR_MS + 1, transport: 'cookie' }
    ] as const
    let returnedToken = originalToken

    for (const checkpoint of checkpoints) {
      const headers =
        checkpoint.transport === 'cookie'
          ? { cookie: `${SESSION_COOKIE}=${encodeURIComponent(returnedToken)}` }
          : { authorization: `Bearer ${returnedToken}` }
      const res = await request(
        '/session',
        { ...headers, 'x-metis-session-fresh': 'true' },
        checkpoint.now
      )
      const responseToken = res.headers.get('X-Metis-Session')
      const verified = await verifySessionToken(responseToken, SESSION_SECRET, checkpoint.now, sessionEnv())

      expect(res.status).toBe(200)
      expect(responseToken).toBe(originalToken)
      expect(res.headers.get('Set-Cookie')).toBeNull()
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(await res.json()).toEqual({ ok: true, session: originalToken })
      expect(verified).toEqual({ email: 'owner@example.test', iat: sessionIat })
      returnedToken = responseToken || ''
    }
  })

  it('accepts a cookie session one millisecond before expiry and rejects it at exactly 12 hours', async () => {
    const token = await existingSession()
    const cookie = `${SESSION_COOKIE}=${encodeURIComponent(token)}`
    const beforeExpiry = await request(
      '/v1/admin/health.json',
      { cookie },
      sessionIat + SESSION_TTL_MS - 1
    )
    expect(beforeExpiry.status).toBe(200)
    expect(beforeExpiry.headers.get('X-Metis-Session')).toBe(token)

    const atExpiry = await request('/v1/admin/health.json', { cookie }, sessionIat + SESSION_TTL_MS)
    expect(atExpiry.status).toBe(401)
    expect(atExpiry.headers.get('X-Metis-Session')).toBeNull()
  })

  it('accepts a Bearer session one millisecond before expiry and rejects it at exactly 12 hours', async () => {
    const token = await existingSession()
    const authorization = `Bearer ${token}`
    const beforeExpiry = await request(
      '/v1/admin/health.json',
      { authorization },
      sessionIat + SESSION_TTL_MS - 1
    )
    expect(beforeExpiry.status).toBe(200)
    expect(beforeExpiry.headers.get('X-Metis-Session')).toBe(token)

    const atExpiry = await request(
      '/v1/admin/health.json',
      { authorization },
      sessionIat + SESSION_TTL_MS
    )
    expect(atExpiry.status).toBe(401)
    expect(atExpiry.headers.get('X-Metis-Session')).toBeNull()
  })

  it('lets a freshly verified allowlisted Access identity mint a new 12-hour session', async () => {
    const oldToken = await existingSession()
    const renewedAt = sessionIat + SESSION_TTL_MS
    const res = await request(
      '/',
      { cookie: `${SESSION_COOKIE}=${encodeURIComponent(oldToken)}` },
      renewedAt,
      ownerAccess
    )
    const token = res.headers.get('X-Metis-Session') || ''
    const cookie = res.headers.get('Set-Cookie') || ''
    const verified = await verifySessionToken(token, SESSION_SECRET, renewedAt, sessionEnv())

    expect(res.status).toBe(200)
    expect(token).not.toBe(oldToken)
    expect(verified).toEqual({ email: 'owner@example.test', iat: renewedAt })
    expect(cookie).toContain(`${SESSION_COOKIE}=`)
    expect(cookie).toContain('Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=43200')
    expect(res.headers.get('cache-control')).toBe('no-store')
  })
})
