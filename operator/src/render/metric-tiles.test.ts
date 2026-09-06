import { describe, expect, it } from 'vitest'
import { metricTiles } from './metric-tiles'

describe('metricTiles', () => {
  it('renders one card with one cell per tile (SPEC rule 6: one divided grid, not N cards)', () => {
    const html = metricTiles([
      { label: 'Live seats', value: '3', delta: 8.9 },
      { label: 'Live · 30 min', value: '31', live: true }
    ])
    expect((html.match(/class="card mtiles-card"/g) || []).length).toBe(1)
    expect((html.match(/class="mtile"/g) || []).length).toBe(2)
    expect(html).toContain('delta-up')
    expect(html).toContain('class="live"')
  })

  it('renders caption and spark when provided', () => {
    const html = metricTiles([{ label: 'Time saved', value: '3.2h', caption: 'Last 7 days', spark: '<svg class="spark"></svg>' }])
    expect(html).toContain('Last 7 days')
    expect(html).toContain('<svg class="spark">')
  })

  it('escapes labels/values and never emits an em dash', () => {
    const html = metricTiles([{ label: '<x>', value: '<y>' }])
    expect(html).not.toContain('<x>')
    expect(html).not.toContain('<y>')
    expect(html).not.toMatch(/ — /)
  })
})
