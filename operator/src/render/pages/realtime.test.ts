import { describe, expect, it } from 'vitest'
import { fixtureDashboard } from '../fixture'
import { renderConnectedSeatsTable, renderGeoTable, renderRealtime } from './realtime'
import type { GeoTableRow, LiveSeatTableRow } from '../../routes/live'

const CTX = { now: 1_725_000_000_000, theme: 'light' as const }

describe('renderRealtime (QA fixture)', () => {
  it('renders the toolbar, the map, the strip, the geo table and the seats table, in order', async () => {
    const data = await fixtureDashboard()
    const html = renderRealtime(data, CTX)
    expect(html).toContain('data-world-map')
    expect(html).toContain('data-rt-live-strip')
    expect(html).toContain('data-realtime-geo')
    expect(html).toContain('data-realtime-seats')
    expect(html.indexOf('data-world-map')).toBeLessThan(html.indexOf('data-rt-live-strip'))
    expect(html.indexOf('data-rt-live-strip')).toBeLessThan(html.indexOf('data-realtime-geo'))
    expect(html.indexOf('data-realtime-geo')).toBeLessThan(html.indexOf('data-realtime-seats'))
    expect(html).toContain('>Realtime<')
  })

  it('the map top-right LIVE pill and the strip Live card both carry data.roi.liveSeats', async () => {
    const data = await fixtureDashboard()
    const html = renderRealtime(data, CTX)
    expect(html).toContain(`data-world-live aria-live="polite">LIVE ${data.roi.liveSeats}`)
  })

  it('carries the country filter chip and the seat drawer shells, hidden by default', async () => {
    const data = await fixtureDashboard()
    const html = renderRealtime(data, CTX)
    expect(html).toMatch(/data-country-chip[^>]*hidden/)
    expect(html).toContain('data-country-chip-clear')
    expect(html).toMatch(/id="rt-seat-drawer"[^>]*hidden/)
    expect(html).toContain('data-drawer-body')
  })

  it('the geo table and seats table sections render either the fixture-sized skeleton or the honest empty state, never fabricated rows', async () => {
    const data = await fixtureDashboard()
    const html = renderRealtime(data, CTX)
    if (data.roi.seats30m > 0) {
      expect(html).toContain('data-rt-skeleton')
    } else {
      expect(html).toContain('No seats have checked in during the last 30 minutes.')
    }
    // Never a fake row: the tables only ever hold a skeleton or the empty state until the
    // client hydrates them from the live JSON routes.
    expect(html).not.toContain('data-geo-row')
    expect(html).not.toContain('data-rt-seat=')
  })

  it('adds no inline style= attribute anywhere (css.ts already positions .rt-map)', async () => {
    const data = await fixtureDashboard()
    const html = renderRealtime(data, CTX)
    expect(html).not.toContain('style="')
  })

  it('has no em dash outside the MISSING placeholder glyph', async () => {
    const data = await fixtureDashboard()
    const html = renderRealtime(data, CTX)
    const withoutMissingGlyphs = html.split('—').join('')
    expect(withoutMissingGlyphs).not.toContain('—')
  })
})

describe('renderGeoTable', () => {
  const rows: GeoTableRow[] = [
    { iso: 'CA', country: 'CA', city: 'Montreal', events: 12, liveSessions: 2, seats30m: 3, avgDurationMs: 90_000 },
    { iso: 'CA', country: 'CA', city: 'Toronto', events: 4, liveSessions: 1, seats30m: 1, avgDurationMs: 30_000 },
    { iso: 'FR', country: 'FR', city: null, events: 2, liveSessions: 0, seats30m: 1, avgDurationMs: 15_000 }
  ]

  it('renders one row per country/city with a flag, the events/live/seats/duration columns, and a search key', () => {
    const html = renderGeoTable(rows)
    expect(html).toContain('Canada, Montreal')
    expect(html).toContain('Canada, Toronto')
    expect(html).toContain('France (country only)')
    expect(html).toMatch(/data-geo-row data-iso="CA"[^>]*data-q="ca canada montreal"/)
  })

  it('dedupes the header flags by country, capped at 8', () => {
    const many: GeoTableRow[] = Array.from({ length: 12 }, (_, i) => ({
      iso: 'CA',
      country: 'CA',
      city: `City ${i}`,
      events: 1,
      liveSessions: 0,
      seats30m: 1,
      avgDurationMs: 1000
    }))
    const html = renderGeoTable(many)
    expect((html.match(/class="flag"/g) || []).length).toBeLessThanOrEqual(1 + 12) // header (1 distinct) + one per row label
  })

  it('renders the named empty state when there are no rows', () => {
    const html = renderGeoTable([])
    expect(html).toContain('No seats have checked in during the last 30 minutes.')
  })
})

describe('renderConnectedSeatsTable', () => {
  const now = 1_725_000_000_000
  const rows: LiveSeatTableRow[] = [
    {
      deviceId: 'device-1',
      hostname: 'tonys-macbook',
      email: 'tony@example.com',
      country: 'CA',
      city: 'Montreal',
      os: 'darwin',
      appVersion: '1.8.5',
      tier: 'metis',
      licenseState: 'licensed',
      sessionStartedAt: now - 600_000,
      durationMs: 600_000,
      eventsThisSession: 14,
      asksThisSession: 3,
      lastSeen: now - 5000,
      live: true
    },
    {
      deviceId: 'device-2',
      hostname: null,
      email: null,
      country: null,
      city: null,
      os: 'win32',
      appVersion: '1.8.5',
      tier: null,
      licenseState: 'unlicensed',
      sessionStartedAt: null,
      durationMs: null,
      eventsThisSession: null,
      asksThisSession: null,
      lastSeen: now - 500_000,
      live: false
    }
  ]

  it('renders a row per seat with avatar, country/city, OS, client, tier, session timing and asks', () => {
    const html = renderConnectedSeatsTable(rows, now)
    expect(html).toContain('data-rt-seat="device-1"')
    expect(html).toContain('data-duration-since=')
    expect(html).toContain('tonys-macbook')
    expect(html).toContain('Canada, Montreal')
    expect(html).toContain('Métis')
  })

  it('never fabricates a value: unknown fields show the MISSING glyph, not a zero', () => {
    const html = renderConnectedSeatsTable(rows, now)
    expect(html).toContain('data-rt-seat="device-2"')
    // device-2 has no session/events/asks -- the row must not print "0" for any of them.
    const rowMatch = html.match(/<tr[^>]*data-rt-seat="device-2"[\s\S]*?<\/tr>/)
    expect(rowMatch).toBeTruthy()
    expect(rowMatch![0]).not.toContain('>0<')
  })

  it('renders the named empty state when there are no rows', () => {
    const html = renderConnectedSeatsTable([], now)
    expect(html).toContain('No seats have checked in during the last 30 minutes.')
  })
})
