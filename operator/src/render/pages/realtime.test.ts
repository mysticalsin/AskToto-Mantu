import { describe, expect, it } from 'vitest'
import { fixtureDashboard } from '../fixture'
import { renderRealtime } from './realtime'

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
  it('adds no inline style= of its own outside the not-yet-migrated world map markup', async () => {
    const data = await fixtureDashboard()
    const html = renderRealtime(data, CTX)
    const withoutKnownMapStyle = html.split('style="position:relative"').join('')
    expect(withoutKnownMapStyle).not.toContain('style="')
  })
})
