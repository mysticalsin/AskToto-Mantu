/**
 * Events page (plan 6.4, P1.4 brief). Full rebuild off the "moved out of ui.ts unchanged" P0.4
 * prototype: three tabs (Events, Asks, CRM). Events/Asks share one filterable, cursor-paginated
 * dataTable (Asks is that same table pre-filtered to kind=ask, never a second table); CRM takes
 * over the funnel + sends telemetry that used to live on Notifications (plan 6.8).
 *
 * Server/client split (plan D2): `renderEvents(data, ctx)` renders first paint from
 * `DashboardPayload.events` (a `ConsoleEvent[]`, merged from the stored events table plus
 * synthetic ask/crm rows -- see operator/src/dashboard.ts `mergeEvents()`). That shape carries no
 * `appVersion` and only an 8-char device prefix, so the "Client" column and exact seat links read
 * "Not reported" until the client hydrates from the real `GET /v1/admin/events.json` (richer:
 * full `deviceId`, `appVersion`) moments after mount -- a true reflection of what has loaded, never
 * a stub value. `EventRowLike` is the shape both sources normalize into, and `renderEventRowsHtml`
 * is the one row template both the initial `dataTable()` call and every later client-side patch
 * (hydrate, Load older, Listening prepend) build rows from, so server and client never drift.
 *
 * Ask trace (drawer, "never text" per lock 2): `GET /v1/admin/asks` returns full `AskRow`s with
 * the prompt fields stripped. There is no shared id between an `events` row and its `asks` row
 * (the Worker mints two separate ids at ingest, see operator/src/index.ts's ask handler), but both
 * inserts share the exact same `ts` and `device_id` value from that one request -- `findAskTrace`
 * joins on that pair (a device-id prefix match covers the SSR path, whose chips only carry the
 * first 8 characters).
 */
import type { ConsoleEvent, DashboardPayload } from '../../dashboard'
import { looksLikeSecret, type SafeChip } from '../../redact'
import { CRM_FILTER_ORDER, type CrmStatus } from '../../crm'
import { statusBadge } from '../../components/ui/status-badge'
import { estimateCacheCost, formatUsdEstimate, type StreamCacheUsage } from '../../../../src/shared/operator'
import {
  avatar,
  clientChip,
  dataTable,
  detailDrawer,
  esc,
  exportMenu,
  flag,
  KIND_ICON_PATHS,
  kindBadge,
  metricTable,
  NAV_ICON_PATHS,
  osChip,
  pageHeader,
  segmented,
  skeletonRows,
  sourceTooltip,
  timeCell,
  toolbar,
  toolbarButton,
  toolbarSearch,
  viewButton,
  type DataTableColumn,
  type DataTableRow,
  type RenderCtx
} from '../index'
import { field, MISSING } from './_shared'

// ---------------------------------------------------------------------------------------------
// Normalized row shape shared by the SSR ConsoleEvent[] and the client's events.json rows.
// ---------------------------------------------------------------------------------------------

export interface EventRowLike {
  id: string
  ts: number
  kind: string
  hostname: string | null
  email: string | null
  country: string | null
  city: string | null
  os: string | null
  appVersion: string | null
  detail: string | null
  /** Full device id when known (events.json hydration); the seat-context chip's 8-char prefix
   *  on first paint. `findAskTrace` handles both. */
  deviceId: string | null
}

/** The client's `GET /v1/admin/events.json` row shape, kept as a structural interface (not an
 *  import of operator/src/routes/events.ts's `EventListRow`) so this render module never depends
 *  on the routes layer. */
export interface EventListRowLike {
  id: string
  ts: number
  kind: string
  hostname: string | null
  email: string | null
  country: string | null
  city: string | null
  os: string | null
  appVersion: string | null
  detail: string | null
  deviceId: string | null
}

function chipVal(chips: SafeChip[], key: string): string | null {
  const hit = chips.find((c) => c.key === key)
  return hit ? hit.value : null
}

