/**
 * Connectors page (plan 6.10, D9, task P1.9). CRMs, work tools and MCP servers Métis can reach
 * through the Operator: a code-defined catalog (operator/src/connectors/catalog.ts,
 * `publicConnectorCatalog()`) rendered statically on first paint (no fetch needed, it is not
 * secret and not per-request), plus a "Connected" table and a connection drawer that both talk to
 * `operator/src/routes/integrations.ts` (already shipped, task B2).
 *
 * Architecture note (same shape as operator/src/render/pages/groups.ts, a file this page does not
 * own but mirrors): operator/src/dashboard.ts's DashboardPayload (a shared file this page does not
 * own) carries no connector rows -- only a derived `failingConnectors` count for the rail badge
 * (plan B7, live.json). `renderConnectors()` below therefore renders the catalog for real (it is
 * code, not data) plus a loading skeleton for the Connected table; operator/client/pages/
 * connectors.ts's initConnectors() fetches GET /v1/admin/integrations on mount and fills it in
 * through the exact same pure functions this module's tests exercise, so the client and the test
 * suite render byte-identical markup from the wire shape that route already returns.
 *
 * Wire types below (`ConnectorSummary`, `ConnectorProbeResult`, ...) mirror
 * operator/src/routes/integrations.ts's `integrationSummary()` / `ProbeResult` (operator/src/
 * connectors/probe.ts) field for field, so a change to either shape is a compile error here rather
 * than a silent drift -- the same discipline groups.ts's `GroupListRow` etc. already establish.
 *
 * Security note: an existing connection's credential is never re-displayed, not even masked as
 * dots tied to a real length -- the drawer shows only "stored, ****last4" and points at Rotate to
 * replace it. A new connection's credential field is `type="password"` with a reveal toggle
 * (crossfade dots to text, plan 3.5b) exactly like operator/src/render/pages/keys.ts's Add form.
 */
