/**
 * Audit page (plan 6.11b, task P1.11). Every admin action, delivery and reveal, with who, when,
 * where from and a request id to chase in the logs.
 *
 * Server/client split (plan D2), same shape as Events (operator/src/render/pages/events.ts):
 * `renderAudit(data, ctx)` renders first paint from `DashboardPayload.change.timeline` (built by
 * `operator/src/dashboard.ts` from `store.listAudit(80)`), which carries only `ts`/`actor`/
 * `action`/`detail` -- no `request_id`, `route` or `ask_id`. Those three read "Not reported" until
 * the client hydrates from the real `GET /v1/admin/audit.json` (operator/src/routes/admin-core.ts),
 * which does carry them. `AuditRowLike` is the shape both sources normalize into; `renderAuditRowsHtml`
 * is the one row template both the initial `dataTable()` call and every later client-side patch
 * (hydrate, Load older, a filter change) build rows from, so server and client markup never drift.
 *
 * Action groups (plan: "actor, action group: licenses / seats / keys / connectors / skills /
 * reveals / exports / platform, route, seat, connector, request id"). The audit table has no
 * `group` column -- every group is a heuristic classification of the free-text `action` string
 * (`classifyAuditGroup`), because two different naming schemes coexist in this codebase today:
 * the QA fixture's own `buildAudit()` (operator/src/render/fixture.ts) writes `license-generate`,
 * `seat-approve`, `integration-test-failed`, while the real admin routes write `revoke-license`,
 * `approve-seat`, `integration-test` (see operator/src/routes/admin-ctx.ts's `auditLog` call
 * sites). `classifyAuditGroup` matches on substrings that are stable across both word orders
 * (`license`, `seat`, `vault`, `integration`, `skill`, `reveal`, `export`, `platform`) plus a
 * short exact-match list for the generic single-word skill actions (`approve`/`reject`/`draft`/
 * `push`) and the seat-initiated `use` action, checked in an order that never lets a shorter,
 * generic word (`approve`) steal a row that also contains a more specific one (`seat`). This is a
 * flagged, best-effort classification, not a schema the backend enforces -- see this page's build
 * report for the exact backend patch that would give Audit a real, queryable group column.
 *
 * Target / links (plan: "Target (seat, license last4, key provider, connector label, skill id)"
 * and "links to the seat, the license, the connector"): the audit table has no structured target
 * column either -- every admin route folds its target into the free-text `detail` (and sometimes
 * `ask_id`) it already audits. `deriveAuditLinks` extracts a best-effort seat id / license last4 /
 * connector hint from those same fields (a leading token, a "..XXXX" style suffix, an
 * `/integrations/<id>/` route segment) -- real substrings of real audited text, never invented.
 * When extraction finds nothing the row honestly reads "Not reported" (lock 3), never a guess.
 */
import type { DashboardPayload } from '../../dashboard'
import { looksLikeSecret } from '../../redact'
import {
  avatar,
  dataTable,
  detailDrawer,
  esc,
  iconSvg,
  KIND_ICON_PATHS,
  metricTiles,
  NAV_ICON_PATHS,
  pageHeader,
  relativeTime,
  skeletonRows,
  timeCell,
  toolbar,
  toolbarButton,
  toolbarSearch,
  viewButton,
  type DataTableColumn,
  type DataTableRow,
  type MetricTile,
  type RenderCtx
} from '../index'
import { field, MISSING } from './_shared'

// ---------------------------------------------------------------------------------------------
// Local icon paths (Lucide, ISC), copied the same way operator/src/render/pages/notifications.ts
// does for the two kinds design-lead's icons.ts has no path for: this page does not own that file,
// and neither "eye" (reveals) nor "download" (exports) nor "check" (copy confirmation) exist there.
// ---------------------------------------------------------------------------------------------

const SKILL_ICON_PATH =
  '<path d="M21.42 10.922a1 1 0 0 0-.019-1.838L12.83 5.18a2 2 0 0 0-1.66 0L2.6 9.08a1 1 0 0 0 0 1.832l8.57 3.908a2 2 0 0 0 1.66 0z"/><path d="M22 10v6"/><path d="M6 12.5V16a6 3 0 0 0 12 0v-3.5"/>'