/** `ConsoleEvent` -> `EventRowLike`. The synthetic ask/crm rows `dashboard.ts` builds carry their
 *  kind-specific extras (mode/provider/cache, status/connector/action) as chips instead of a
 *  `detail` chip -- falling back to those keeps the Detail column truthful to what ingest would
 *  have written (`safeEventDetail(mode || cacheStatus || 'ask')` etc, operator/src/index.ts). */
export function normalizeConsoleEvent(e: ConsoleEvent): EventRowLike {
  const get = (key: string): string | null => chipVal(e.chips, key)
  return {
    id: e.id,
    ts: e.ts,
    kind: looksLikeSecret(e.name) ? 'event' : e.name,
    hostname: e.hostname,
    email: e.email,
    country: get('country'),
    city: get('city'),
    os: get('os'),
    appVersion: null,
    detail: get('detail') ?? get('mode') ?? get('status') ?? null,
    deviceId: get('device')
  }
}

/** `events.json`'s row shape is already this shape field for field (its `actor` is dropped: the
 *  table shows hostname/email, never the raw HMAC actor string). */
export function normalizeEventListRow(row: EventListRowLike): EventRowLike {
  return {
    id: row.id,
    ts: row.ts,
    kind: row.kind,
    hostname: row.hostname,
    email: row.email,
    country: row.country,
    city: row.city,
    os: row.os,
    appVersion: row.appVersion,
    detail: row.detail,
    deviceId: row.deviceId
  }
}

// ---------------------------------------------------------------------------------------------
// Kind chips (counts from the `counts` field of events.json; SSR seeds them from data.events).
// ---------------------------------------------------------------------------------------------

/** Just the button row, exported so the client can rebuild it in place after every hydrate()
 *  (fresh counts) without re-rendering the whole page. Order follows KIND_ICON_PATHS's own
 *  declaration order (the same 11-kind ingest taxonomy kindBadge() tints) rather than a second,
 *  independently-maintained list. A kind with zero events in the resolved range gets no chip:
 *  a chip nobody could ever click is chrome, not information. */
export function renderKindChipButtons(counts: Record<string, number>, activeKind = 'all'): string {
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0)
  const allOn = activeKind === 'all'
  const all = `<button type="button" class="chip ev-kind-chip${allOn ? ' is-active' : ''}" data-kind-chip="all" aria-pressed="${allOn}"><span class="ev-kind-all">All</span><b class="ev-kind-count" data-count-to="${total}">${total}</b></button>`
  const rest = Object.keys(KIND_ICON_PATHS)
    .filter((k) => (counts[k] ?? 0) > 0)
    .map((k) => {
      const n = counts[k] ?? 0
      const on = activeKind === k
      return `<button type="button" class="chip ev-kind-chip${on ? ' is-active' : ''}" data-kind-chip="${esc(k)}" aria-pressed="${on}">${kindBadge(k)}<b class="ev-kind-count" data-count-to="${n}">${n}</b></button>`
    })
    .join('')
  return `${all}${rest}`
}

function kindChipsBlock(counts: Record<string, number>): string {
  return `<div class="ev-kind-heading"><span class="ev-kind-label">Filter by kind</span>${sourceTooltip(
    'Count of events by kind in the selected range and filters',
    'events table, resolved range'
  )}</div>
  <div class="ev-kind-row" data-ev-kind-row role="tablist" aria-label="Filter by kind">${renderKindChipButtons(counts)}</div>`
}

// ---------------------------------------------------------------------------------------------
// The dataTable columns + row template. One template, used by dataTable() for first paint and by
// renderEventRowsHtml() for every client-side patch (hydrate, Load older, Listening prepend).
// ---------------------------------------------------------------------------------------------

const EVENT_COLUMNS: DataTableColumn[] = [
  { key: 'created', label: 'Created at' },
  { key: 'name', label: 'Name' },
  { key: 'profile', label: 'Profile' },
  { key: 'country', label: 'Country' },
  { key: 'os', label: 'OS' },
  { key: 'client', label: 'Client' },
  { key: 'detail', label: 'Detail' }
]

