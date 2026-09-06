import { describe, expect, it } from 'vitest'
import { fixtureDashboard } from '../fixture'
import { renderOverview } from './overview'

const CTX = { now: 1_725_000_000_000, theme: 'light' as const }

describe('renderOverview (QA fixture)', () => {
  it('renders the KPI tiles, the toplists and geo blocks, and no inline style=', async () => {
    const data = await fixtureDashboard()
    const html = renderOverview(data, CTX)
    expect(html).toContain('Live seats')
    expect(html).toContain('Time saved')
    expect(html).toContain('Value')
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
})
