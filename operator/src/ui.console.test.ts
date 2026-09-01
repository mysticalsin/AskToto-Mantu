import { describe, expect, it } from 'vitest'
import { handleRequest, type Env } from './index'
import { hmacHex } from './hmac'
import { sha256Hex } from './crypto'
import { ingestCanonical, OPERATOR_HMAC_HEADERS } from '../../src/shared/operator-hmac'
import { memoryStore } from './store'
import { TEST_INGEST_SECRET, TEST_PROMPT_KEY } from './test-fixtures'
import { findBandSubpaths } from './map-bands'
import { NAV_IDS } from './nav'
import { tokenPatternForTests } from './redact'

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

describe('product sidebar', () => {
  it('fills the rail with real Operator routes and has no Scale/Change leftover', async () => {
    const html = await page()
    const nav = [...html.matchAll(/data-nav="([^"]+)"/g)].map((m) => m[1])
    expect(nav).toEqual([...NAV_IDS])
    expect(html).not.toMatch(/data-nav="(scale|change)"/)
    expect(html).not.toMatch(/>CONSOLE</)
    expect(html).not.toContain('orphan')
    for (const id of NAV_IDS) {
      expect(html).toContain(`data-page="${id}"`)
    }
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