/** Column keys the View menu can hide (plan: "View (column visibility)"). Created at / Name /
 *  Profile stay mandatory -- without them a row is not identifiable at all. */
export const EVENT_OPTIONAL_COLUMNS = ['country', 'os', 'client', 'detail'] as const
export type EventOptionalColumn = (typeof EVENT_OPTIONAL_COLUMNS)[number]
const EVENT_OPTIONAL_COLUMN_LABEL: Record<EventOptionalColumn, string> = {
  country: 'Country',
  os: 'OS',
  client: 'Client',
  detail: 'Detail'
}

function safeOrNull(value: string | null): string | null {
  return value && !looksLikeSecret(value) ? value : null
}

/** Every free-text field run through the same secret filter `field()` uses, before it goes
 *  anywhere in the HTML -- `data-q` (client search) and `data-row` (the drawer's JSON payload)
 *  are both attribute values a token-shaped detail string would otherwise leak through even
 *  though the visible Detail cell already redacts it via `field()`. */
function redactRowForAttrs(row: EventRowLike): EventRowLike {
  return {
    id: row.id,
    ts: row.ts,
    kind: row.kind,
    hostname: safeOrNull(row.hostname),
    email: safeOrNull(row.email),
    country: safeOrNull(row.country),
    city: safeOrNull(row.city),
    os: safeOrNull(row.os),
    appVersion: safeOrNull(row.appVersion),
    detail: safeOrNull(row.detail),
    deviceId: safeOrNull(row.deviceId)
  }
}

function eventRowParts(row: EventRowLike, now: number): { attrs: string; cells: Record<string, string> } {
  const safe = redactRowForAttrs(row)
  const q = [safe.kind, safe.hostname, safe.email, safe.country, safe.city, safe.os, safe.detail]
    .filter((v): v is string => Boolean(v))
    .join(' ')
    .toLowerCase()
  const payload = esc(JSON.stringify(safe))
  const profile = `<span class="ev-profile-cell">${avatar({ name: row.hostname || row.email || '?', email: row.email })}<span class="ev-profile-text"><span class="ev-profile-name">${field(
    row.hostname
  )}</span><span class="muted ev-profile-email">${field(row.email)}</span></span></span>`
  return {
    // data-event (not just data-event-id) is kept for operator/src/ui.console.test.ts's
    // pre-existing "events never render token-like strings" contract, unrelated to this rebuild.
    attrs: `data-event-row data-event="${esc(row.id)}" data-event-id="${esc(row.id)}" data-kind="${esc(row.kind)}" data-q="${esc(q)}" data-row="${payload}"`,
    cells: {
      created: timeCell(row.ts, now),
      name: kindBadge(row.kind),
      profile,
      country: `${flag(row.country)}${field(row.city || row.country)}`,
      os: osChip(row.os) || MISSING,
      client: clientChip(row.appVersion) || MISSING,
      detail: field(row.detail)
    }
  }
}

/** Raw `<tr>` HTML for a batch of rows -- the client's building block for Load older (append) and
 *  Listening (prepend); never used for the initial paint, which goes through dataTable() below so
 *  the empty state stays that primitive's job, not duplicated here. */
export function renderEventRowsHtml(rows: EventRowLike[], now: number): string {
  return rows
    .map((row) => {
      const { attrs, cells } = eventRowParts(row, now)
      return `<tr ${attrs}>${EVENT_COLUMNS.map((c) => `<td>${cells[c.key] ?? ''}</td>`).join('')}</tr>`
    })
    .join('')
}

/** The full `<div class="table-wrap"><table>...</table></div>` (or, with zero rows, dataTable()'s
 *  own empty state) -- exported so the client's hydrate() rebuilds the whole table body element
 *  the same way on every fresh fetch, rather than duplicating the empty-state/populated-state
 *  branch client-side. Row-level patches (Load older, Listening) go through renderEventRowsHtml()
 *  above instead, straight into an already-populated `<tbody>`. */
