/**
 * Connectors page (plan 6.10, 6.10b, 6.10c, task P1.9, dev-connectors deep-brief wave). CRMs, work
 * tools and MCP servers Métis can reach through the Operator: a code-defined catalog
 * (operator/src/connectors/catalog.ts, `publicConnectorCatalog()`) rendered statically on first
 * paint, a status strip and a "Needs attention" / "Connected" pair of blocks that now also render
 * on first paint from real data, and a connection drawer with tabs for an existing connection.
 *
 * Architecture note (plan 6.10c, "extending the pattern Licenses already uses to Connectors" --
 * Groups does NOT do this yet, see render/pages/groups.ts's own doc comment): operator/src/
 * dashboard.ts's DashboardPayload now carries a real `connectors: IntegrationSummary[]` field,
 * read from the exact same D1 query `GET /v1/admin/integrations` already runs
 * (`integrationSummary()`, pulled out to operator/src/connectors/summary.ts so both this route and
 * `buildDashboard()` share one implementation without pulling routes/integrations.ts's Worker-only
 * imports -- crypto, vault, the probe's SSRF-guarded fetch -- into the client bundle; see that
 * module's doc comment). `renderConnectors()` below therefore renders the Needs attention and
 * Connected blocks for real on first paint, no skeleton, no client fetch: the client
 * (operator/client/pages/connectors.ts) only fetches after a mutation (Test/Save/Rotate/Revoke),
 * never on mount.
 *
 * Wire types below (`ConnectorSummary`, `ConnectorProbeResult`, ...) mirror
 * operator/src/connectors/summary.ts's `IntegrationSummary` / `ProbeResult` (operator/src/
 * connectors/probe.ts) field for field, so a change to either shape is a compile error here rather
 * than a silent drift -- the same discipline groups.ts's `GroupListRow` etc. already establish. They
 * are independently defined (not imported from connectors/summary.ts) so this page module -- which
 * the client bundle pulls in directly -- never gains a dependency on that module's own imports
 * beyond what it already needs.
 *
 * Security note: an existing connection's credential is never re-displayed, not even masked as
 * dots tied to a real length -- the drawer shows only "stored, ****last4" and points at Rotate to
 * replace it. A new connection's credential field is `type="password"` with a reveal toggle
 * (crossfade dots to text, plan 3.5b) exactly like operator/src/render/pages/keys.ts's Add form.
 *
 * Scope notes (said here, and in the task report, per the brief's own instruction not to skip
 * silently):
 *  - The status strip's "Calls 24h" cell the brief lists does not render. `mcp_calls` (task B3) is
 *    only reachable through `ctx.env.DB` inside a route handler (connectors/mcp-calls.ts); `
 *    buildDashboard()` only ever receives the abstract `OperatorStore`, with no D1 handle, and this
 *    task's one sanctioned additive change to DashboardPayload is `connectors` alone. Rather than
 *    widen buildDashboard()'s signature (a second shared-file change beyond what was scoped) or
 *    fabricate the number, the cell is omitted -- exactly the brief's own rule: "so it is either
 *    the real number or the cell doesn't render." The drawer's own Activity tab, which runs inside
 *    a real route with `ctx.env.DB`, does show real per-connection call data.
 *  - For the exact same reason, the Connected table's "Used" column (`usedCell()` below) shows the
 *    integrations row's own lifetime `uses` count and `last_used_at` timestamp, not the brief's
 *    "calls 7 d, last seat" -- a rolling 7-day window and the identity of the seat that last called
 *    it both live in `mcp_calls`, unreachable from `buildDashboard()`'s `OperatorStore` the same way
 *    "Calls 24h" is. The cell's own tooltip says "since it was added" precisely so it never claims a
 *    7-day window it cannot back; the drawer's Activity tab is again where the real per-call, per-
 *    seat numbers live.
 *  - The catalog's sticky filter row (block 7) pairs the category `segmented()` chips (rendered
 *    here) with the ONE toolbar search this page now has (block 4) rather than a second, duplicate
 *    search input: item 4 already states the toolbar search "filters catalog tiles + both blocks
 *    below," so a second `toolbarSearch()` instance inside the catalog card would either duplicate
 *    the `id="connectors-search"` DOM id or need a second one filtering the same tiles twice.
 */
import type { DashboardPayload } from '../../dashboard'
import { getConnectorCatalogEntry, getConnectorRestTools, publicConnectorCatalog, type ConnectorField, type ConnectorRestTool, type PublicConnectorCatalogEntry } from '../../connectors/catalog'
import {
  alertBadge,
  catalogTile,
  chip,
  connectionDrawer,
  dataTable,
  dialog,
  esc,
  logoGlyph,
  pageHeader,
  relativeTime,
  segmented,
  sourceTooltip,
  statusDot,
  tabs,
  timeCell,
  toolbar,
  toolbarSearch,
  tooltip,
  type CatalogTileState,
  type ChipTone,
  type DataTableRow,
  type DetailField,
  type RenderCtx,
  type StatusDotState
} from '../index'
import { connectorGroup, type ConnectorRow } from '../connectors-list'

// ---------------------------------------------------------------------------
// Wire types -- mirror operator/src/connectors/summary.ts's IntegrationSummary and
// operator/src/connectors/probe.ts's ProbeResult exactly.
// ---------------------------------------------------------------------------

export type ConnectorHealth = 'connected' | 'failing' | 'untested'
export type ConnectorMode = 'brokered' | 'direct'

export interface ConnectorToolInfo {
  name: string
  description?: string
  write: boolean
}

export interface ConnectorProbeResult {
  ok: boolean
  status?: number
  latencyMs: number
  summary: string
  tools?: ConnectorToolInfo[]
  error?: { code: string; message: string }
}

export interface ConnectorScope {
  tiers?: string[]
  groups?: string[]
}

export interface ConnectorSummary {
  id: string
  kind: string
  label: string
  baseUrl: string | null
  last4: string | null
  status: string
  health: ConnectorHealth
  transport: string | null
  authKind: string | null
  headerName: string | null
  mode: ConnectorMode
  allowWrites: boolean
  scope: ConnectorScope
  notes: string | null
  tools: ConnectorToolInfo[] | null
  disabledTools: string[]
  lastTest: ConnectorProbeResult | null
  lastTestAt: number | null
  uses: number
  lastUsedAt: number | null
  grantsCount: number
  createdAt: number
  createdBy: string | null
  rotatedAt: number | null
  revokedAt: number | null
}

/** GET /v1/admin/integrations/:id/activity.json's wire shape (drawer Activity tab only). */
export interface ConnectorActivityRow {
  ts: number
  tool: string
  hostname: string | null
  email: string | null
  deviceShort: string
  ms: number
  outcome: string
}

export interface ConnectorActivityPayload {
  ok: boolean
  available: boolean
  rows: ConnectorActivityRow[]
  toolCounts: { tool: string; calls: number }[]
  sparkline: { ts: number; calls: number; errors: number }[]
}

export interface TierOption {
  id: string
  label: string
  /** Seats currently resolving to this tier (`GET /v1/admin/tiers`'s own `seats` field). Powers the
   *  Scope tab's live "adds/removes access for N seats" preview (plan 6.10c). Omitted (not zero)
   *  before that route has answered -- the preview then reads its count as 0 rather than guessing. */
  seats?: number
}

export interface GroupOption {
  id: string
  name: string
  /** Members of this group (`GET /v1/admin/groups`'s own `members` field), the same seat-count
   *  proxy the Scope tab preview uses for a group. */
  members?: number
}

/** Shown until GET /v1/admin/tiers answers (mirrors groups.ts's own DEFAULT_TIER_OPTIONS fallback;
 *  not imported from that page so the two pages stay disjoint per this task's file ownership). */
export const FALLBACK_TIER_OPTIONS: TierOption[] = [
  { id: 'metis', label: 'Métis' },
  { id: 'metis-light', label: 'Métis Light' }
]

// ---------------------------------------------------------------------------
// Category grouping (plan 6.10c: catalog filter chips, counted live).
// ---------------------------------------------------------------------------

const CATEGORY_ORDER: readonly string[] = ['crm', 'work', 'support', 'knowledge', 'dev', 'comms', 'custom']
const CATEGORY_LABEL: Record<string, string> = {
  crm: 'CRM',
  work: 'Work management',
  support: 'Support',
  knowledge: 'Knowledge',
  dev: 'Dev',
  comms: 'Comms',
  custom: 'Custom'
}

function categoryLabel(id: string): string {
  return CATEGORY_LABEL[id] || id
}

