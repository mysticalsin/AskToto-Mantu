import { describe, expect, it } from 'vitest'
import { fixtureDashboard } from '../fixture'
import { fixtureForConnectors } from './connectors.fixture'
import {
  catalogByKind,
  needsAttentionRows,
  renderCatalogGrid,
  renderConnectedTable,
  renderConnectionDrawerHtml,
  renderConnectorRowHtml,
  renderConnectors,
  renderDangerBanner,
  renderNeedsAttention,
  renderProbeResultCard,
  renderStatusStrip,
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
  hasProbe: true,
  oauthConfigured: false
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
  hasProbe: false,
  oauthConfigured: false
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
    disabledTools: [],
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
  it('renders the header, danger banner, status strip, toolbar search, needs attention, connected table and a flat catalog, all from DashboardPayload with no skeleton', async () => {
    const data = await fixtureDashboard()
    const html = renderConnectors(data, CTX)
    expect(html).toContain('>Connectors<')
    expect(html).toContain('CRMs, work tools and MCP servers Métis can reach through the Operator.')
    expect(html).toContain('data-connectors-header-add')
    expect(html).toContain('id="connectors-search"')
    expect(html).not.toContain('data-connectors-state="loading"')
    expect(html).not.toContain('Could not load')
    // Danger banner: the QA fixture seeds 2 failing connectors.
    expect(html).toContain('2 connectors are failing. Seats using them get no data until fixed.')
    // Status strip.
    expect(html).toContain('data-connectors-status-strip')
    expect(html).toContain('Connections')
    expect(html).toContain('Healthy')
    expect(html).toContain('Never tested')
    expect(html).toContain('Slowest (last test)')
    // Needs attention (real failing rows, not a skeleton).
    expect(html).toContain('Needs attention')
    // Connected table sourced from data.connectors, not a fetch.
    expect(html).toContain('data-connectors-connected-root')
    expect(html).toContain('HubSpot CRM')
    // Catalog: flat grid, no per-category section wrapper.
    expect(html).not.toContain('data-category-section')
    expect(html).not.toContain('class="eyebrow">CRM<')
    expect(html).toContain('data-catalog-tile="hubspot"')
    expect(html).toContain('id="connector-rotate-dialog"')
    expect(html).toContain('data-connectors-drawer-slot')
    expect(html).not.toContain('style="')
    expect(html).not.toContain('—')
  })

  it('needs-oauth kinds render at reduced availability, never as a working tile', async () => {
    const data = await fixtureDashboard()
    const html = renderConnectors(data, CTX)
    expect(html).toContain('catalog-tile-needs-oauth')
    expect(html).toContain('Needs OAuth (phase 2)')
  })

  it('the Danger banner is absent entirely (not hidden) when nothing is failing', async () => {
    const data = await fixtureDashboard()
    const healed = { ...data, connectors: data.connectors.map((c) => ({ ...c, health: 'connected' as const, lastTest: { ok: true, latencyMs: 100, summary: 'ok' } })) }
    const html = renderConnectors(healed, CTX)
    expect(html).not.toContain('are failing')
    expect(html).not.toContain('alert-badge-danger')
  })

  it('renders the zero state, never an empty box, when there are no active connections', async () => {
    const data = await fixtureDashboard()
    const empty = { ...data, connectors: data.connectors.map((c) => ({ ...c, status: 'revoked' })) }
    const html = renderConnectors(empty, CTX)
    expect(html).toContain('data-connectors-zero-state')
    expect(html).toContain('Nothing connected yet.')
    expect(html).not.toContain('data-connectors-connected-card')
    // The catalog still renders underneath, in full.
    expect(html).toContain('data-catalog-tile="hubspot"')
  })
})

