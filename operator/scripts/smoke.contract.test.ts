import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TEAM_DOMAIN,
  checkAccessRedirect,
  checkAdminDashboardUnauth,
  checkAssetIndexJs,
  checkHealth,
  checkHeartbeatNoHmac,
  checkIngestGetNever200,
  checkWorldSvg,
  parseArgs,
  runSmoke
} from './smoke.mjs'

const BASE = 'https://metis-operator.tony-walteur.workers.dev'

/** Minimal fake `Response`-like object, just what these checkers read. */
function fakeResponse({ status = 200, headers = {}, jsonBody, textBody } = {}) {
  const headerMap = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
  return {
    status,
    headers: { get: (name) => headerMap.get(String(name).toLowerCase()) ?? null },
    json: async () => {
      if (jsonBody === undefined) throw new Error('no json body')
      return jsonBody
    },
    text: async () => textBody ?? ''
  }
}

/** Builds a fake fetch keyed by exact URL (+ optional method match), returning a canned response
 *  or throwing NOT_STUBBED so a missing route is a loud test failure, not a false pass. */
function fakeFetch(routes) {
  return async (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase()
    const hit = routes.find((r) => r.url === url && (!r.method || r.method === method))
    if (!hit) throw new Error(`NOT_STUBBED ${method} ${url}`)
    return hit.response
  }
}

describe('smoke.mjs pure checkers (fake fetch)', () => {
  it('checkHealth passes on 200 + ok:true + version', async () => {
    const fetchImpl = fakeFetch([
      { url: `${BASE}/health`, response: fakeResponse({ jsonBody: { ok: true, version: 'abc1234' } }) }
    ])
    const r = await checkHealth(fetchImpl, BASE)
    expect(r.ok).toBe(true)
  })

  it('checkHealth fails when version is missing (current live deploy, pre-P4.0)', async () => {
    const fetchImpl = fakeFetch([
      {
        url: `${BASE}/health`,
        response: fakeResponse({ jsonBody: { ok: true, service: 'metis-operator', configured: true } })
      }
    ])
    const r = await checkHealth(fetchImpl, BASE)
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('version=missing')
  })

  it('checkHealth fails on non-200', async () => {
    const fetchImpl = fakeFetch([
      { url: `${BASE}/health`, response: fakeResponse({ status: 500, jsonBody: { ok: false } }) }
    ])
    const r = await checkHealth(fetchImpl, BASE)
    expect(r.ok).toBe(false)
  })

  it('checkAssetIndexJs passes on 200 JS over 40 KB', async () => {
    const body = 'x'.repeat(41 * 1024)
    const fetchImpl = fakeFetch([
      {
        url: `${BASE}/assets/index.js`,
        response: fakeResponse({ headers: { 'content-type': 'application/javascript; charset=utf-8' }, textBody: body })
      }
    ])
    const r = await checkAssetIndexJs(fetchImpl, BASE)
    expect(r.ok).toBe(true)
  })

  it('checkAssetIndexJs fails when under 40 KB', async () => {
    const fetchImpl = fakeFetch([
      {
        url: `${BASE}/assets/index.js`,
        response: fakeResponse({ headers: { 'content-type': 'application/javascript' }, textBody: 'tiny' })
      }
    ])
    const r = await checkAssetIndexJs(fetchImpl, BASE)
    expect(r.ok).toBe(false)
  })

  it('checkAssetIndexJs fails when content-type is not JS', async () => {
    const fetchImpl = fakeFetch([
      {
        url: `${BASE}/assets/index.js`,
        response: fakeResponse({ headers: { 'content-type': 'text/html' }, textBody: 'x'.repeat(50 * 1024) })
      }
    ])
    const r = await checkAssetIndexJs(fetchImpl, BASE)
    expect(r.ok).toBe(false)
  })

  it('checkWorldSvg passes on 200 svg', async () => {
    const fetchImpl = fakeFetch([
      { url: `${BASE}/assets/world.svg`, response: fakeResponse({ headers: { 'content-type': 'image/svg+xml' } }) }
    ])
    const r = await checkWorldSvg(fetchImpl, BASE)
    expect(r.ok).toBe(true)
  })

  it('checkAccessRedirect passes on 302 to the team domain', async () => {
    const fetchImpl = fakeFetch([
      {
        url: `${BASE}/`,
        response: fakeResponse({ status: 302, headers: { location: `${DEFAULT_TEAM_DOMAIN}/cdn-cgi/access/login/x` } })
      }
    ])
    const r = await checkAccessRedirect(fetchImpl, BASE, DEFAULT_TEAM_DOMAIN)
    expect(r.ok).toBe(true)
  })

  it('checkAccessRedirect fails on a 302 to somewhere else', async () => {
    const fetchImpl = fakeFetch([
      { url: `${BASE}/`, response: fakeResponse({ status: 302, headers: { location: 'https://evil.example/' } }) }
    ])
    const r = await checkAccessRedirect(fetchImpl, BASE, DEFAULT_TEAM_DOMAIN)
    expect(r.ok).toBe(false)
  })

  it('checkAccessRedirect fails when the console renders instead of redirecting (200)', async () => {
    const fetchImpl = fakeFetch([{ url: `${BASE}/`, response: fakeResponse({ status: 200 }) }])
    const r = await checkAccessRedirect(fetchImpl, BASE, DEFAULT_TEAM_DOMAIN)
    expect(r.ok).toBe(false)
  })

  it('checkAdminDashboardUnauth passes on 401 JSON ok:false', async () => {
    const fetchImpl = fakeFetch([
      {
        url: `${BASE}/v1/admin/dashboard`,
        response: fakeResponse({ status: 401, jsonBody: { ok: false, error: 'Access required' } })
      }
    ])
    const r = await checkAdminDashboardUnauth(fetchImpl, BASE)
    expect(r.ok).toBe(true)
  })

  it('checkAdminDashboardUnauth fails if it ever leaks the dashboard (200)', async () => {
    const fetchImpl = fakeFetch([
      { url: `${BASE}/v1/admin/dashboard`, response: fakeResponse({ status: 200, jsonBody: { ok: true } }) }
    ])
    const r = await checkAdminDashboardUnauth(fetchImpl, BASE)
    expect(r.ok).toBe(false)
  })

  it('checkIngestGetNever200 passes on 401 or 405', async () => {
    for (const status of [401, 405]) {
      const fetchImpl = fakeFetch([{ url: `${BASE}/v1/ingest`, response: fakeResponse({ status }) }])
      const r = await checkIngestGetNever200(fetchImpl, BASE)
      expect(r.ok).toBe(true)
    }
  })

  it('checkIngestGetNever200 FAILS loudly if a bare GET ever ingests (200)', async () => {
    const fetchImpl = fakeFetch([{ url: `${BASE}/v1/ingest`, response: fakeResponse({ status: 200 }) }])
    const r = await checkIngestGetNever200(fetchImpl, BASE)
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('FAIL')
  })

  it('checkHeartbeatNoHmac passes on 401', async () => {
    const fetchImpl = fakeFetch([
      { url: `${BASE}/v1/heartbeat`, method: 'POST', response: fakeResponse({ status: 401 }) }
    ])
    const r = await checkHeartbeatNoHmac(fetchImpl, BASE)
    expect(r.ok).toBe(true)
  })

  it('checkHeartbeatNoHmac fails if an unsigned heartbeat is accepted (200)', async () => {
    const fetchImpl = fakeFetch([
      { url: `${BASE}/v1/heartbeat`, method: 'POST', response: fakeResponse({ status: 200, jsonBody: { ok: true } }) }
    ])
    const r = await checkHeartbeatNoHmac(fetchImpl, BASE)
    expect(r.ok).toBe(false)
  })

  it('a network error surfaces as a failed (not thrown) check', async () => {
    const fetchImpl = async () => {
      throw new Error('ECONNRESET')
    }
    const r = await checkHealth(fetchImpl, BASE)
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('ECONNRESET')
  })
})

