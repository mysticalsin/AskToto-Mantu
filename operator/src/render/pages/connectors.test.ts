import { describe, expect, it } from 'vitest'
import { fixtureDashboard } from '../fixture'
import { fixtureForConnectors } from './connectors.fixture'
import {
  catalogByKind,
  renderCatalogGrid,
  renderConnectedTable,
  renderConnectionDrawerHtml,
  renderConnectorRowHtml,
  renderConnectors,
  renderProbeResultCard,
  type ConnectorSummary,
  type PublicConnectorCatalogEntry
} from './connectors'

const CTX = { now: 1_725_000_000_000, theme: 'light' as const }

const HUBSPOT_ENTRY: PublicConnectorCatalogEntry = {
  kind: 'hubspot',
  label: 'HubSpot',
  category: 'crm',
  transport: 'rest',
  auth: 'bearer',
  availability: 'ready',
  docsUrl: 'https://developers.hubspot.com/docs/api/private-apps',
  logo: 'hubspot',
  fields: [{ key: 'credential', label: 'Private app access token', type: 'password', required: true, placeholder: 'pat-na1-...' }],
  hasProbe: true
}

const SALESFORCE_ENTRY: PublicConnectorCatalogEntry = {
  kind: 'salesforce',
  label: 'Salesforce',
  category: 'crm',
  transport: 'rest',
  auth: 'oauth2-client-credentials',
  availability: 'needs-oauth',
  docsUrl: 'https://developer.salesforce.com/docs',
  logo: 'salesforce',
  fields: [
    { key: 'clientId', label: 'Connected app client id', type: 'text', required: false },
    { key: 'clientSecret', label: 'Connected app client secret', type: 'password', required: false }
  ],
  hasProbe: false
}

function summary(overrides: Partial<ConnectorSummary> = {}): ConnectorSummary {
  return {
    id: 'int-1',
    kind: 'hubspot',
    label: 'HubSpot CRM',
    baseUrl: 'https://api.hubapi.com',
    last4: 'abcd',
    status: 'active',
    health: 'connected',
    transport: 'rest',
    authKind: 'bearer',
    headerName: null,
    mode: 'brokered',
    allowWrites: false,
    scope: {},
    notes: null,
    tools: null,
    lastTest: { ok: true, status: 200, latencyMs: 120, summary: 'Reached HubSpot account 12345' },
    lastTestAt: CTX.now - 60_000,
    uses: 42,
    lastUsedAt: CTX.now - 30_000,
    grantsCount: 2,
    createdAt: CTX.now - 86_400_000,
    createdBy: 'tony.walteur@gmail.com',
    rotatedAt: null,
    revokedAt: null,
    ...overrides
  }
}

describe('renderConnectors (page shell)', () => {
  it('renders the header, toolbar search, catalog (grouped by category) and a loading Connected card', async () => {
    const data = await fixtureDashboard()
    const html = renderConnectors(data, CTX)
    expect(html).toContain('>Connectors<')
    expect(html).toContain('CRMs, work tools and MCP servers Métis can reach through the Operator.')
    expect(html).toContain('data-connectors-add-open')
    expect(html).toContain('id="connectors-search"')
    expect(html).toContain('data-connectors-state="loading"')
    expect(html).toContain('data-catalog-tile="hubspot"')
    expect(html).toContain('>CRM<')
    expect(html).toContain('>Custom<')
    expect(html).toContain('id="connector-rotate-dialog"')
    expect(html).toContain('data-connectors-drawer-slot')
    expect(html).not.toContain('style="')
    expect(html).not.toContain('—')
  })

  it('needs-oauth kinds render at reduced availability with the exact phase-2 sentence, never as a working tile', async () => {
    const data = await fixtureDashboard()
    const html = renderConnectors(data, CTX)
    expect(html).toContain('catalog-tile-needs-oauth')
    expect(html).toContain('Needs OAuth (phase 2)')
  })
})

