import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ADMIN_EMAILS } from './access'
import { CLIENT_GEO_KEYS } from './geo'
import { handleRequest, type Env } from './index'
import { hmacHex } from './hmac'
import { sha256Hex } from './crypto'
import { ingestCanonical, OPERATOR_HMAC_HEADERS } from '../../src/shared/operator-hmac'
import { memoryStore } from './store'
import { TEST_INGEST_SECRET, TEST_PROMPT_KEY } from './test-fixtures'
import { tokenPatternForTests } from './redact'

/**
 * Tony 6:17 PM ET quality bar. After every Operator change these four
 * contracts must still hold. Overlay Island/Hide files stay frozen — this
 * file proves the Operator slice does not import them.
 */
const NOW = 1_725_000_000_000
const SRC = dirname(fileURLToPath(import.meta.url))

function env(): Env {
  return {
    OPERATOR_INGEST_SECRET: TEST_INGEST_SECRET,
    OPERATOR_PROMPT_KEY: TEST_PROMPT_KEY,
    OPERATOR_SKILL_PRIVATE_KEY: 'unused'
  }
}

function access(email: string) {
  return { getIdentity: async () => ({ email }) }
}

async function signedRequest(path: string, bodyText: string): Promise<Request> {
  const ts = String(NOW)
  const nonce = `qb-${Math.random().toString(16).slice(2)}`
  const deviceId = 'device-qb'
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

function collectTs(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...collectTs(p))
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(p)
  }
  return out
}

function eventsHtml(html: string): string {
  const start = html.indexOf('data-page="events"')
  const end = html.indexOf('data-page="profiles"')
  return start >= 0 && end > start ? html.slice(start, end) : html
}

describe('quality bar: overlay chrome stays a separate slice', () => {
  it('Operator Worker source does not import Island/Hide overlay files', () => {
    const banned =
      /overlay-chrome|OverlayPeek|OverlayChromePicker|overlay-autohide|overlay-motion|overlay-placement|main\/island/
    for (const file of collectTs(SRC)) {
      const src = readFileSync(file, 'utf8')
      expect(src, file).not.toMatch(banned)
    }
  })
})