export function renderEventsTableBody(rows: EventRowLike[], now: number): string {
  return dataTable({
    id: 'ev-table',
    columns: EVENT_COLUMNS,
    rows: rows.map((row): DataTableRow => eventRowParts(row, now)),
    emptyTitle: 'No events yet.',
    emptyDescription: 'A row appears here within seconds of a seat’s first heartbeat, ask or CRM push.'
  })
}

// ---------------------------------------------------------------------------------------------
// Toolbar pieces (listening toggle, range menu, filters menu, view menu, export).
// ---------------------------------------------------------------------------------------------

function listenToggleHtml(): string {
  return `<button type="button" class="tool ev-listen" data-listen-toggle aria-pressed="true">
    <i class="ev-listen-dot" data-beacon aria-hidden="true"></i><span data-listen-label>Listening</span>
  </button>`
}

export const EVENT_RANGE_OPTIONS: { id: string; label: string }[] = [
  { id: '30m', label: 'Last 30 min' },
  { id: '24h', label: 'Last 24 h' },
  { id: '7d', label: 'Last 7 d' },
  { id: '30d', label: 'Last 30 d' }
]

function rangeMenuHtml(activeId = '24h'): string {
  const activeLabel = EVENT_RANGE_OPTIONS.find((o) => o.id === activeId)?.label ?? 'Last 24 h'
  const items = EVENT_RANGE_OPTIONS.map(
    (o) =>
      `<button type="button" class="ev-menu-item" data-range-option="${esc(o.id)}" role="menuitemradio" aria-checked="${o.id === activeId}">${esc(o.label)}</button>`
  ).join('')
  return `<div class="ev-menu-wrap" data-menu="range">
    ${toolbarButton({ label: activeLabel, icon: NAV_ICON_PATHS['chevron-down'], attrs: 'data-menu-toggle="range" aria-haspopup="true" aria-expanded="false"' })}
    <div class="ev-menu-panel" hidden data-menu-panel="range" role="menu" data-range-label>${items}</div>
  </div>`
}

function filtersMenuHtml(): string {
  const os = segmented({
    items: [
      { id: '', label: 'All', active: true },
      { id: 'darwin', label: 'macOS' },
      { id: 'win', label: 'Windows' },
      { id: 'linux', label: 'Linux' }
    ],
    attrs: 'data-os-filter'
  })
  return `<div class="ev-menu-wrap" data-menu="filters">
    ${toolbarButton({ label: 'Filters', icon: NAV_ICON_PATHS['chevron-down'], attrs: 'data-menu-toggle="filters" aria-haspopup="true" aria-expanded="false"' })}
    <div class="ev-menu-panel ev-filters-panel" hidden data-menu-panel="filters" role="menu">
      <p class="ev-menu-title">OS</p>
      ${os}
      <label class="ev-filter-field"><span>Country</span><input type="text" data-filter="country" placeholder="e.g. CA" maxlength="2" autocomplete="off"></label>
      <label class="ev-filter-field"><span>Version</span><input type="text" data-filter="version" placeholder="e.g. 1.8.5" autocomplete="off"></label>
      <label class="ev-filter-field"><span>Profile</span><input type="text" data-filter="profile" placeholder="hostname, email or device id" autocomplete="off"></label>
      <div class="ev-menu-actions"><button type="button" class="btn" data-filters-clear>Clear</button></div>
    </div>
  </div>`
}

function viewMenuHtml(): string {
  const items = EVENT_OPTIONAL_COLUMNS.map(
    (key) =>
      `<label class="ev-view-item"><input type="checkbox" data-col-toggle="${key}" checked> ${esc(EVENT_OPTIONAL_COLUMN_LABEL[key])}</label>`
  ).join('')
  return `<div class="ev-view-wrap">
    ${viewButton({ attrs: 'data-view-toggle aria-haspopup="true" aria-expanded="false"' })}
    <div class="ev-menu-panel ev-view-panel" hidden data-view-menu role="menu">
      <p class="ev-menu-title">Columns</p>
      ${items}
    </div>
  </div>`
}

