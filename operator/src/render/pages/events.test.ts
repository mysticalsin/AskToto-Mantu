import { describe, expect, it } from 'vitest'
import { fixtureDashboard } from '../fixture'
import { renderEvents } from './events'

const CTX = { now: 1_725_000_000_000, theme: 'light' as const }

describe('renderEvents (QA fixture)', () => {
  it('renders event rows with a data-event id and never a token-shaped string, no inline style=', async () => {
    const data = await fixtureDashboard()
    const html = renderEvents(data, CTX)
    expect(data.events.length).toBeGreaterThan(0)
    expect(html).toContain('data-event=')
    expect(html).toContain('id="events-search"')
    expect(html).toContain('>Events<')
    expect(html).not.toMatch(/Bearer |sk-ant-/)
    expect(html).not.toContain('style="')
  })
})