const EYE_ICON_PATH = '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>'
const DOWNLOAD_ICON_PATH =
  '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>'
export const AUDIT_CHECK_ICON_PATH = '<path d="M20 6 9 17l-5-5"/>'

// ---------------------------------------------------------------------------------------------
// Action groups.
// ---------------------------------------------------------------------------------------------

export type AuditGroup = 'licenses' | 'seats' | 'keys' | 'connectors' | 'skills' | 'reveals' | 'exports' | 'platform'

export const AUDIT_GROUP_ORDER: readonly AuditGroup[] = [
  'licenses',
  'seats',
  'keys',
  'connectors',
  'skills',
  'reveals',
  'exports',
  'platform'
]

export const AUDIT_GROUP_LABEL: Record<AuditGroup, string> = {
  licenses: 'Licenses',
  seats: 'Seats',
  keys: 'Keys',
  connectors: 'Connectors',
  skills: 'Skills',
  reveals: 'Reveals',
  exports: 'Exports',
  platform: 'Platform'
}

/** Substrings unique enough to a group that they never collide with another group's real action
 *  names (checked in this order, first match wins). "use" and the four skill verbs are checked
 *  as a separate exact-match table below them: they are short, generic English words that would
 *  otherwise substring-match unrelated future action names. */
const GROUP_SUBSTRINGS: readonly (readonly [AuditGroup, readonly string[]])[] = [
  ['reveals', ['reveal']],
  ['exports', ['export']],
  ['keys', ['vault']],
  ['connectors', ['integration', 'connector', 'mcp']],
  ['licenses', ['license']],
  ['seats', ['seat']],
  ['skills', ['skill']]
]

const GROUP_EXACT: Record<string, AuditGroup> = {
  use: 'keys',
  approve: 'skills',
  reject: 'skills',
  draft: 'skills',
  push: 'skills'
}

/** See the file header for why this is a heuristic, not a schema lookup. Unknown/empty actions
 *  fall to "platform" -- the same catch-all real crm-retry, group- and tier- administrative
 *  actions land in today, never a blank group. */
export function classifyAuditGroup(action: string): AuditGroup {
  const a = (action || '').trim().toLowerCase()
  if (!a) return 'platform'
  const exact = GROUP_EXACT[a]
  if (exact) return exact
  for (const [group, words] of GROUP_SUBSTRINGS) {
    if (words.some((w) => a.includes(w))) return group
  }
  return 'platform'
}

const GROUP_TINT_CLASS: Record<AuditGroup, string> = {
  licenses: 'kind-audit-licenses',
  seats: 'kind-audit-seats',
  keys: 'kind-audit-keys',
  connectors: 'kind-audit-connectors',
  skills: 'kind-audit-skills',
  reveals: 'kind-audit-reveals',
  exports: 'kind-audit-exports',
  platform: 'kind-audit-platform'
}

function groupIconPath(group: AuditGroup): string {
  if (group === 'licenses') return KIND_ICON_PATHS.license
  if (group === 'seats') return KIND_ICON_PATHS.seat
  if (group === 'keys') return KIND_ICON_PATHS.vault
  if (group === 'connectors') return NAV_ICON_PATHS.plug
  if (group === 'skills') return SKILL_ICON_PATH
  if (group === 'reveals') return EYE_ICON_PATH
  if (group === 'exports') return DOWNLOAD_ICON_PATH
  return KIND_ICON_PATHS.platform
}

/** Reuses the shared `.kind-badge`/`.kind-icon` shape (design-lead's primitives.ts) with this
 *  page's own tint classes (operator/src/spa/css-audit.ts), the same technique
 *  notifications.ts's `noticeKindBadge()` uses for the two kinds kindBadge()'s own tint map
 *  (the ingest taxonomy) does not cover. */
export function auditActionBadge(action: string): string {
  const group = classifyAuditGroup(action)
  const icon = iconSvg(groupIconPath(group), { class: 'kind-icon' })
  const raw = action || 'Not reported'
  return `<span class="kind-badge ${GROUP_TINT_CLASS[group]}" title="${esc(raw)}">${icon}<span>${esc(AUDIT_GROUP_LABEL[group])}</span></span>`
}

// ---------------------------------------------------------------------------------------------
// Normalized row shape shared by the SSR `DashboardPayload.change.timeline` and the client's
// audit.json rows.
// ---------------------------------------------------------------------------------------------