import type { DashboardPayload } from '../../dashboard'
import { getConnectorCatalogEntry, publicConnectorCatalog, type ConnectorField, type PublicConnectorCatalogEntry } from '../../connectors/catalog'
import {
  catalogTile,
  chip,
  connectionDrawer,
  dataTable,
  dialog,
  esc,
  logoGlyph,
  pageHeader,
  relativeTime,
  skeletonRows,
  sourceTooltip,
  statusDot,
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

// ---------------------------------------------------------------------------
// Wire types -- mirror operator/src/routes/integrations.ts's integrationSummary() and
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

export interface TierOption {
  id: string
  label: string
}

export interface GroupOption {
  id: string
  name: string
}

/** Shown until GET /v1/admin/tiers answers (mirrors groups.ts's own DEFAULT_TIER_OPTIONS fallback;
 *  not imported from that page so the two pages stay disjoint per this task's file ownership). */
export const FALLBACK_TIER_OPTIONS: TierOption[] = [
  { id: 'metis', label: 'Métis' },
  { id: 'metis-light', label: 'Métis Light' }
]

// ---------------------------------------------------------------------------
// Category grouping (plan 6.10: "category headers CRM, Work management, Support, Knowledge, Dev,
// Comms, Custom").
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

export function catalogByKind(catalog: PublicConnectorCatalogEntry[]): Record<string, PublicConnectorCatalogEntry> {
  const by: Record<string, PublicConnectorCatalogEntry> = {}
  for (const entry of catalog) by[entry.kind] = entry
  return by
}

// ---------------------------------------------------------------------------
// Catalog grid (static, code-derived -- no fetch, no loading state needed).
// ---------------------------------------------------------------------------

function tileHaystack(entry: PublicConnectorCatalogEntry): string {
  return `${entry.label} ${entry.kind} ${categoryLabel(entry.category)}`.toLowerCase()
}

function tileState(entry: PublicConnectorCatalogEntry): CatalogTileState {
  return entry.availability === 'needs-oauth' ? 'needs-oauth' : 'ready'
}

function renderCatalogTile(entry: PublicConnectorCatalogEntry): string {
  return catalogTile({
    kind: entry.kind,
    label: entry.label,
    transport: entry.transport,
    state: tileState(entry),
    attrs: `data-q="${esc(tileHaystack(entry))}" data-stagger`
  })
}

/** Grouped, ordered catalog grid (plan 6.10 block 2). Any category CATEGORY_ORDER does not name
 *  yet (there is none today; every CONNECTOR_CATEGORIES value is covered) still renders, appended
 *  after the known order, so a future category can never silently vanish. */
export function renderCatalogGrid(catalog: PublicConnectorCatalogEntry[]): string {
  const byCategory = new Map<string, PublicConnectorCatalogEntry[]>()
  for (const entry of catalog) {
    const list = byCategory.get(entry.category) ?? []
    list.push(entry)
    byCategory.set(entry.category, list)
  }
  const order = [...CATEGORY_ORDER, ...[...byCategory.keys()].filter((c) => !CATEGORY_ORDER.includes(c))]
  const sections = order
    .filter((id) => byCategory.has(id))
    .map((id) => {
      const entries = byCategory.get(id) || []
      const tiles = entries.map((e) => renderCatalogTile(e)).join('')
      return `<section class="connectors-category" data-category-section data-category="${esc(id)}">
        <p class="eyebrow">${esc(categoryLabel(id))}</p>
        <div class="catalog-tile-grid" data-tile-grid>${tiles}</div>
      </section>`
    })
    .join('')
  return `<div class="connectors-catalog" data-connectors-catalog>${sections}</div>`
}

// ---------------------------------------------------------------------------
// Connected table (plan 6.10 block 1, "hidden when empty").
// ---------------------------------------------------------------------------

function healthMeta(health: ConnectorHealth): { state: StatusDotState; label: string } {
  if (health === 'connected') return { state: 'live', label: 'Connected' }
  if (health === 'failing') return { state: 'failed', label: 'Failing' }
  return { state: 'pending', label: 'Untested' }
}

const TIER_LABEL: Record<string, string> = { metis: 'Métis', 'metis-light': 'Métis Light' }

function scopeChipsHtml(scope: ConnectorScope, groupNameById: Record<string, string>): string {
  const tierChips = (scope.tiers || []).map((t) => chip({ label: TIER_LABEL[t] || t }))
  const groupChips = (scope.groups || []).map((g) => chip({ label: groupNameById[g] || g, tone: 'accent' as ChipTone }))
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

function toolsCell(row: ConnectorSummary): string {
  if (row.transport !== 'mcp') return '<span class="muted">Not applicable</span>'
  const count = row.tools?.length ?? 0
  if (!count) {
    return row.lastTestAt == null
      ? '<span class="muted">Not tested yet</span>'
      : '<span class="muted">No tools reported</span>'
  }
  const items = row.tools!
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
  const last = row.lastUsedAt != null ? `<span class="connector-used-last">${timeCell(row.lastUsedAt, now)}</span>` : ''
  return `<div class="connector-used-cell"><span>${row.uses} call${row.uses === 1 ? '' : 's'}</span>${last}</div>${tip}`
}

function actionsCell(row: ConnectorSummary): string {
  if (row.status !== 'active') return '<span class="muted">Revoked</span>'
  return `<div class="row connector-row-actions">
    <button type="button" class="tool" data-connector-test="${esc(row.id)}">Test</button>
    <button type="button" class="tool" data-connector-rotate="${esc(row.id)}">Rotate</button>
    <button type="button" class="tool danger" data-connector-revoke="${esc(row.id)}" data-connector-revoke-label="${esc(row.label)}">Revoke</button>
  </div>`
}

function connectorNameCell(row: ConnectorSummary, catalog: Record<string, PublicConnectorCatalogEntry>): string {
  const known = catalog[row.kind]
  const label = known?.label || row.label
  return `<div class="connector-name-cell">${logoGlyph(row.kind, label, { size: 24 })}<div><strong>${esc(row.label)}</strong>${
    row.last4 ? `<span class="connector-last4 mono">••${esc(row.last4)}</span>` : ''
  }</div></div>`
}

function kindCell(row: ConnectorSummary, catalog: Record<string, PublicConnectorCatalogEntry>): string {
  return esc(catalog[row.kind]?.label || row.kind)
}

const CONNECTED_COLUMNS: { key: string; label: string }[] = [
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

function connectedRowCells(
  row: ConnectorSummary,
  now: number,
  catalog: Record<string, PublicConnectorCatalogEntry>,
  groupNameById: Record<string, string>
): Record<string, string> {
  return {
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

function connectedRowAttrs(row: ConnectorSummary, isHistory: boolean): string {
  const history = isHistory ? ' hidden data-connector-history-row' : ''
  return `data-connector-row="${esc(row.id)}" data-connector-kind="${esc(row.kind)}" data-connector-health="${esc(row.health)}" role="button" tabindex="0" aria-label="Open ${esc(row.label)}"${history}`
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
  return `<tr class="connector-row" data-stagger ${connectedRowAttrs(row, false)}>${tds}</tr>`
}

export interface ConnectedTableResult {
  html: string
  activeCount: number
  historyCount: number
}

/** Exported so this module's tests and operator/client/pages/connectors.ts render the table from
 *  the exact same function (plan D2). Active (status "active") connections sort newest first;
 *  revoked ones collapse under a "Show history" toggle, same convention as operator/src/render/
 *  pages/keys.ts's vault table. */
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
  const ordered = [...active, ...history]
  const dataRows: DataTableRow[] = ordered.map((r) => ({
    cells: connectedRowCells(r, now, catalog, groupNameById),
    attrs: connectedRowAttrs(r, !active.includes(r))
  }))
  const html = dataTable({
    columns: CONNECTED_COLUMNS,
    rows: dataRows,
    emptyTitle: 'No connectors yet.',
    emptyDescription: 'Connect a CRM, a work tool or an MCP server from the catalog below.',
    id: 'connectors-table',
    rowClass: 'connector-row'
  })
  return { html, activeCount: active.length, historyCount: history.length }
}

export function renderHistoryToggle(count: number): string {
  if (count <= 0) return ''
  return `<button type="button" class="tool connectors-history-toggle" data-connectors-history-toggle aria-expanded="false" data-show-label="Show history (${count})" data-hide-label="Hide history">Show history (${count})</button>`
}

function renderConnectedSkeleton(): string {
  return `<div class="table-wrap"><div class="connectors-skeleton" role="status" aria-label="Loading connectors">${skeletonRows(3)}</div></div>`
}

// ---------------------------------------------------------------------------
// Connection drawer (plan 6.10: from a tile, or from a Connected row).
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

function fieldInputHtml(field: ConnectorField): string {
  if (field.key === 'credential') {
    return `<div class="connector-credential-wrap">
      <input type="password" name="credential" id="connector-credential-input" placeholder="${esc(field.placeholder || '')}" ${field.required ? 'required' : ''} autocomplete="off">
      <button type="button" class="tool" data-credential-reveal aria-pressed="false">Show</button>
    </div>${field.help ? `<p class="connector-field-help muted">${esc(field.help)}</p>` : ''}`
  }
  const type = field.type === 'url' ? 'url' : 'text'
  return `<input type="${type}" name="cfg_${esc(field.key)}" placeholder="${esc(field.placeholder || '')}" value="${esc(field.default || '')}" ${field.required ? 'required' : ''}>${
    field.help ? `<p class="connector-field-help muted">${esc(field.help)}</p>` : ''
  }`
}

function scopeFieldsHtml(tiers: TierOption[], groups: GroupOption[], selected: ConnectorScope): string {
  const selTiers = selected.tiers || []
  const selGroups = selected.groups || []
  const tierBoxes = tiers
    .map(
      (t) =>
        `<label class="connector-scope-check"><input type="checkbox" name="scopeTier" value="${esc(t.id)}" ${selTiers.includes(t.id) ? 'checked' : ''}> ${esc(t.label)}</label>`
    )
    .join('')
  const groupBoxes = groups.length
    ? groups
        .map(
          (g) =>
            `<label class="connector-scope-check"><input type="checkbox" name="scopeGroup" value="${esc(g.id)}" ${selGroups.includes(g.id) ? 'checked' : ''}> ${esc(g.name)}</label>`
        )
        .join('')
    : '<p class="muted connector-scope-empty">No groups yet.</p>'
  return `<div class="connector-scope-grid">
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

function existingConnectionFooterHtml(row: ConnectorSummary): string {
  return `<div class="connector-drawer-actions">
    <button type="button" class="btn" data-connector-test="${esc(row.id)}">Test connection</button>
    <button type="button" class="tool" data-connector-rotate="${esc(row.id)}">Rotate</button>
    <button type="button" class="tool danger" data-connector-revoke="${esc(row.id)}" data-connector-revoke-label="${esc(row.label)}">Revoke</button>
    <button type="button" class="primary" data-connector-save="${esc(row.id)}">Save</button>
  </div>
  <div class="connector-test-result" data-connector-test-result hidden></div>`
}

export interface DrawerFieldsCtx {
  tiers: TierOption[]
  groups: GroupOption[]
  existing: ConnectorSummary | null
}

/** Everything the connection drawer shows for one catalog entry: a brand new connection, an
 *  existing one opened from the Connected table, or (needs-oauth) a read-only explainer (plan
 *  lock 12: "inert beats fake" -- it says exactly what is missing, never pretends to connect).
 *  Returns the full `<aside>` markup through the shared connectionDrawer() shell (plan D9 /
 *  P0.3), so header, logo and Docs link stay whatever design-lead's primitive renders. */
export function renderConnectionDrawerHtml(entry: PublicConnectorCatalogEntry, ctx: DrawerFieldsCtx): string {
  const shellEntry = { kind: entry.kind, label: entry.label, docsUrl: entry.docsUrl || undefined }

  if (entry.availability === 'needs-oauth') {
    const fieldNames = entry.fields.map((f) => f.label).join(', ') || 'no additional fields'
    const fields: DetailField[] = [
      { label: 'Status', value: chip({ label: 'Needs OAuth (phase 2)', tone: 'warn' }) },
      { label: 'Authentication', value: esc(authKindLabel(entry.auth)) },
      {
        label: 'What is missing',
        value: `${esc(entry.label)} needs an OAuth flow the Operator does not support yet. Once it does, this connector will collect: ${esc(fieldNames)}.`,
        wide: true
      }
    ]
    return connectionDrawer(shellEntry, { fields })
  }

  if (ctx.existing) {
    const row = ctx.existing
    const fields: DetailField[] = [
      { label: 'Label', value: esc(row.label) },
      {
        label: 'Credential',
        value: row.last4
          ? `<span class="mono">stored, ••${esc(row.last4)}</span><span class="connector-field-help muted"> Use Rotate to replace it.</span>`
          : '<span class="muted">No credential stored (this kind needs none, or it was left blank).</span>'
      },
      { label: 'Scope', value: scopeFieldsHtml(ctx.tiers, ctx.groups, row.scope), wide: true },
      { label: 'Mode', value: modeFieldHtml(row.mode), wide: true }
    ]
    return connectionDrawer(shellEntry, { fields, footer: existingConnectionFooterHtml(row) })
  }

  const configFields = entry.fields.filter((f) => f.key !== 'credential')
  const fields: DetailField[] = [
    { label: 'Label', value: `<input type="text" name="label" maxlength="120" required placeholder="${esc(entry.label)}" value="${esc(entry.label)}">` },
    ...(entry.fields.some((f) => f.key === 'credential')
      ? [{ label: entry.fields.find((f) => f.key === 'credential')!.label, value: fieldInputHtml(entry.fields.find((f) => f.key === 'credential')!) }]
      : []),
    ...configFields.map((f) => ({ label: f.label, value: fieldInputHtml(f) })),
    { label: 'Scope', value: scopeFieldsHtml(ctx.tiers, ctx.groups, {}), wide: true },
    { label: 'Mode', value: modeFieldHtml('brokered'), wide: true }
  ]
  return connectionDrawer(shellEntry, { fields, footer: newConnectionFooterHtml() })
}

// ---------------------------------------------------------------------------
// Page shell (first paint / operator/client/main.ts's rerender('connectors')).
// ---------------------------------------------------------------------------

function renderRotateDialog(): string {
  return dialog({ id: 'connector-rotate-dialog', title: 'Rotate credential', label: 'New credential', confirmLabel: 'Rotate', masked: true })
}

export function renderConnectors(_data: DashboardPayload, _ctx: RenderCtx): string {
  const catalog = publicConnectorCatalog()
  const addAction = `<button type="button" class="primary" data-connectors-add-open>Add connector</button>`
  return `${pageHeader({
    title: 'Connectors',
    subtitle: 'CRMs, work tools and MCP servers Métis can reach through the Operator.',
    action: addAction
  })}
    ${toolbar({ left: toolbarSearch({ id: 'connectors-search', placeholder: 'Search connectors' }), right: '' })}
    <article class="card pad-b10" data-connectors-connected-card>
      <div class="connectors-card-head">
        <p class="eyebrow eyebrow-flush">Connected</p>
        <span data-connectors-history-slot></span>
      </div>
      <div data-connectors-connected-root data-connectors-state="loading">${renderConnectedSkeleton()}</div>
      <div class="connectors-inline-error" data-connectors-connected-error hidden role="alert"></div>
    </article>
    <article class="card pad-b10" data-connectors-catalog-card>
      <p class="eyebrow">Catalog</p>
      ${renderCatalogGrid(catalog)}
    </article>
    ${renderRotateDialog()}
    <div data-connectors-drawer-slot></div>`
}

/** Reused by operator/client/pages/connectors.ts to look the entry up for a kind without
 *  re-importing operator/src/connectors/catalog directly in two places for the same lookup. */
export { getConnectorCatalogEntry, publicConnectorCatalog }
export type { PublicConnectorCatalogEntry, ConnectorField }
