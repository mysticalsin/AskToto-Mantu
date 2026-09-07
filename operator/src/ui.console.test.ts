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

/** Shoey land color and every other console rule now lives in the hashed external stylesheet
 * (plan D3: no inline <style>), not inline in the page HTML. Fetch it the same way a browser
 * would via the <link> the page prints. */
async function cssOf(store = memoryStore()): Promise<string> {
  const res = await handleRequest(
    new Request(`https://operator.test${SPA_CSS_PATH}`),
    env(),
    {},
    { store, now: NOW }
  )
  return res.text()
}

/** Slices one `data-page="<id>"` section out of the full console document, up to the next
 *  page's `data-page="<nextId>"`. Throws rather than silently widening to the whole document
 *  (or to `-1`, i.e. "everything but the last character") the moment either id stops existing --
 *  the exact failure mode that let this file's stale page ids rot unnoticed for a while. Every
 *  page-scoped assertion below goes through this one helper instead of its own ad hoc
 *  `indexOf`/`slice` pair. */
function pageSlice(html: string, id: string, nextId: string): string {
  const start = html.indexOf(`data-page="${id}"`)
  const end = html.indexOf(`data-page="${nextId}"`)
  if (start < 0 || end < start) {
    throw new Error(`pageSlice: could not find data-page="${id}"..data-page="${nextId}" boundaries in the console HTML`)
  }
  return html.slice(start, end)
}

function eventsHtml(html: string): string {
  return pageSlice(html, 'events', 'licenses')
}

/** Scopes findBandSubpaths to the real land geometry (world/map.ts's world-land-group), not the
 *  whole document: the full map's intentional 10-degree graticule (plan 3.7 item 2) is itself a
 *  set of full-width, near-zero-height lines and trips the exact "wide, short subpath" heuristic
 *  findBandSubpaths uses for a genuine date-line sliver. This test used to scan the whole page
 *  back when the map SVG had no graticule; scanning it now produces a false positive on every
 *  render. A real date-line sliver would show up in the land paths, so that is what stays
 *  checked -- throws instead of silently checking nothing if the land group ever moves. */
function landPathsHtml(html: string): string {
  const start = html.indexOf('class="world-land-group"')
  const end = html.indexOf('</g>', start)
  if (start < 0 || end < start) {
    throw new Error('landPathsHtml: could not find the world-land-group boundaries in the console HTML')
  }
  return html.slice(start, end)
}

/** The full realtime map (world/map.ts renderRealtimeMapSvg) marks its root with the
 *  `data-map-root` attribute, not the old monolith's `id="map-root"` (that id has no remaining
 *  caller anywhere in operator/src -- grep confirms only test files still name it). Throws
 *  instead of returning '' so a future rename fails loud here, same as pageSlice above. */
