import { describe, expect, it } from 'vitest'
import { fixtureDashboard } from '../fixture'
import { renderKeys } from './keys'

const CTX = { now: 1_725_000_000_000, theme: 'light' as const }

describe('renderKeys (QA fixture)', () => {
  it('renders the bindings table, the add-key form, and the vault, no inline style=', async () => {
    const data = await fixtureDashboard()
    const html = renderKeys(data, CTX)
    expect(html).toContain('id="key-add"')
    expect(html).toContain('data-cf-overview')
    expect(html).toContain('>Keys<')
    expect(html).not.toContain('style="')
  })
})
