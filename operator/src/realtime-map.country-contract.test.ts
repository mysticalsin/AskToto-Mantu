import { describe, expect, it } from 'vitest'
import { chromium } from 'playwright'
import { buildDashboard, buildLiveSnapshot, ONLINE_MS } from './dashboard'
import { renderRealtime } from './render/pages/realtime'
import { CONSOLE_JS } from './spa/client.generated'
import { memoryStore, type OperatorStore, type SeatRow } from './store'

const NOW = 1_800_000_000_000
let pulseSequence = 0

async function heartbeat(store: OperatorStore, deviceId: string, country: string | null, ts: number): Promise<void> {
  await store.recordPulseSession({
    id: `synthetic-pulse-${++pulseSequence}`,
    device_id: deviceId,
    ts,
    kind: 'heartbeat',
    country,
    city: null
  }, { os: 'darwin', app_version: '2.0.0' })
}

function seat(device_id: string, country: string | null, last_seen: number, city = 'SyntheticCityAlpha'): SeatRow {
  return {
    device_id,
    seat_hash: `synthetic-${device_id}`,
    os: 'darwin',
    app_version: '2.0.0',
    first_seen: NOW - 3_600_000,
    last_seen,
    country,
    city,
    lat: 45.5017,
    lon: -73.5673,
    last_index_at: null,
    hostname: `synthetic-${device_id}`,
    sso_email: null,
    license: 'licensed',
    approval: 'approved'
  }
}

function worldMap(html: string): string {
  const hook = html.indexOf('data-world-map')
  const start = html.lastIndexOf('<article', hook)
  const end = html.indexOf('</article>', hook)
  expect(hook).toBeGreaterThanOrEqual(0)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return html.slice(start, end + '</article>'.length)
}

