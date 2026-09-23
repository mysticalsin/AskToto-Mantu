/**
 * Realtime page interactions (operator UX plan, Rock 1 proof). Drives the real console + committed
 * client bundle through the harness with Playwright's fake clock, so the 5 s poll, the backoff and
 * the expiry stop are exercised through operator/client/live.ts itself, never a hand-dispatched event.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser } from 'playwright'
import type { LiveSnapshot } from '../dashboard'
import type { RealtimePlace } from '../realtime-geo'
import { shoot } from '../render/test-shots'
import { openConsole, type ConsoleHarness } from './harness'

const PARIS: RealtimePlace = { iso2: 'FR', country: 'France', region: 'Île-de-France', city: 'Paris', lat: 48.86, lon: 2.35, seats: 3, sessions: 2 }
const AMSTERDAM: RealtimePlace = { iso2: 'NL', country: 'Netherlands', region: 'North Holland', city: 'Amsterdam', lat: 52.37, lon: 4.9, seats: 2, sessions: 1 }

let browser: Browser
beforeAll(async () => {
  browser = await chromium.launch({ headless: true })
})
afterAll(async () => {
  await browser?.close()
}, 30_000)

function withPlaces(places: RealtimePlace[]) {
  return (s: LiveSnapshot): LiveSnapshot => ({
    ...s,
    generation: s.generation + places.length + 1,
    geo: { ...s.geo, places }
  })
}

/** The first 5 s poll has landed and repainted: the KPI shows the injected seat total. */
async function waitForRepaint(h: ConsoleHarness, seats: string): Promise<void> {
  await h.page.waitForFunction((want) => document.querySelector('[data-rt-seats]')?.textContent?.trim() === want, seats)
}

async function openRealtime(admin: Parameters<typeof openConsole>[1] = {}): Promise<ConsoleHarness> {
  const h = await openConsole(browser, { hash: 'realtime', fakeClock: true, ...admin })
  await h.page.waitForSelector('section[data-page="realtime"]:not([hidden]) [data-map-svg]')
  return h
}

