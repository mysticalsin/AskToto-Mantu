/**
 * Events page (plan 6.4, P1.3 brief, rewritten 2026-09-06 to the shoey-ref/events-1440.png
 * fidelity clause). Four tabs: Events, Asks, CRM, Stats. Events/Asks share one filterable,
 * cursor-paginated dataTable (Asks is that same table pre-filtered to kind=ask, never a second
 * table); CRM takes over the funnel + sends telemetry that used to live on Notifications (plan
 * 6.8); Stats is its own tab, entirely client-fetched (see the Stats section below).
 *
 * Row anatomy matches the reference's column order minus its Browser slot (Métis has no
 * browser): Created at, Name, Profile, Country, Platform, Detail. Platform carries the real OS
 * mark plus the OS name as its primary line and the Métis client version as its secondary line --
 * the slot the reference gives the browser.
 *
 * Server/client split (plan D2): `renderEvents(data, ctx)` renders first paint from
 * `DashboardPayload.events` (a `ConsoleEvent[]`, merged from the stored events table plus
 * synthetic ask/crm rows -- see operator/src/dashboard.ts `mergeEvents()`). That shape carries no
 * `appVersion` and only an 8-char device prefix, so the Platform cell's Métis-version line and
 * exact seat links read "Not reported" until the client hydrates from the real `GET
 * /v1/admin/events.json` (richer: full `deviceId`, `appVersion`) moments after mount -- a true
 * reflection of what has loaded, never a stub value. `EventRowLike` is the shape both sources
 * normalize into, and `renderEventRowsHtml` is the one row template both the initial
 * `dataTable()` call and every later client-side patch (hydrate, Load older, Listening prepend)
 * build rows from, so server and client never drift.
 *
 * Ask trace (drawer, "never text" per lock 2): `GET /v1/admin/asks` returns full `AskRow`s with
 * the prompt fields stripped. There is no shared id between an `events` row and its `asks` row
 * (the Worker mints two separate ids at ingest, see operator/src/index.ts's ask handler), but both
 * inserts share the exact same `ts` and `device_id` value from that one request -- `findAskTrace`
 * joins on that pair (a device-id prefix match covers the SSR path, whose chips only carry the
 * first 8 characters). The same join, duplicated in operator/src/routes/events.ts because routes/
 * never depends on render/, is how the Name cell's inline question type gets to an ask row.
 */
