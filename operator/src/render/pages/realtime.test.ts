import { describe, expect, it } from 'vitest'
import { resolveMapTheme } from '../../theme-preference'
import { fixtureDashboard } from '../fixture'
import { liveStripEvents, realtimeSeatTotal, renderRealtime, rtFeedRows, rtLocationTable } from './realtime'

const CTX = { now: 1_725_000_000_000, theme: 'light' as const }

function mapMarkup(html: string): string {
  const start = html.indexOf('<div id="map-root"')
  const end = html.indexOf('<div class="rt-overlay">', start)
  return start >= 0 && end > start ? html.slice(start, end) : ''
}

describe('renderRealtime (QA fixture)', () => {
  it('renders the map stage, the live strip, and the locations card, in order', async () => {
    const data = await fixtureDashboard()
    const html = renderRealtime(data, CTX)
    expect(html).toContain('data-world-map')
    expect(html).toContain('data-rt-live-strip')
    expect(html).toContain('data-realtime-geo')
    expect(html.indexOf('data-world-map')).toBeLessThan(html.indexOf('data-rt-live-strip'))
    expect(html.indexOf('data-rt-live-strip')).toBeLessThan(html.indexOf('data-realtime-geo'))
    expect(html).toContain('>Realtime<')
  })

  // Stronger successor of the old "no inline style outside map markup" pin: the map module now
  // styles everything through classes + tokens, so the whole page carries no style= at all.
  it('adds no inline style= anywhere, map markup included', async () => {
    const data = await fixtureDashboard()
    expect(renderRealtime(data, CTX)).not.toContain('style="')
  })

  it('KPI headline is the 30 min seat total over realtime places', async () => {
    const data = await fixtureDashboard()
    const html = renderRealtime(data, CTX)
    const total = realtimeSeatTotal(data.realtime.places)
    expect(html).toContain(`data-rt-seats>${total}<`)
  })

  it('Locations card has Countries | Regions | Cities panes built from realtime places', async () => {
    const data = await fixtureDashboard()
    const html = renderRealtime(data, CTX)
    for (const pane of ['country', 'region', 'city']) expect(html).toContain(`data-rt-loc-pane="${pane}"`)
    expect(html).toMatch(/data-rt-loc-tabs[\s\S]*?data-tab="country"[\s\S]*?data-tab="region"[\s\S]*?data-tab="city"/)
    expect(rtLocationTable([], 'city')).toContain('No seat locations in the last 30 minutes.')
  })
})

describe('realtime map theme + live strip', () => {
  it('resolves system theme to dark for map paint', () => {
    expect(resolveMapTheme('system')).toBe('dark')
  })

  // Successor of the "#1f1830 dark land" pin: colour now comes only from tokens (css.ts
  // --map-* in both themes), so the map markup carries no hex colour and no data-map-theme.
  it('map markup carries token classes, never a hex colour or a baked theme', async () => {
    const data = await fixtureDashboard()
    const map = mapMarkup(renderRealtime(data, { now: data.now, theme: 'system' }))
    expect(map).toContain('class="world-ocean"')
    expect(map).toMatch(/class="world-land"/)
    expect(map).toContain('rt-map')
    expect(map).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(map).not.toContain('data-map-theme')
  })

  it('drops stale heartbeats from LIVE EVENTS while keeping fresh ones', () => {
    const now = 1_725_000_000_000
    const events = [
      { id: 'fresh', ts: now - 30_000, name: 'heartbeat', hostname: 'a', email: null, chips: [] },
      { id: 'stale', ts: now - 36 * 60 * 60 * 1000, name: 'heartbeat', hostname: 'b', email: null, chips: [] }
    ]
    const fresh = liveStripEvents(events, now)
    expect(fresh.map((e) => e.id)).toEqual(['fresh'])
  })

  it('live feed rows are metadata only and stale rows fall back to the honest empty line', () => {
    const now = 1_725_000_000_000
    const row = { id: 'e1', ts: now - 60_000, kind: 'ask', actor: 'Tonys-MacBook-Pro', country: 'CA', city: 'Longueuil', os: 'darwin', appVersion: '1.9.6' }
    const html = rtFeedRows([row], now)
    expect(html).toContain('data-rt-feed-row="e1"')
    expect(html).toContain('class="rt-feed-where">Longueuil, CA<')
    expect(rtFeedRows([{ ...row, ts: now - 2 * 60 * 60 * 1000 }], now)).toContain('No events in the last 30 minutes.')
  })
})