/** operator/src/render/primitives.ts's exportMenu() takes one `csvHref` + `label`: called twice
 *  here (CSV, Excel) rather than duplicating its markup, so the primitive stays the single
 *  source of that link's shape (icon, `data-export-link`) and this page only adds the wrapper the
 *  client re-targets with the current filters (operator/client/pages/events.ts). */
function exportGroupHtml(): string {
  return `<div class="ev-export-group" data-export-group>
    ${exportMenu({ csvHref: '/v1/admin/export.csv?table=events', label: 'CSV' })}
    ${exportMenu({ csvHref: '/v1/admin/export.xlsx?table=events', label: 'Excel' })}
  </div>`
}

// ---------------------------------------------------------------------------------------------
// Ask trace (drawer, kind === 'ask' only). Pure so both this module's test and the client's
// drawer-fill logic exercise the exact same join and formatting.
// ---------------------------------------------------------------------------------------------

export interface AskTraceLite {
  ts: number
  device_id: string
  mode: string | null
  provider: string | null
  model: string | null
  question_type: string | null
  ttft_ms: number | null
  total_ms: number | null
  input_tokens: number | null
  output_tokens: number | null
  cache_read: number | null
  cache_write: number | null
  cache_uncached: number | null
  cache_status: string | null
  cache_ttl: string | null
  outcome: string | null
  rating: string | null
}

/** Joins an event row to its ask trace by (ts, device_id) -- see the file header for why there is
 *  no shared id. `row.deviceId` may be a full id (events.json hydration) or an 8-char prefix
 *  (first paint's seat-context chip); `startsWith` covers both without the caller needing to know
 *  which one it has. Returns null rather than guessing across a same-millisecond collision. */
export function findAskTrace(row: { ts: number; deviceId: string | null }, asks: AskTraceLite[]): AskTraceLite | null {
  if (!row.deviceId) return null
  const deviceId = row.deviceId
  return asks.find((a) => a.ts === row.ts && a.device_id.startsWith(deviceId)) ?? null
}

/** Mode, question type, provider, model, tokens, cache, cost, rating, latency -- never the prompt
 *  text (lock 2), which `GET /v1/admin/asks` never returns in the first place. Cost reuses the
 *  same list-price estimator Keys/Settings use so the number on this page never disagrees with
 *  theirs; `null` (cache fields never reported) reads "Not reported", never a lying $0.00. */
export function formatAskTrace(ask: AskTraceLite): { label: string; value: string }[] {
  const tokensIn = ask.input_tokens != null ? ask.input_tokens.toLocaleString('en-US') : null
  const tokensOut = ask.output_tokens != null ? ask.output_tokens.toLocaleString('en-US') : null
  const cacheParts: string[] = []
  if (ask.cache_status) cacheParts.push(ask.cache_status.replace(/-/g, ' '))
  if (ask.cache_read) cacheParts.push(`${ask.cache_read.toLocaleString('en-US')} read`)
  if (ask.cache_write) cacheParts.push(`${ask.cache_write.toLocaleString('en-US')} write`)
  const usage: StreamCacheUsage = {
    inputTokens: ask.input_tokens ?? undefined,
    outputTokens: ask.output_tokens ?? undefined,
    cacheRead: ask.cache_read ?? undefined,
    cacheWrite: ask.cache_write ?? undefined,
    cacheUncached: ask.cache_uncached ?? undefined,
    cacheStatus: (ask.cache_status as StreamCacheUsage['cacheStatus']) ?? undefined,
    cacheTtl: (ask.cache_ttl as StreamCacheUsage['cacheTtl']) ?? undefined
  }
  const cost = estimateCacheCost(usage, ask.model || '', ask.provider || undefined)
  const latencyParts: string[] = []
  if (ask.ttft_ms != null) latencyParts.push(`${ask.ttft_ms.toLocaleString('en-US')} ms to first token`)
  if (ask.total_ms != null) latencyParts.push(`${ask.total_ms.toLocaleString('en-US')} ms total`)
  return [
    { label: 'Mode', value: ask.mode || 'Not reported' },
    { label: 'Question type', value: ask.question_type || 'Not reported' },
    { label: 'Provider', value: ask.provider || 'Not reported' },
    { label: 'Model', value: ask.model || 'Not reported' },
    { label: 'Tokens', value: tokensIn != null || tokensOut != null ? `${tokensIn ?? '0'} in, ${tokensOut ?? '0'} out` : 'Not reported' },
    { label: 'Cache', value: cacheParts.length ? cacheParts.join(', ') : 'Not reported' },
    { label: 'Cost', value: cost ? `${formatUsdEstimate(cost.usd)} list price` : 'Not reported' },
    { label: 'Rating', value: ask.rating || ask.outcome || 'Not rated' },
    { label: 'Latency', value: latencyParts.length ? latencyParts.join(', ') : 'Not reported' }
  ]
}

