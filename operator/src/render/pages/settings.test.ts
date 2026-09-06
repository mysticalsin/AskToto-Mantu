import { describe, expect, it } from 'vitest'
import { fixtureDashboard } from '../fixture'
import { renderSettings } from './settings'

const CTX = { now: 1_725_000_000_000, theme: 'light' as const }

describe('renderSettings (QA fixture)', () => {
  it('renders the three rule cards, no inline style=', async () => {
    const data = await fixtureDashboard()
    const html = renderSettings(data, CTX)
    expect(html).toContain('Access keep')
    expect(html).toContain('Generate license')
    expect(html).toContain('Geo')
    expect(html).toContain('>Settings<')
    expect(html).not.toContain('style="')
  })
})