function orderedCategories(catalog: PublicConnectorCatalogEntry[]): string[] {
  const seen = new Set<string>(catalog.map((e) => e.category))
  return [...CATEGORY_ORDER, ...[...seen].filter((c) => !CATEGORY_ORDER.includes(c))].filter((c) => seen.has(c))
}

export function catalogByKind(catalog: PublicConnectorCatalogEntry[]): Record<string, PublicConnectorCatalogEntry> {
  const by: Record<string, PublicConnectorCatalogEntry> = {}
  for (const entry of catalog) by[entry.kind] = entry
  return by
}

// A handful of alias keywords beyond label/kind/category (plan 6.10: "'deals' finds HubSpot").
// Not exhaustive over all 28 kinds by design -- these are the searches Tony is actually likely to
// type; a kind with no alias below still matches on its own label, kind and category.
const CATALOG_ALIASES: Record<string, string> = {
  hubspot: 'deals pipeline',
  pipedrive: 'deals pipeline',
  salesforce: 'deals pipeline',
  attio: 'deals pipeline',
  close: 'deals pipeline',
  zoho: 'deals pipeline',
  dynamics365: 'deals pipeline',
  clickup: 'tasks tickets project',
  jira: 'tickets tasks issues',
  asana: 'tasks project',
  trello: 'tasks board',
  monday: 'tasks project',
  linear: 'issues tickets',
  plane: 'issues tickets tasks',
  notion: 'docs wiki knowledge',
  confluence: 'docs wiki knowledge',
  sharepoint: 'docs wiki files',
  googledrive: 'docs files storage',
  airtable: 'database spreadsheet',
  github: 'git code repos',
  gitlab: 'git code repos',
  slack: 'chat messaging',
  microsoftteams: 'chat messaging',
  zendesk: 'tickets support helpdesk',
  intercom: 'chat support helpdesk',
  freshdesk: 'tickets support helpdesk'
}

// ---------------------------------------------------------------------------
// Catalog grid (static, code-derived -- no fetch, no loading state needed).
// ---------------------------------------------------------------------------

function tileHaystack(entry: PublicConnectorCatalogEntry): string {
  const alias = CATALOG_ALIASES[entry.kind] || ''
  return `${entry.label} ${entry.kind} ${categoryLabel(entry.category)} ${alias}`.toLowerCase()
}

/** plan 6.10c: "add a per-kind connection count computed from the same ConnectorSummary[] now on
 *  the page, pass state:'connected' + connections:N" -- this is the literal fix for `tileState()`
 *  previously never returning 'connected' at all. `failingCount` (of that same kind's active
 *  connections) takes priority: a kind whose only connection(s) are all currently failing is
 *  `'failing'`, never a plain `'connected'` indistinguishable from a healthy one (plan 6.10b's
 *  emerald/rose/amber status vocabulary, which every other status indicator on this page follows). */
function tileState(entry: PublicConnectorCatalogEntry, connectionCount: number, failingCount: number): CatalogTileState {
  if (failingCount > 0) return 'failing'
  if (connectionCount > 0) return 'connected'
  return entry.availability === 'needs-oauth' ? 'needs-oauth' : 'ready'
}

function renderCatalogTile(entry: PublicConnectorCatalogEntry, connectionCount: number, failingCount: number = 0): string {
  const state = tileState(entry, connectionCount, failingCount)
  return catalogTile({
    kind: entry.kind,
    label: entry.label,
    transport: entry.transport,
    state,
    connections: (state === 'failing' ? failingCount : connectionCount) || undefined,
    // 25ms cadence (plan 3.5b Connectors row: "stagger in by category 25ms"). Tiles are ordered by
    // category below, so a flat 25ms stagger across the one grid reads as a category-by-category
    // cascade without motion-bind.ts needing any per-category grouping of its own.
    attrs: `data-q="${esc(tileHaystack(entry))}" data-category="${esc(entry.category)}" data-stagger data-stagger-ms="25"`
  })
}

/**
 * plan 6.10c: "Remove renderCatalogGrid()'s per-category <section>/<p class="eyebrow"> wrapper
 * entirely... Replace with... ONE flat <div class="catalog-tile-grid"> with every catalogTile()
 * rendered unconditionally." Category becomes a data attribute + client filter state; the DOM is
 * always complete (every kind, JS disabled or not), filtering only ever toggles [hidden].
 */
export function renderCatalogGrid(
  catalog: PublicConnectorCatalogEntry[],
  connectionCounts: Record<string, number> = {},
  failingCounts: Record<string, number> = {}
): string {
  const ordered = orderedCategories(catalog)
  const byCategory = new Map<string, PublicConnectorCatalogEntry[]>()
  for (const entry of catalog) {
    const list = byCategory.get(entry.category) ?? []
    list.push(entry)
    byCategory.set(entry.category, list)
  }
  const tiles = ordered
    .flatMap((cat) => byCategory.get(cat) ?? [])
    .map((e) => renderCatalogTile(e, connectionCounts[e.kind] ?? 0, failingCounts[e.kind] ?? 0))
    .join('')
  return `<div class="catalog-tile-grid" data-tile-grid data-connectors-catalog>${tiles}</div>`
}

/** Category chip row (plan 6.10c block 7): segmented() with live counts, "All" default, computed
 *  at render time from the catalog itself -- never hardcoded, so a catalog addition is reflected
 *  the moment it ships with no second number to keep in sync. */
export function renderCatalogFilterRow(catalog: PublicConnectorCatalogEntry[]): string {
  const ordered = orderedCategories(catalog)
  const counts = new Map<string, number>()
  for (const entry of catalog) counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1)
  const items = [
    { id: 'all', label: `All ${catalog.length}`, active: true },
    ...ordered.map((c) => ({ id: c, label: `${categoryLabel(c)} ${counts.get(c) ?? 0}`, active: false }))
  ]
  return `<div class="connectors-catalog-filters">${segmented({ items, attrs: 'data-connectors-category-filter' })}</div>`
}

// ---------------------------------------------------------------------------
// Status strip (plan 6.10c: "the page opens on a status strip that answers 'is anything wrong'
// before any scrolling"). Every cell is a real DashboardPayload-derived number or it does not
// render (see this file's top comment for "Calls 24h").
// ---------------------------------------------------------------------------

/** `text: true` marks a cell whose value is a sentence, not a number ("Slowest" names a connector
 *  and a latency, not a bare count) -- plan 3.3's KPI-numeral type (Space Grotesk, 18px bold here)
 *  is for the numeral KPIs (Connections, Healthy, Failing, Never tested) this strip is otherwise
 *  full of; applied to a sentence it does not fit its tile at that size and wraps to a second
 *  line, making that one tile visibly taller than its four siblings and breaking the strip's
 *  shared baseline. A text value instead gets ordinary label type, sized to actually fit, with
 *  `overflow-x: auto` never wrap so the tile's height always matches its neighbours, and a
 *  `title` carrying the full sentence for whatever the visible width elides. */
function statusCellHtml(opts: { label: string; value: string; formula: string; source: string; danger?: boolean; attrs?: string; text?: boolean }): string {
  const toneClass = opts.danger ? ' connectors-status-cell-danger' : ''
  const valueClass = opts.text ? 'connectors-status-value connectors-status-value-text' : 'connectors-status-value mono'
  const titleAttr = opts.text ? ` title="${esc(opts.value)}"` : ''
  return `<button type="button" class="connectors-status-cell${toneClass}" ${opts.attrs || ''}>
    <span class="connectors-status-label">${esc(opts.label)}${sourceTooltip(opts.formula, opts.source)}</span>
    <span class="${valueClass}"${titleAttr}>${esc(opts.value)}</span>
  </button>`
}

/** The connection with the largest latency among tests that actually passed (plan 6.10c, lock 3:
 *  "one probe stored per connection, so this is 'last latency', not a fabricated median across
 *  many" -- a failed test's latency is usually just the timeout ceiling, not a meaningful speed
 *  signal, so only passing tests compete for "slowest"). */
function slowestPassingConnector(rows: ConnectorSummary[]): ConnectorSummary | null {
  const passing = rows.filter((r) => r.status === 'active' && r.lastTest?.ok === true && r.lastTestAt != null)
  if (!passing.length) return null
  return passing.reduce((slowest, r) => (r.lastTest!.latencyMs > slowest.lastTest!.latencyMs ? r : slowest))
}