// ---------------------------------------------------------------------------------------------
// CRM tab (plan: "takes over the CRM telemetry that used to live on Notifications" -- status
// chips, the funnel as a metricTable, the sends table with Retry that never auto-sends).
// ---------------------------------------------------------------------------------------------

function crmStatusChipsHtml(counts: Record<CrmStatus, number>, total: number): string {
  const all = `<button type="button" class="chip ev-kind-chip is-active" data-crm-status-chip="all" aria-pressed="true"><span class="ev-kind-all">All</span><b class="ev-kind-count" data-count-to="${total}">${total}</b></button>`
  const chips = CRM_FILTER_ORDER.map((status) => {
    const n = counts[status] ?? 0
    return `<button type="button" class="chip ev-kind-chip" data-crm-status-chip="${esc(status)}" aria-pressed="false">${statusBadge(status)}<b class="ev-kind-count" data-count-to="${n}">${n}</b></button>`
  }).join('')
  return `<div class="ev-kind-heading"><span class="ev-kind-label">Filter by status</span>${sourceTooltip(
    'Count of CRM pushes by status',
    'crm_sends table, last 50 rows'
  )}</div>
  <div class="ev-kind-row" role="tablist" aria-label="Filter by status">${all}${chips}</div>`
}

function crmFunnelHtml(funnel: DashboardPayload['crm']['funnel']): string {
  return metricTable({
    title: 'Funnel by connector',
    labelHeader: 'Connector',
    columns: [
      { key: 'attempted', label: 'Attempted' },
      { key: 'submitted', label: 'Submitted' },
      { key: 'success', label: 'Success' },
      { key: 'failed', label: 'Failed' }
    ],
    rows: funnel.map((f) => ({
      label: f.connector,
      barValue: f.attempted,
      cells: {
        attempted: String(f.attempted),
        submitted: String(f.submitted),
        success: String(f.success),
        failed: String(f.failed)
      }
    })),
    emptyTitle: 'No CRM pushes yet.'
  })
}

function crmRetryCell(status: CrmStatus, retryRequested: boolean, id: string): string {
  const canRetry = status === 'failed' || status === 'expired'
  if (canRetry) return `<button type="button" class="btn" data-crm-retry="${esc(id)}">Retry</button>`
  if (retryRequested) return '<span class="muted">Retry asked</span>'
  return ''
}

function crmSendsTable(rows: DashboardPayload['crm']['rows'], now: number): string {
  return dataTable({
    id: 'ev-crm-table',
    columns: [
      { key: 'status', label: 'Status' },
      { key: 'title', label: 'Title' },
      { key: 'connector', label: 'Connector' },
      { key: 'remote', label: 'Remote' },
      { key: 'attempt', label: 'Try' },
      { key: 'when', label: 'When' },
      { key: 'action', label: '' }
    ],
    rows: rows.map((r): DataTableRow => {
      const remote = r.remoteUrl
        ? `<a href="${esc(r.remoteUrl)}" target="_blank" rel="noreferrer">${esc(r.remoteId || 'Open')}</a>`
        : field(r.remoteId)
      return {
        attrs: `data-crm-row data-crm-status="${esc(r.status)}" data-q="${esc(`${r.title} ${r.connector} ${r.status}`.toLowerCase())}"`,
        cells: {
          status: statusBadge(r.status),
          title: `${esc(r.title)}${r.error ? `<div class="muted ev-crm-error">${esc(r.error)}</div>` : ''}`,
          connector: esc(r.connector),
          remote,
          attempt: String(r.attempt),
          when: timeCell(r.ts, now),
          action: `<span class="ev-crm-action-cell">${crmRetryCell(r.status, r.retryRequested, r.id)}</span>`
        }
      }
    }),
    emptyTitle: 'No CRM pushes ingested yet.',
    emptyDescription: 'A push appears here when a seat sends event=crm to the Operator.'
  })
}