describe('renderStatusStrip', () => {
  it('hides the Failing cell entirely when nothing is failing, never a false-cheerful zero', () => {
    const rows = [summary({ id: 'a' }), summary({ id: 'b', health: 'untested', lastTest: null, lastTestAt: null })]
    const html = renderStatusStrip(rows)
    expect(html).not.toContain('data-status-filter="failing"')
    expect(html).toContain('Never tested')
  })

  it('shows the Failing cell with a real count when something is failing', () => {
    const rows = [summary({ id: 'a', health: 'failing', lastTest: { ok: false, latencyMs: 400, summary: 'x', error: { code: 'bad-status', message: 'Timed out' } } })]
    const html = renderStatusStrip(rows)
    expect(html).toContain('data-status-filter="failing"')
    expect(html).toContain('connectors-status-cell-danger')
  })

  it('Slowest is the slowest connection among tests that PASSED, never a failing test\'s timeout latency', () => {
    const rows = [
      summary({ id: 'fast', lastTest: { ok: true, latencyMs: 100, summary: 'x' } }),
      summary({ id: 'slow-but-passed', lastTest: { ok: true, latencyMs: 900, summary: 'x' } }),
      summary({ id: 'failed-and-slow', health: 'failing', lastTest: { ok: false, latencyMs: 10000, summary: 'x', error: { code: 'timeout', message: 'Timed out' } } })
    ]
    const html = renderStatusStrip(rows)
    expect(html).toContain('900 ms')
    expect(html).not.toContain('10000 ms')
  })

  it('reads "Not tested yet" when nothing has ever passed, never a fabricated number', () => {
    const rows = [summary({ health: 'untested', lastTest: null, lastTestAt: null })]
    const html = renderStatusStrip(rows)
    expect(html).toContain('Not tested yet')
  })
})

describe('renderDangerBanner', () => {
  it('renders nothing at all for zero failing (not merely hidden)', () => {
    expect(renderDangerBanner(0)).toBe('')
  })

  it('singular grammar for exactly one failing connector', () => {
    const html = renderDangerBanner(1)
    expect(html).toContain('1 connector is failing. Seats using it get no data until fixed.')
  })

  it('plural grammar and a link to Needs attention for more than one', () => {
    const html = renderDangerBanner(3)
    expect(html).toContain('3 connectors are failing. Seats using them get no data until fixed.')
    expect(html).toContain('#connectors-needs-attention')
  })
})

describe('needsAttentionRows / renderNeedsAttention', () => {
  it('carries the real redacted upstream message plus age, never a generic "Test failed."', () => {
    const rows = [
      summary({
        health: 'failing',
        lastTestAt: CTX.now - 2 * 60 * 60 * 1000,
        lastTest: { ok: false, latencyMs: 300, summary: 'x', error: { code: 'auth', message: '401 unauthorized.' } }
      })
    ]
    const attention = needsAttentionRows(rows, CTX.now)
    expect(attention).toHaveLength(1)
    expect(attention[0].reason).toBe('401 unauthorized, since 2h ago')
    expect(attention[0].action).toBe('Fix')
  })

  it('renders nothing when nothing is failing (connectorGroup\'s own empty rule)', () => {
    expect(renderNeedsAttention([summary()], CTX.now)).toBe('')
  })

  it('never one click from hidden: visibleLimit is 8, not the primitive\'s default 5', () => {
    const rows = Array.from({ length: 7 }, (_, i) => summary({ id: `f-${i}`, health: 'failing', lastTest: { ok: false, latencyMs: 100, summary: 'x' } }))
    const html = renderNeedsAttention(rows, CTX.now)
    expect(html).not.toContain('Show')
  })
})