describe('quality bar: login', () => {
  it('302s unauth console GET to Access and keeps admin APIs at 401 JSON', async () => {
    expect([...ADMIN_EMAILS].sort()).toEqual(['tony.walteur@gmail.com', 'twalteur@amaris.com'].sort())
    const store = memoryStore()
    const configured = {
      ...env(),
      TEAM_DOMAIN: 'https://tony-walteur.cloudflareaccess.com'
    }
    const denied = await handleRequest(new Request('https://operator.test/'), configured, {}, { store, now: NOW })
    expect(denied.status).toBe(302)
    const loc = denied.headers.get('location') || ''
    expect(loc).toMatch(/login/i)
    expect(decodeURIComponent(loc)).toMatch(/next=\//)
    expect(await denied.text()).not.toContain('data-login="1"')

    const keys = await handleRequest(new Request('https://operator.test/keys'), configured, {}, { store, now: NOW })
    expect(keys.status).toBe(302)
    expect(decodeURIComponent(keys.headers.get('location') || '')).toMatch(/next=\/keys/)

    const api = await handleRequest(
      new Request('https://operator.test/v1/admin/dashboard'),
      configured,
      {},
      { store, now: NOW }
    )
    expect(api.status).toBe(401)
    expect(await api.json()).toEqual({ ok: false, error: 'Access required' })

    const postKeys = await handleRequest(
      new Request('https://operator.test/v1/admin/keys', { method: 'POST', body: '{}' }),
      configured,
      {},
      { store, now: NOW }
    )
    expect(postKeys.status).toBe(401)

    const postLicenses = await handleRequest(
      new Request('https://operator.test/v1/admin/licenses', { method: 'POST', body: '{}' }),
      configured,
      {},
      { store, now: NOW }
    )
    expect(postLicenses.status).toBe(401)
    expect(await postLicenses.json()).toEqual({ ok: false, error: 'Access required' })

    const postGenerate = await handleRequest(
      new Request('https://operator.test/v1/admin/licenses/generate', {
        method: 'POST',
        body: JSON.stringify({ days: 30 })
      }),
      configured,
      {},
      { store, now: NOW }
    )
    expect(postGenerate.status).toBe(401)
    expect(await postGenerate.json()).toEqual({ ok: false, error: 'Access required' })

    const other = await handleRequest(
      new Request('https://operator.test/v1/admin/summary'),
      env(),
      { access: access('other@example.com') },
      { store, now: NOW }
    )
    expect(other.status).toBe(401)

    for (const email of ADMIN_EMAILS) {
      const ok = await handleRequest(
        new Request('https://operator.test/'),
        env(),
        { access: access(email) },
        { store, now: NOW }
      )
      expect(ok.status, email).toBe(200)
      expect(ok.headers.get('content-type')).toMatch(/text\/html/)
      const page = await ok.text()
      expect(page).toContain('data-nav="overview"')
      expect(page).not.toContain('data-login="1"')
    }
  })
})

describe('quality bar: map data contract', () => {
  it('uses request.cf country only, ignores client geo, and never paints sample dots', async () => {
    expect([...CLIENT_GEO_KEYS]).toEqual(
      expect.arrayContaining(['lat', 'lon', 'country', 'city', 'ip', 'clientIp'])
    )
    const store = memoryStore()
    const emptyHome = await handleRequest(
      new Request('https://operator.test/'),
      env(),
      { access: access('tony.walteur@gmail.com') },
      { store, now: NOW }
    )
    const emptyHtml = await emptyHome.text()
    expect(emptyHtml).toContain('No heartbeats yet. The map stays empty until a seat checks in.')
    expect(emptyHtml).toContain('not sample dots')
    expect(emptyHtml).not.toContain('class="dot"')
    expect(emptyHtml).not.toMatch(/Unique Visitors|visitor traffic|\$6,525|\b1,344\b/)
    const emptyDash = (await (
      await handleRequest(
        new Request('https://operator.test/v1/admin/dashboard'),
        env(),
        { access: access('tony.walteur@gmail.com') },
        { store, now: NOW }
      )
    ).json()) as { map: { empty: boolean; countries: unknown[]; dots: unknown[] } }
    expect(emptyDash.map).toEqual({ empty: true, countries: [], dots: [] })

    const spoof = await signedRequest(
      '/v1/heartbeat',
      JSON.stringify({
        os: 'darwin',
        appVersion: '1.8.2',
        lat: 40.7,
        lon: -74.0,
        country: 'US',
        city: 'SampleCity',
        ip: '203.0.113.9'
      })
    )
    expect(
      (
        await handleRequest(spoof, env(), {}, {
          store,
          now: NOW,
          geo: { country: 'CA', city: 'Longueuil', lat: 45.531, lon: -73.518 }
        })
      ).status
    ).toBe(200)
    const seats = await store.listSeats()
    expect(seats[0]?.country).toBe('CA')
    expect(seats[0]?.city).toBe('Longueuil')
    expect(seats[0]?.lat).toBe(45.531)
    expect(seats[0]?.lon).toBe(-73.518)
    const live = await handleRequest(
      new Request('https://operator.test/'),
      env(),
      { access: access('twalteur@amaris.com') },
      { store, now: NOW }
    )
    const html = await live.text()
    expect(html).toContain('data-iso="CA"')
    expect(html).toContain('#E5E7EB')
    expect(html).not.toContain('203.0.113.9')
    expect(html).not.toContain('SampleCity')
    const dash = (await (
      await handleRequest(
        new Request('https://operator.test/v1/admin/dashboard'),
        env(),
        { access: access('twalteur@amaris.com') },
        { store, now: NOW }
      )
    ).json()) as { map: { empty: boolean; countries: { iso: string; devices: number }[]; dots: { country: string }[] } }
    expect(dash.map.empty).toBe(false)
    expect(dash.map.countries).toEqual([{ iso: 'CA', devices: 1 }])
    expect(dash.map.dots.every((d) => d.country === 'CA')).toBe(true)
  })
})

describe('quality bar: token-free events', () => {
  it('never renders a token-shaped string on the events page', async () => {
    const store = memoryStore()
    await store.insertEvent({
      id: 'qb-tok',
      ts: NOW,
      kind: 'ask',
      actor: 'tony.walteur@gmail.com',
      device_id: 'device-qb',
      country: 'CA',
      detail: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aaa.bbb sk-ant-api03-abcdefghijklmnop'
    })
    const html = await handleRequest(
      new Request('https://operator.test/'),
      env(),
      { access: access('tony.walteur@gmail.com') },
      { store, now: NOW }
    ).then((r) => r.text())
    const events = eventsHtml(html)
    expect(events).not.toMatch(tokenPatternForTests())
    expect(events).not.toContain('Bearer')
    expect(events).not.toContain('sk-ant-')
    expect(events).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9')
  })
})

describe('quality bar: keys last4 and Cloudflare fail-loud', () => {
  it('empty keys copy is retired and Overview fails loud without a CF token', async () => {
    const store = memoryStore()
    const html = await handleRequest(
      new Request('https://operator.test/'),
      env(),
      { access: access('tony.walteur@gmail.com') },
      { store, now: NOW }
    ).then((r) => r.text())
    expect(html).not.toContain('Seats keep their own keys')
    expect(html).toContain('No provider keys on Operator yet')
    expect(html).toContain('Connect Cloudflare (login) on Keys.')
    expect(html).toContain('data-install-works')
    expect(html).toContain('Install → works')
    expect(html).toContain('data-theme="light"')
    expect(html).toContain('<body data-theme="light">')
    expect(html).toContain('data-people-head')
    expect(html).toContain('.rule h3 { margin: 0 0 4px; font-size: 13px; font-weight: 650; color: var(--ink); }')
    expect(html).not.toContain('Cloudflare token missing')
    expect(html).toContain('data-page="keys"')
    expect(html).not.toMatch(tokenPatternForTests())
  })
})

describe('quality bar: Ultron lock — Operator only, no Latest feed', () => {
  it('design law forbids Metis-Releases Latest and Operator source does not touch the feed', () => {
    const root = join(SRC, '../..')
    const operatorLaw = readFileSync(join(root, 'docs/design/OPERATOR.md'), 'utf8')
    const designLaw = readFileSync(join(root, 'docs/design/DESIGN.md'), 'utf8')
    expect(operatorLaw).toMatch(/ULTRON LOCK/)
    expect(operatorLaw).toMatch(/Metis-Releases Latest/)
    expect(operatorLaw).toMatch(/Bob QA/)
    expect(designLaw).toMatch(/EXE\/DMG\/Native → Latest only after Bob QA \+ Ultron approve/)
    expect(designLaw).toMatch(/WebsiteCloner/)
    expect(designLaw).toMatch(/localhost:3112\/demo\/shoey\/realtime/)
    expect(designLaw).toMatch(/WorldMap \+ LiveFeed \+ GeoTable/)
    expect(designLaw).toMatch(/corner/)
    expect(designLaw).toMatch(/Live seats/)
    expect(designLaw).toMatch(/Time saved/)
    expect(designLaw).toMatch(/not reported/)
    expect(designLaw).toMatch(/#notifications/)
    expect(designLaw).toMatch(/Write this section first/)
    expect(operatorLaw).toMatch(/PR153/)
    expect(operatorLaw).toMatch(/1\.8\.5 KineticGrid/)
    expect(operatorLaw).toMatch(/b8a677b/)
    expect(designLaw).toMatch(/1\.8\.5 KineticGrid/)
    expect(designLaw).toMatch(/b8a677b/)
    for (const file of collectTs(SRC)) {
      const src = readFileSync(file, 'utf8')
      expect(src, file).not.toMatch(/Metis-Releases|latest-mac\.yml|latest\.yml/)
      expect(src, file).not.toMatch(/from ['"].*Settings['"]|renderer\/src\/components\/Settings/)
    }
  })
})
