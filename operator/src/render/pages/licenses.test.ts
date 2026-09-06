import { describe, expect, it } from 'vitest'
import { fixtureDashboard } from '../fixture'
import { renderLicenses } from './licenses'

const CTX = { now: 1_725_000_000_000, theme: 'light' as const }

describe('renderLicenses (QA fixture)', () => {
  it('renders the generate form and the seats table with data-license-last4 hooks, no inline style=', async () => {
    const data = await fixtureDashboard()
    const html = renderLicenses(data, CTX)
    expect(html).toContain('data-license-generate')
    expect(html).toContain('Generate license')
    expect(html).toContain('>Licenses<')
    if (data.licenses.issued.length) {
      expect(html).toContain('data-license-last4=')
      expect(html).toContain('data-license-status=')
    }
    expect(html).not.toContain('style="')
  })
})