export interface AuditRowLike {
  ts: number
  actor: string
  action: string
  detail: string
  askId: string | null
  requestId: string | null
  route: string | null
}

/** The real `GET /v1/admin/audit.json` row shape, kept as a structural interface (not an import
 *  of operator/src/store.ts's `AuditRow`, a file this page does not own) so this render module
 *  never depends on the store layer directly. */
export interface AuditJsonRow {
  ts: number
  actor: string
  action: string
  ask_id: string | null
  detail: string
  request_id: string | null
  route: string | null
}

export function normalizeChangeTimelineRow(row: DashboardPayload['change']['timeline'][number]): AuditRowLike {
  return { ts: row.ts, actor: row.actor, action: row.action, detail: row.detail, askId: null, requestId: null, route: null }
}

export function normalizeAuditJsonRow(row: AuditJsonRow): AuditRowLike {
  return {
    ts: row.ts,
    actor: row.actor,
    action: row.action,
    detail: row.detail,
    askId: row.ask_id,
    requestId: row.request_id,
    route: row.route
  }
}

// ---------------------------------------------------------------------------------------------
// Target + links (see file header). Pure so both this module's test and the client's drawer-fill
// logic exercise the exact same extraction.
// ---------------------------------------------------------------------------------------------

function firstToken(text: string | null): string | null {
  const token = (text || '').trim().split(/\s+/)[0]
  return token || null
}

/** A device id looks like a short, dash/underscore/dot-friendly identifier and is never an email
 *  and never the literal actor sentinel "system" real cron rows use. */
function looksLikeDeviceId(value: string | null): value is string {
  if (!value || value === 'system' || value.includes('@')) return false
  return /^[a-z0-9][a-z0-9._-]{2,63}$/i.test(value)
}

export interface AuditLinks {
  seatId: string | null
  licenseLast4: string | null
  connectorHint: string | null
}

/** Extracted from real audited text (actor, detail, route) -- never invented. `looksLikeSecret`
 *  guards the whole `detail` string first: `safeAuditText` (admin-ctx.ts) already redacts a
 *  secret-shaped detail to `[redacted]` at write time, but a second, independent check here means
 *  a row that somehow reached this page without going through that helper still never has a
 *  substring pulled out of it (the same defence-in-depth admin-ctx.ts's own comment describes). */
export function deriveAuditLinks(row: AuditRowLike, group: AuditGroup): AuditLinks {
  const detailSafe = row.detail && !looksLikeSecret(row.detail) ? row.detail : null

  let seatId: string | null = null
  if (looksLikeDeviceId(row.actor)) seatId = row.actor
  else if (group === 'seats') {
    const token = firstToken(detailSafe)
    if (looksLikeDeviceId(token)) seatId = token
  }

  let licenseLast4: string | null = null
  if (group === 'licenses' && detailSafe) {
    const m = detailSafe.match(/·+\s*([0-9a-z]{4})\b/i)
    if (m) licenseLast4 = m[1]
  }

  let connectorHint: string | null = null
  if (group === 'connectors') {
    const routeMatch = row.route ? row.route.match(/\/integrations\/([^/]+)/) : null
    if (routeMatch) connectorHint = decodeURIComponent(routeMatch[1])
    else connectorHint = firstToken(detailSafe)
  }

  return { seatId, licenseLast4, connectorHint }
}

/** The Target column: one short label, best effort, "Not reported" when nothing could be
 *  extracted (lock 3: a named reason beats a guess). */
export function auditTargetLabel(row: AuditRowLike, group: AuditGroup, links: AuditLinks): string {
  if (group === 'licenses' && links.licenseLast4) return `License ··${links.licenseLast4}`
  if (group === 'seats' && links.seatId) return `Seat ${links.seatId}`
  if (group === 'connectors' && links.connectorHint) return `Connector ${links.connectorHint}`
  if (group === 'keys') {
    const token = firstToken(row.detail && !looksLikeSecret(row.detail) ? row.detail : null)
    if (token) return `Key ${token}`
  }
  if (group === 'skills') {
    if (row.askId) return `Skill ${row.askId}`
    const token = firstToken(row.detail && !looksLikeSecret(row.detail) ? row.detail : null)
    if (token) return `Skill ${token}`
  }
  if (group === 'reveals' && row.askId) return `Ask ${row.askId}`
  return 'Not reported'
}

