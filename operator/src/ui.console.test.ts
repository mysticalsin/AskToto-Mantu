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
  const end = html.indexOf('data-page="sessions"')
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

  it('mirrors Shoey chrome with Métis nouns and no shoe SKUs', async () => {
    const html = await page()
    expect(html).not.toContain('+ Create report')
    expect(html).not.toContain('Ask AI anything')
    expect(html).toContain('Unique seats')
    expect(html).toContain('Unique sessions')
    expect(html).toContain('Sessions / day')
    expect(html).toContain('API calls')
    expect(html).toContain('Time saved')
    expect(html).toContain('Listen minutes')
    expect(html).toContain('CLI asks')
    expect(html).toContain('Operator-key asks')
    expect(html).toContain('CLI vs Operator-key asks')
    expect(html).toContain('Countries')
    expect(html).toContain('Mac vs Windows')
    expect(html).toContain('Version mix')
    expect(html).toContain('data-overview-cards="10"')
    expect(html.match(/data-stat-card="/g)?.length).toBe(10)
    expect(html).toContain('data-bklit="area"')
    expect(html).toContain('data-bklit="line"')
    expect(html).toContain('data-bklit="gauge"')
    expect(html).toContain('data-bklit="ring"')
    expect(html).toContain('data-bklit="choropleth"')
    const realtime = html.slice(html.indexOf('data-page="realtime"'), html.indexOf('data-page="events"'))
    expect(realtime).not.toContain('data-stat-card=')
    expect(realtime).not.toContain('data-bklit=')
    expect(html).not.toContain('not reported')
    expect(html).toContain('data-stat-card="tokens"')
    expect(html).toMatch(/data-stat-card="tokens"[\s\S]*?<div class="lbl">tokens<\/div>/)
    expect((html.match(/data-iso="/g) || []).length).toBeGreaterThan(50)
    expect(html).toContain('data-iso="CA"')
    expect(html).toContain('data-iso="US"')
    expect(html).toContain('class="world-ocean"')
    expect(html).not.toContain('Asks per seat')
    expect(html).toContain('Live · 30 min')
    expect(html).toContain('Unique seats last 30 min')
    expect(html).toContain('data-nav="overview"')
    expect(html).toContain('data-nav="realtime"')
    expect(html).toContain('data-nav="events"')
    expect(html).toContain('data-nav="sessions"')
    expect(html).toContain('data-nav="notifications"')
    expect(html).toContain('data-nav="keys"')
    expect(html).toContain('data-nav="settings"')
    expect(html).not.toContain('data-nav="dashboards"')
    expect(html).not.toContain('data-nav="insights"')
    expect(html).not.toContain('data-nav="pages"')
    expect(html).not.toContain('data-nav="seo"')
    expect(html).not.toContain('data-nav="groups"')
    expect(html).not.toContain('data-nav="cohorts"')
    expect(html).not.toContain('data-nav="profiles"')
    expect(html).not.toContain('data-nav="references"')
    expect(html).not.toContain('/products/sneakers')
    expect(html).not.toMatch(/heroku\.com|bitbucket\.com/)
    expect(html).not.toContain('data-nav="map"')
    expect(html).not.toContain('data-nav="macos"')
    expect(html).toContain(`<link rel="stylesheet" href="${SPA_CSS_PATH}">`)
    expect(html).toContain(`<script src="${SPA_JS_PATH}" defer>`)
    expect(html).not.toContain('self.METIS_OPERATOR =')
    expect(html).not.toContain('<style>')
    expect(html).toContain('data-alias="realtime"')
    expect(html).toContain('>Events</span><span>Sessions</span>')
    expect(html).toContain('class="world shoey-world"')
    expect(html).toContain('#E5E7EB')
    expect(html).toContain('class="world-ocean"')
    expect(html).toContain('class="world-land"')
    const eventsPage = html.slice(html.indexOf('data-page="events"'), html.indexOf('data-page="sessions"'))
    expect(eventsPage).toContain('Created at')
    expect(eventsPage).toContain('>Name<')
    expect(eventsPage).toContain('>Profile<')
    expect(eventsPage).toContain('>Country<')
    expect(eventsPage).toContain('>OS<')
    expect(eventsPage).toContain('>Browser<')
    expect(eventsPage).not.toContain('Conversions')
    expect(eventsPage).not.toContain('screen_view')
    const sessionsPage = html.slice(html.indexOf('data-page="sessions"'), html.indexOf('data-page="notifications"'))
    expect(sessionsPage).toContain('data-seat-table')
    expect(sessionsPage).toContain('Seat / computer')
    expect(sessionsPage).toContain('Last seen')
    const notesPage = html.slice(html.indexOf('data-page="notifications"'), html.indexOf('data-page="map"'))
    expect(notesPage).toContain('>Title<')
    expect(notesPage).toContain('>Integration<')
    expect(notesPage).toContain('Created at')
    expect(html).toContain('id="key-add"')
    const css = await handleRequest(
      new Request(`https://operator.test${SPA_CSS_PATH}`),
      env(),
      {},
      { store: memoryStore(), now: NOW }
    ).then((r) => r.text())
    expect(css).toContain('grid-template-columns: 185px 1fr')
    expect(css).toContain('font: 12px/1.4')
    const js = await handleRequest(
      new Request(`https://operator.test${SPA_JS_PATH}`),
      env(),
      {},
      { store: memoryStore(), now: NOW }
    ).then((r) => r.text())
    expect(js).toContain("requested === 'map' ? 'realtime'")
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
    expect(html).toContain('class="world-land"')
    expect(html).toMatch(/fill="#E5E7EB"/)
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
    expect(html).toContain('data-seat-row')
    expect(html).toContain('seat-status')
    expect(html).toMatch(/Active|Paused|Inactive/)
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
