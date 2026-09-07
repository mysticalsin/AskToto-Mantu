import { describe, expect, it } from 'vitest'
import { fixtureDashboard } from '../fixture'
import { renderConnectors } from './connectors'

const CTX = { now: 1_725_000_000_000, theme: 'light' as const }

describe('renderConnectors (QA fixture)', () => {
  it('renders the named empty state (P1.9 has not landed a real Connectors page yet)', async () => {
    const data = await fixtureDashboard()
    const html = renderConnectors(data, CTX)
    expect(html).toContain('No connectors yet.')
    expect(html).toContain('Connect a CRM, a work tool or an MCP server')
    expect(html).toContain('>Connectors<')
    expect(html).not.toContain('style="')
  })
})
