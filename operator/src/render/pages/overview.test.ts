import { describe, expect, it } from 'vitest'
import { fixtureDashboard } from '../fixture'
import { renderOverview } from './overview'

const CTX = { now: 1_725_000_000_000, theme: 'light' as const }

describe('renderOverview (QA fixture)', () => {
  it('renders the KPI tiles, the toplists and geo blocks, and no inline style=', async () => {
    const data = await fixtureDashboard()
    const html = renderOverview(data, CTX)
    expect(html).toContain('Portal CF')
    expect(html).toContain('Portal direct')
    expect(html).toContain('Live seats')
    expect(html).toContain('heartbeat &lt; 2 min · real devices')
    expect(html).not.toContain('heartbeat &amp;lt; 2 min')
    expect(html).toContain('Time saved')
    expect(html).toContain('Value')
    expect(html).toContain('Portal CF')
    expect(html).toContain('Portal direct')
    expect(html).toContain('data-overview-kpis')
    expect(html).toContain('data-overview-toplists')
    expect(html).toContain('data-overview-activity')
    expect(html).toContain('data-overview-people')
    expect(html).toContain('data-geo-corner')
    expect(html).toContain('data-install-works')
    expect(html).toContain('>Overview<')
    expect(html).not.toContain('style="')
  })

  it('shows real seat rows from the fixture, never a placeholder', async () => {
    const data = await fixtureDashboard()
    const html = renderOverview(data, CTX)
    expect(data.profiles.length).toBeGreaterThan(0)
    expect(html).toContain('data-people-row')
  })

  it('labels Devices with the real seat count from profiles', async () => {
    const data = await fixtureDashboard()
    const html = renderOverview(data, CTX)
    expect(html).toContain(`Devices · ${data.profiles.length} seats`)
    expect(html).toContain('data-toplist-device')
  })

  it('keeps the spend number compact and moves the estimate into supporting copy', async () => {
    const data = await fixtureDashboard()
    data.roi.portalDirect = '21991 tok · ≈$0.01 · estimate, list price'
    const html = renderOverview(data, CTX)
    expect(html).toContain('<div class="n">21991 tok</div>')
    expect(html).toContain('DeepSeek platform · ≈$0.01 · estimate, list price')
    expect(html).not.toContain('<div class="n">21991 tok · ≈$0.01 · estimate, list price</div>')
  })

  it('shows zero activity for a known seat with no events instead of inventing one', async () => {
    const data = await fixtureDashboard()
    data.events = []
    const html = renderOverview(data, CTX)
    const firstDevice = html.match(/<div class="vol-row" data-toplist-device="[^"]+"[\s\S]*?<\/div>/)?.[0]
    expect(firstDevice).toContain('<span class="muted">0</span>')
    expect(firstDevice).toContain('width="0%"')
  })

  it('keeps the Overview activity concise and links to the full Events page', async () => {
    const data = await fixtureDashboard()
    expect(data.events.length).toBeGreaterThan(10)

    const html = renderOverview(data, CTX)

    expect((html.match(/data-event="/g) ?? [])).toHaveLength(10)
    expect(html).toContain('href="#events"')
    expect(html).toContain('Open Events')
  })
})