import type { ConsoleEvent, DashboardPayload } from '../../dashboard'
import { looksLikeSecret, type SafeChip } from '../../redact'
import { CRM_FILTER_ORDER, type CrmStatus } from '../../crm'
import { statusBadge } from '../../components/ui/status-badge'
import { estimateCacheCost, formatUsdEstimate, type StreamCacheUsage } from '../../../../src/shared/operator'
import { isQuestionType, QUESTION_TYPE_LABELS } from '../../../../src/shared/question-type'
import { platformMarkSvg, type PlatformOs } from '../icons'
import {
  avatar,
  countryCell,
  dataTable,
  detailDrawer,
  esc,
  KIND_ICON_PATHS,
  kindBadge,
  metricTable,
  NAV_ICON_PATHS,
  pageHeader,
  segmented,
  skeletonRows,
  sourceTooltip,
  timeCell,
  toolbar,
  toolbarButton,
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
  /** Name cell (plan 6.4): for an ask row, the closed-taxonomy question type (never the prompt
   *  text) -- null for every non-ask row and for an ask whose join missed. */
  questionType: string | null
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
  questionType: string | null
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
    deviceId: get('device'),
    questionType: get('questionType')
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
    deviceId: row.deviceId,
    questionType: row.questionType
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

/** Column order matches the reference exactly minus its Browser slot, which Métis has no
 *  equivalent for (plan 6.4, Tony 2026-09-06 correction): Created at, Name, Profile, Country,
 *  Platform, Detail. The reference's OS + Browser pair collapses into one Platform cell (the
 *  real OS mark plus the Métis client version as its secondary line) rather than keeping a
 *  seventh column for a browser Métis does not have. */
const EVENT_COLUMNS: DataTableColumn[] = [
  { key: 'created', label: 'Created at' },
  { key: 'name', label: 'Name' },
  { key: 'profile', label: 'Profile' },
  { key: 'country', label: 'Country' },
  { key: 'platform', label: 'Platform' },
  { key: 'detail', label: 'Detail' }
]

/** Column keys the View menu can hide (plan: "View (column visibility)"). Created at / Name /
 *  Profile stay mandatory -- without them a row is not identifiable at all. */
export const EVENT_OPTIONAL_COLUMNS = ['country', 'platform', 'detail'] as const
export type EventOptionalColumn = (typeof EVENT_OPTIONAL_COLUMNS)[number]
const EVENT_OPTIONAL_COLUMN_LABEL: Record<EventOptionalColumn, string> = {
  country: 'Country',
  platform: 'Platform',
  detail: 'Detail'
}

function safeOrNull(value: string | null): string | null {
  return value && !looksLikeSecret(value) ? value : null
}

/** Name cell (plan 6.4): "for an ask its question type follows in --ink-3, never the question
 *  text". `question_type` is a closed taxonomy (src/shared/question-type.ts) crossing the wire
 *  as a label already, or a raw stored value on the SSR/legacy path -- either way this only ever
 *  emits the classification, never anything that could be prompt text. */
function askQuestionTypeLabel(questionType: string | null): string | null {
  if (!questionType) return null
  return isQuestionType(questionType) ? QUESTION_TYPE_LABELS[questionType] : null
}

/** Row anatomy (plan 6.4): "an unidentified seat reads 'Seat 4f2c' from its short device id,
 *  never 'Anonymous' and never an invented name." The reference shows "Anonymous" for a web
 *  visitor with no login; Métis has no such thing (every row is a real installed seat), so the
 *  one honest fallback when a hostname was never reported is the seat's own short id, never a
 *  fabricated name and never the reference's wording. */
function profileCellHtml(row: EventRowLike): string {
  const hostname = safeOrNull(row.hostname)
  const email = safeOrNull(row.email)
  const shortSeatId = row.deviceId ? row.deviceId.slice(-4) : null
  const primary = hostname || (shortSeatId ? `Seat ${shortSeatId}` : 'Unidentified seat')
  const secondary = email || MISSING
  return `<span class="ev-profile-cell">${avatar({ name: hostname || email || primary, email })}<span class="ev-profile-text"><span class="ev-profile-name">${esc(
    primary
  )}</span><span class="muted ev-profile-email">${esc(secondary)}</span></span></span>`
}

/** Country cell (plan 6.4 / 3.6): `countryCell` -- flag, country name, city underneath -- rather
 *  than the old bare `flag() + field(city||country)` pair. */
function countryCellHtml(row: EventRowLike): string {
  return countryCell(row.country, { secondary: safeOrNull(row.city) || undefined })
}

const PLATFORM_OS_LABEL: Record<PlatformOs, string> = { darwin: 'macOS', win: 'Windows', linux: 'Linux' }

function platformOsOf(os: string | null | undefined): PlatformOs | null {
  const raw = String(os || '').trim().toLowerCase()
  if (raw === 'darwin' || raw === 'macos' || raw === 'mac') return 'darwin'
  if (raw === 'win' || raw === 'win32' || raw === 'windows') return 'win'
  if (raw === 'linux') return 'linux'
  return null
}

/** Platform cell (plan 6.4, Tony 2026-09-06 correction): the real OS mark plus the OS name as
 *  the primary line, and the Métis client version as the secondary line in --ink-3 -- the slot
 *  the reference gives the browser, since Métis has no browser. `appVersion` reads "Not
 *  reported" (never a stub) until the client hydrates the richer events.json row (see the file
 *  header doc comment on why SSR cannot know it yet). */
function platformCellHtml(row: EventRowLike): string {
  const key = platformOsOf(row.os)
  if (!key) return MISSING
  const version = row.appVersion ? `Métis ${row.appVersion}` : 'Not reported'
  return `<span class="ev-platform-cell">${platformMarkSvg(key, { class: 'ev-platform-mark' })}<span class="ev-platform-text"><span class="ev-platform-os">${esc(
    PLATFORM_OS_LABEL[key]
  )}</span><span class="muted ev-platform-version">${esc(version)}</span></span></span>`
}

/** Detail cell (plan 6.4): "the redacted detail string, truncated with the full value in the
 *  title" -- one line, ellipsis, never wrapped (plan rule). */
function detailCellHtml(detail: string | null): string {
  const safe = safeOrNull(detail)
  if (!safe) return MISSING
  return `<span class="ev-detail-cell" title="${esc(safe)}">${esc(safe)}</span>`
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
    deviceId: safeOrNull(row.deviceId),
    questionType: safeOrNull(row.questionType)
  }
}