export function renderStatusStrip(rows: ConnectorSummary[]): string {
  const active = rows.filter((r) => r.status === 'active')
  const healthy = active.filter((r) => r.health === 'connected')
  const failing = active.filter((r) => r.health === 'failing')
  const untested = active.filter((r) => r.health === 'untested')
  const slowest = slowestPassingConnector(rows)

  const cells: string[] = [
    statusCellHtml({
      label: 'Connections',
      value: String(active.length),
      formula: 'Active connections right now',
      source: 'integrations table, status active',
      attrs: 'data-status-filter="all"'
    }),
    statusCellHtml({
      label: 'Healthy',
      value: String(healthy.length),
      formula: "Connections whose last test passed",
      source: 'integrations table, last_test_json',
      attrs: 'data-status-filter="connected"'
    })
  ]
  if (failing.length > 0) {
    cells.push(
      statusCellHtml({
        label: 'Failing',
        value: String(failing.length),
        formula: 'Connections whose last test failed',
        source: 'integrations table, last_test_json',
        danger: true,
        attrs: 'data-status-filter="failing"'
      })
    )
  }
  cells.push(
    statusCellHtml({
      label: 'Never tested',
      value: String(untested.length),
      formula: 'Connections with no stored test result yet',
      source: 'integrations table, last_test_at',
      attrs: 'data-status-filter="untested"'
    })
  )
  cells.push(
    slowest && slowest.lastTest
      ? statusCellHtml({
          label: 'Slowest (last test)',
          value: `${slowest.label} · ${slowest.lastTest.latencyMs} ms`,
          formula: 'The slowest connection among tests that passed (one probe stored per connection: its own last latency, not a computed median)',
          source: 'integrations table, last_test_json',
          attrs: `data-connector-scroll-to="${esc(slowest.id)}"`,
          text: true
        })
      : statusCellHtml({
          label: 'Slowest (last test)',
          value: 'Not tested yet',
          text: true,
          formula: 'The slowest connection among tests that passed',
          source: 'integrations table, last_test_json'
        })
  )
  return `<article class="card connectors-status-strip" data-connectors-status-strip>${cells.join('')}</article>`
}

/** plan 6.10c: "a Danger banner ... rendered ONLY when failing > 0 ... Absent entirely (not hidden,
 *  not rendered) when failing = 0." */
export function renderDangerBanner(failingCount: number): string {
  if (failingCount <= 0) return ''
  const isOne = failingCount === 1
  const label = `${failingCount} connector${isOne ? '' : 's'} ${isOne ? 'is' : 'are'} failing. Seats using ${isOne ? 'it get' : 'them get'} no data until fixed.`
  return `<div class="connectors-danger-banner">${alertBadge({
    variant: 'danger',
    label,
    action: { label: 'Needs attention', href: '#connectors-needs-attention', attrs: 'data-connectors-scroll-attention' }
  })}</div>`
}

// ---------------------------------------------------------------------------
// Needs attention (plan 6.10b/6.10c): a connectorGroup() built from real failing connections.
// ---------------------------------------------------------------------------

/** "401 unauthorized, since 2h ago" (plan 6.10c) -- the real redacted upstream message, trailing
 *  period stripped so the ", since X ago" clause reads as one sentence, plus age; never the
 *  generic "Test failed." */
function failingReason(row: ConnectorSummary, now: number): string {
  const raw = row.lastTest?.error?.message || row.lastTest?.summary || 'Test failed'
  const message = raw.replace(/\.+\s*$/, '')
  if (row.lastTestAt == null) return message
  return `${message}, since ${relativeTime(row.lastTestAt, now)} ago`
}

export function needsAttentionRows(rows: ConnectorSummary[], now: number): ConnectorRow[] {
  return rows
    .filter((r) => r.status === 'active' && r.health === 'failing')
    .sort((a, b) => (b.lastTestAt ?? 0) - (a.lastTestAt ?? 0))
    .map((r) => ({
      id: r.id,
      kind: r.kind,
      label: r.label,
      transport: r.transport === 'mcp' ? 'mcp' : 'rest',
      status: 'attention',
      action: 'Fix',
      auth: r.authKind || 'bearer',
      reason: failingReason(r, now)
    }))
}

/** plan 6.10c: "visibleLimit uncapped to 8 ... higher than Connected's default 5, because a failing
 *  row must never be one click from hidden. Empty renders nothing." */
export function renderNeedsAttention(rows: ConnectorSummary[], now: number): string {
  const attention = needsAttentionRows(rows, now)
  if (!attention.length) return ''
  return `<div id="connectors-needs-attention">${connectorGroup('Needs attention', attention, { visibleLimit: 8 })}</div>`
}

// ---------------------------------------------------------------------------
// Connected table (plan 6.10 block 1 / 6.10c block 6, "hidden when empty").
// ---------------------------------------------------------------------------

function healthMeta(health: ConnectorHealth): { state: StatusDotState; label: string } {
  if (health === 'connected') return { state: 'live', label: 'Connected' }
  if (health === 'failing') return { state: 'failed', label: 'Failing' }
  return { state: 'pending', label: 'Untested' }
}

const TIER_LABEL: Record<string, string> = { metis: 'Métis', 'metis-light': 'Métis Light' }

function scopeChipsHtml(scope: ConnectorScope, groupNameById: Record<string, string>): string {
  const tierChips = (scope.tiers || []).map((t) => chip({ label: TIER_LABEL[t] || t }))
  // `data-group-id` lets operator/client/pages/connectors.ts fill in the real name once
  // GET /v1/admin/groups answers (DashboardPayload carries no group data -- render/pages/groups.ts's
  // own doc comment -- so first paint honestly shows the id itself rather than a fabricated name).
  const groupChips = (scope.groups || []).map((g) =>
    chip({ label: groupNameById[g] || g, tone: 'accent' as ChipTone, attrs: `data-group-id="${esc(g)}"` })
  )
  const all = [...tierChips, ...groupChips]
  if (!all.length) return '<span class="muted">Everyone</span>'
  return `<div class="connector-scope-chips">${all.join('')}</div>`
}

function transportCell(transport: string | null): string {
  if (!transport) return '<span class="muted">Not reported</span>'
  return chip({ label: transport === 'mcp' ? 'MCP' : 'API' })
}

function modeCell(mode: ConnectorMode): string {
  return chip({ label: mode === 'direct' ? 'Direct' : 'Brokered', tone: mode === 'direct' ? 'warn' : 'default' })
}

function statusCell(row: ConnectorSummary, now: number): string {
  const meta = healthMeta(row.health)
  const dot = statusDot(meta)
  if (!row.lastTestAt || !row.lastTest) {
    return `<div class="connector-status-cell">${dot}<span class="muted">Never tested</span></div>`
  }
  const rel = relativeTime(row.lastTestAt, now)
  const absolute = new Date(row.lastTestAt).toISOString().replace('T', ' ').slice(0, 19)
  const outcome = row.lastTest.ok ? 'Passed' : 'Failed'
  const reason = row.lastTest.ok ? row.lastTest.summary : row.lastTest.error?.message || row.lastTest.summary
  const detail = `${outcome}: ${reason} (${row.lastTest.latencyMs} ms), tested ${absolute} UTC`
  const inner = `<span class="connector-last-test">tested ${esc(rel)} ago</span>`
  return `<div class="connector-status-cell">${dot}${tooltip(inner, detail)}</div>`
}

/** A row's tool set for display: real discovered/live `row.tools` when present (an MCP
 *  handshake's `tools/list`), else the phase-1 REST adapter's static tool set for `row.kind` when
 *  one has shipped (plan D8; `catalog.ts`'s `getConnectorRestTools()`). `null` means genuinely no
 *  known tool set -- an untested/toolless MCP row, or a REST kind with no adapter yet -- not "REST
 *  therefore nothing," which previously hid HubSpot's and ClickUp's real brokered tools. */
function resolvedTools(row: ConnectorSummary): (ConnectorToolInfo | ConnectorRestTool)[] | null {
  if (row.tools && row.tools.length) return row.tools
  return getConnectorRestTools(row.kind)
}

function toolsCell(row: ConnectorSummary): string {
  const tools = resolvedTools(row)
  if (!tools || !tools.length) {
    if (row.transport !== 'mcp') return '<span class="muted">Not applicable</span>'
    return row.lastTestAt == null
      ? '<span class="muted">Not tested yet</span>'
      : '<span class="muted">No tools reported</span>'
  }
  const count = tools.length
  const items = tools
    .map(
      (t) =>
        `<li>${esc(t.name)}${chip({ label: t.write ? 'write' : 'read', tone: t.write ? 'warn' : 'ok' })}</li>`
    )
    .join('')
  return `<div class="connector-tools-cell">
    <button type="button" class="tool connector-tools-toggle" data-tools-toggle="${esc(row.id)}" aria-expanded="false">${count} tool${count === 1 ? '' : 's'}</button>
    <ul class="connector-tools-list" data-tools-list="${esc(row.id)}" hidden>${items}</ul>
  </div>`
}