describe('Realtime map + live repaint', () => {
  it('repaints pins, clusters and the KPI in place on the next 5 s poll without re-rendering the section', async () => {
    const h = await openRealtime()
    try {
      const snap = await h.liveSnapshot(withPlaces([PARIS, AMSTERDAM]))
      h.setAdmin('/v1/admin/live.json', { json: snap })
      await h.page.evaluate(() => {
        ;(document.querySelector('section[data-page="realtime"]') as HTMLElement & { __marker?: number }).__marker = 42
      })
      await h.page.clock.runFor(5_500)
      await h.page.waitForFunction(() => document.querySelector('[data-rt-seats]')?.textContent?.trim() === '5')
      const state = await h.page.evaluate(() => ({
        marker: (document.querySelector('section[data-page="realtime"]') as HTMLElement & { __marker?: number }).__marker,
        pins: document.querySelectorAll('[data-pin-layer] [data-pin]').length,
        isos: [...document.querySelectorAll('[data-pin-layer] [data-pin]')].map((p) => p.getAttribute('data-iso')).sort()
      }))
      expect(state.marker).toBe(42)
      expect(state.pins).toBe(2)
      expect(state.isos).toEqual(['FR', 'NL'])
      expect(h.requestsTo('/v1/admin/live.json').length).toBeGreaterThanOrEqual(2)
      await shoot(h.page, 'realtime-live')
    } finally {
      await h.close()
    }
  }, 60_000)

  it('zooming from 1 to 3+ splits a two-country cluster into city pills', async () => {
    const h = await openRealtime()
    try {
      h.setAdmin('/v1/admin/live.json', { json: await h.liveSnapshot(withPlaces([PARIS, AMSTERDAM])) })
      await h.page.clock.runFor(5_500)
      await waitForRepaint(h, '5')
      const before = await h.page.$$eval('[data-cluster-layer] .rt-pill-label', (els) => els.map((e) => e.textContent?.trim()))
      expect(before).toContain('2 countries')
      for (let i = 0; i < 3; i++) await h.page.click('[data-zoom-in]')
      await h.page.waitForFunction(() =>
        [...document.querySelectorAll('[data-cluster-layer] .rt-pill-label')].some((e) => e.textContent?.trim() === 'Paris')
      )
      const after = await h.page.$$eval('[data-cluster-layer] .rt-pill-label', (els) => els.map((e) => e.textContent?.trim()))
      expect(after).toEqual(expect.arrayContaining(['Paris', 'Amsterdam']))
      expect(after).not.toContain('2 countries')
    } finally {
      await h.close()
    }
  }, 60_000)

  it('a cluster pill opens the popover with Locations / Countries / Cities tiles; Escape closes it and returns focus', async () => {
    const h = await openRealtime()
    try {
      h.setAdmin('/v1/admin/live.json', { json: await h.liveSnapshot(withPlaces([PARIS, AMSTERDAM])) })
      await h.page.clock.runFor(5_500)
      await waitForRepaint(h, '5')
      // A second poll with the same generation must not touch the DOM (the pill stays attached).
      await h.page.clock.runFor(5_500)
      const pill = await h.page.waitForSelector('[data-cluster-pill]')
      await pill.click()
      const pop = await h.page.waitForSelector('[data-rt-popover]:not([hidden])')
      const text = (await pop.textContent()) ?? ''
      expect(text).toContain('REALTIME CLUSTER')
      expect(text).toContain('Locations')
      expect(text).toContain('Countries')
      expect(text).toContain('Cities')
      expect(await pop.getAttribute('role')).toBe('dialog')
      await shoot(h.page, 'realtime-popover')
      await h.page.keyboard.press('Escape')
      await h.page.waitForSelector('[data-rt-popover]', { state: 'hidden' })
      const focused = await h.page.evaluate(() => document.activeElement?.hasAttribute('data-cluster-pill') ?? false)
      expect(focused).toBe(true)
    } finally {
      await h.close()
    }
  }, 60_000)
})

describe('Realtime live states', () => {
  it('live.json 500 shows "Live paused · retrying" and keeps the last pins', async () => {
    const h = await openRealtime()
    try {
      h.setAdmin('/v1/admin/live.json', { json: await h.liveSnapshot(withPlaces([PARIS])) })
      await h.page.clock.runFor(5_500)
      await h.page.waitForFunction(() => document.querySelectorAll('[data-pin-layer] [data-pin]').length === 1)
      h.setAdmin('/v1/admin/live.json', { status: 500, json: { error: 'boom' } })
      await h.page.clock.runFor(5_500)
      await h.page.waitForFunction(() =>
        [...document.querySelectorAll('[data-live-text]')].some((e) => e.textContent?.trim() === 'Live paused · retrying')
      )
      expect(await h.page.$$eval('[data-pin-layer] [data-pin]', (els) => els.length)).toBe(1)
    } finally {
      await h.close()
    }
  }, 60_000)

  for (const [label, response] of [
    ['401', { status: 401, json: { error: 'unauthorized' } }],
    ['opaque redirect', { redirectTo: 'https://tony-walteur.cloudflareaccess.com/cdn-cgi/access/login' }]
  ] as const) {
    it(`live.json ${label} stops polling and shows "Session expired — reload"`, async () => {
      const h = await openRealtime()
      try {
        h.setAdmin('/v1/admin/live.json', response)
        await h.page.clock.runFor(5_500)
        await h.page.waitForSelector('[data-session-banner]')
        expect(await h.page.textContent('[data-session-banner]')).toContain('Session expired — reload')
        const polls = h.requestsTo('/v1/admin/live.json').length
        await h.page.clock.runFor(20_000)
        expect(h.requestsTo('/v1/admin/live.json').length).toBe(polls)
      } finally {
        await h.close()
      }
    }, 60_000)
  }
})