describe('renderCatalogGrid', () => {
  it('is one flat grid with no per-category section wrapper', () => {
    const html = renderCatalogGrid([SALESFORCE_ENTRY, HUBSPOT_ENTRY])
    expect(html).not.toContain('<section')
    expect(html).not.toContain('data-category-section')
    expect(html).toContain('data-catalog-tile="hubspot"')
    expect(html).toContain('data-catalog-tile="salesforce"')
    expect(html).toContain('data-category="crm"')
  })

  it('carries a lowercase search haystack (label, kind, category) on every tile for client-side filtering', () => {
    const html = renderCatalogGrid([HUBSPOT_ENTRY])
    expect(html).toContain('data-q="hubspot hubspot crm')
  })

  it('marks an already-connected kind as connected, with its live connection count', () => {
    const html = renderCatalogGrid([HUBSPOT_ENTRY], { hubspot: 2 })
    expect(html).toContain('catalog-tile-connected')
    expect(html).toContain('Connected, 2 connections')
  })

  it('marks a kind whose only connection is currently failing as failing, not plain connected (plan 6.10b status colours)', () => {
    const html = renderCatalogGrid([HUBSPOT_ENTRY], { hubspot: 1 }, { hubspot: 1 })
    expect(html).toContain('catalog-tile-failing')
    expect(html).not.toContain('catalog-tile-connected')
    expect(html).toContain('catalog-tile-dot-failing')
    expect(html).toContain('Needs attention')
  })

  it('stagger cadence is 25ms (plan 3.5b Connectors row), not the usual 40ms', () => {
    expect(renderCatalogGrid([HUBSPOT_ENTRY])).toContain('data-stagger-ms="25"')
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

  it('row class is connectors-table-row, never the connectorRow primitive\'s own connector-row class', () => {
    const { html } = renderConnectedTable([summary()], CTX.now, {}, {})
    expect(html).toContain('class="connectors-table-row')
    expect(html).not.toMatch(/class="connector-row[" ]/)
  })

  it('caps active rows at 8 visible, the rest hidden behind an overflow marker', () => {
    const rows = Array.from({ length: 10 }, (_, i) => summary({ id: `c-${i}` }))
    const { html, overflowCount } = renderConnectedTable(rows, CTX.now, {}, {})
    expect(overflowCount).toBe(2)
    expect(html).toContain('data-connector-overflow-row')
    expect((html.match(/data-connector-overflow-row/g) || []).length).toBe(2)
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

  it('marks a rest connection\'s tools column not applicable only when its kind has no phase-1 adapter tool set', () => {
    // salesforce is REST-transport but never shipped a D8 adapter (see catalog.ts's
    // REST_TOOL_CATALOG) -- genuinely "not applicable", unlike hubspot below.
    const { html } = renderConnectedTable([summary({ kind: 'salesforce', transport: 'rest' })], CTX.now, {}, {})
    expect(html).toContain('Not applicable')
  })

  it('shows a REST connection\'s real phase-1 adapter tool set instead of "Not applicable" (plan D8: hubspot, clickup, ...)', () => {
    const { html } = renderConnectedTable([summary({ kind: 'hubspot', transport: 'rest', tools: null })], CTX.now, {}, {})
    expect(html).not.toContain('Not applicable')
    expect(html).toContain('5 tools')
    expect(html).toContain('list_contacts')
    expect(html).toContain('create_contact')
    expect(html).toContain('>write<')
    expect(html).toContain('>read<')
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
  it('needs-oauth: read-only, no Test/Save actions, names the exact wrangler secret put commands', () => {
    const html = renderConnectionDrawerHtml(SALESFORCE_ENTRY, { tiers: [], groups: [], existing: null })
    expect(html).toContain('Needs OAuth (phase 2)')
    expect(html).toContain('wrangler secret put OAUTH_SALESFORCE_CLIENT_ID')
    expect(html).toContain('wrangler secret put OAUTH_SALESFORCE_CLIENT_SECRET')
    expect(html).not.toContain('data-connector-test')
    expect(html).not.toContain('data-connector-save')
  })

  it('new connection: masked credential input, scope unchecked, brokered mode default, Save disabled until a test passes, no tabs yet', () => {
    const html = renderConnectionDrawerHtml(HUBSPOT_ENTRY, { tiers: [{ id: 'metis', label: 'Métis' }], groups: [], existing: null })
    expect(html).toContain('type="password" name="credential"')
    expect(html).toContain('data-credential-reveal')
    expect(html).toContain('value="metis"')
    expect(html).toContain('value="brokered" checked')
    expect(html).toContain('The seat will hold this credential in memory until restart.')
    expect(html).toContain('data-connector-test')
    expect(html).toContain('data-connector-save disabled')
    expect(html).not.toContain('data-connector-tabs')
    // plan 6.10b/6.10c: a real, clickable "Open <vendor> docs" link at the credential step, not
    // just the static help breadcrumb text.
    expect(html).toMatch(/<a class="connector-field-link" href="https:\/\/developers\.hubspot\.com\/docs\/api\/private-apps" target="_blank"[^>]*>Open HubSpot docs/)
  })

  it('existing connection: tabs (Overview default, Tools, Scope, Activity, Danger), credential never re-displayed, scope pre-checked, Rotate/Revoke/Delete live in the Danger panel', () => {
    const existing = summary({ scope: { tiers: ['metis'] }, mode: 'direct' })
    const html = renderConnectionDrawerHtml(HUBSPOT_ENTRY, { tiers: [{ id: 'metis', label: 'Métis' }], groups: [], existing })
    expect(html).toContain('data-connector-tabs')
    expect(html).toContain('data-tab="overview"')
    expect(html).toContain('data-tab="tools"')
    expect(html).toContain('data-tab="scope"')
    expect(html).toContain('data-tab="activity"')
    expect(html).toContain('data-tab="danger"')
    expect(html).not.toContain('type="password" name="credential"')
    expect(html).toContain('stored, ••abcd')
    expect(html).toMatch(/name="scopeTier" value="metis" data-count="\d+" checked/)
    expect(html).toContain(`data-connector-rotate="${existing.id}"`)
    expect(html).toContain(`data-connector-revoke="${existing.id}"`)
    expect(html).toContain(`data-connector-save="${existing.id}"`)
    // Direct mode carries its own persistent warning line in the Overview panel.
    expect(html).toContain('alert-badge-warn')
    expect(html).toContain('Direct mode');
    // Save starts disabled: nothing has changed yet.
    expect(html).toMatch(/data-connector-save="int-1" disabled/)
  })

  it('the Tools tab renders every discovered tool with a real, working per-tool switch, checked by default, plus the allowWrites control', () => {
    const existing = summary({
      transport: 'mcp',
      tools: [{ name: 'create_issue', write: true, description: 'Create an issue' }],
      lastTestAt: CTX.now
    })
    const html = renderConnectionDrawerHtml({ ...HUBSPOT_ENTRY, transport: 'mcp' }, { tiers: [], groups: [], existing, activeTab: 'tools' })
    expect(html).toContain('create_issue')
    expect(html).toContain(`<input type="checkbox" data-connector-tool-toggle="${existing.id}" data-connector-tool-name="create_issue" checked aria-label="create_issue enabled">`)
    expect(html).toContain(`data-connector-allow-writes="${existing.id}"`)
  })

  it('a tool named in disabledTools renders its switch unchecked, "Off"', () => {
    const existing = summary({
      transport: 'mcp',
      tools: [{ name: 'create_issue', write: true, description: 'Create an issue' }],
      disabledTools: ['create_issue'],
      lastTestAt: CTX.now
    })
    const html = renderConnectionDrawerHtml({ ...HUBSPOT_ENTRY, transport: 'mcp' }, { tiers: [], groups: [], existing, activeTab: 'tools' })
    expect(html).toContain(`<input type="checkbox" data-connector-tool-toggle="${existing.id}" data-connector-tool-name="create_issue" aria-label="create_issue disabled">`)
    expect(html).toContain('>Off<')
  })

  it('the Tools tab shows a REST connection\'s real phase-1 adapter tool set too, not just MCP-discovered ones', () => {
    const existing = summary({ kind: 'hubspot', transport: 'rest', tools: null })
    const html = renderConnectionDrawerHtml(HUBSPOT_ENTRY, { tiers: [], groups: [], existing, activeTab: 'tools' })
    expect(html).not.toContain('not discovered MCP tools')
    expect(html).toContain('list_contacts')
    expect(html).toContain('create_contact')
  })

  it('the Scope tab starts with the honest "no change" preview line', () => {
    const existing = summary()
    const html = renderConnectionDrawerHtml(HUBSPOT_ENTRY, { tiers: [{ id: 'metis', label: 'Métis' }], groups: [], existing, activeTab: 'scope' })
    expect(html).toContain('data-scope-preview')
    expect(html).toContain('No change to who has access.')
  })

  it('the Danger tab states real grantsCount/uses numbers and disables Delete until revoked and unused', () => {
    const existing = summary({ grantsCount: 2, uses: 42 })
    const html = renderConnectionDrawerHtml(HUBSPOT_ENTRY, { tiers: [], groups: [], existing, activeTab: 'danger' })
    expect(html).toContain('2 seats have used it, 42 calls total')
    expect(html).toMatch(/data-connector-delete="int-1"[\s\S]*?Delete|disabled title="Revoke this connection first\."/)
    expect(html).toContain('Revoke this connection first.')
  })

  it('the Danger tab enables Delete once revoked and unused', () => {
    const existing = summary({ status: 'revoked', revokedAt: CTX.now, uses: 0, grantsCount: 0 })
    const html = renderConnectionDrawerHtml(HUBSPOT_ENTRY, { tiers: [], groups: [], existing, activeTab: 'danger' })
    expect(html).toContain(`data-connector-delete="${existing.id}"`)
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
  it('derives 5 connectors (3 connected, 2 failing) from the same seeded rows the QA fixture uses everywhere else, through the real buildDashboard()', async () => {
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

  it('is a thin pass-through onto dashboard.connectors, never a second reimplementation of the query', async () => {
    const fx = await fixtureForConnectors()
    expect(fx.connectors).toBe(fx.dashboard.connectors as unknown as typeof fx.connectors)
  })
})
