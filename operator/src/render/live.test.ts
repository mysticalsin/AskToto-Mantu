import { describe, expect, it } from 'vitest'
import { liveCard, liveFeed, visitorsBars, visitorsCard } from './live'

describe('visitorsBars', () => {
  it('always renders exactly 30 bars, 6px wide, at the 8.1935 step', () => {
    const svg = visitorsBars(Array.from({ length: 30 }, (_, i) => i))
    expect((svg.match(/<rect/g) || []).length).toBe(30)
    expect(svg).toContain('width="6"')
    expect(svg).toContain('viewBox="0 0 254 42"')
    expect(svg).toContain('x="8.19"')
  })
  it('pads short series with leading zero bars instead of fabricating data', () => {
    const svg = visitorsBars([5, 5, 5])
    expect((svg.match(/<rect/g) || []).length).toBe(30)
  })
})

describe('visitorsCard', () => {
  it('renders the title, the big number, and the bar chart', () => {
    const html = visitorsCard({ title: 'Unique visitors last 30 min', value: 160, bars: [1, 2, 3] })
    expect(html).toContain('Unique visitors last 30 min')
    expect(html).toContain('>160<')
    expect(html).toContain('visitors-bars')
  })
  it('never emits an inline style attribute (plan D6: no style-src unsafe-inline)', () => {
    expect(visitorsCard({ title: 'x', value: 1, bars: [1] })).not.toContain('style="')
  })
})

describe('liveCard', () => {
  it('renders a pinging live dot, the value, and a caption', () => {
    const html = liveCard({ title: 'Live', value: 22, caption: 'Visitors online now' })
    expect(html).toContain('>Live<')
    expect(html).toContain('>22<')
    expect(html).toContain('Visitors online now')
    expect(html).toContain('class="live"')
  })
  it('never emits an inline style attribute', () => {
    expect(liveCard({ title: 'x', value: 1, caption: 'y' })).not.toContain('style="')
  })
})

describe('liveFeed', () => {
  it('renders one row per event with a kind badge and age, and the count', () => {
    const html = liveFeed({
      rows: [{ id: 'e1', kind: 'heartbeat', label: '/', ageHtml: 'now' }],
      count: 24
    })
    expect(html).toContain('kind-heartbeat')
    expect(html).toContain('data-event="e1"')
    expect(html).toContain('>24<')
  })
  it('renders an empty state when there are no rows, never a fake row', () => {
    const html = liveFeed({ rows: [] })
    expect(html).toContain('No live events yet')
  })
  it('escapes labels and never emits an em dash', () => {
    const html = liveFeed({ rows: [{ id: '1', kind: 'ask', label: '<x>', ageHtml: 'now' }] })
    expect(html).not.toContain('<x>')
    expect(html).not.toMatch(/ — /)
  })
})
