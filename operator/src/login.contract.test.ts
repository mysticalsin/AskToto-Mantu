import { describe, expect, it } from 'vitest'
import { ADMIN_EMAILS, accessJwtFromRequest, accessLoginLocation, accessTeamDomain } from './access'
import { handleRequest, type Env } from './index'
import { memoryStore } from './store'
import { TEST_INGEST_SECRET, TEST_PROMPT_KEY, TEST_TEAM_DOMAIN } from './test-fixtures'
import { tokenPatternForTests } from './redact'
import { SPA_CSS_PATH, SPA_JS_PATH } from './spa/manifest'

const NOW = 1_725_000_000_000

function env(extra: Partial<Env> = {}): Env {
  return {
    OPERATOR_INGEST_SECRET: TEST_INGEST_SECRET,
    OPERATOR_PROMPT_KEY: TEST_PROMPT_KEY,
    OPERATOR_SKILL_PRIVATE_KEY: 'unused',
    TEAM_DOMAIN: TEST_TEAM_DOMAIN,
    ...extra
  }
}

function access(email: string) {
  return { getIdentity: async () => ({ email }) }
}

function locationOf(res: Response): string {
  return res.headers.get('location') || ''
}

function isAccessLoginRedirect(loc: string, path: string): boolean {
  if (!/login/i.test(loc)) return false
  const decoded = decodeURIComponent(loc)
  return decoded.includes(`next=${path}`) || decoded.includes(path)
}