// ---------------------------------------------------------------------------------------------
// Actor / request id / route cells.
// ---------------------------------------------------------------------------------------------

/** Avatar or "system" for cron and seats (plan): a real email gets the shared avatar(); the
 *  literal actor "system" (retention.ts's cron heartbeat) gets a small platform glyph instead of
 *  a fabricated identity; anything else device-id-shaped (a seat calling /v1/use or receiving a
 *  connector) gets the avatar keyed off the id itself, labelled in mono so it never reads like a
 *  name. */
function actorCell(actor: string): string {
  if (!actor || looksLikeSecret(actor)) return MISSING
  if (actor === 'system') {
    return `<span class="au-actor-system">${iconSvg(KIND_ICON_PATHS.platform, { class: 'tool-ic' })}<span>System</span></span>`
  }
  if (actor.includes('@')) {
    return `<span class="au-actor-cell">${avatar({ name: actor, email: actor })}<span class="au-actor-text">${esc(actor)}</span></span>`
  }
  return `<span class="au-actor-cell">${avatar({ name: actor })}<span class="au-actor-text au-mono">${esc(actor)}</span></span>`
}

/** Mono, copy on click (plan): the click target and the copied value both live in
 *  `data-copy-reqid`; operator/client/pages/audit.ts wires the click, the clipboard write and the
 *  check-mark crossfade (plan 3.5b Audit row: "Request id copy: check mark crossfade"). */
function requestIdCell(requestId: string | null): string {
  if (!requestId || looksLikeSecret(requestId)) return MISSING
  return `<button type="button" class="au-reqid" data-copy-reqid="${esc(requestId)}" title="Copy request id">
    <span class="au-reqid-text au-mono">${esc(requestId)}</span>
    <span class="au-reqid-check" aria-hidden="true">${iconSvg(AUDIT_CHECK_ICON_PATH, { class: 'tool-ic' })}<span>Copied</span></span>
  </button>`
}

function routeCell(route: string | null): string {
  if (!route || looksLikeSecret(route)) return MISSING
  return `<code class="au-route au-mono">${esc(route)}</code>`
}

// ---------------------------------------------------------------------------------------------
// The dataTable columns + row template. One template, used by dataTable() for first paint and by
// renderAuditRowsHtml() for every client-side patch (hydrate, filter, Load older).
// ---------------------------------------------------------------------------------------------

const AUDIT_COLUMNS: DataTableColumn[] = [
  { key: 'when', label: 'When' },
  { key: 'actor', label: 'Actor' },
  { key: 'action', label: 'Action' },
  { key: 'target', label: 'Target' },
  { key: 'route', label: 'Route' },
  { key: 'requestId', label: 'Request id' },
  { key: 'detail', label: 'Detail' }
]

/** Column keys the View menu can hide (plan: "View"). When / Actor / Action stay mandatory --
 *  without them a row is not identifiable at all. */
export const AUDIT_OPTIONAL_COLUMNS = ['target', 'route', 'requestId', 'detail'] as const
export type AuditOptionalColumn = (typeof AUDIT_OPTIONAL_COLUMNS)[number]
const AUDIT_OPTIONAL_COLUMN_LABEL: Record<AuditOptionalColumn, string> = {
  target: 'Target',
  route: 'Route',
  requestId: 'Request id',
  detail: 'Detail'
}

export function auditRowParts(row: AuditRowLike, now: number): { attrs: string; cells: Record<string, string> } {
  const group = classifyAuditGroup(row.action)
  const links = deriveAuditLinks(row, group)
  const target = auditTargetLabel(row, group, links)
  const q = [row.actor, row.action, row.detail, row.route, row.requestId, AUDIT_GROUP_LABEL[group]]
    .filter((v): v is string => Boolean(v) && !looksLikeSecret(v))
    .join(' ')
    .toLowerCase()
  const payload = esc(JSON.stringify({ ...row, group }))
  return {
    attrs: `data-audit-row data-audit-group="${esc(group)}" data-q="${esc(q)}" data-row="${payload}"`,
    cells: {
      when: timeCell(row.ts, now),
      actor: actorCell(row.actor),
      action: auditActionBadge(row.action),
      target: target === 'Not reported' ? MISSING : esc(target),
      route: routeCell(row.route),
      requestId: requestIdCell(row.requestId),
      detail: field(row.detail)
    }
  }
}

