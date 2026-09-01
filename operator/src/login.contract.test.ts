import { describe, expect, it } from 'vitest'
import { ADMIN_EMAILS, SESSION_COOKIE } from './access'
import { handleRequest, type Env } from './index'
import { memoryStore } from './store'
import { TEST_ADMIN_PASSWORD, TEST_INGEST_SECRET, TEST_PROMPT_KEY } from './test-fixtures'
import { tokenPatternForTests } from './redact'

const NOW = 1_725_000_000_000

function env(): Env {
  return {
    OPERATOR_INGEST_SECRET: TEST_INGEST_SECRET,
    OPERATOR_PROMPT_KEY: TEST_PROMPT_KEY,
    OPERATOR_SKILL_PRIVATE_KEY: 'unused',
    OPERATOR_ADMIN_PASSWORD: TEST_ADMIN_PASSWORD
  }
}

function cookieFrom(res: Response): string {
  const raw = res.headers.get('set-cookie') || ''
  const match = raw.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`))
  if (!match) return ''
  return `${SESSION_COOKIE}=${match[1]}`
}

describe('browser GET / is HTML login, never JSON Access required', () => {
  it('serves text/html login for an unauthenticated GET /', async () => {
    const res = await handleRequest(new Request('https://operator.test/'), env(), {}, {
      store: memoryStore(),
      now: NOW
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/html/)
    const html = await res.text()
    expect(html).toContain('data-login="1"')
    expect(html).toContain('type="email"')
    expect(html).toContain('type="password"')
    expect(html).toContain('Sign in')
    expect(html).not.toContain('Access required')
    expect(html).not.toMatch(/\{"ok":\s*false/)
    expect(html).not.toMatch(tokenPatternForTests())
    expect(html).not.toContain('Jane Doe')
    expect(html).not.toContain('visitor@')
  })

  it('returns JSON 401 for Accept application/json on / and for /v1/admin without identity', async () => {
    const store = memoryStore()
    const jsonHome = await handleRequest(
      new Request('https://operator.test/', { headers: { accept: 'application/json' } }),
      env(),
      {},
      { store, now: NOW }
    )
    expect(jsonHome.status).toBe(401)
    expect(jsonHome.headers.get('content-type')).toMatch(/application\/json/)
    expect(await jsonHome.json()).toEqual({ ok: false, error: 'Access required' })

    const api = await handleRequest(
      new Request('https://operator.test/v1/admin/dashboard'),
      env(),
      {},
      { store, now: NOW }
    )
    expect(api.status).toBe(401)
    expect(api.headers.get('content-type')).toMatch(/application\/json/)
    expect(await api.json()).toEqual({ ok: false, error: 'Access required' })
  })

  it('signs in allowlisted emails with the Worker password and then serves the console', async () => {
    for (const email of ADMIN_EMAILS) {
      const store = memoryStore()
      const posted = await handleRequest(
        new Request('https://operator.test/login', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ email, password: TEST_ADMIN_PASSWORD }).toString()
        }),
        env(),
        {},
        { store, now: NOW }
      )
      expect(posted.status, email).toBe(303)
      expect(posted.headers.get('location')).toBe('/')
      const cookie = cookieFrom(posted)
      expect(cookie).toContain(SESSION_COOKIE)
      expect(cookie).not.toContain(TEST_ADMIN_PASSWORD)

      const consolePage = await handleRequest(
        new Request('https://operator.test/', { headers: { cookie } }),
        env(),
        {},
        { store, now: NOW }
      )
      expect(consolePage.status, email).toBe(200)
      const html = await consolePage.text()
      expect(html).toContain('data-nav="overview"')
      expect(html).toContain('data-nav="realtime"')
      expect(html).toContain('data-nav="events"')
      expect(html).toContain('data-nav="profiles"')
      expect(html).toContain('data-page="map"')
      expect(html).toContain(email)
      expect(html).not.toContain('data-login="1"')
    }
  })

  it('rejects a non-allowlisted email and a wrong password, and never opens the console', async () => {
    const store = memoryStore()
    const stranger = await handleRequest(
      new Request('https://operator.test/login', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ email: 'other@example.com', password: TEST_ADMIN_PASSWORD }).toString()
      }),
      env(),
      {},
      { store, now: NOW }
    )
    expect(stranger.status).toBe(200)
    expect(stranger.headers.get('set-cookie')).toBeNull()
    expect(await stranger.text()).toContain('Sign-in failed')

    const wrong = await handleRequest(
      new Request('https://operator.test/login', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ email: 'tony.walteur@gmail.com', password: 'nope' }).toString()
      }),
      env(),
      {},
      { store, now: NOW }
    )
    expect(wrong.status).toBe(200)
    expect(wrong.headers.get('set-cookie')).toBeNull()
    const home = await handleRequest(new Request('https://operator.test/'), env(), {}, { store, now: NOW })
    expect(await home.text()).toContain('data-login="1"')
  })
})