describe('unauth console GET is 302 to Cloudflare Access, never a password form', () => {
  it('builds an Access login URL with next and redirect_url', () => {
    expect(accessTeamDomain(TEST_TEAM_DOMAIN)).toBe(TEST_TEAM_DOMAIN)
    expect(accessTeamDomain(undefined)).toBeNull()
    expect(accessTeamDomain('http://evil.example')).toBeNull()
    const loc = accessLoginLocation(new Request('https://operator.test/keys'), TEST_TEAM_DOMAIN)
    expect(loc).toContain('/cdn-cgi/access/login/operator.test')
    expect(isAccessLoginRedirect(loc, '/keys')).toBe(true)
  })

  it('unauth GET / is 302, not HTML password form', async () => {
    const res = await handleRequest(new Request('https://operator.test/'), env(), {}, {
      store: memoryStore(),
      now: NOW
    })
    expect(res.status).toBe(302)
    expect(isAccessLoginRedirect(locationOf(res), '/')).toBe(true)
    const body = await res.text()
    expect(body).not.toContain('data-login="1"')
    expect(body).not.toContain('type="password"')
    expect(body).not.toContain('Sign in')
    expect(body).not.toMatch(tokenPatternForTests())
  })

  it('unauth GET /keys is 302 with next=/keys, not 404 JSON', async () => {
    const res = await handleRequest(new Request('https://operator.test/keys'), env(), {}, {
      store: memoryStore(),
      now: NOW
    })
    expect(res.status).toBe(302)
    expect(isAccessLoginRedirect(locationOf(res), '/keys')).toBe(true)
    expect(await res.text()).not.toContain('not found')
  })

  it('unauth GET of every console path is 302, not 404', async () => {
    const paths = [
      '/licenses',
      '/devices',
      '/map',
      '/cloudflare',
      '/cloudflare/connect',
      '/cloudflare/callback',
      '/overview',
      '/events',
      '/dashboards',
      '/insights',
      '/pages',
      '/seo',
      '/realtime',
      '/sessions',
      '/profiles',
      '/groups',
      '/cohorts',
      '/settings',
      '/references',
      '/notifications',
      '/session'
    ]
    for (const path of paths) {
      const res = await handleRequest(new Request(`https://operator.test${path}`), env(), {}, {
        store: memoryStore(),
        now: NOW
      })
      expect(res.status, path).toBe(302)
      expect(isAccessLoginRedirect(locationOf(res), path), path).toBe(true)
    }
  })

  it('unauth GET hashed SPA JS/CSS are 200 real files, not Access HTML or a stub', async () => {
    const js = await handleRequest(new Request(`https://operator.test${SPA_JS_PATH}`), env(), {}, {
      store: memoryStore(),
      now: NOW
    })
    expect(js.status).toBe(200)
    expect(js.headers.get('content-type') || '').toMatch(/javascript/)
    const jsBody = await js.text()
    expect(jsBody.length).toBeGreaterThan(97)
    expect(jsBody).toContain('Shoey')
    expect(jsBody).toContain('Overview')
    expect(jsBody).toContain('Realtime')
    expect(jsBody).not.toMatch(/cdn-cgi\/access/)

    const css = await handleRequest(new Request(`https://operator.test${SPA_CSS_PATH}`), env(), {}, {
      store: memoryStore(),
      now: NOW
    })
    expect(css.status).toBe(200)
    expect(css.headers.get('content-type') || '').toMatch(/text\/css/)
    expect((await css.text()).length).toBeGreaterThan(97)
  })

  it('reads the Access session JWT from the CF_Authorization cookie', () => {
    const req = new Request('https://operator.test/v1/admin/keys', {
      method: 'POST',
      headers: { cookie: 'other=1; CF_Authorization=header.payload.sig; extra=2' }
    })
    expect(accessJwtFromRequest(req)).toBe('header.payload.sig')
    expect(accessJwtFromRequest(new Request('https://operator.test/v1/admin/keys'))).toBeNull()
    const mixed = new Request('https://operator.test/v1/admin/keys', {
      headers: { cookie: 'CF_AppSession=not-a-jwt; CF_Authorization=header.payload.sig' }
    })
    expect(accessJwtFromRequest(mixed)).toBe('header.payload.sig')
  })

  it('unauth POST /v1/admin/keys is 401 not 404', async () => {
    const res = await handleRequest(
      new Request('https://operator.test/v1/admin/keys', { method: 'POST', body: '{}' }),
      env(),
      {},
      { store: memoryStore(), now: NOW }
    )
    expect(res.status).toBe(401)
    expect(res.headers.get('content-type')).toMatch(/application\/json/)
    expect(await res.json()).toEqual({ ok: false, error: 'Access required' })
  })

  it('unauth POST /v1/admin/licenses/generate is 401 not 404', async () => {
    const res = await handleRequest(
      new Request('https://operator.test/v1/admin/licenses/generate', {
        method: 'POST',
        body: JSON.stringify({ days: 30 })
      }),
      env(),
      {},
      { store: memoryStore(), now: NOW }
    )
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ ok: false, error: 'Access required' })
  })

  it('unauth POST /v1/admin/licenses is 401 not 404', async () => {
    const res = await handleRequest(
      new Request('https://operator.test/v1/admin/licenses', { method: 'POST', body: '{}' }),
      env(),
      {},
      { store: memoryStore(), now: NOW }
    )
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ ok: false, error: 'Access required' })
  })

  it('fails loud (503) when TEAM_DOMAIN is unset, and does not serve a password form', async () => {
    const res = await handleRequest(
      new Request('https://operator.test/keys'),
      env({ TEAM_DOMAIN: undefined }),
      {},
      { store: memoryStore(), now: NOW }
    )
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({
      ok: false,
      error: 'Cloudflare Access is misconfigured: TEAM_DOMAIN is unset'
    })
  })

  it('fails loud when a JWT is present but POLICY_AUD is unset', async () => {
    const res = await handleRequest(
      new Request('https://operator.test/', { headers: { 'cf-access-jwt-assertion': 'header.payload.sig' } }),
      env({ POLICY_AUD: undefined }),
      {},
      { store: memoryStore(), now: NOW }
    )
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({
      ok: false,
      error: 'Cloudflare Access is misconfigured: POLICY_AUD is unset'
    })
  })

  it('serves the console after Access identity for allowlisted emails, including /keys', async () => {
    for (const email of ADMIN_EMAILS) {
      const store = memoryStore()
      const home = await handleRequest(
        new Request('https://operator.test/'),
        env(),
        { access: access(email) },
        { store, now: NOW }
      )
      expect(home.status, email).toBe(200)
      const html = await home.text()
      expect(html).toContain('data-nav="overview"')
      expect(html).toContain('data-nav="events"')
      expect(html).toContain('data-nav="licenses"')
      expect(html).toContain('data-nav="keys"')
      expect(html).toContain('data-nav="sessions"')
      expect(html).not.toContain('data-nav="seo"')
      expect(html).not.toContain('data-nav="dashboards"')
      expect(html).toContain(email)
      expect(html).not.toContain('data-login="1"')
      expect(html).not.toContain('action="/login"')

      const keys = await handleRequest(
        new Request('https://operator.test/keys'),
        env(),
        { access: access(email) },
        { store, now: NOW }
      )
      expect(keys.status, email).toBe(200)
      expect(keys.headers.get('content-type')).toMatch(/text\/html/)
    }
  })

  it('rejects a non-allowlisted Access email and never opens the console', async () => {
    const res = await handleRequest(
      new Request('https://operator.test/'),
      env(),
      { access: access('other@example.com') },
      { store: memoryStore(), now: NOW }
    )
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ ok: false, error: 'Access required' })
  })

  it('does not accept POST /login as a password fallback', async () => {
    const res = await handleRequest(
      new Request('https://operator.test/login', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'email=tony.walteur@gmail.com&password=anything'
      }),
      env(),
      {},
      { store: memoryStore(), now: NOW }
    )
    expect(res.status).toBe(401)
    expect(res.headers.get('set-cookie')).toBeNull()
  })
})