/** Raw `<tr>` HTML for a batch of rows -- the client's building block for a filter change and
 *  Load older; never used for the initial paint, which goes through dataTable() below so the
 *  empty state stays that primitive's job. */
export function renderAuditRowsHtml(rows: AuditRowLike[], now: number): string {
  return rows
    .map((row) => {
      const { attrs, cells } = auditRowParts(row, now)
      return `<tr ${attrs}>${AUDIT_COLUMNS.map((c) => `<td>${cells[c.key] ?? ''}</td>`).join('')}</tr>`
    })
    .join('')
}

/** The full `<div class="table-wrap"><table>...</table></div>` (or, with zero rows, dataTable()'s
 *  own empty state) -- exported so the client rebuilds the whole table body the same way on every
 *  fresh render (hydrate, a filter change) rather than duplicating the empty-state branch. */
export function renderAuditTableBody(rows: AuditRowLike[], now: number): string {
  return dataTable({
    id: 'audit-table',
    columns: AUDIT_COLUMNS,
    rows: rows.map((row): DataTableRow => auditRowParts(row, now)),
    emptyTitle: 'No audit rows match this filter.',
    emptyDescription: 'Every admin action, delivery and reveal is recorded here the moment it happens.'
  })
}

// ---------------------------------------------------------------------------------------------
// Summary strip (plan: "actions in range, reveals in range, deliveries in range, failed connector
// tests in range, last cron run"). Computed over whatever row set the caller passes -- SSR passes
// the unfiltered `data.change.timeline`; the client passes its currently visible (filtered) rows,
// so the strip always agrees with the table under it.
// ---------------------------------------------------------------------------------------------

export interface AuditSummary {
  actions: number
  reveals: number
  deliveries: number
  failedConnectorTests: number
  lastCronRunTs: number | null
}

const FAILURE_WORDS = /fail|error|timeout|refused|unreachable|denied/i

/** "Failed connector tests" cannot be a clean lookup: the real `integration-test` audit row
 *  (operator/src/routes/integrations.ts) never records pass/fail, only that a test ran -- the
 *  outcome lives in `last_test_json` on the integration row, never copied into the audit detail.
 *  This counts a connectors-group row whose action mentions "test" and whose detail happens to
 *  report a failure in words (true today only for the QA fixture's own `integration-test-failed`
 *  rows). Flagged here and in this page's build report as a backend gap: `auditLog(ctx,
 *  'integration-test', ...)` should encode the real outcome so this tile is accurate in
 *  production, not only in the fixture. */
function isFailedConnectorTest(row: AuditRowLike, group: AuditGroup): boolean {
  return group === 'connectors' && row.action.toLowerCase().includes('test') && FAILURE_WORDS.test(row.detail || '')
}

export function computeAuditSummary(rows: AuditRowLike[]): AuditSummary {
  let reveals = 0
  let deliveries = 0
  let failedConnectorTests = 0
  let lastCronRunTs: number | null = null
  for (const row of rows) {
    const group = classifyAuditGroup(row.action)
    if (group === 'reveals') reveals++
    if (row.action.toLowerCase().includes('deliver')) deliveries++
    if (isFailedConnectorTest(row, group)) failedConnectorTests++
    if (row.action === 'platform.heartbeat' || row.action.toLowerCase().includes('cron')) {
      if (lastCronRunTs == null || row.ts > lastCronRunTs) lastCronRunTs = row.ts
    }
  }
  return { actions: rows.length, reveals, deliveries, failedConnectorTests, lastCronRunTs }
}