function usedCell(row: ConnectorSummary, now: number): string {
  const tip = sourceTooltip('Calls this connector has handled since it was added', 'integrations table, lifetime count')
  if (!row.uses) return `<span class="muted">Not used yet</span>${tip}`
  const last =
    row.lastUsedAt != null
      ? `<span class="connector-used-sep" aria-hidden="true">·</span><span class="connector-used-last">${timeCell(row.lastUsedAt, now)}</span>`
      : ''
  return `<div class="connector-used-cell"><span>${row.uses} call${row.uses === 1 ? '' : 's'}</span>${last}</div>${tip}`
}

function actionsCell(row: ConnectorSummary): string {
  if (row.status !== 'active') return '<span class="muted">Revoked</span>'
  return `<div class="row connector-row-actions">
    <button type="button" class="tool" data-connector-test="${esc(row.id)}">Test</button>
    <button type="button" class="tool danger" data-connector-revoke="${esc(row.id)}" data-connector-revoke-label="${esc(row.label)}">Revoke</button>
  </div>`
}

function selectCell(row: ConnectorSummary): string {
  return `<input type="checkbox" class="connector-select-check" data-connector-select="${esc(row.id)}" aria-label="Select ${esc(row.label)}">`
}

function connectorNameCell(row: ConnectorSummary, catalog: Record<string, PublicConnectorCatalogEntry>): string {
  const known = catalog[row.kind]
  const altLabel = known?.label || row.label
  return `<div class="connector-name-cell">${logoGlyph(row.kind, altLabel, { size: 24 })}<div><strong>${esc(row.label)}</strong>${
    row.last4 ? `<span class="connector-last4 mono">••${esc(row.last4)}</span>` : ''
  }</div></div>`
}

function kindCell(row: ConnectorSummary, catalog: Record<string, PublicConnectorCatalogEntry>): string {
  const label = catalog[row.kind]?.label || row.kind
  return `<span class="connector-kind-cell">${esc(label)}</span>`
}

const CONNECTED_COLUMNS: { key: string; label: string }[] = [
  { key: 'select', label: '' },
  { key: 'connector', label: 'Connector' },
  { key: 'kind', label: 'Kind' },
  { key: 'transport', label: 'Transport' },
  { key: 'mode', label: 'Mode' },
  { key: 'scope', label: 'Scope' },
  { key: 'status', label: 'Status' },
  { key: 'tools', label: 'Tools' },
  { key: 'used', label: 'Used' },
  { key: 'actions', label: '' }
]

/** Rows past this many stay in the DOM, `hidden`, behind "Show N more" (plan 6.10c: "Cap at 8
 *  visible rows with 'Show 4 more' past that, law 10"). */
const CONNECTED_VISIBLE_CAP = 8

function connectedRowCells(
  row: ConnectorSummary,
  now: number,
  catalog: Record<string, PublicConnectorCatalogEntry>,
  groupNameById: Record<string, string>
): Record<string, string> {
  return {
    select: selectCell(row),
    connector: connectorNameCell(row, catalog),
    kind: kindCell(row, catalog),
    transport: transportCell(row.transport),
    mode: modeCell(row.mode),
    scope: scopeChipsHtml(row.scope, groupNameById),
    status: statusCell(row, now),
    tools: toolsCell(row),
    used: usedCell(row, now),
    actions: actionsCell(row)
  }
}

function connectedRowAttrs(row: ConnectorSummary, opts: { history?: boolean; overflow?: boolean }): string {
  const extra = opts.history ? ' hidden data-connector-history-row' : opts.overflow ? ' hidden data-connector-overflow-row' : ''
  // 35ms, distinct from the sitewide default 40ms motion-bind.ts falls back to (plan 3.5b names
  // 25ms for catalog tiles and 30ms, connectors-list.ts, for Needs attention rows -- Connected
  // rows get their own third value so this table's stagger group is never shared with every other
  // page's default-cadence elements, which would otherwise inherit that group's full sitewide
  // index and, on a direct #connectors boot (or any earlier page's client init throwing before
  // this page's own re-bind runs), sit at opacity 0 far longer than intended).
  return `data-connector-row="${esc(row.id)}" data-connector-kind="${esc(row.kind)}" data-connector-health="${esc(row.health)}" data-stagger-ms="35" role="button" tabindex="0" aria-label="Open ${esc(row.label)}"${extra}`
}

/** One `<tr>` in the exact shape renderConnectedTable() below produces, for FLIP-inserting a
 *  freshly-saved connection (plan 3.5b: "the Connected table inserts the row with FLIP") without
 *  redrawing rows that were already there. */
export function renderConnectorRowHtml(
  row: ConnectorSummary,
  now: number,
  catalog: Record<string, PublicConnectorCatalogEntry>,
  groupNameById: Record<string, string>
): string {
  const cells = connectedRowCells(row, now, catalog, groupNameById)
  const tds = CONNECTED_COLUMNS.map((c) => `<td>${cells[c.key] ?? ''}</td>`).join('')
  return `<tr class="connectors-table-row" data-stagger ${connectedRowAttrs(row, {})}>${tds}</tr>`
}

export interface ConnectedTableResult {
  html: string
  activeCount: number
  historyCount: number
  overflowCount: number
}

/** Exported so this module's tests and operator/client/pages/connectors.ts render the table from
 *  the exact same function (plan D2). Active (status "active") connections sort newest first;
 *  revoked ones collapse under a "Show history" toggle, same convention as operator/src/render/
 *  pages/keys.ts's vault table; active rows past CONNECTED_VISIBLE_CAP collapse under "Show N more"
 *  (plan 6.10c, law 10).
 *
 *  Row class is `connectors-table-row`, deliberately not the shared `connector-row` class
 *  operator/src/render/connectors-list.ts's connectorRow() primitive already owns (56px flex div
 *  rows for the Needs attention / Overview card blocks) -- operator/src/spa/css.ts's `.connector-row`
 *  rule (`display:flex; height:56px`) would otherwise apply to this table's `<tr>` elements too,
 *  the same class reused for two structurally different rows.
 */
export function renderConnectedTable(
  rows: ConnectorSummary[],
  now: number,
  catalog: Record<string, PublicConnectorCatalogEntry>,
  groupNameById: Record<string, string>
): ConnectedTableResult {
  const active = rows.filter((r) => r.status === 'active').sort((a, b) => b.createdAt - a.createdAt)
  const history = rows
    .filter((r) => r.status !== 'active')
    .sort((a, b) => (b.revokedAt ?? b.createdAt) - (a.revokedAt ?? a.createdAt))
  const dataRows: DataTableRow[] = [
    ...active.map((r, i) => ({ cells: connectedRowCells(r, now, catalog, groupNameById), attrs: connectedRowAttrs(r, { overflow: i >= CONNECTED_VISIBLE_CAP }) })),
    ...history.map((r) => ({ cells: connectedRowCells(r, now, catalog, groupNameById), attrs: connectedRowAttrs(r, { history: true }) }))
  ]
  const html = dataTable({
    columns: CONNECTED_COLUMNS,
    rows: dataRows,
    emptyTitle: 'No connectors yet.',
    emptyDescription: 'Connect a CRM, a work tool or an MCP server from the catalog below.',
    id: 'connectors-table',
    rowClass: 'connectors-table-row',
    variant: 'card'
  })
  return { html, activeCount: active.length, historyCount: history.length, overflowCount: Math.max(0, active.length - CONNECTED_VISIBLE_CAP) }
}

export function renderHistoryToggle(count: number): string {
  if (count <= 0) return ''
  return `<button type="button" class="tool connectors-history-toggle" data-connectors-history-toggle aria-expanded="false" data-show-label="Show history (${count})" data-hide-label="Hide history">Show history (${count})</button>`
}

export function renderConnectedOverflowToggle(count: number): string {
  if (count <= 0) return ''
  return `<button type="button" class="tool connectors-overflow-toggle" data-connectors-overflow-toggle aria-expanded="false" data-show-label="Show ${count} more" data-hide-label="Show fewer">Show ${count} more</button>`
}

// ---------------------------------------------------------------------------
// Toolbar (plan 6.10c block 4): search, the active status-strip filter chip when set, Select.
// ---------------------------------------------------------------------------

