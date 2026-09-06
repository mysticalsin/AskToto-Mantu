import { describe, expect, it } from 'vitest'
import { connectorGroup, connectorRow, type ConnectorRow } from './connectors-list'

const baseRow: ConnectorRow = {
  id: 'conn_1',
  kind: 'hubspot',
  label: 'HubSpot',
  transport: 'rest',
  status: 'connected',
  action: 'Test',
  auth: 'api-key',
  toolsCount: 3
}

describe('connectorRow', () => {
  it('renders the logo, an emerald status dot for connected, the transport badge, and the action', () => {
    const html = connectorRow(baseRow)
    expect(html).toContain('src="/assets/logos/hubspot.svg"')
    expect(html).toContain('connector-row-dot-connected')
    expect(html).toContain('>API<')
    expect(html).toContain('connector-row-action">Test<')
  })

  it('shows "N tools enabled" with a count-up for a connected row', () => {
    const html = connectorRow(baseRow)
    expect(html).toContain('<span data-count-to="3">3</span> tools enabled')
  })

  it('shows "No tools discovered yet" when toolsCount is 0 or omitted', () => {
    expect(connectorRow({ ...baseRow, toolsCount: 0 })).toContain('No tools discovered yet')
    const { toolsCount: _drop, ...rest } = baseRow
    expect(connectorRow(rest)).toContain('No tools discovered yet')
  })

  it('shows the reason for an attention row instead of a tools count, rose dot', () => {
    const html = connectorRow({ ...baseRow, status: 'attention', action: 'Fix', reason: 'Test failed 2 hours ago', toolsCount: 5 })
    expect(html).toContain('connector-row-dot-attention')
    expect(html).toContain('Test failed 2 hours ago')
    expect(html).not.toContain('tools enabled')
  })

  it('defaults the attention reason when none is given', () => {
    expect(connectorRow({ ...baseRow, status: 'attention', action: 'Fix' })).toContain('Needs attention')
  })

  it('mcp transport shows the MCP badge', () => {
    expect(connectorRow({ ...baseRow, transport: 'mcp' })).toContain('>MCP<')
  })

  it('carries every data-connector-* attribute the client reads', () => {
    const html = connectorRow({ ...baseRow, action: 'Authenticate', auth: 'oauth2-auth-code' })
    expect(html).toContain('data-connector-kind="hubspot"')
    expect(html).toContain('data-connector-id="conn_1"')
    expect(html).toContain('data-connector-action="Authenticate"')
    expect(html).toContain('data-connector-auth="oauth2-auth-code"')
  })

  it('stagger cadence is 30ms (plan 6.10b), not the usual 40ms', () => {
    expect(connectorRow(baseRow)).toContain('data-stagger-ms="30"')
  })

  it('renders hidden when asked, for rows past the "Show N more" limit', () => {
    expect(connectorRow(baseRow, { hidden: true })).toContain(' hidden')
    expect(connectorRow(baseRow)).not.toMatch(/ hidden[ >]/)
  })

  it('is keyboard-operable: role=button, tabindex=0', () => {
    const html = connectorRow(baseRow)
    expect(html).toContain('role="button"')
    expect(html).toContain('tabindex="0"')
  })

  it('escapes labels and never emits an inline style or an em dash', () => {
    const html = connectorRow({ ...baseRow, label: '<x>', reason: '<y>', status: 'attention', action: 'Fix' })
    expect(html).not.toContain('<x>')
    expect(html).not.toContain('<y>')
    expect(html).not.toContain('style="')
    expect(html).not.toMatch(/ — /)
  })
})

describe('connectorGroup', () => {
  it('renders nothing for an empty group, never a zero count', () => {
    expect(connectorGroup('Needs attention', [])).toBe('')
  })

  it('renders the heading with a count and every row when 5 or fewer', () => {
    const rows = [baseRow, { ...baseRow, id: 'conn_2' }]
    const html = connectorGroup('Connected', rows)
    expect(html).toContain('Connected <span class="connector-group-count">2</span>')
    expect((html.match(/class="connector-row"/g) || []).length).toBe(2)
    expect(html).not.toContain('Show')
  })

  it('hides rows past 5 and renders "Show N more"', () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({ ...baseRow, id: `conn_${i}` }))
    const html = connectorGroup('Connected', rows)
    expect(html).toContain('Show 3 more')
    expect(html).toContain('data-expand')
    const hiddenCount = (html.match(/ hidden/g) || []).length
    expect(hiddenCount).toBe(3)
  })

  it('respects a custom visibleLimit', () => {
    const rows = Array.from({ length: 4 }, (_, i) => ({ ...baseRow, id: `conn_${i}` }))
    const html = connectorGroup('Connected', rows, { visibleLimit: 2 })
    expect(html).toContain('Show 2 more')
  })

  it('never emits an inline style attribute or an em dash', () => {
    const html = connectorGroup('Connected', [baseRow])
    expect(html).not.toContain('style="')
    expect(html).not.toMatch(/ — /)
  })
})
