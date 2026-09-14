import { describe, expect, it } from 'vitest'
import { resolveMapTheme } from '../../theme-preference'
import { fixtureDashboard } from '../fixture'
import { liveStripEvents, renderRealtime } from './realtime'

const CTX = { now: 1_725_000_000_000, theme: 'light' as const }

describe('renderRealtime (QA fixture)', () => {
  it('renders the map, the live strip, and the geo table, in order', async () => {
    const data = await fixtureDashboard()
    const html = renderRealtime(data, CTX)
    expect(html).toContain('data-world-map')
    expect(html).toContain('data-rt-live-strip')
    expect(html).toContain('data-realtime-geo')
    expect(html.indexOf('data-world-map')).toBeLessThan(html.indexOf('data-rt-live-strip'))
    expect(html.indexOf('data-rt-live-strip')).toBeLessThan(html.indexOf('data-realtime-geo'))
    expect(html).toContain('>Realtime<')
  })

  // operator/src/world/map.ts:232 (dev-analytics/P1.2, not this file) still bakes
  // `style="position:relative"` into its `data-map-root` div; this page's own code adds none.
  // See the task report for the one-line patch (move `position:relative` into a `.rt-map` CSS
  // rule) once P1.2 lands.
  it('adds no inline style= of its own outside map markup (viewport + country pills)', async () => {
    const data = await fixtureDashboard()
    const html = renderRealtime(data, CTX)
    // map.ts owns position:relative on data-map-root and theme colors on rt-country-pill.
    const withoutKnownMapStyle = html
      .split('style="position:relative"')
      .join('')
      .replace(/style="background:[^"]*"/g, '')
    expect(withoutKnownMapStyle).not.toContain('style="')
  })
})

describe('realtime map theme + live strip', () => {
  it('resolves system theme to dark for map paint', () => {
    expect(resolveMapTheme('system')).toBe('dark')
  })

  it('uses dark land when ctx.theme is system and emits data-map-theme', async () => {
    const data = await fixtureDashboard()
    const html = renderRealtime(data, { now: data.now, theme: 'system' })
    expect(html).toContain('data-map-theme="system"')
    expect(html).toContain('#1f1830')
    expect(html).toContain('world-ocean')
    expect(html).toContain('rt-map')
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
})
