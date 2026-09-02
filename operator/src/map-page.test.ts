import { describe, expect, it } from 'vitest'
import { handleRequest, type Env } from './index'
import { hmacHex } from './hmac'
import { sha256Hex } from './crypto'
import { ingestCanonical, OPERATOR_HMAC_HEADERS } from '../../src/shared/operator-hmac'
import { memoryStore } from './store'
import { TEST_ADMIN_PASSWORD, TEST_INGEST_SECRET, TEST_PROMPT_KEY } from './test-fixtures'
import { findBandSubpaths } from './map-bands'
import { FORBIDDEN_NAV, NAV_IDS } from './nav'
import { tokenPatternForTests } from './redact'
import { activityName } from './dashboard'
import { relTime } from './map-page'

const NOW = 1_725_000_000_000

function env(): Env {
  return {
    OPERATOR_INGEST_SECRET: TEST_INGEST_SECRET,
    OPERATOR_PROMPT_KEY: TEST_PROMPT_KEY,
    OPERATOR_SKILL_PRIVATE_KEY: 'unused',
    OPERATOR_ADMIN_PASSWORD: TEST_ADMIN_PASSWORD
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

function mapHtml(html: string): string {
  const start = html.indexOf('data-page="map"')
  const end = html.indexOf('data-page="macos"')
  return start >= 0 && end > start ? html.slice(start, end) : html
}

describe('activity names and relative time', () => {
  it('maps crm to recap and leaves listen/ask/skill honest', () => {
    expect(activityName('crm')).toBe('recap')
    expect(activityName('ask')).toBe('ask')
    expect(activityName('listen')).toBe('listen')
    expect(activityName('skill')).toBe('skill')
    expect(activityName('draft')).toBe('skill')
    expect(activityName('heartbeat')).toBe('heartbeat')
  })

  it('prints just now for a pulse in the last half minute', () => {
    expect(relTime(NOW, NOW)).toBe('just now')
    expect(relTime(NOW - 60_000, NOW)).toBe('1 minute ago')
  })
})

describe('login HTML still serves', () => {
  it('GET / without identity is text/html 200 with data-login', async () => {
    const res = await handleRequest(new Request('https://operator.test/'), env(), {}, {
      store: memoryStore(),
      now: NOW
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/html/)
    const html = await res.text()
    expect(html).toContain('data-login="1"')
    expect(html).toContain('type="password"')
    expect(html).not.toContain('data-page="map"')
    expect(html).not.toMatch(/\{"ok":\s*false/)
  })
})

describe('Map page is Shoey Realtime structure', () => {
  it('renders live count, world, and three tables even when empty', async () => {
    const html = await handleRequest(
      new Request('https://operator.test/'),
      env(),
      { access: tonyAccess },
      { store: memoryStore(), now: NOW }
    ).then((r) => r.text())
    const map = mapHtml(html)
    expect(html).toContain('data-page="map"')
    expect(map).toContain('data-map-live')
    expect(map).toContain('data-map-world')
    expect(map).toContain('data-map-geo')
    expect(map).toContain('data-map-referrals')
    expect(map).toContain('data-map-paths')
    expect(map).toContain('Unique seats last 30 min')
    expect(map).toContain('data-map-count')
    expect(map).toContain('Live activity')
    expect(map).toContain('>Geo<')
    expect(map).toContain('>Referrals<')
    expect(map).toContain('>Paths<')
    expect(map).not.toContain('Unique visitors')
    expect(map).not.toContain('Unique Visitors')
    expect(map).not.toContain('/products/sneakers')
    expect(map).not.toContain('data-map="land"')
    expect(map).not.toContain('data-map="analytics"')
    expect(map).not.toContain('data-map="graticule"')
    expect(map).not.toContain('data-map="hatch"')
    expect(map).not.toContain('Graticule')
    expect(map).not.toContain('>Hatch<')
    expect(html).not.toMatch(new RegExp(`data-nav="(${FORBIDDEN_NAV.join('|')})"`))
    for (const id of NAV_IDS) expect(html).toContain(`data-nav="${id}"`)
  })

  it('counts unique seats last 30 min from real pulses and paints cf geo', async () => {
    const store = memoryStore()
    const hb = await signedRequest(
      '/v1/heartbeat',
      JSON.stringify({ os: 'darwin', appVersion: '1.8.2', hostname: 'Tonys-MacBook-Pro' })
    )
    expect(
      (
        await handleRequest(hb, env(), {}, {
          store,
          now: NOW,
          geo: { country: 'BR', city: 'São Paulo', lat: -23.55, lon: -46.63 }
        })
      ).status
    ).toBe(200)
    const ask = await signedRequest(
      '/v1/ingest',
      JSON.stringify({
        id: 'ask-map',
        mode: 'interview',
        skillId: 'interview',
        provider: 'anthropic',
        question: 'How do I close this week?'
      }),
      { nonce: 'ask-map-n' }
    )
    expect(
      (
        await handleRequest(ask, env(), {}, {
          store,
          now: NOW,
          geo: { country: 'BR', city: 'São Paulo', lat: -23.55, lon: -46.63 }
        })
      ).status
    ).toBe(200)
    const html = await handleRequest(
      new Request('https://operator.test/'),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    ).then((r) => r.text())
    const map = mapHtml(html)
    expect(map).toContain('data-map-count>1<')
    expect(map).toContain('São Paulo')
    expect(map).toContain('Brazil')
    expect(map).toContain('anthropic')
    expect(map).toContain('interview')
    expect(map).toContain('>ask<')
    expect(map).toContain('Tonys-MacBook-Pro')
    expect(map).toContain('just now')
    expect(map).toContain('data-iso="BR"')
    expect(map).toContain('class="dot"')
    expect(map).toContain('shoey-world')
    expect(findBandSubpaths(map)).toEqual([])
    expect(map).not.toMatch(tokenPatternForTests())
    const dash = (await (
      await handleRequest(
        new Request('https://operator.test/v1/admin/dashboard'),
        env(),
        { access: tonyAccess },
        { store, now: NOW }
      )
    ).json()) as {
      map: {
        uniqueSeats30m: number
        bars30m: number[]
        referralKind: string
        pathKind: string
        geo: { label: string; seats: number }[]
        stream: { name: string }[]
      }
    }
    expect(dash.map.uniqueSeats30m).toBe(1)
    expect(dash.map.bars30m).toHaveLength(30)
    expect(dash.map.bars30m.at(-1)).toBeGreaterThan(0)
    expect(dash.map.referralKind).toBe('provider')
    expect(dash.map.pathKind).toBe('skill')
    expect(dash.map.geo.some((g) => g.seats === 1)).toBe(true)
    expect(dash.map.stream.some((e) => e.name === 'ask')).toBe(true)
    expect(dash.map.stream.every((e) => e.name !== 'heartbeat')).toBe(true)
  })

  it('shows recap for CRM ingest and never token strings on the Map stream', async () => {
    const store = memoryStore()
    await store.insertEvent({
      id: 'tok-map',
      ts: NOW,
      kind: 'ask',
      actor: 'tony.walteur@gmail.com',
      device_id: 'device-a',
      country: 'CA',
      detail: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signaturexx'
    })
    const crm = await signedRequest(
      '/v1/ingest',
      JSON.stringify({
        event: 'crm',
        id: 'crm-map',
        status: 'success',
        title: 'Acme recap',
        connector: 'bidstack'
      })
    )
    expect(
      (
        await handleRequest(crm, env(), {}, {
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
    const map = mapHtml(html)
    expect(map).toContain('>recap<')
    expect(map).not.toMatch(tokenPatternForTests())
    expect(map).not.toContain('Bearer')
    expect(map).not.toContain('sk-ant-')
  })
})