describe('runSmoke orchestrator', () => {
  function allGreenFetch() {
    return fakeFetch([
      { url: `${BASE}/health`, response: fakeResponse({ jsonBody: { ok: true, version: 'deadbee' } }) },
      {
        url: `${BASE}/assets/index.js`,
        response: fakeResponse({ headers: { 'content-type': 'application/javascript' }, textBody: 'x'.repeat(50_000) })
      },
      { url: `${BASE}/assets/world.svg`, response: fakeResponse({ headers: { 'content-type': 'image/svg+xml' } }) },
      {
        url: `${BASE}/`,
        response: fakeResponse({ status: 302, headers: { location: `${DEFAULT_TEAM_DOMAIN}/cdn-cgi/access/login/x` } })
      },
      {
        url: `${BASE}/v1/admin/dashboard`,
        response: fakeResponse({ status: 401, jsonBody: { ok: false } })
      },
      { url: `${BASE}/v1/ingest`, response: fakeResponse({ status: 401 }) },
      { url: `${BASE}/v1/heartbeat`, method: 'POST', response: fakeResponse({ status: 401 }) }
    ])
  }

  it('allOk is true when every check passes', async () => {
    const report = await runSmoke({ baseUrl: BASE, fetchImpl: allGreenFetch() })
    expect(report.checks).toHaveLength(7)
    expect(report.allOk).toBe(true)
  })

  it('allOk is false when a single check fails', async () => {
    const fetchImpl = allGreenFetch()
    const report = await runSmoke({
      baseUrl: BASE,
      fetchImpl: async (url, init) => {
        if (url === `${BASE}/health`) return fakeResponse({ jsonBody: { ok: true } })
        return fetchImpl(url, init)
      }
    })
    expect(report.allOk).toBe(false)
    expect(report.checks.filter((c) => !c.ok)).toHaveLength(1)
  })

  it('trims a trailing slash off baseUrl before building check URLs', async () => {
    const fetchImpl = allGreenFetch()
    const report = await runSmoke({ baseUrl: `${BASE}/`, fetchImpl })
    expect(report.baseUrl).toBe(BASE)
    expect(report.allOk).toBe(true)
  })
})

describe('parseArgs', () => {
  it('reads --url, --team-domain and --json', () => {
    const args = parseArgs(['--url', BASE, '--team-domain', 'https://x.cloudflareaccess.com', '--json'])
    expect(args.url).toBe(BASE)
    expect(args.teamDomain).toBe('https://x.cloudflareaccess.com')
    expect(args.json).toBe(true)
  })

  it('defaults teamDomain and json when omitted', () => {
    const args = parseArgs(['--url', BASE])
    expect(args.teamDomain).toBe(DEFAULT_TEAM_DOMAIN)
    expect(args.json).toBe(false)
  })

  it('flags --help', () => {
    expect(parseArgs(['--help']).help).toBe(true)
  })
})