export function auditSummaryHtml(summary: AuditSummary, now: number, truncated: boolean): string {
  const tiles: MetricTile[] = [
    {
      label: 'Actions',
      value: summary.actions.toLocaleString('en-US'),
      rawValue: summary.actions,
      caption: truncated ? 'in the most recent rows loaded' : 'in range',
      formula: 'Count of audit rows matching the resolved range and filters',
      source: 'audit table, resolved range'
    },
    {
      label: 'Reveals',
      value: summary.reveals.toLocaleString('en-US'),
      rawValue: summary.reveals,
      caption: 'in range',
      formula: 'Audit rows for a prompt reveal',
      source: 'audit table, action = reveal'
    },
    {
      label: 'Deliveries',
      value: summary.deliveries.toLocaleString('en-US'),
      rawValue: summary.deliveries,
      caption: 'in range',
      formula: 'Connector deliveries to a seat',
      source: 'audit table, action contains deliver'
    },
    {
      label: 'Failed connector tests',
      value: summary.failedConnectorTests.toLocaleString('en-US'),
      rawValue: summary.failedConnectorTests,
      caption: 'in range',
      formula: 'Connector test audit rows whose detail reports a failure',
      source: 'audit table, action contains test'
    },
    {
      label: 'Last cron run',
      value: summary.lastCronRunTs != null ? relativeTime(summary.lastCronRunTs, now) : 'Not reported',
      caption:
        summary.lastCronRunTs != null
          ? `${new Date(summary.lastCronRunTs).toISOString().replace('T', ' ').slice(0, 16)} UTC`
          : 'No platform.heartbeat row yet',
      formula: 'Most recent retention cron heartbeat',
      source: 'audit table, action = platform.heartbeat'
    }
  ]
  return metricTiles(tiles)
}

// ---------------------------------------------------------------------------------------------
// Toolbar pieces (range incl. custom, filters, view). Export lives in the page header action slot
// per this page's brief, not the toolbar.
// ---------------------------------------------------------------------------------------------

export const AUDIT_RANGE_OPTIONS: { id: string; label: string }[] = [
  { id: '24h', label: 'Last 24 h' },
  { id: '7d', label: 'Last 7 d' },
  { id: '30d', label: 'Last 30 d' },
  { id: '90d', label: 'Last 90 d' },
  { id: '365d', label: 'Last 365 d' },
  { id: 'custom', label: 'Custom' }
]

function rangeMenuHtml(activeId = '24h'): string {
  const activeLabel = AUDIT_RANGE_OPTIONS.find((o) => o.id === activeId)?.label ?? 'Last 24 h'
  const items = AUDIT_RANGE_OPTIONS.map(
    (o) =>
      `<button type="button" class="au-menu-item" data-range-option="${esc(o.id)}" role="menuitemradio" aria-checked="${o.id === activeId}">${esc(o.label)}</button>`
  ).join('')
  return `<div class="au-menu-wrap" data-menu="range">
    ${toolbarButton({ label: activeLabel, icon: NAV_ICON_PATHS['chevron-down'], attrs: 'data-menu-toggle="range" aria-haspopup="true" aria-expanded="false"' })}
    <div class="au-menu-panel" hidden data-menu-panel="range" role="menu" data-range-label>
      ${items}
      <div class="au-custom-range" data-custom-range hidden>
        <label class="au-filter-field"><span>From</span><input type="date" data-range-from></label>
        <label class="au-filter-field"><span>To</span><input type="date" data-range-to></label>
        <div class="au-menu-actions"><button type="button" class="btn primary" data-range-apply>Apply</button></div>
      </div>
    </div>
  </div>`
}

function filtersMenuHtml(): string {
  const groupOptions = ['<option value="">All</option>']
    .concat(AUDIT_GROUP_ORDER.map((g) => `<option value="${esc(g)}">${esc(AUDIT_GROUP_LABEL[g])}</option>`))
    .join('')
  return `<div class="au-menu-wrap" data-menu="filters">
    ${toolbarButton({ label: 'Filters', icon: NAV_ICON_PATHS['chevron-down'], attrs: 'data-menu-toggle="filters" aria-haspopup="true" aria-expanded="false"' })}
    <div class="au-menu-panel au-filters-panel" hidden data-menu-panel="filters" role="menu">
      <label class="au-filter-field"><span>Actor</span><input type="text" data-filter="actor" placeholder="email or seat id" autocomplete="off"></label>
      <label class="au-filter-field"><span>Action group</span><select data-filter="group">${groupOptions}</select></label>
      <label class="au-filter-field"><span>Route</span><input type="text" data-filter="route" placeholder="/v1/admin/..." autocomplete="off"></label>
      <label class="au-filter-field"><span>Seat</span><input type="text" data-filter="seat" placeholder="device id" autocomplete="off"></label>
      <label class="au-filter-field"><span>Connector</span><input type="text" data-filter="connector" placeholder="kind or label" autocomplete="off"></label>
      <label class="au-filter-field"><span>Request id</span><input type="text" data-filter="requestId" placeholder="cf-ray" autocomplete="off"></label>
      <div class="au-menu-actions"><button type="button" class="btn" data-filters-clear>Clear</button></div>
    </div>
  </div>`
}