function connectorsToolbarHtml(): string {
  const left = `${toolbarSearch({ id: 'connectors-search', placeholder: 'Search connectors' })}<span class="connectors-filter-chip-slot" data-connectors-filter-chip-slot></span>`
  const right = `<button type="button" class="tool" data-connectors-select-toggle aria-pressed="false">Select</button>`
  return toolbar({ left, right })
}

/** Bulk footer bar (plan 6.10c block 4: "appearing as a footer bar naming every affected
 *  connection by label before running, never inline in the resting toolbar"). Hidden until Select
 *  mode is on and at least one row is checked; operator/client/pages/connectors.ts fills the
 *  naming text and wires Re-test / Re-scope / Revoke onto the same per-connection routes the row
 *  actions already use, looped. */
function bulkBarHtml(tiers: TierOption[], groups: GroupOption[]): string {
  return `<div class="connectors-bulk-bar" data-connectors-bulk-bar hidden>
    <p class="connectors-bulk-text" data-connectors-bulk-text></p>
    <div class="row connectors-bulk-actions">
      <button type="button" class="tool" data-connectors-bulk-retest>Re-test</button>
      <button type="button" class="tool" data-connectors-bulk-rescope aria-expanded="false">Re-scope</button>
      <button type="button" class="tool danger" data-connectors-bulk-revoke>Revoke</button>
      <button type="button" class="tool" data-connectors-bulk-cancel>Cancel</button>
    </div>
    <div class="connectors-bulk-rescope-panel" data-connectors-bulk-rescope-panel hidden>
      ${scopeFieldsHtml(tiers, groups, {}, { previewless: true })}
      <div class="row connectors-bulk-rescope-actions">
        <button type="button" class="tool primary" data-connectors-bulk-rescope-apply>Apply to selected</button>
      </div>
    </div>
  </div>`
}

// ---------------------------------------------------------------------------
// Connection drawer (plan 6.10c: tabs for an existing connection; a flat guided form for a new
// one).
// ---------------------------------------------------------------------------

const AUTH_LABEL: Record<string, string> = {
  bearer: 'Bearer token',
  'api-key-header': 'API key header',
  basic: 'Basic auth',
  'api-key-query': 'API key in the URL',
  none: 'None',
  'oauth2-client-credentials': 'OAuth2 (client credentials)',
  'oauth2-auth-code': 'OAuth2 (authorization code)'
}

function authKindLabel(auth: string): string {
  return AUTH_LABEL[auth] || auth
}

/** `credentialLink` (only ever passed for the `credential` field, from the catalog entry's own
 *  already-vetted `docsUrl` -- see catalog.ts's top comment: every one of those was checked
 *  against the vendor's real documentation) is plan 6.10b/6.10c's "Open <vendor> to create a key"
 *  actionable link: a real `<a target="_blank">`, not the plain breadcrumb-text `help` string
 *  alone, and not the drawer header's generic "Docs" chip (that one is a fixed, always-present
 *  affordance for the whole connection, not specific to this one field). No new URL is invented
 *  here -- `docsUrl` is reused rather than guessing an exact "create a key" sub-page per vendor. */
function fieldInputHtml(field: ConnectorField, credentialLink?: { url: string; vendor: string }): string {
  if (field.key === 'credential') {
    // Worded as "docs", not "create a key": docsUrl is each kind's verified API/auth reference
    // page (catalog.ts), not a hand-checked deep link straight to a "generate token" button for
    // all 20+ kinds -- this stays true to what the link actually opens for every one of them.
    const link = credentialLink
      ? `<a class="connector-field-link" href="${esc(credentialLink.url)}" target="_blank" rel="noopener noreferrer">Open ${esc(credentialLink.vendor)} docs ↗</a>`
      : ''
    const help = field.help ? `<p class="connector-field-help muted">${esc(field.help)}</p>` : ''
    return `<div class="connector-credential-wrap">
      <input type="password" name="credential" id="connector-credential-input" placeholder="${esc(field.placeholder || '')}" ${field.required ? 'required' : ''} autocomplete="off">
      <button type="button" class="tool" data-credential-reveal aria-pressed="false">Show</button>
    </div>${help}${link}`
  }
  const type = field.type === 'url' ? 'url' : 'text'
  return `<input type="${type}" name="cfg_${esc(field.key)}" placeholder="${esc(field.placeholder || '')}" value="${esc(field.default || '')}" ${field.required ? 'required' : ''}>${
    field.help ? `<p class="connector-field-help muted">${esc(field.help)}</p>` : ''
  }`
}

/** plan 6.10c Scope tab: "one live preview sentence above them recomputed on every checkbox change
 *  from tier/group member counts already loaded for the page." Each checkbox carries its own seat
 *  count as `data-count` so operator/client/pages/connectors.ts can recompute the sentence with no
 *  second lookup table; `data-scope-preview` is the placeholder the client fills in on every
 *  change (starts as the honest "no change" line, since nothing has been touched yet). `opts.
 *  previewless` drops that line for the bulk Re-scope panel, whose preview does not make sense
 *  against no single row's current scope. */
export function scopeFieldsHtml(
  tiers: TierOption[],
  groups: GroupOption[],
  selected: ConnectorScope,
  opts: { previewless?: boolean } = {}
): string {
  const selTiers = selected.tiers || []
  const selGroups = selected.groups || []
  const tierBoxes = tiers
    .map(
      (t) =>
        `<label class="connector-scope-check"><input type="checkbox" name="scopeTier" value="${esc(t.id)}" data-count="${t.seats ?? 0}" ${selTiers.includes(t.id) ? 'checked' : ''}> ${esc(t.label)}</label>`
    )
    .join('')
  const groupBoxes = groups.length
    ? groups
        .map(
          (g) =>
            `<label class="connector-scope-check"><input type="checkbox" name="scopeGroup" value="${esc(g.id)}" data-count="${g.members ?? 0}" ${selGroups.includes(g.id) ? 'checked' : ''}> ${esc(g.name)}</label>`
        )
        .join('')
    : '<p class="muted connector-scope-empty">No groups yet.</p>'
  const preview = opts.previewless ? '' : `<p class="connector-scope-preview muted" data-scope-preview>No change to who has access.</p>`
  return `${preview}<div class="connector-scope-grid">
    <div><span class="connector-scope-label">Tiers</span><div class="connector-scope-list" data-scope-tiers>${tierBoxes}</div></div>
    <div><span class="connector-scope-label">Groups</span><div class="connector-scope-list" data-scope-groups>${groupBoxes}</div></div>
    <p class="connector-scope-hint muted">Leave everything unchecked for everyone with the integrations entitlement.</p>
  </div>`
}

function modeFieldHtml(mode: ConnectorMode): string {
  return `<div class="connector-mode-grid">
    <label class="connector-mode-option"><span class="row"><input type="radio" name="mode" value="brokered" ${mode !== 'direct' ? 'checked' : ''}> Brokered</span><span class="connector-mode-desc muted">The Operator holds the credential and calls the provider on the seat's behalf. Recommended.</span></label>
    <label class="connector-mode-option"><span class="row"><input type="radio" name="mode" value="direct" ${mode === 'direct' ? 'checked' : ''}> Direct</span><span class="connector-mode-desc muted">The seat will hold this credential in memory until restart.</span></label>
  </div>`
}

/** Result card for a Test connection run (plan 3.5b: "the result card slides in; the tool list
 *  reveals row by row; read/write marks pop"). `data-stagger` on each tool row lets bindMotion()
 *  play that reveal the moment this markup is inserted. */
export function renderProbeResultCard(result: ConnectorProbeResult): string {
  const dot = statusDot(result.ok ? { state: 'live', label: 'Passed' } : { state: 'failed', label: 'Failed' })
  const toolsHtml =
    result.tools && result.tools.length
      ? `<ul class="connector-test-tools">${result.tools
          .map((t) => `<li data-stagger><span class="connector-tool-name">${esc(t.name)}</span>${chip({ label: t.write ? 'write' : 'read', tone: t.write ? 'warn' : 'ok' })}</li>`)
          .join('')}</ul>`
      : ''
  const error = !result.ok && result.error ? `<p class="connector-test-error">${esc(result.error.message)}</p>` : ''
  return `<div class="connector-result-card">
    <div class="connector-result-head">${dot}<span class="connector-result-latency mono">${result.latencyMs} ms</span></div>
    <p class="connector-result-summary">${esc(result.summary)}</p>
    ${error}
    ${toolsHtml}
  </div>`
}

function newConnectionFooterHtml(): string {
  return `<div class="connector-drawer-actions">
    <button type="button" class="btn" data-connector-test>Test connection</button>
    <button type="button" class="primary" data-connector-save disabled>Save</button>
  </div>
  <div class="connector-test-result" data-connector-test-result hidden></div>`
}