describe('Operator realtime map country-only contract', () => {
  it('counts unique devices with a country only while their heartbeat is younger than 120 seconds', async () => {
    const store = memoryStore()
    await store.upsertSeat(seat('ca-live', 'CA', NOW - ONLINE_MS + 1))
    await store.upsertSeat(seat('ca-expired', 'CA', NOW - ONLINE_MS))
    await store.upsertSeat(seat('us-live', 'US', NOW))
    await store.upsertSeat(seat('unknown-live', null, NOW))
    await heartbeat(store, 'ca-live', 'CA', NOW - ONLINE_MS + 1)
    await heartbeat(store, 'ca-expired', 'CA', NOW - ONLINE_MS)
    await heartbeat(store, 'us-live', 'US', NOW)
    await heartbeat(store, 'unknown-live', null, NOW)

    const dashboard = await buildDashboard(store, 'owner@example.test', NOW)
    expect(dashboard.kpis.live).toBe(3)
    expect(dashboard.map.countries).toEqual(expect.arrayContaining([
      { iso: 'CA', devices: 1 },
      { iso: 'US', devices: 1 }
    ]))
    expect(dashboard.map.countries).toHaveLength(2)
    expect(JSON.stringify(dashboard.map)).not.toMatch(/"(?:city|lat|lon)"/)
  })

  it('moves a device after a new heartbeat without retaining a ghost in its previous country', async () => {
    const store = memoryStore()
    await store.upsertSeat(seat('moving', 'CA', NOW - 30_000))
    await heartbeat(store, 'moving', 'CA', NOW - 30_000)
    await store.upsertSeat(seat('moving', 'US', NOW))
    await heartbeat(store, 'moving', 'US', NOW)
    await store.upsertSeat(seat('moving', 'US', NOW))
    await heartbeat(store, 'moving', 'US', NOW)

    const dashboard = await buildDashboard(store, 'owner@example.test', NOW)
    expect(dashboard.map.countries).toEqual([{ iso: 'US', devices: 1 }])
  })

  it('does not reuse old seat geography when the latest live heartbeat has no country', async () => {
    const store = memoryStore()
    await store.upsertSeat(seat('traveler', 'CA', NOW))
    await heartbeat(store, 'traveler', 'CA', NOW - 30_000)
    await heartbeat(store, 'traveler', null, NOW)

    const dashboard = await buildDashboard(store, 'owner@example.test', NOW)
    expect(dashboard.map.countries).toEqual([])
  })

  it('excludes a device when equally recent heartbeats disagree about its country', async () => {
    const store = memoryStore()
    await store.upsertSeat(seat('tie', 'CA', NOW))
    await heartbeat(store, 'tie', 'CA', NOW)
    await heartbeat(store, 'tie', 'US', NOW)

    const dashboard = await buildDashboard(store, 'owner@example.test', NOW)
    expect(dashboard.map.countries).toEqual([])
  })

  it('sends country totals in the live-poll map payload without seat-level coordinates', async () => {
    const store = memoryStore()
    await store.upsertSeat(seat('ca-live', 'CA', NOW - 1, 'SyntheticCityAlpha'))
    await store.upsertSeat(seat('us-live', 'US', NOW - 1, 'SyntheticCityBeta'))
    await store.upsertSeat(seat('ca-expired', 'CA', NOW - ONLINE_MS, 'SyntheticCityGamma'))
    await store.upsertSeat(seat('unknown-live', null, NOW))
    await heartbeat(store, 'ca-live', 'CA', NOW - 1)
    await heartbeat(store, 'us-live', 'US', NOW - 1)
    await heartbeat(store, 'ca-expired', 'CA', NOW - ONLINE_MS)
    await heartbeat(store, 'unknown-live', null, NOW)

    const snapshot = await buildLiveSnapshot(store, NOW)
    const map = (snapshot as unknown as { map?: { countries: Array<{ iso: string; devices: number }> } }).map
    expect(map?.countries).toEqual(expect.arrayContaining([
      { iso: 'CA', devices: 1 },
      { iso: 'US', devices: 1 }
    ]))
    expect(map?.countries).toHaveLength(2)
    expect(JSON.stringify(map ?? {})).not.toMatch(/"(?:city|lat|lon)"/)
  })

  it('shows country totals but no precise seat places in the map DOM', async () => {
    const store = memoryStore()
    await store.upsertSeat(seat('ca-a', 'CA', NOW, 'SyntheticCityAlpha'))
    await store.upsertSeat(seat('ca-b', 'CA', NOW, 'SyntheticCityBeta'))
    await heartbeat(store, 'ca-a', 'CA', NOW)
    await heartbeat(store, 'ca-b', 'CA', NOW)
    const dashboard = await buildDashboard(store, 'owner@example.test', NOW)
    const html = renderRealtime(dashboard, { now: NOW, theme: 'dark' })
    const map = worldMap(html)

    expect(map).toContain('Canada')
    expect(map).toMatch(/2 (?:live )?(?:devices|seats)/)
    expect(map).toContain('data-zoom-in')
    expect(map).toContain('data-zoom-out')
    expect(map).not.toMatch(/SyntheticCityAlpha|SyntheticCityBeta|data-(?:city|lat|lon)=/)
    // The privacy rule belongs to the map, not every separate Operator detail table.
    expect(html).toContain('SyntheticCityAlpha')
  })

  it('applies a polled country change to the open map without resetting its zoom or pan', async () => {
    const store = memoryStore()
    await store.upsertSeat(seat('moving-a', 'CA', NOW, 'SyntheticCityAlpha'))
    await store.upsertSeat(seat('moving-b', 'CA', NOW, 'SyntheticCityBeta'))
    await heartbeat(store, 'moving-a', 'CA', NOW)
    await heartbeat(store, 'moving-b', 'CA', NOW)
    const initial = await buildDashboard(store, 'owner@example.test', NOW)
    await store.upsertSeat(seat('moving-a', 'US', NOW + 1))
    await store.upsertSeat(seat('moving-b', 'US', NOW + 1))
    await store.upsertSeat(seat('new-c', 'US', NOW + 1, 'SyntheticCityGamma'))
    await heartbeat(store, 'moving-a', 'US', NOW + 1)
    await heartbeat(store, 'moving-b', 'US', NOW + 1)
    await heartbeat(store, 'new-c', 'US', NOW + 1)
    const next = await buildLiveSnapshot(store, NOW + 1)

    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
      await page.goto('about:blank#realtime')
      await page.setContent(`<style>body{margin:0}</style><section data-page="realtime">${renderRealtime(initial, { now: NOW, theme: 'dark' })}</section>`)
      await page.evaluate(() => {
        let respond: ((value: Response) => void) | undefined
        ;(window as typeof window & { resolveMetisPoll?: (body: unknown) => void }).resolveMetisPoll = (body) => {
          if (!respond) throw new Error('The live poll did not start')
          respond(new Response(JSON.stringify(body), { status: 200, headers: { etag: '"map-next"' } }))
        }
        window.fetch = () => new Promise<Response>((resolve) => { respond = resolve })
      })
      await page.addScriptTag({ content: CONSOLE_JS })
      await page.locator('[data-zoom-in]').click()
      const svg = page.locator('[data-map-svg]')
      const box = await svg.boundingBox()
      if (!box) throw new Error('Realtime map SVG has no viewport')
      const viewport = page.locator('[data-viewport]')
      const zoomPosition = await viewport.getAttribute('transform')
      expect(zoomPosition).not.toBe('translate(0,0) scale(1)')
      const zoomTranslation = zoomPosition?.match(/^translate\(([^)]+)\)/)?.[1]
      expect(zoomTranslation).toBeTruthy()
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.down()
      await page.mouse.move(box.x + box.width / 2 + 50, box.y + box.height / 2 + 25, { steps: 3 })
      await page.mouse.up()
      const position = await viewport.getAttribute('transform')
      const panTranslation = position?.match(/^translate\(([^)]+)\)/)?.[1]
      expect(panTranslation).toBeTruthy()
      expect(panTranslation).not.toBe(zoomTranslation)

      await page.evaluate((body) => {
        ;(window as typeof window & { resolveMetisPoll?: (body: unknown) => void }).resolveMetisPoll?.(body)
      }, next)
      await page.waitForFunction(() => document.querySelector('[data-world-live]')?.textContent === 'LIVE 3', undefined, { timeout: 3_000 })
      expect(await page.locator('#map-root').textContent()).toContain('United States')
      expect(await page.locator('#map-root').textContent()).not.toMatch(/SyntheticCityAlpha|SyntheticCityBeta/)
      expect(await page.locator('[data-viewport]').getAttribute('transform')).toBe(position)
      await page.close()
    } finally {
      await browser.close()
    }
  }, 30_000)
})