function viewMenuHtml(): string {
  const items = AUDIT_OPTIONAL_COLUMNS.map(
    (key) =>
      `<label class="au-view-item"><input type="checkbox" data-col-toggle="${key}" checked> ${esc(AUDIT_OPTIONAL_COLUMN_LABEL[key])}</label>`
  ).join('')
  return `<div class="au-view-wrap">
    ${viewButton({ attrs: 'data-view-toggle aria-haspopup="true" aria-expanded="false"' })}
    <div class="au-menu-panel au-view-panel" hidden data-view-menu role="menu">
      <p class="au-menu-title">Columns</p>
      ${items}
    </div>
  </div>`
}

/** Header action slot (plan: `pageHeader("Audit", ..., action: Export)`): one "Export" pill that
 *  opens a menu with CSV/Excel, scale + opacity (plan 3.5b: "Export menu opens with scale").
 *  operator/client/pages/audit.ts keeps both links' `href` in sync with the current filters and
 *  runs a brief shimmer on the clicked link (plan 3.5b: "clicking Excel shows a brief progress
 *  shimmer on the button until the file starts"). */
function exportActionHtml(): string {
  return `<div class="au-menu-wrap au-export-wrap" data-menu="export">
    ${toolbarButton({ label: 'Export', icon: NAV_ICON_PATHS['chevron-down'], attrs: 'data-menu-toggle="export" aria-haspopup="true" aria-expanded="false"' })}
    <div class="au-menu-panel au-export-panel" hidden data-menu-panel="export" role="menu">
      <a class="au-menu-item au-export-link" href="/v1/admin/export.csv?table=audit" data-export-link="csv">CSV</a>
      <a class="au-menu-item au-export-link" href="/v1/admin/export.xlsx?table=audit" data-export-link="xlsx">Excel</a>
    </div>
  </div>`
}

// ---------------------------------------------------------------------------------------------
// Page assembly.
// ---------------------------------------------------------------------------------------------

export function renderAudit(data: DashboardPayload, ctx: RenderCtx): string {
  const rows = data.change.timeline.map(normalizeChangeTimelineRow)
  const summary = computeAuditSummary(rows)

  const drawer = detailDrawer({
    id: 'audit-drawer',
    title: 'Audit row',
    footer: '<div class="au-drawer-links" data-drawer-links></div>'
  })

  return `${pageHeader({
    title: 'Audit',
    subtitle: 'Every action, every delivery, every reveal, with who and when.',
    action: exportActionHtml()
  })}
  <div data-audit-summary>${auditSummaryHtml(summary, ctx.now, false)}</div>
  <article class="card au-toolbar-card">
    ${toolbar({
      left: `${rangeMenuHtml()}${filtersMenuHtml()}`,
      search: toolbarSearch({ id: 'audit-search', placeholder: 'Search actor, action, detail, route or request id' }),
      right: viewMenuHtml()
    })}
  </article>
  <article class="card pad-b10">
    <div class="au-table-shell" data-audit-table-wrap data-hide-cols="">
      <div data-audit-table-body>${renderAuditTableBody(rows, ctx.now)}</div>
      <div class="au-skeleton" data-audit-skeleton hidden aria-hidden="true">${skeletonRows(6)}</div>
    </div>
    <button type="button" class="btn au-load-older" data-audit-load-older hidden>Load older</button>
    <p class="sub muted pad-b6" data-audit-limit-note hidden>Showing the most recent rows for this range. Narrow the range or filters to see fewer.</p>
  </article>
  <p class="sub muted au-retention-note">Audit rows are kept 365 days. Exports are audited.</p>
  ${drawer}
  <div class="au-drawer-backdrop" hidden data-drawer-backdrop="audit-drawer"></div>`
}
