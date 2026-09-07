import { describe, expect, it } from 'vitest'
import { fixtureDashboard } from '../fixture'
import { renderSessions } from './sessions'

const CTX = { now: 1_725_000_000_000, theme: 'light' as const }

describe('renderSessions (QA fixture)', () => {
  it('renders seat rows with the data-seat-* hooks the client search index reads, plus the seat drawer, no inline style=', async () => {
    const data = await fixtureDashboard()
    const html = renderSessions(data, CTX)
    expect(data.profiles.length).toBeGreaterThan(0)
    expect(html).toContain('data-seat-row')
    expect(html).toContain('data-seat-computer=')
    expect(html).toContain('data-seat-identity=')
    expect(html).toContain('id="seat-overlay"')
    expect(html).toContain('>Sessions<')
    expect(html).not.toContain('style="')
  })
})