function mapRootHtml(html: string): string {
  const start = html.indexOf('data-map-root')
  const articleEnd = html.indexOf('</article>', start)
  if (start < 0 || articleEnd < start) {
    throw new Error('mapRootHtml: could not find data-map-root..</article> boundaries in the console HTML')
  }
  return html.slice(start, articleEnd)
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
    const overviewEmpty = pageSlice(html, 'overview', 'realtime')
    expect(overviewEmpty).toContain('data-license-generate')
    expect(overviewEmpty).toContain('Generate license')
    expect(html).toContain('Live seats')
    expect(html).toContain('Time saved')
    expect(html).toContain('Value')
    // Overview's KPI tiles (render/pages/overview.ts renderMetricTilesBlock) and its six-plus
    // top-list-card grid have no data-overview-kpis/data-overview-toplists id from the old
    // monolith; they render under stable classes/attributes instead: mtiles-grid for the tile
    // strip, data-overview-grid for the card grid (P0.4's page-module rebuild, plan 6.2).
    expect(html).toContain('mtiles-grid')
    expect(html).toContain('data-overview-grid')
    // The old raw "Activity" feed and "People" strip left Overview entirely (plan 6.2 lists six
    // top-list-cards -- Seats, Asks, Events (Kinds), Licenses, Countries, Map -- plus a
    // Connectors card and the Generate license card; no standalone activity log or people list
    // is in that spec). "Who is live" (3.7b law 2's first question) now answers through the
    // Seats top-list-card; the raw event replay moved to Events' own table and Realtime's Live
    // events feed (both still real, checked elsewhere in this file).
    expect(html).toContain('data-ov-tlc-card="seats"')
    // "Created at" (the Events table's first column, EVENT_COLUMNS in render/pages/events.ts)
    // cannot be checked from this empty-store fixture any more: dataTable() (plan lock 3, no
    // fake tables) now renders only the named empty state, with no <thead>, when there are zero
    // rows -- the old monolith printed a static header regardless of data. Checked instead in
    // "events keep seat OS after a later ask ingest" below, once a real event exists.
    expect(html).toContain('Search seats')
    // Events toolbar (plan 6.4, Tony 2026-09-06 fidelity clause: match the reference's toolbar
    // exactly -- Listening, range, Filters, View, no visible search box). Text search still
    // works through the Filters panel's own Profile field, checked here instead of the retired
    // standalone search box's placeholder.
    expect(html).toContain('placeholder="hostname, email or device id"')
    expect(html).not.toContain('id="ev-search"')
    expect(html).toContain('data-rt-live-strip')
    expect(html).toContain('Seats 30m')
    expect(html).toContain('Live events')
    expect(html).not.toContain('ROI today')
    expect(html).not.toContain('Unique Visitors')
    expect(html).not.toContain('data-login="1"')
    expect(html).toContain(`<link rel="stylesheet" href="${SPA_CSS_PATH}"`)
    expect(html).toContain(`<script src="${SPA_JS_PATH}"`)
    // No page-level inline <style> in <head> (plan D3) — an SVG-scoped <style> for the world
    // map's pulse animation is fine, that is not the page's own chrome CSS.
    const head = html.slice(html.indexOf('<head>'), html.indexOf('</head>'))
    expect(head).not.toContain('<style')
    expect(html).not.toMatch(/<script>(?!.*src=)/s)
    const css = await cssOf()
    // Amaris-skinned tokens (plan 3.2) replaced the measured-Shoey light map and rail-logo hex
    // literals: the map reads --map-land / --map-ocean (defined in both :root and
    // [data-theme="dark"]), the rail logo reads --accent, and neither retired hex remains.
    expect(css).toMatch(/--map-land:\s*#[0-9a-f]{3,8}/i)
    expect(css).toMatch(/--map-ocean:\s*#[0-9a-f]{3,8}/i)
    // Defined for both light and dark: :root (light), [data-theme="dark"], and the
    // prefers-color-scheme fallback for an unset cookie -- at least 2, never a single value.
    expect((css.match(/--map-land:/g) || []).length).toBeGreaterThanOrEqual(2)
    expect(css).toContain('fill: var(--map-land)')
    expect(css).toContain('.rail-logo')
    expect(css).toMatch(/--accent:\s*#[0-9a-f]{3,8}/i)
    expect(css).not.toContain('#E5E7EB')
    expect(css).not.toContain('#2563EB')
    // The Overview "Install -> works" ladder is retired (plan 6.7 block 0, "Needs your review":
    // Licenses is now the only place a seat is approved -- see the quality-bar.test.ts and
    // keys.test.ts reports for the full citation). data-install-works has no caller left in
    // operator/src outside test files.
    expect(html).toContain('data-review-block')
    expect(html).toContain('data-access-solid')
    expect(html).toContain('data-theme="light"')
    const overview = pageSlice(html, 'overview', 'realtime')
    expect(overview).toContain('data-overview-grid')
    expect(overview).toContain('data-ov-tlc-card="seats"')
    expect(overview).toContain('data-ov-map-card')
    // "Places" was the old paired Countries+Map widget's own eyebrow; the Amaris rebuild split
    // it into the Countries top-list-card (whose first tab is literally labelled "Countries")
    // and its own standalone Map card, so there is no single "Places" heading left to check.
    expect(overview).toContain('>Countries<')
    expect(overview).toContain('>Map<')
    // Same six-question ordering the old assertion protected (top-lists, then the map, then the
    // page's one action), just anchored on the real ids: the grid (which contains the map card
    // as its last child) comes before the map card's own position, which comes before the
    // trailing Generate license card.
    expect(overview.indexOf('data-overview-grid')).toBeLessThan(overview.indexOf('data-ov-map-card'))
    expect(overview.indexOf('data-ov-map-card')).toBeLessThan(overview.indexOf('data-ov-license-card'))
    const realtime = pageSlice(html, 'realtime', 'sessions')
    expect(realtime.indexOf('data-world-map')).toBeLessThan(realtime.indexOf('data-rt-live-strip'))
    expect(realtime.indexOf('data-rt-live-strip')).toBeLessThan(realtime.indexOf('data-realtime-geo'))
  })

  it('puts pending seats on the Licenses "Needs your review" path with Approve', async () => {
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
    const overview = pageSlice(html, 'overview', 'realtime')
    // Overview keeps the six-question summary (plan 3.7b law 2) and the Generate license
    // action; approving a seat is not one of Overview's questions any more. Plan 6.7 block 0
    // ("Needs your review", 2026-09-06: "seats awaiting approval have their own section, in the
    // license section ... it shouldn't be mixed with the notifications, it gets confusing") made
    // Licenses the one place a seat is approved -- checked below, not here.
    expect(overview).toContain('data-license-generate')
    expect(overview).toContain('Generate license')
    expect(overview).toContain('mtiles-grid')
    expect(overview).toContain('data-overview-grid')
    expect(overview).toContain('data-ov-map-card')
    expect(overview).toContain('data-ov-license-card')
    expect(overview.indexOf('data-overview-grid')).toBeLessThan(overview.indexOf('data-ov-map-card'))
    expect(overview.indexOf('data-ov-map-card')).toBeLessThan(overview.indexOf('data-ov-license-card'))
    // Places is now the Countries card (Countries/Regions/Cities tabs) -- its Cities pane still
    // carries this seat's real city, the Seats card still carries its hostname and OS, and every
    // row still grows a real proportional bar (class="row-bar", renamed from the old vol-bar).
    expect(overview).toContain('data-ov-tlc-pane="countries:cities"')
    expect(overview).toContain('data-ov-tlc-card="seats"')
    expect(overview).toContain('data-ov-tlc-pane="seats:os"')
    expect(overview).toContain('class="row-bar"')
    expect(overview).toContain('Longueuil')
    expect(overview).toContain('Tonys-MacBook-Pro')
    expect(overview).toContain('data-os="darwin"')
    expect(overview).toContain('data-country="CA"')
    expect(overview).toContain('status-dot-live')
    // The Licenses states pane (real, not fabricated) still shows this seat's real state.
    expect(overview).toContain('data-q="pending"')
    // Approving a seat has exactly one home now: never duplicated back onto Overview.
    expect(overview).not.toContain('data-license-approve')
    expect(html).toContain('data-nav="licenses"')
    expect(html).toContain('class="nav-count"')
    const licenses = pageSlice(html, 'licenses', 'groups')
    expect(licenses).toContain('Needs your review')
    expect(licenses).toContain('data-review-approve="device-a"')
    expect(licenses).toContain('Tonys-MacBook-Pro')
    expect(licenses).toContain('data-license-approve="device-a"')
  })

  it('lands a heartbeat on Overview and Realtime with city', async () => {
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
    const overview = pageSlice(html, 'overview', 'realtime')
    // "Who is live" (3.7b law 2) now answers through the Seats top-list-card: the real seat's
    // hostname, its live status dot, and the fleet-wide Live seats tile counting it.
    expect(overview).toContain('data-ov-tlc-card="seats"')
    expect(overview).toContain('Tonys-MacBook-Pro')
    expect(overview).toContain('status-dot-live')
    expect(overview).toContain('>Live<')
    expect(overview).toContain('data-count-to="1"')
    // City is discoverable through the Countries card's Cities pane, not a raw data-city
    // attribute (retired along with the old <table>-based Places widget).
    expect(overview).toContain('data-ov-tlc-pane="countries:cities"')
    expect(overview).toContain('Longueuil')
    expect(overview).toContain('Generate license')
    expect(overview).toContain('data-license-generate')
    // The raw activity/people log with a per-row age and email moved off Overview entirely
    // (plan 6.2's cards summarise counts, they do not replay a feed) -- it lives on Realtime
    // (Live events feed, ages included) and Licenses (this seat's real SSO email).
    const realtime = pageSlice(html, 'realtime', 'sessions')
    expect(realtime).toContain('data-live-feed')
    expect(realtime).toContain('class="ago"')
    expect(realtime).toMatch(/>now</)
    expect(realtime).toContain('data-city="Longueuil"')
    const licenses = pageSlice(html, 'licenses', 'notifications')
    expect(licenses).toContain('twalteur@amaris.com')
    expect(licenses).toContain('Tonys-MacBook-Pro')
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
    expect(findBandSubpaths(landPathsHtml(html))).toEqual([])
    expect(html).not.toMatch(/repeating-linear-gradient/)
    expect(html).toContain('data-iso="CA"')
    expect(await cssOf(store)).toMatch(/--map-land:\s*#[0-9a-f]{3,8}/i)
    expect(await cssOf(store)).toContain('fill: var(--map-land)')
    expect(await cssOf(store)).not.toContain('#E5E7EB')
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
    expect(events).toContain('Longueuil')
    // Moved here from the 'product sidebar' empty-store test: EVENT_COLUMNS's header only
    // renders once at least one row exists (dataTable() shows just the named empty state at
    // zero rows, plan lock 3), so this real event is what proves the column label.
    expect(events).toContain('Created at')
    const realtime = pageSlice(html, 'realtime', 'sessions')
    expect(realtime).toContain('data-world-live')
    expect(realtime).toContain('LIVE 1')
    expect(realtime).toContain('class="ago"')
    // The old feed rendered each chip as raw "key value" text ("city Longueuil"); the map pin
    // (world/map.ts renderPin) now carries the same real geo honestly as a data-city attribute
    // plus a visible label on the map itself, rather than a plain-text chip.
    expect(realtime).toContain('data-city="Longueuil"')
    expect(realtime).toContain('>Longueuil<')
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
    const licenses = pageSlice(html, 'licenses', 'notifications')
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
    const notices = pageSlice(html, 'notifications', 'keys')
    expect(notices).toContain('data-notice-table')
    expect(notices).toContain('<th>Profile</th>')
    // countryCell() (plan 3.6) replaced the plain City column with a Country column that
    // carries the city as its secondary line -- flag, country name, then city underneath --
    // rather than dropping city information; it is still on the page, just not its own <th>.
    expect(notices).toContain('<th>Country</th>')
    expect(notices).toContain('<th>OS</th>')
    expect(notices).toContain('Tonys-MacBook-Pro')
    expect(notices).toContain('Longueuil')
    expect(notices).toContain('darwin')
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
    expect(await cssOf(store)).toMatch(/--map-land:\s*#[0-9a-f]{3,8}/i)
    expect(await cssOf(store)).toContain('fill: var(--map-land)')
    expect(await cssOf(store)).not.toContain('#E5E7EB')
    // The old "Live people" strip (data-live-presence) was a plain list of currently-live
    // seats, separate from the map. Plan 6.3's Connected seats table absorbed and enriched that
    // job (avatar with live dot, hostname, email, country/city, OS, client, tier, session
    // timing) rather than dropping it -- data-realtime-seats is its real successor.
    expect(html).toContain('data-realtime-seats')
    expect(html).toContain('data-world-map')
    expect(html).toContain('data-live-feed')
    expect(html).toContain('data-realtime-geo')
    expect(html).toContain('data-city="Longueuil"')
    const realtime = pageSlice(html, 'realtime', 'sessions')
    // "WorldMap" / "GeoTable" were the old Shoey-clone's own internal component names leaking
    // into page copy; the Amaris rebuild (plan 3.1/3.7b law 6, "no jargon in chrome") replaced
    // them with the real data-* hooks already asserted above, or with no label at all where the
    // map panel needs none.
    expect(realtime).toContain('data-world-map')
    expect(realtime).toContain('Live events')
    expect(realtime).toContain('data-live-feed')
    expect(realtime).toContain('data-rt-live-strip')
    expect(realtime).toContain('Seats 30m')
    expect(realtime).toContain('data-realtime-geo')
    expect(realtime).toContain('class="rt-pin"')
    expect(realtime).toContain('data-country="Canada"')
    expect(realtime).toContain('data-city="Longueuil"')
    // Plan D2: the Geo table's real per-country/per-city rows are JSON-hydrated client-side
    // (GET /v1/admin/realtime/geo.json, checked directly by the neighbouring
    // 'realtime.geo.json is city-level Shoey rows' describe block below) rather than
    // server-rendered -- first paint honestly shows a sized skeleton while seats30m > 0
    // (data-rt-skeleton) instead of a data-geo-table="realtime" table full of guessed rows or a
    // Country/Region/City tab switcher (that tabbed breakdown, data-geo-tab, is Overview's
    // Countries card, plan 6.2, exercised separately by the 'product sidebar' tests).
    expect(realtime).toContain('data-rt-skeleton')
    expect(realtime).not.toContain('data-geo-corner')
    expect(html).toContain('data-page="sessions"')
    // Sessions is fully client-hydrated now (plan D2: DashboardPayload carries no `sessions`
    // field of its own -- render/pages/sessions.ts's renderSessions always gets `rows == null`
    // on first server paint). It honestly shows a sized skeleton, never the old server-rendered
    // <th>City</th>/<th>Device</th> table with real or fabricated rows; the merged Country /
    // City and Seat columns (plan 6.5) and this seat's real values are covered directly by
    // render/pages/sessions.test.ts (renderSessionsTableBody with real row data) and the GET
    // /v1/admin/sessions.json contract, not by this file's job of asserting the shell.
    const sessions = pageSlice(html, 'sessions', 'events')
    expect(sessions).toContain('data-sessions-skeleton')
    expect(sessions).toContain('data-loaded="false"')
    expect(html).not.toContain('/products/sneakers')
    expect(html).not.toContain('defaultServers')
  })
})

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
    expect(root).toContain('data-map-root')
    // World land (world/map.ts's landPaths(), one path[data-iso] per country) is inlined
    // unconditionally -- Canada's outline renders whether or not any seat has ever checked in,
    // same as the old id="map-root" contract asserted, just under the new attribute.
    expect(root).toContain('data-iso="CA"')
    // 'map' stays a real, empty, aria-hidden placeholder section (operator/src/ui.ts) -- a dead
    // hash target for any link still pointing at #map -- even though the actual map now lives
    // on Realtime, not its own page.
    expect(html).toContain('data-page="map"')
    expect(html).toContain('data-nav="sessions"')
  })
})