// ---------------------------------------------------------------------------------------------
// Page assembly.
// ---------------------------------------------------------------------------------------------

/** First paint is superseded within one round trip by the client's own hydrate() (the real
 *  GET /v1/admin/events.json, richer and cursor-paginated) the moment the section mounts, so it
 *  only has to look right for that brief window -- 20 rows keeps the mandatory 40ms-per-row
 *  stagger (plan 3.5b) inside the same ~800ms settle window the rest of this design system uses
 *  for a first-paint reveal, instead of dumping the merged sample's full 80 rows into one long
 *  cascade. Kind chip counts still read every merged row (data.events is already sorted newest
 *  first): a count larger than what is currently paged in is the same, correct pagination
 *  behaviour the real route's resolved-range counts give once the client hydrates. */
const FIRST_PAINT_ROW_LIMIT = 20

export function renderEvents(data: DashboardPayload, ctx: RenderCtx): string {
  const allRows = data.events.map(normalizeConsoleEvent)
  const rows = allRows.slice(0, FIRST_PAINT_ROW_LIMIT)
  const counts: Record<string, number> = {}
  for (const row of allRows) counts[row.kind] = (counts[row.kind] ?? 0) + 1

  const eventsPane = `<div data-ev-pane="events">
    <article class="card ev-toolbar-card">
      ${toolbar({
        left: `${listenToggleHtml()}${rangeMenuHtml()}${filtersMenuHtml()}`,
        search: toolbarSearch({ id: 'ev-search', placeholder: 'Search hostnames, emails, device ids' }),
        right: `${viewMenuHtml()}${exportGroupHtml()}`
      })}
    </article>
    <article class="card pad-b10">
      ${kindChipsBlock(counts)}
      <div class="ev-table-shell" data-ev-table-wrap data-hide-cols="">
        <div data-ev-table-body>${renderEventsTableBody(rows, ctx.now)}</div>
        <div class="ev-skeleton" data-ev-skeleton hidden aria-hidden="true">${skeletonRows(6)}</div>
      </div>
      <p class="sub muted pad-b8" data-ev-filtered-empty hidden>No events match this filter.</p>
      <button type="button" class="btn ev-load-older" data-ev-load-older hidden>Load older</button>
    </article>
  </div>`

  const crmPane = `<div data-ev-pane="crm" hidden>
    <article class="card pad-b10">
      ${crmStatusChipsHtml(data.crm.counts, data.crm.rows.length)}
      ${crmFunnelHtml(data.crm.funnel)}
    </article>
    <article class="card pad-b10">
      ${crmSendsTable(data.crm.rows, ctx.now)}
    </article>
  </div>`

  const drawer = detailDrawer({
    id: 'event-drawer',
    title: 'Event',
    footer: '<div class="ev-drawer-links" data-drawer-links></div>'
  })

  return `${pageHeader({
    title: 'Events',
    subtitle: 'Everything the fleet reported, newest first.',
    tabs: [
      { id: 'events', label: 'Events', active: true },
      { id: 'asks', label: 'Asks' },
      { id: 'crm', label: 'CRM' }
    ]
  })}
  ${eventsPane}
  ${crmPane}
  ${drawer}
  <div class="ev-drawer-backdrop" hidden data-drawer-backdrop="event-drawer"></div>`
}
