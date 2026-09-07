import { describe, expect, it } from 'vitest'
import { fixtureDashboard } from '../fixture'
import { renderAudit } from './audit'

const CTX = { now: 1_725_000_000_000, theme: 'light' as const }

describe('renderAudit (QA fixture)', () => {
  it('renders real audit rows when the fixture has them, or the named empty state when it does not', async () => {
    const data = await fixtureDashboard()
    const html = renderAudit(data, CTX)
    expect(html).toContain('>Audit<')
    expect(html).not.toContain('style="')
    if (data.change.timeline.length) {
      expect(html).toContain('<table>')
      expect(html).toContain('<th>Actor</th>')
    } else {
      expect(html).toContain('No audit rows yet.')
      expect(html).toContain('Every action you take here will appear in this list.')
    }
  })
})