describe('renderCatalogGrid', () => {
  it('groups tiles by category in the plan-specified order', () => {
    const html = renderCatalogGrid([SALESFORCE_ENTRY, HUBSPOT_ENTRY])
    const crmIndex = html.indexOf('data-category="crm"')
    expect(crmIndex).toBeGreaterThanOrEqual(0)
    expect(html.indexOf('hubspot')).toBeLessThan(html.length)
    // Both crm-category kinds land in the same section.
    const section = html.slice(crmIndex, html.indexOf('</section>', crmIndex))
    expect(section).toContain('data-catalog-tile="hubspot"')
    expect(section).toContain('data-catalog-tile="salesforce"')
  })

  it('carries a lowercase search haystack (label, kind, category) on every tile for client-side filtering', () => {
    const html = renderCatalogGrid([HUBSPOT_ENTRY])
    expect(html).toContain('data-q="hubspot hubspot crm"')
  })
})

describe('renderConnectedTable', () => {
  it('renders the named empty state when there are no connections', () => {
    const { html, activeCount, historyCount } = renderConnectedTable([], CTX.now, {}, {})
    expect(html).toContain('No connectors yet.')
    expect(activeCount).toBe(0)
    expect(historyCount).toBe(0)
  })

  it('splits active and revoked rows, and escapes a hostile label', () => {
    const catalog = catalogByKind([HUBSPOT_ENTRY])
    const rows = [
      summary({ id: 'a', status: 'active', label: '<script>x</script>' }),
      summary({ id: 'b', status: 'revoked', revokedAt: CTX.now - 1000 })
    ]
    const { html, activeCount, historyCount } = renderConnectedTable(rows, CTX.now, catalog, {})
    expect(activeCount).toBe(1)
    expect(historyCount).toBe(1)
    expect(html).not.toContain('<script>x</script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('data-connector-history-row')
    expect(html).not.toContain('style="')
  })

  it('shows a failing row with a health marker for the CSS pulse, and a source tooltip on the used cell', () => {
    const rows = [summary({ health: 'failing', lastTest: { ok: false, latencyMs: 4200, summary: 'x', error: { code: 'bad-status', message: 'The provider responded with status 503.' } } })]
    const { html } = renderConnectedTable(rows, CTX.now, {}, {})
    expect(html).toContain('data-connector-health="failing"')
    expect(html).toContain('Failing')
    expect(html).toContain('source-tooltip-mark')
  })

  it('shows scope chips for tiers and groups, or "Everyone" when scope is empty', () => {
    const scoped = renderConnectedTable([summary({ scope: { tiers: ['metis'], groups: ['g1'] } })], CTX.now, {}, { g1: 'Sales Paris' })
    expect(scoped.html).toContain('Métis')
    expect(scoped.html).toContain('Sales Paris')
    const unscoped = renderConnectedTable([summary({ scope: {} })], CTX.now, {}, {})
    expect(unscoped.html).toContain('Everyone')
  })

  it('renders an expandable tool count with read/write marks for an mcp connection', () => {
    const rows = [
      summary({
        transport: 'mcp',
        tools: [
          { name: 'list_issues', write: false },
          { name: 'create_issue', write: true }
        ]
      })
    ]
    const { html } = renderConnectedTable(rows, CTX.now, {}, {})
    expect(html).toContain('2 tools')
    expect(html).toContain('list_issues')
    expect(html).toContain('create_issue')
    expect(html).toContain('>write<')
    expect(html).toContain('>read<')
  })

  it('marks a rest connection\'s tools column not applicable', () => {
    const { html } = renderConnectedTable([summary({ transport: 'rest' })], CTX.now, {}, {})
    expect(html).toContain('Not applicable')
  })
})

describe('renderConnectorRowHtml', () => {
  it('produces one <tr> matching the connected table\'s own row shape', () => {
    const row = summary()
    const html = renderConnectorRowHtml(row, CTX.now, catalogByKind([HUBSPOT_ENTRY]), {})
    expect(html.startsWith('<tr')).toBe(true)
    expect(html).toContain(`data-connector-row="${row.id}"`)
    expect(html).toContain('data-stagger')
  })
})

describe('renderConnectionDrawerHtml', () => {
  it('needs-oauth: read-only, no Test/Save actions, states exactly what is missing', () => {
    const html = renderConnectionDrawerHtml(SALESFORCE_ENTRY, { tiers: [], groups: [], existing: null })
    expect(html).toContain('Needs OAuth (phase 2)')
    expect(html).toContain('Connected app client id, Connected app client secret')
    expect(html).not.toContain('data-connector-test')
    expect(html).not.toContain('data-connector-save')
  })

  it('new connection: masked credential input, scope unchecked, brokered mode default, Save disabled until a test passes', () => {
    const html = renderConnectionDrawerHtml(HUBSPOT_ENTRY, { tiers: [{ id: 'metis', label: 'Métis' }], groups: [], existing: null })
    expect(html).toContain('type="password" name="credential"')
    expect(html).toContain('data-credential-reveal')
    expect(html).toContain('value="metis" >')
    expect(html).toContain('value="brokered" checked')
    expect(html).toContain('The seat will hold this credential in memory until restart.')
    expect(html).toContain('data-connector-test')
    expect(html).toContain('data-connector-save disabled')
  })

  it('existing connection: credential never re-displayed, scope pre-checked from the row, Rotate/Revoke available', () => {
    const existing = summary({ scope: { tiers: ['metis'] }, mode: 'direct' })
    const html = renderConnectionDrawerHtml(HUBSPOT_ENTRY, { tiers: [{ id: 'metis', label: 'Métis' }], groups: [], existing })
    expect(html).not.toContain('type="password" name="credential"')
    expect(html).toContain('stored, ••abcd')
    expect(html).toContain('value="metis" checked')
    expect(html).toContain('value="direct" checked')
    expect(html).toContain(`data-connector-rotate="${existing.id}"`)
    expect(html).toContain(`data-connector-revoke="${existing.id}"`)
    expect(html).toContain(`data-connector-save="${existing.id}"`)
  })
})

describe('renderProbeResultCard', () => {
  it('a passing MCP test lists tools with read/write marks', () => {
    const html = renderProbeResultCard({
      ok: true,
      latencyMs: 88,
      summary: 'Reached Custom MCP server, 2 tools available.',
      tools: [
        { name: 'list_things', write: false },
        { name: 'create_thing', write: true }
      ]
    })
    expect(html).toContain('88 ms')
    expect(html).toContain('list_things')
    expect(html).toContain('>write<')
    expect(html).not.toContain('style="')
  })

  it('a failing test shows the error message, never a fabricated success', () => {
    const html = renderProbeResultCard({ ok: false, latencyMs: 4200, summary: 'x', error: { code: 'timeout', message: 'Timed out after 10 seconds.' } })
    expect(html).toContain('Timed out after 10 seconds.')
    expect(html).toContain('Failed')
  })
})

describe('fixtureForConnectors', () => {
  it('derives 5 connectors (3 connected, 2 failing) from the same seeded rows the QA fixture uses everywhere else', async () => {
    const fx = await fixtureForConnectors()
    expect(fx.connectors).toHaveLength(5)
    expect(fx.connectors.filter((c) => c.health === 'connected')).toHaveLength(3)
    expect(fx.connectors.filter((c) => c.health === 'failing')).toHaveLength(2)
    expect(fx.catalog.length).toBeGreaterThan(20)
    const { html, activeCount } = renderConnectedTable(fx.connectors, fx.dashboard.now, catalogByKind(fx.catalog), {})
    expect(activeCount).toBe(5)
    expect(html).not.toContain('style="')
    expect(html).not.toContain('—')
  })
})
