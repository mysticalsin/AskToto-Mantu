import { describe, expect, it } from 'vitest'
import { handleRequest, type Env } from './index'
import { hmacHex } from './hmac'
import { sha256Hex } from './crypto'
import { ingestCanonical, OPERATOR_HMAC_HEADERS } from '../../src/shared/operator-hmac'
import { memoryStore } from './store'
import { TEST_INGEST_SECRET, TEST_PROMPT_KEY } from './test-fixtures'
import { findBandSubpaths } from './map-bands'
import { FORBIDDEN_NAV, NAV_IDS } from './nav'
import { tokenPatternForTests } from './redact'
import { SPA_CSS_PATH, SPA_JS_PATH } from './spa/manifest'

const NOW = 1_725_000_000_000

function env(): Env {
  return {
    OPERATOR_INGEST_SECRET: TEST_INGEST_SECRET,
    OPERATOR_PROMPT_KEY: TEST_PROMPT_KEY,
    OPERATOR_SKILL_PRIVATE_KEY: 'unused'
  }
}

const tonyAccess = {
  getIdentity: async () => ({ email: 'tony.walteur@gmail.com' })
}

async function signedRequest(
  path: string,
  bodyText: string,
  opts: { nonce?: string; deviceId?: string } = {}
): Promise<Request> {
  const ts = String(NOW)
  const nonce = opts.nonce ?? `nonce-${Math.random().toString(16).slice(2)}`
  const deviceId = opts.deviceId ?? 'device-a'
  const bodyHash = await sha256Hex(bodyText)
  const sig = await hmacHex(TEST_INGEST_SECRET, ingestCanonical(ts, nonce, deviceId, bodyHash))
  return new Request(`https://operator.test${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [OPERATOR_HMAC_HEADERS.ts]: ts,
      [OPERATOR_HMAC_HEADERS.nonce]: nonce,
      [OPERATOR_HMAC_HEADERS.device]: deviceId,
      [OPERATOR_HMAC_HEADERS.sig]: sig
    },
    body: bodyText
  })
}

async function page(store = memoryStore()): Promise<string> {
  const home = await handleRequest(
    new Request('https://operator.test/'),
    env(),
    { access: tonyAccess },
    { store, now: NOW }
  )
  return home.text()
}

function eventsHtml(html: string): string {
  const start = html.indexOf('data-page="events"')
  const end = html.indexOf('data-page="profiles"')
  return start >= 0 && end > start ? html.slice(start, end) : html
}

describe('product sidebar (#105)', () => {
  it('fills the rail with real Operator routes and has no Scale/Change leftover', async () => {
    const html = await page()
    const nav = [...html.matchAll(/data-nav="([^"]+)"/g)].map((m) => m[1])
    expect(nav).toEqual([...NAV_IDS])
    expect(html).not.toMatch(/data-nav="(scale|change)"/)
    expect(html).not.toMatch(/>CONSOLE</)
    expect(html).not.toContain('orphan')
    for (const id of NAV_IDS) {
      expect(html).toContain(`data-nav="${id}"`)
      expect(html).toContain(`data-page="${id}"`)
    }
    for (const id of FORBIDDEN_NAV) {
      expect(html, id).not.toContain(`data-nav="${id}"`)
      expect(html, id).not.toContain(`data-page="${id}"`)
    }
  })

  it('keeps LIVE chrome plus Licenses: Sessions, Keys, Settings', async () => {
    const html = await page()
    expect(html).not.toContain('+ Create report')
    expect(html).not.toContain('Ask AI anything')
    expect(html).toContain('data-nav="overview"')
    expect(html).toContain('data-nav="realtime"')
    expect(html).toContain('data-nav="events"')
    expect(html).toContain('data-nav="sessions"')
    expect(html).toContain('data-nav="licenses"')
    expect(html).toContain('data-nav="keys"')
    expect(html).toContain('data-nav="settings"')
    expect(html).toContain('data-nav="notifications"')
    expect(html).not.toContain('data-nav="map"')
    expect(html).not.toContain('data-nav="macos"')
    expect(html).not.toContain('data-nav="windows"')
    expect(html).not.toContain('data-nav="skills"')
    expect(html).not.toContain('data-nav="rules"')
    expect(html).not.toContain('data-nav="pushes"')
    expect(html).not.toContain('data-nav="dashboards"')
    expect(html).not.toContain('data-nav="seo"')
    expect(html).not.toContain('/products/sneakers')
    expect(html).not.toContain('defaultServers')
    expect(html).not.toContain('Frankfurt')
    expect(html).toContain('id="key-add"')
    expect(html).toContain('data-licenses-empty')
    expect(html).toContain('No licenses in D1')
    expect(html).toContain('Generate license')
    expect(html).toContain('data-license-generate')
    expect(html).toContain('/v1/admin/licenses/generate')
    const overviewEmpty = html.slice(html.indexOf('data-page="overview"'), html.indexOf('data-page="realtime"'))
    expect(overviewEmpty).toContain('data-license-generate')
    expect(overviewEmpty).toContain('Generate license')
    expect(html).toContain('Live seats')
    expect(html).toContain('Time saved')
    expect(html).toContain('Value')
    expect(html).toContain('data-overview-kpis')
    expect(html).toContain('data-overview-activity')
    expect(html).toContain('data-overview-people')
    expect(html).not.toContain('ROI today')
    expect(html).not.toContain('Unique Visitors')
    expect(html).not.toContain('data-login="1"')
    expect(html).toContain('#E5E7EB')
    expect(html).toContain('data-install-works')
    expect(html).toContain('data-access-solid')
    expect(html).toContain('#2563EB')
    expect(html).toContain('data-theme="dark"')
  })

  it('puts pending seats on the Install → works path with Approve', async () => {
    const store = memoryStore()
    await store.upsertSeat({
      device_id: 'device-a',
      seat_hash: 'seat-a',
      os: 'darwin',
      app_version: '1.8.2',
      first_seen: NOW,
      last_seen: NOW,
      country: 'CA',
      city: 'Longueuil',
      lat: 45.5,
      lon: -73.5,
      last_index_at: null,
      hostname: 'Tonys-MacBook-Pro',
      sso_email: 'twalteur@amaris.com',
      license: 'licensed',
      approval: 'pending'
    })
    const html = await page(store)
    const overview = html.slice(html.indexOf('data-page="overview"'), html.indexOf('data-page="realtime"'))
    expect(overview).toContain('data-install-works')
    expect(overview).toContain('Install → works')
    expect(overview).toContain('data-license-generate')
    expect(overview).toContain('Generate license')
    expect(overview).toContain('data-overview-kpis')
    expect(overview).toContain('data-overview-activity')
    expect(overview).toContain('data-overview-people')
    expect(overview).toContain('data-geo-corner')
    expect(overview).toContain('data-geo-widget')
    expect(overview).toContain('data-geo-tab="cities"')
    expect(overview).toContain('Longueuil')
    expect(overview).toContain('Tonys-MacBook-Pro')
    expect(overview).toContain('data-people-row')
    expect(overview).toContain('data-live="1"')
    expect(overview).toContain('data-license-approve="device-a"')
    expect(overview).toContain('pending')
    expect(html).toContain('data-nav="licenses"')
    expect(html).toContain('class="nav-count"')
  })

  it('lands a heartbeat on Overview people + activity with city', async () => {
    const store = memoryStore()
    const req = await signedRequest(
      '/v1/heartbeat',
      JSON.stringify({
        os: 'darwin',
        appVersion: '1.8.3',
        hostname: 'Tonys-MacBook-Pro',
        ssoEmail: 'twalteur@amaris.com',
        license: 'licensed'
      })
    )
    expect(
      (
        await handleRequest(req, env(), {}, {
          store,
          now: NOW,
          geo: { country: 'CA', city: 'Longueuil', region: 'Quebec', lat: 45.531, lon: -73.518 }
        })
      ).status
    ).toBe(200)
    const html = await page(store)
    const overview = html.slice(html.indexOf('data-page="overview"'), html.indexOf('data-page="realtime"'))
    expect(overview).toContain('data-overview-people')
    expect(overview).toContain('data-people-row')
    expect(overview).toContain('data-live="1"')
    expect(overview).toContain('data-city="Longueuil"')
    expect(overview).toContain('Tonys-MacBook-Pro')
    expect(overview).toContain('>live<')
    expect(overview).toContain('data-overview-activity')
    expect(overview).toMatch(/live|heartbeat/)
    expect(overview).toContain('Longueuil')
    expect(overview).toContain('data-geo-table="cities"')
    expect(overview).toContain('Generate license')
  })
})

describe('map has no repeating horizontal band', () => {
  it('renders Cloudflare geo without date-line slivers', async () => {
    const store = memoryStore()
    const req = await signedRequest(
      '/v1/heartbeat',
      JSON.stringify({ os: 'darwin', appVersion: '1.8.2', hostname: 'Tonys-MacBook-Pro' })
    )
    expect(
      (
        await handleRequest(req, env(), {}, {
          store,
          now: NOW,
          geo: { country: 'CA', city: 'Longueuil', lat: 45.531, lon: -73.518 }
        })
      ).status
    ).toBe(200)
    const html = await handleRequest(
      new Request('https://operator.test/'),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    ).then((r) => r.text())
    expect(findBandSubpaths(html)).toEqual([])
    expect(html).not.toMatch(/repeating-linear-gradient/)
    expect(html).toContain('data-iso="CA"')
    expect(html).toContain('#E5E7EB')
    expect(html).not.toMatch(/<rect class="world-ocean"[^>]*fill="#F5F5F5"/)
  })
})

describe('events keep seat OS after a later ask ingest', () => {
  it('does not wipe darwin when an ask arrives without os', async () => {
    const store = memoryStore()
    const hb = await signedRequest(
      '/v1/heartbeat',
      JSON.stringify({ os: 'darwin', appVersion: '1.8.2', hostname: 'Tonys-MacBook-Pro' }),
      { deviceId: 'mac-keep-os' }
    )
    expect((await handleRequest(hb, env(), {}, { store, now: NOW, geo: { country: 'CA', city: 'Longueuil', lat: 45.5, lon: -73.5 } })).status).toBe(200)
    const ask = await signedRequest(
      '/v1/ingest',
      JSON.stringify({ id: 'ask-keep-os', provider: 'claude-cli', mode: 'answer' }),
      { deviceId: 'mac-keep-os', nonce: 'ask-keep-os' }
    )
    expect((await handleRequest(ask, env(), {}, { store, now: NOW, geo: { country: 'CA', city: 'Longueuil', lat: 45.5, lon: -73.5 } })).status).toBe(200)
    const html = await handleRequest(
      new Request('https://operator.test/'),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    ).then((r) => r.text())
    const events = eventsHtml(html)
    expect(events).toContain('darwin')
    expect(events).toContain('Tonys-MacBook-Pro')
  })
})

describe('events never render token-like strings', () => {
  it('drops bearer, sk-, JWT, and HMAC-shaped values from the events page', async () => {
    const store = memoryStore()
    await store.insertEvent({
      id: 'tok-1',
      ts: NOW,
      kind: 'ask',
      actor: 'twalteur@amaris.com',
      device_id: 'device-a',
      country: 'CA',
      detail: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signaturexx'
    })
    await store.upsertSeat({
      device_id: 'device-a',
      seat_hash: 'seat',
      os: 'darwin',
      app_version: '1.8.2',
      first_seen: NOW,
      last_seen: NOW,
      country: 'CA',
      city: 'Longueuil',
      lat: 45.5,
      lon: -73.5,
      last_index_at: null,
      hostname: 'Tonys-MacBook-Pro',
      sso_email: 'twalteur@amaris.com',
      license: 'approved'
    })
    const ingest = await signedRequest(
      '/v1/ingest',
      JSON.stringify({
        id: 'ask-token',
        mode: 'interview',
        question: 'Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345',
        cacheStatus: 'hit'
      })
    )
    expect((await handleRequest(ingest, env(), {}, { store, now: NOW })).status).toBe(200)
    const html = await handleRequest(
      new Request('https://operator.test/'),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    ).then((r) => r.text())
    const events = eventsHtml(html)
    expect(events).not.toMatch(tokenPatternForTests())
    expect(events).not.toContain('Bearer')
    expect(events).not.toContain('sk-ant-')
    expect(events).toContain('data-event=')
  })
})

describe('licenses pane is real seats with Tony approval, not Shoey demo rows', () => {
  it('lists computer, SSO, license, approval, and Approve for pending seats', async () => {
    const store = memoryStore()
    await store.upsertSeat({
      device_id: 'device-a',
      seat_hash: 'seat-a',
      os: 'darwin',
      app_version: '1.8.2',
      first_seen: NOW - 31_000,
      last_seen: NOW,
      country: 'CA',
      city: 'Longueuil',
      lat: 45.5,
      lon: -73.5,
      last_index_at: null,
      hostname: 'Tonys-MacBook-Pro',
      sso_email: 'twalteur@amaris.com',
      license: 'licensed',
      approval: 'pending'
    })
    const html = await page(store)
    const licenses = html.slice(html.indexOf('data-page="licenses"'), html.indexOf('data-page="skills"'))
    expect(licenses).toContain('Tonys-MacBook-Pro')
    expect(licenses).toContain('twalteur@amaris.com')
    expect(licenses).toContain('licensed')
    expect(licenses).toContain('pending')
    expect(licenses).toContain('data-license-approve="device-a"')
    expect(licenses).not.toContain('defaultServers')
    expect(licenses).not.toContain('Frankfurt')
    expect(html).toContain('data-nav="sessions"')
    expect(html).toContain('data-nav="notifications"')
    expect(html).toContain('data-nav="licenses"')
    expect(html).toContain('data-nav="settings"')
  })
})

describe('profiles hostname and SSO email', () => {
  it('renders hostname and email when the seat sent them', async () => {
    const store = memoryStore()
    const req = await signedRequest(
      '/v1/heartbeat',
      JSON.stringify({
        os: 'darwin',
        appVersion: '1.8.2',
        hostname: 'Tonys-MacBook-Pro',
        ssoEmail: 'Twalteur@amaris.com'
      })
    )
    expect((await handleRequest(req, env(), {}, { store, now: NOW })).status).toBe(200)
    const html = await handleRequest(
      new Request('https://operator.test/'),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    ).then((r) => r.text())
    expect(html).toContain('Tonys-MacBook-Pro')
    expect(html).toContain('twalteur@amaris.com')
    expect(html).toContain('data-page="sessions"')
    expect(html).toContain('data-page="licenses"')
    const seats = await store.listSeats()
    expect(seats[0]?.hostname).toBe('Tonys-MacBook-Pro')
    expect(seats[0]?.sso_email).toBe('twalteur@amaris.com')
  })

  it('uses an em dash when hostname or email is missing, never invented people', async () => {
    const store = memoryStore()
    const req = await signedRequest('/v1/heartbeat', JSON.stringify({ os: 'win', appVersion: '1.8.2' }))
    expect((await handleRequest(req, env(), {}, { store, now: NOW })).status).toBe(200)
    const html = await handleRequest(
      new Request('https://operator.test/'),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    ).then((r) => r.text())
    expect(html).toContain('—')
    expect(html).not.toContain('Jane Doe')
    expect(html).not.toContain('visitor@')
    const seats = await store.listSeats()
    expect(seats[0]?.hostname).toBeNull()
    expect(seats[0]?.sso_email).toBeNull()
  })
})

describe('realtime and map use live heartbeats, not leftover OpenPanel', () => {
  it('paints real seats on the pre-Shoey map and fleet, never shoe SKUs', async () => {
    const store = memoryStore()
    await store.upsertSeat({
      device_id: 'mac-a',
      seat_hash: 'seat-mac-a',
      os: 'darwin',
      app_version: '1.8.3',
      first_seen: NOW,
      last_seen: NOW,
      country: 'CA',
      city: 'Longueuil',
      lat: 45.531,
      lon: -73.518,
      last_index_at: null,
      hostname: 'Tonys-MacBook-Pro',
      sso_email: 'twalteur@amaris.com',
      license: 'licensed',
      approval: 'approved'
    })
    const html = await page(store)
    expect(html).toContain('Tonys-MacBook-Pro')
    expect(html).toContain('data-iso="CA"')
    expect(html).toContain('#E5E7EB')
    expect(html).toContain('data-live-presence')
    expect(html).toContain('data-world-map')
    expect(html).toContain('data-live-feed')
    expect(html).toContain('data-realtime-geo')
    expect(html).toContain('data-geo-table="realtime"')
    expect(html).toContain('data-geo-tab="regions"')
    expect(html).toContain('data-city="Longueuil"')
    const realtime = html.slice(html.indexOf('data-page="realtime"'), html.indexOf('data-page="sessions"'))
    expect(realtime).toContain('WorldMap')
    expect(realtime).toContain('LiveFeed')
    expect(realtime).toContain('GeoTable')
    expect(realtime).not.toContain('data-geo-corner')
    expect(html).toContain('data-page="sessions"')
    expect(html).toContain('<th>City</th>')
    expect(html).toContain('<th>Device</th>')
    expect(html).toContain('Longueuil')
    expect(html).not.toContain('/products/sneakers')
    expect(html).not.toContain('defaultServers')
  })
})

function mapRootHtml(html: string): string {
  const start = html.indexOf('<div id="map-root"')
  if (start < 0) return ''
  const articleEnd = html.indexOf('</article>', start)
  return articleEnd > start ? html.slice(start, articleEnd) : ''
}

describe('realtime.geo.json is city-level Shoey rows', () => {
  it('returns 401 without Access', async () => {
    const res = await handleRequest(
      new Request('https://operator.test/v1/admin/realtime.geo.json'),
      env(),
      {},
      { store: memoryStore(), now: NOW }
    )
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ ok: false, error: 'Access required' })
  })

  it('emits city rows after a heartbeat and never country-only', async () => {
    const store = memoryStore()
    const req = await signedRequest(
      '/v1/heartbeat',
      JSON.stringify({ os: 'darwin', appVersion: '1.8.3', hostname: 'Tonys-MacBook-Pro' })
    )
    expect(
      (
        await handleRequest(req, env(), {}, {
          store,
          now: NOW,
          geo: { country: 'CA', city: 'Longueuil', region: 'Quebec', lat: 45.531, lon: -73.518 }
        })
      ).status
    ).toBe(200)
    const res = await handleRequest(
      new Request('https://operator.test/v1/admin/realtime.geo.json'),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      geo: { country: string; city: string; count: number; unique_sessions: number; avg_duration: number }[]
    }
    expect(body.ok).toBe(true)
    expect(body.geo[0]).toMatchObject({
      country: 'CA',
      city: 'Longueuil',
      count: 1,
      unique_sessions: 1
    })
    expect(body.geo[0]).toHaveProperty('avg_duration')
    expect(body.geo.every((r) => r.city)).toBe(true)
  })
})

describe('map land is in #map-root HTML', () => {
  it('inlines path[data-iso] land inside #map-root', async () => {
    const html = await page()
    const root = mapRootHtml(html)
    expect(root).toContain('id="map-root"')
    expect(root).toContain('data-iso="CA"')
    expect(html).toContain('data-page="map"')
    expect(html).toContain('data-nav="sessions"')
  })
})