function eventRowParts(row: EventRowLike, now: number): { attrs: string; cells: Record<string, string> } {
  const safe = redactRowForAttrs(row)
  const q = [safe.kind, safe.hostname, safe.email, safe.country, safe.city, safe.os, safe.detail]
    .filter((v): v is string => Boolean(v))
    .join(' ')
    .toLowerCase()
  const payload = esc(JSON.stringify(safe))
  const qType = row.kind === 'ask' ? askQuestionTypeLabel(row.questionType) : null
  const name = qType ? `${kindBadge(row.kind)}<span class="muted ev-name-qtype">${esc(qType)}</span>` : kindBadge(row.kind)
  return {
    // data-event (not just data-event-id) is kept for operator/src/ui.console.test.ts's
    // pre-existing "events never render token-like strings" contract, unrelated to this rebuild.
    attrs: `data-event-row data-event="${esc(row.id)}" data-event-id="${esc(row.id)}" data-kind="${esc(row.kind)}" data-q="${esc(q)}" data-row="${payload}"`,
    cells: {
      created: timeCell(row.ts, now),
      name,
      profile: profileCellHtml(row),
      country: countryCellHtml(row),
      platform: platformCellHtml(row),
      detail: detailCellHtml(row.detail)
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

// ---------------------------------------------------------------------------------------------
// Stats tab (plan 6.4): the same range and filters as the Events table, no second set of
// controls. Entirely client-fetched from GET /v1/admin/events-stats.json (operator/src/routes/
// events.ts) -- the SSR pane below is a named skeleton, never a duplicate, out-of-sync
// computation of the same aggregation. Render functions are exported so the client builds the
// exact same markup after every fetch (mirrors renderEventsTableBody's own contract).
// ---------------------------------------------------------------------------------------------

export interface EventsStatsCountRowLike {
  key: string
  count: number
}

export interface EventsStatsSeriesPointLike {
  start: number
  count: number
}

export interface EventsStatsPayloadLike {
  since: number
  until: number
  truncated: boolean
  byKind: EventsStatsCountRowLike[]
  askKindIncluded: boolean
  questionTypes: EventsStatsCountRowLike[]
  questionTypeCoverage: number | null
  providers: EventsStatsCountRowLike[]
  models: EventsStatsCountRowLike[]
  os: EventsStatsCountRowLike[]
  clientVersions: EventsStatsCountRowLike[]
  series: EventsStatsSeriesPointLike[]
  seriesBucketMs: number
}

/** Display label (routes/events.ts's own osLabelOf(), duplicated the same layering-boundary way
 *  that file duplicates platform/question-type helpers rather than importing across it) -> the
 *  raw `os` filter value the toolbar's Filters panel understands, for a Stats row's click-through.
 *  "Unknown" has no real filter value, so it stays out of this map and that row renders inert. */
const OS_LABEL_TO_FILTER: Record<string, string> = { macOS: 'darwin', Windows: 'win', Linux: 'linux' }

function statsWindowNote(table: string, since: number, until: number, truncated?: boolean): string {
  const fmt = (ts: number): string => new Date(ts).toISOString().replace('T', ' ').slice(0, 16)
  const cap = truncated ? ', capped to the most recent matching rows -- an older match may be missing' : ''
  return `${table} table, ${fmt(since)} to ${fmt(until)} UTC${cap}`
}

function statsRowAttrs(filterKey: 'kind' | 'os' | 'version', value: string | undefined): string {
  if (!value) return ''
  return `data-ev-stats-row="${esc(filterKey)}" data-ev-stats-key="${esc(value)}" role="button" tabindex="0"`
}

function statsCountTable(opts: {
  title: string
  labelHeader: string
  source: string
  rows: EventsStatsCountRowLike[]
  emptyTitle: string
  /** Kind rows get the same tinted badge the table's own Name cell uses instead of plain text. */
  kindIcons?: boolean
  filterKey?: 'kind' | 'os' | 'version'
  keyToFilterValue?: (key: string) => string | undefined
}): string {
  return metricTable({
    title: opts.title,
    labelHeader: opts.labelHeader,
    headerIcons: [sourceTooltip(`Count by ${opts.labelHeader.toLowerCase()}`, opts.source)],
    columns: [{ key: 'count', label: 'Count' }],
    rows: opts.rows.map((r) => ({
      icon: opts.kindIcons ? kindBadge(r.key) : undefined,
      label: opts.kindIcons ? '' : r.key,
      barValue: r.count,
      cells: { count: r.count.toLocaleString('en-US') },
      attrs: opts.filterKey ? statsRowAttrs(opts.filterKey, opts.keyToFilterValue ? opts.keyToFilterValue(r.key) : r.key) : ''
    })),
    emptyTitle: opts.emptyTitle
  })
}

/** The five metricTables (plan: "every dimension the row shows can also be read as a total"),
 *  built from one GET /v1/admin/events-stats.json response. Exported so the client rebuilds this
 *  exact markup after every fetch. */
export function renderEventsStatsTables(stats: EventsStatsPayloadLike): string {
  const eventsNote = statsWindowNote('events', stats.since, stats.until, stats.truncated)
  const askNote = statsWindowNote('asks', stats.since, stats.until)
  const askEmpty = stats.askKindIncluded ? 'No asks in this range.' : 'The kind filter excludes ask, so there is nothing to show here.'
  return [
    statsCountTable({
      title: 'Event kinds',
      labelHeader: 'Kind',
      source: eventsNote,
      rows: stats.byKind,
      emptyTitle: 'No events in this range.',
      kindIcons: true,
      filterKey: 'kind'
    }),
    statsCountTable({
      title: 'Ask question types',
      labelHeader: 'Question type',
      source:
        stats.questionTypeCoverage != null
          ? `${askNote}. ${Math.round(stats.questionTypeCoverage * 100)}% of matching asks carried a classification.`
          : askNote,
      rows: stats.questionTypes,
      emptyTitle: askEmpty
    }),
    statsCountTable({ title: 'Providers', labelHeader: 'Provider', source: askNote, rows: stats.providers, emptyTitle: askEmpty }),
    statsCountTable({ title: 'Models', labelHeader: 'Model', source: askNote, rows: stats.models, emptyTitle: askEmpty }),
    statsCountTable({
      title: 'OS',
      labelHeader: 'OS',
      source: eventsNote,
      rows: stats.os,
      emptyTitle: 'No seats reported yet.',
      filterKey: 'os',
      keyToFilterValue: (key) => OS_LABEL_TO_FILTER[key]
    }),
    statsCountTable({
      title: 'Client version',
      labelHeader: 'Version',
      source: eventsNote,
      rows: stats.clientVersions.map((r) => ({ key: `Métis ${r.key}`, count: r.count })),
      emptyTitle: 'No seats reported yet.',
      filterKey: 'version',
      keyToFilterValue: (key) => stats.clientVersions.find((r) => `Métis ${r.key}` === key)?.key
    })
  ].join('')
}

/** A small bucketed bar series ("so a spike is visible before it is explained", plan 6.4) --
 *  every bar's native `<title>` names the exact bucket window and count, in addition to the
 *  block-level sourceTooltip() above it, so every number here carries a source. Bars render even
 *  at 0 (the honest value), never a fabricated placeholder shape. */
export function renderEventsStatsSeries(stats: EventsStatsPayloadLike): string {
  const points = stats.series
  const w = 720
  const h = 56
  const gap = 2
  const n = Math.max(1, points.length)
  const max = Math.max(1, ...points.map((p) => p.count))
  const bw = Math.max(2, (w - gap * (n + 1)) / n)
  const bucketLabel = stats.seriesBucketMs >= 24 * 60 * 60 * 1000 ? 'day' : stats.seriesBucketMs >= 60 * 60 * 1000 ? 'hour' : `${Math.round(stats.seriesBucketMs / 60000)} min`
  const bars = points
    .map((p, i) => {
      const bh = Math.max(2, Math.round((p.count / max) * (h - 4)))
      const x = gap + i * (bw + gap)
      const y = h - bh
      const iso = new Date(p.start).toISOString().replace('T', ' ').slice(0, 16)
      return `<rect x="${x.toFixed(1)}" y="${y}" width="${bw.toFixed(1)}" height="${bh}" rx="1" fill="var(--data-1)" data-grow data-grow-delay="${i * 20}"><title>${esc(
        iso
      )} UTC, one ${esc(bucketLabel)} bucket: ${p.count} event${p.count === 1 ? '' : 's'}</title></rect>`
    })
    .join('')
  return `<svg class="ev-stats-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Events per ${esc(bucketLabel)} over the selected range">${bars}</svg>`
}

function statsPaneHtml(): string {
  return `<div data-ev-pane="stats" hidden>
    <article class="card pad-b10">
      <div class="ev-kind-heading"><span class="ev-kind-label">Events over the selected range</span>${sourceTooltip(
        'Count of matching events per bucket',
        'events table, resolved range and filters'
      )}</div>
      <div class="ev-stats-series-wrap" data-ev-stats-series aria-live="polite"></div>
    </article>
    <article class="card pad-b10" data-ev-stats-tables aria-live="polite">
      <div class="ev-skeleton" data-ev-stats-skeleton aria-hidden="true">${skeletonRows(6)}</div>
    </article>
  </div>`
}

export function renderEvents(data: DashboardPayload, ctx: RenderCtx): string {
  const allRows = data.events.map(normalizeConsoleEvent)
  const rows = allRows.slice(0, FIRST_PAINT_ROW_LIMIT)
  const counts: Record<string, number> = {}
  for (const row of allRows) counts[row.kind] = (counts[row.kind] ?? 0) + 1

  const eventsPane = `<div data-ev-pane="events">
    <article class="card ev-toolbar-card">
      ${toolbar({
        left: `${listenToggleHtml()}${rangeMenuHtml()}${filtersMenuHtml()}`,
        right: viewMenuHtml()
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

  const statsPane = statsPaneHtml()

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
      { id: 'crm', label: 'CRM' },
      { id: 'stats', label: 'Stats' }
    ]
  })}
  ${eventsPane}
  ${crmPane}
  ${statsPane}
  ${drawer}
  <div class="ev-drawer-backdrop" hidden data-drawer-backdrop="event-drawer"></div>`
}