/** Test + Save only (plan 6.10c: Rotate/Revoke/Delete move into the Danger tab panel, where their
 *  real consequences -- grants, uses, "revoke first" -- are stated next to the button, rather than
 *  living in a footer with no room for that text). Save starts disabled: the Scope tab's own script
 *  enables it only once a tier, group or mode checkbox actually differs from what the row was
 *  opened with (plan 6.10c: "Save disabled until something actually changed"). */
function existingConnectionFooterHtml(row: ConnectorSummary): string {
  return `<div class="connector-drawer-actions">
    <button type="button" class="btn" data-connector-test="${esc(row.id)}">Test connection</button>
    <button type="button" class="primary" data-connector-save="${esc(row.id)}" disabled>Save</button>
  </div>
  <div class="connector-test-result" data-connector-test-result hidden></div>`
}

// ---------------------------------------------------------------------------
// Existing-connection drawer tabs (plan 6.10c: Overview, Tools, Scope, Activity, Danger).
// ---------------------------------------------------------------------------

export type ConnectorDrawerTab = 'overview' | 'tools' | 'scope' | 'activity' | 'danger'
const CONNECTOR_DRAWER_TABS: { id: ConnectorDrawerTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'tools', label: 'Tools' },
  { id: 'scope', label: 'Scope' },
  { id: 'activity', label: 'Activity' },
  { id: 'danger', label: 'Danger' }
]

function scopeSummaryText(scope: ConnectorScope, tiers: TierOption[], groups: GroupOption[]): string {
  const tierNames = (scope.tiers || []).map((id) => tiers.find((t) => t.id === id)?.label || TIER_LABEL[id] || id)
  const groupNames = (scope.groups || []).map((id) => groups.find((g) => g.id === id)?.name || id)
  const names = [...tierNames, ...groupNames]
  return names.length ? names.join(', ') : 'everyone with the integrations entitlement'
}

/** plan 6.10c Overview tab: "one generated sentence stating what a seat can do right now" -- built
 *  entirely from this row's own real fields, never a fabricated capability list. */
function capabilitySentence(row: ConnectorSummary, entry: PublicConnectorCatalogEntry | undefined, tiers: TierOption[], groups: GroupOption[]): string {
  const label = entry?.label || row.label
  if (row.status !== 'active') return `${label} is revoked. No seat can reach it.`
  if (row.health !== 'connected') return `${label} has not passed a test yet. Seats entitled to it get no data until one does.`
  const scopeText = scopeSummaryText(row.scope, tiers, groups)
  const verb =
    row.transport === 'mcp'
      ? row.tools?.length
        ? `use ${row.tools.length} discovered tool${row.tools.length === 1 ? '' : 's'}`
        : 'reach it, once a test discovers its tools'
      : `read from ${label}${row.allowWrites ? ' and write to it' : ''}`
  return `A seat in ${scopeText} can ${verb} through the Operator right now.`
}

function absoluteUtc(ts: number): string {
  return `${new Date(ts).toISOString().replace('T', ' ').slice(0, 19)} UTC`
}

function overviewPanelHtml(row: ConnectorSummary, entry: PublicConnectorCatalogEntry | undefined, tiers: TierOption[], groups: GroupOption[]): string {
  const meta = healthMeta(row.health)
  const healthLine =
    row.lastTestAt != null && row.lastTest
      ? `${statusDot(meta)}<span class="muted">${row.lastTest.ok ? 'Passed' : 'Failed'} · ${row.lastTest.latencyMs} ms · ${absoluteUtc(row.lastTestAt)}</span>`
      : `${statusDot(meta)}<span class="muted">Never tested</span>`
  const directWarn =
    row.mode === 'direct'
      ? `<div class="connector-overview-direct-warn">${alertBadge({ variant: 'warn', label: 'Direct mode: the seat holds this credential in memory until restart.' })}</div>`
      : ''
  const rows: { label: string; value: string }[] = [
    { label: 'Transport', value: transportCell(row.transport) },
    { label: 'Mode', value: modeCell(row.mode) },
    { label: 'Health', value: healthLine },
    { label: 'Created', value: `${timeCell(row.createdAt, Date.now())} by ${esc(row.createdBy || 'operator')}` },
    { label: 'Last rotation', value: row.rotatedAt != null ? timeCell(row.rotatedAt, Date.now()) : '<span class="muted">Never rotated</span>' },
    {
      label: 'Credential',
      value: row.last4
        ? `<span class="mono">stored, ••${esc(row.last4)}</span> <span class="connector-field-help muted">Use Rotate (Danger tab) to replace it.</span>`
        : '<span class="muted">No credential stored.</span>'
    }
  ]
  const grid = rows.map((r) => `<div class="connector-overview-row"><span class="connector-scope-label">${esc(r.label)}</span><span>${r.value}</span></div>`).join('')
  return `${directWarn}<div class="connector-overview-grid">${grid}</div><p class="connector-capability-sentence">${esc(capabilitySentence(row, entry, tiers, groups))}</p>`
}

/** plan 6.10c Tools tab: every discovered tool with a real call-derived read/write mark and a real
 *  per-tool enable switch. Unchecking a tool here PATCHes `disabledTools` (operator/client/pages/
 *  connectors.ts's `handleToolToggleChange`), which `gateway.ts` checks on every `tools/call`
 *  before either dispatch path (REST-adapter or MCP-proxy) runs -- see that file's own doc comment.
 *  `allowWrites` stays the blanket, category-level control (every write tool at once); this switch
 *  is the finer one, on top of it: a write tool still needs both allowWrites on AND its own switch
 *  on to run. */
function toolsPanelHtml(row: ConnectorSummary): string {
  const allowWrites = `<div class="connector-allow-writes">
    <label class="connector-allow-writes-toggle"><input type="checkbox" data-connector-allow-writes="${esc(row.id)}" data-connector-allow-writes-label="${esc(row.label)}" ${row.allowWrites ? 'checked' : ''}> Allow write tools</label>
    <p class="muted">The blanket control on this tab. Turning this on lets ${esc(row.label)} run write tools at all; the per-tool switch below still turns any one of them off individually.</p>
  </div>`
  const tools = resolvedTools(row)
  if (!tools || !tools.length) {
    if (row.transport !== 'mcp') return `<p class="muted">Not applicable.</p>${allowWrites}`
    if (row.lastTestAt == null) {
      return `<p class="muted">The handshake has not run yet. Test connection to discover tools.</p>${allowWrites}`
    }
    return `<p class="muted">The last handshake returned no tools.</p>${allowWrites}`
  }
  const disabled = new Set(row.disabledTools)
  const items = tools
    .map((t) => {
      const isOff = disabled.has(t.name)
      return `<li data-stagger>
      <span class="connector-tool-name">${esc(t.name)}</span>
      ${t.description ? `<span class="connector-tool-desc muted">${esc(t.description)}</span>` : ''}
      ${chip({ label: t.write ? 'write' : 'read', tone: t.write ? 'warn' : 'ok' })}
      <label class="connector-tool-switch"><input type="checkbox" data-connector-tool-toggle="${esc(row.id)}" data-connector-tool-name="${esc(t.name)}"${isOff ? '' : ' checked'} aria-label="${esc(t.name)} ${isOff ? 'disabled' : 'enabled'}"><span>${isOff ? 'Off' : 'Enabled'}</span></label>
    </li>`
    })
    .join('')
  return `<ul class="connector-tools-panel-list">${items}</ul>
    <p class="muted connector-tools-panel-note">Per-tool call counts need a query this drawer does not run yet -- see the Activity tab for real per-connection call data.</p>
    ${allowWrites}`
}

/** plan 6.10c Scope tab. Renders `modeFieldHtml(row.mode)` for an existing connection too (not
 *  only the new-connection drawer at the bottom of this file) so `input[name="mode"]` actually
 *  exists here: without it, operator/client/pages/connectors.ts's `currentScopeAndMode()` fell
 *  back to its 'brokered' default even for a Direct-mode row, which (a) made a freshly-opened
 *  Direct drawer read as "changed" with Save enabled on zero interaction, and (b) meant any
 *  Scope-tab save on a Direct connection silently PATCHed `mode: 'brokered'` -- flipping who holds
 *  the credential -- since `handleSaveClick()` always sends the field `collectMode()` computed. */
function scopePanelHtml(row: ConnectorSummary, tiers: TierOption[], groups: GroupOption[]): string {
  return `${scopeFieldsHtml(tiers, groups, row.scope)}${modeFieldHtml(row.mode)}`
}

/** plan 6.10c Danger tab: Rotate / Revoke / Delete, each stating what breaks and for whom before it
 *  happens -- real grantsCount/uses numbers, not a generic confirm. */
function dangerPanelHtml(row: ConnectorSummary): string {
  const rotateRow = `<div class="connector-danger-row">
    <p>Rotate replaces the stored credential. Seats keep working until they next call it, then get an authentication error until they refresh.</p>
    <button type="button" class="tool" data-connector-rotate="${esc(row.id)}">Rotate credential</button>
  </div>`
  const revokeRow =
    row.status === 'active'
      ? `<div class="connector-danger-row">
      <p>Revoke ends this connection for every seat immediately. ${row.grantsCount} seat${row.grantsCount === 1 ? ' has' : 's have'} used it${row.uses ? `, ${row.uses} call${row.uses === 1 ? '' : 's'} total` : ''}.</p>
      <button type="button" class="tool danger" data-connector-revoke="${esc(row.id)}" data-connector-revoke-label="${esc(row.label)}">Revoke</button>
    </div>`
      : `<div class="connector-danger-row"><p>Already revoked.</p></div>`
  const canDelete = row.status !== 'active' && row.uses === 0
  const deleteReason = row.status === 'active' ? 'Revoke this connection first.' : `Used ${row.uses} time${row.uses === 1 ? '' : 's'}; not eligible until uses fall to zero.`
  const deleteRow = `<div class="connector-danger-row">
    <p>Delete removes the record entirely. Only available once revoked and never used.</p>
    ${
      canDelete
        ? `<button type="button" class="tool danger" data-connector-delete="${esc(row.id)}" data-connector-delete-label="${esc(row.label)}">Delete</button>`
        : `<button type="button" class="tool" disabled title="${esc(deleteReason)}">Delete</button>`
    }
  </div>`
  return `<div class="connector-danger-grid">${rotateRow}${revokeRow}${deleteRow}</div>`
}

function activityPanelPlaceholderHtml(rowId: string): string {
  return `<div data-connector-activity-panel="${esc(rowId)}"><p class="muted">Loading activity...</p></div>`
}

/** 7-day calls-vs-errors bars (plan 6.10c: "reusing the existing sparkline component"): the same
 *  `data-grow` per-bar convention operator/src/render/pages/overview-charts.ts's `miniBars()` uses
 *  is followed here rather than imported from it -- that file's own doc comment states it is
 *  "owned exclusively by the Overview page: no other page module imports from this file," and
 *  Connectors needs two series (calls and errors stacked in one bar) that function does not
 *  produce. */
function activitySparklineHtml(days: { ts: number; calls: number; errors: number }[]): string {
  if (!days.length || days.every((d) => d.calls === 0)) {
    return '<p class="muted">No calls in the last 7 days.</p>'
  }
  const w = 168
  const h = 28
  const gap = 2
  const n = days.length
  const bw = Math.max(2, (w - gap * (n + 1)) / n)
  const max = Math.max(1, ...days.map((d) => d.calls))
  const bars = days
    .map((d, i) => {
      const barH = Math.max(2, Math.round((d.calls / max) * (h - 4)))
      const errH = d.calls ? Math.round((d.errors / d.calls) * barH) : 0
      const okH = barH - errH
      const x = gap + i * (bw + gap)
      const y = h - barH
      const okRect = okH > 0 ? `<rect x="${x.toFixed(1)}" y="${y}" width="${bw.toFixed(1)}" height="${okH}" rx="1" fill="var(--data-1)" data-grow data-grow-delay="${i * 20}" />` : ''
      const errRect = errH > 0 ? `<rect x="${x.toFixed(1)}" y="${y + okH}" width="${bw.toFixed(1)}" height="${errH}" rx="1" fill="var(--danger)" data-grow data-grow-delay="${i * 20}" />` : ''
      return okRect + errRect
    })
    .join('')
  return `<svg class="connector-activity-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">${bars}</svg>`
}

/** Fills the Activity tab's placeholder once operator/client/pages/connectors.ts's fetch of
 *  GET /v1/admin/integrations/:id/activity.json answers (plan 6.10c: capped 20 rows, tool/seat/
 *  duration/outcome, never arguments -- probe.ts's own redaction discipline; a 7-day sparkline; a
 *  link to Audit filtered to this connector). Exported so the client and this module's tests build
 *  it from the same function. */
export function renderActivityPanelHtml(payload: ConnectorActivityPayload, now: number): string {
  if (!payload.available) {
    return '<p class="muted">Activity is not available yet. It needs the MCP gateway audit table, which is not bound in this environment.</p>'
  }
  if (!payload.rows.length) {
    return `<div class="connector-activity-spark-wrap">${activitySparklineHtml(payload.sparkline)}</div><p class="muted">No calls recorded yet for this connection.</p>`
  }
  const totalErrors = payload.sparkline.reduce((s, d) => s + d.errors, 0)
  const errorLine = totalErrors ? `${totalErrors} error${totalErrors === 1 ? '' : 's'} in 7 days` : 'No errors in 7 days'
  const rows = payload.rows
    .map(
      (r) => `<li data-stagger>
      <span class="connector-activity-tool mono">${esc(r.tool)}</span>
      <span class="connector-activity-seat">${esc(r.hostname || r.email || `Seat ${r.deviceShort}`)}</span>
      <span class="connector-activity-ms mono">${r.ms} ms</span>
      ${chip({ label: r.outcome === 'ok' ? 'ok' : 'error', tone: r.outcome === 'ok' ? 'ok' : 'danger' })}
      <span class="connector-activity-age muted">${esc(relativeTime(r.ts, now))} ago</span>
    </li>`
    )
    .join('')
  return `<div class="connector-activity-spark-wrap">${activitySparklineHtml(payload.sparkline)}<span class="muted">${esc(errorLine)}</span></div>
    <ul class="connector-activity-list">${rows}</ul>
    <a class="tool" href="#audit" data-connector-activity-audit-link>View in Audit</a>`
}

function existingConnectionBodyHtml(row: ConnectorSummary, entry: PublicConnectorCatalogEntry | undefined, tiers: TierOption[], groups: GroupOption[], activeTab: ConnectorDrawerTab): string {
  const tabsHtml = tabs({
    items: CONNECTOR_DRAWER_TABS.map((t) => ({ id: t.id, label: t.label, active: t.id === activeTab })),
    attrs: 'data-connector-tabs'
  })
  const panelFor = (id: ConnectorDrawerTab): string => {
    switch (id) {
      case 'overview':
        return overviewPanelHtml(row, entry, tiers, groups)
      case 'tools':
        return toolsPanelHtml(row)
      case 'scope':
        return scopePanelHtml(row, tiers, groups)
      case 'activity':
        return activityPanelPlaceholderHtml(row.id)
      case 'danger':
        return dangerPanelHtml(row)
    }
  }
  const panels = CONNECTOR_DRAWER_TABS.map((t) => `<div class="connector-tab-panel" data-connector-panel="${t.id}"${t.id === activeTab ? '' : ' hidden'}>${panelFor(t.id)}</div>`).join('')
  return `${tabsHtml}${panels}`
}

export interface DrawerFieldsCtx {
  tiers: TierOption[]
  groups: GroupOption[]
  existing: ConnectorSummary | null
  activeTab?: ConnectorDrawerTab
}

/** Everything the connection drawer shows for one catalog entry: a brand new connection (flat
 *  guided field grid, no tabs until the row exists), an existing one opened from the Connected
 *  table or a Needs attention row (tabs, plan 6.10c), or (needs-oauth) a read-only explainer
 *  naming the exact `wrangler secret put` commands (lock 12: "inert beats fake"). Returns the full
 *  `<aside>` markup through the shared connectionDrawer() shell (unchanged, plan 6.10c), passing
 *  the tabbed body through as ONE wide DetailField whose value is raw HTML -- the shell's own
 *  field-grid renderer (operator/src/render/detail-drawer.ts, a file this task does not touch)
 *  just wraps whatever value it is given. */
export function renderConnectionDrawerHtml(entry: PublicConnectorCatalogEntry, ctx: DrawerFieldsCtx): string {
  const shellEntry = { kind: entry.kind, label: entry.label, docsUrl: entry.docsUrl || undefined }

  if (entry.availability === 'needs-oauth') {
    const upper = entry.kind.toUpperCase()
    const clientIdEnv = `OAUTH_${upper}_CLIENT_ID`
    const clientSecretEnv = `OAUTH_${upper}_CLIENT_SECRET`
    const fields: DetailField[] = [
      { label: 'Status', value: chip({ label: 'Needs OAuth (phase 2)', tone: 'warn' }) },
      { label: 'Authentication', value: esc(authKindLabel(entry.auth)) },
      {
        label: 'What is missing',
        value: `<p>${esc(entry.label)} needs the Operator's own OAuth app registration before this connects. Bind both secrets, then this tile connects like any other:</p>
          <pre class="connector-oauth-commands mono">wrangler secret put ${esc(clientIdEnv)}
wrangler secret put ${esc(clientSecretEnv)}</pre>`,
        wide: true
      }
    ]
    return connectionDrawer(shellEntry, { fields })
  }

  if (ctx.existing) {
    const row = ctx.existing
    const body = existingConnectionBodyHtml(row, entry, ctx.tiers, ctx.groups, ctx.activeTab ?? 'overview')
    const fields: DetailField[] = [{ label: '', value: body, wide: true }]
    return connectionDrawer(shellEntry, { fields, footer: existingConnectionFooterHtml(row) })
  }

  const configFields = entry.fields.filter((f) => f.key !== 'credential')
  const fields: DetailField[] = [
    { label: 'Label', value: `<input type="text" name="label" maxlength="120" required placeholder="${esc(entry.label)}" value="${esc(entry.label)}">` },
    ...(entry.fields.some((f) => f.key === 'credential')
      ? [
          {
            label: entry.fields.find((f) => f.key === 'credential')!.label,
            value: fieldInputHtml(entry.fields.find((f) => f.key === 'credential')!, entry.docsUrl ? { url: entry.docsUrl, vendor: entry.label } : undefined)
          }
        ]
      : []),
    ...configFields.map((f) => ({ label: f.label, value: fieldInputHtml(f) })),
    { label: 'Scope', value: scopeFieldsHtml(ctx.tiers, ctx.groups, {}), wide: true },
    { label: 'Mode', value: modeFieldHtml('brokered'), wide: true }
  ]
  return connectionDrawer(shellEntry, { fields, footer: newConnectionFooterHtml() })
}

// ---------------------------------------------------------------------------
// Zero state (plan 6.10c: "with no connections the page shows the three Tony would most likely
// want first, each with a one line reason, and the catalog underneath, never an empty box").
// ---------------------------------------------------------------------------

const ZERO_STATE_SUGGESTIONS: { kind: string; reason: string }[] = [
  { kind: 'hubspot', reason: 'Push meeting recaps straight into deals.' },
  { kind: 'clickup', reason: 'Turn a recap into a task without leaving Métis.' },
  { kind: 'slack', reason: 'Post launch updates where the team already is.' }
]

export function renderConnectorsZeroState(catalog: PublicConnectorCatalogEntry[]): string {
  const byKind = catalogByKind(catalog)
  const tiles = ZERO_STATE_SUGGESTIONS.filter((s) => byKind[s.kind])
    .map(
      (s) => `<div class="connectors-zero-suggestion">
      ${renderCatalogTile(byKind[s.kind], 0)}
      <p class="muted connectors-zero-reason">${esc(s.reason)}</p>
    </div>`
    )
    .join('')
  return `<article class="card connectors-zero-state" data-connectors-zero-state>
    <p class="connectors-zero-lede">Nothing connected yet. A few teams usually start here.</p>
    <div class="connectors-zero-suggestions">${tiles}</div>
  </article>`
}

// ---------------------------------------------------------------------------
// Page shell (first paint / operator/client/main.ts's rerender('connectors')).
// ---------------------------------------------------------------------------

function renderRotateDialog(): string {
  return dialog({ id: 'connector-rotate-dialog', title: 'Rotate credential', label: 'New credential', confirmLabel: 'Rotate', masked: true })
}

/** Exported (as well as used here) so operator/client/pages/connectors.ts rebuilds the exact same
 *  card after a mutation (Test/Save/Rotate/Revoke/Delete) -- the client never fetches on mount
 *  (plan 6.10c: "no first-paint-critical fetch"), but a mutation is an interaction, not first
 *  paint, and needs some way back to fresh server truth without `location.reload()` (plan D3). */
export function connectedBlockHtml(connectors: ConnectorSummary[], now: number, catalog: Record<string, PublicConnectorCatalogEntry>, groupNameById: Record<string, string> = {}): string {
  if (!connectors.some((c) => c.status === 'active')) return ''
  const { html, historyCount, overflowCount } = renderConnectedTable(connectors, now, catalog, groupNameById)
  return `<article class="card pad-b10" data-connectors-connected-card>
    <div class="connectors-card-head">
      <p class="eyebrow eyebrow-flush">Connected</p>
      <span data-connectors-history-slot>${renderHistoryToggle(historyCount)}</span>
    </div>
    <div data-connectors-connected-root data-connectors-state="ready">${html}</div>
    ${overflowCount > 0 ? `<div class="connectors-overflow-slot" data-connectors-overflow-slot>${renderConnectedOverflowToggle(overflowCount)}</div>` : ''}
  </article>`
}

/** The Needs attention + Connected pair, or the zero state in their place (plan 6.10c block 8:
 *  "replaces blocks 5+6 together when there are zero connections total"). Exported for the same
 *  post-mutation refresh reason as connectedBlockHtml() above. */
export function connectorsBodyHtml(
  connectors: ConnectorSummary[],
  now: number,
  catalog: PublicConnectorCatalogEntry[],
  catalogMap: Record<string, PublicConnectorCatalogEntry>,
  groupNameById: Record<string, string> = {}
): string {
  const hasActive = connectors.some((c) => c.status === 'active')
  if (!hasActive) return renderConnectorsZeroState(catalog)
  return `${renderNeedsAttention(connectors, now)}${connectedBlockHtml(connectors, now, catalogMap, groupNameById)}`
}

function catalogBlockHtml(catalog: PublicConnectorCatalogEntry[], connectionCounts: Record<string, number>, failingCounts: Record<string, number>): string {
  return `<article class="card pad-b10" data-connectors-catalog-card>
    <div class="connectors-card-head">
      <p class="eyebrow eyebrow-flush">Catalog</p>
    </div>
    <div class="connectors-catalog-sticky-row" data-connectors-catalog-sticky>${renderCatalogFilterRow(catalog)}</div>
    ${renderCatalogGrid(catalog, connectionCounts, failingCounts)}
  </article>`
}

/** Number of currently-failing active connections. Exported so operator/src/ui.ts can pass the
 * same number into the rail's `navCounts.connectors` badge (plan 6.1: "Connectors = failing
 * tests") that this page's own danger banner and status strip already compute here -- one
 * definition of "failing," not two that can drift apart. */
export function failingConnectorsCount(connectors: ConnectorSummary[]): number {
  return connectors.filter((c) => c.status === 'active' && c.health === 'failing').length
}

export function renderConnectors(data: DashboardPayload, _ctx: RenderCtx): string {
  const catalog = publicConnectorCatalog()
  const catalogMap = catalogByKind(catalog)
  const connectors = (data.connectors || []) as unknown as ConnectorSummary[]
  const now = data.now
  const activeConnectors = connectors.filter((c) => c.status === 'active')
  const failingCount = failingConnectorsCount(connectors)
  const connectionCounts: Record<string, number> = {}
  const failingCountsByKind: Record<string, number> = {}
  for (const c of activeConnectors) {
    connectionCounts[c.kind] = (connectionCounts[c.kind] || 0) + 1
    if (c.health === 'failing') failingCountsByKind[c.kind] = (failingCountsByKind[c.kind] || 0) + 1
  }

  const addAction = `<button type="button" class="primary" data-connectors-header-add>Add connector</button>`

  return `${pageHeader({
    title: 'Connectors',
    subtitle: 'CRMs, work tools and MCP servers Métis can reach through the Operator.',
    action: addAction
  })}
    <div data-connectors-danger-slot>${renderDangerBanner(failingCount)}</div>
    <div data-connectors-status-slot>${renderStatusStrip(connectors)}</div>
    ${connectorsToolbarHtml()}
    ${bulkBarHtml(FALLBACK_TIER_OPTIONS, [])}
    <div data-connectors-body-slot>${connectorsBodyHtml(connectors, now, catalog, catalogMap)}</div>
    ${catalogBlockHtml(catalog, connectionCounts, failingCountsByKind)}
    ${renderRotateDialog()}
    <div data-connectors-drawer-slot></div>`
}

/** Reused by operator/client/pages/connectors.ts to look the entry up for a kind without
 *  re-importing operator/src/connectors/catalog directly in two places for the same lookup. */
export { getConnectorCatalogEntry, publicConnectorCatalog }
export type { PublicConnectorCatalogEntry, ConnectorField }
