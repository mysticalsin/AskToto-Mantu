/**
 * Sessions page (plan 6.5): a `dataTable` of real seat sessions (heartbeats + asks + recaps
 * materialized in `sessions`, operator/src/routes/sessions.ts), a toolbar (search, filters,
 * range, column View), and a drawer built from the session's own timeline
 * (`GET /v1/admin/sessions/:id.json`) plus the seat's device-wide history
 * (`GET /v1/admin/seats/:id/timeline.json`, task B4) for license state, group and the connectors
 * this seat received.
 *
 * `DashboardPayload` (operator/src/dashboard.ts, shared, not owned by this page) has no
 * session-grain rows -- only `profiles`, one row per seat. So first paint renders the toolbar and
 * a skeleton (a legitimate loading state, plan 9c2's "skeleton, empty and inline error states"),
 * and `operator/client/pages/sessions.ts` hydrates it immediately with the real
 * `/v1/admin/sessions.json` rows, the same JSON a browser always fetches for this page (plan D2).
 * `SessionsPageData.sessions` lets a caller that DOES have the real rows up front (this page's own
 * fixture, `sessions.fixture.ts`, and any future first-paint enhancement) skip the empty skeleton
 * and render real rows immediately -- the render logic is identical either way.
 */
import type { DashboardPayload } from '../../dashboard'
import type { SessionListRow } from '../../routes/sessions'
import type { SeatLicenseState, SeatTimelineRow } from '../../routes/seat-timeline'
import {
  avatar,
  chip,
  clientChip,
  countryCell,
  dataTable,
  emptyState,
  esc,
  exportMenu,
  kindBadge,
  logoGlyph,
  osChip,
  pageHeader,
  relativeTime,
  skeletonRows,
  sourceTooltip,
  statusDot,
  tierBadge,
  timeCell,
  toolbar,
  toolbarButton,
  toolbarSearch,
  viewButton,
  type DataTableColumn,
  type DataTableRow,
  type RenderCtx,
  type StatusDotState
} from '../index'
import { looksLikeSecret } from '../../redact'

export type SessionsPageData = DashboardPayload & { sessions?: SessionListRow[] }

/** Spelled-out "no value" placeholder (never an em dash: this page's non-negotiable lock is
 *  stricter than the shared `_shared.ts` MISSING convention other pages still use). Mirrors
 *  `field()`'s secret-redaction safety property. */
const NOT_REPORTED = '<span class="muted">not reported</span>'

function displayField(value: string | null | undefined): string {
  if (!value || looksLikeSecret(value)) return NOT_REPORTED
  return esc(value)
}

export const SESSIONS_COLUMNS: DataTableColumn[] = [
  { key: 'started', label: 'Started' },
  { key: 'session', label: 'Session' },
  { key: 'profile', label: 'Profile' },
  { key: 'seat', label: 'Seat' },
  { key: 'place', label: 'Country / City' },
  { key: 'os', label: 'OS' },
  { key: 'client', label: 'Client' },
  { key: 'tier', label: 'Tier' },
  { key: 'duration', label: 'Duration' },
  { key: 'events', label: 'Events' },
  { key: 'asks', label: 'Asks' },
  { key: 'recaps', label: 'Recaps' },
  { key: 'live', label: 'Live' }
]

/** `4212ms` -> `"1:10:12"` / `"4:12"`, mono, never fractional seconds. */
export function formatSessionDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

/** Elapsed time since a session (or seat activity) started, for the drawer timeline's
 *  "kind badge + relative offset" rows (plan 6.5). Offset from the session start, never wall
 *  clock "ago" -- these are ordered events inside one session, not a live feed. */
export function offsetLabel(ts: number, startedAt: number): string {
  const total = Math.max(0, Math.round((ts - startedAt) / 1000))
  if (total < 60) return `+${total}s`
  const m = Math.floor(total / 60)
  const s = total % 60
  if (m < 60) return s ? `+${m}m ${s}s` : `+${m}m`
  const h = Math.floor(m / 60)
  const mm = m % 60
  return mm ? `+${h}h ${mm}m` : `+${h}h`
}

function shortId(id: string, len = 8): string {
  const short = id.length > len ? id.slice(0, len) : id
  return `<span class="mono" title="${esc(id)}">${esc(short)}</span>`
}

/** The small pulsing live indicator (the same `.live` + `data-beacon` pattern
 *  operator/src/render/live.ts's `liveCard()` and metric-tiles.ts already use for a beacon dot),
 *  paired with a visible text label so live-ness is never colour alone. */
function liveCell(isLive: boolean): string {
  if (!isLive) return statusDot({ state: 'idle', label: 'Idle' })
  return `<span class="session-live"><span class="live" aria-hidden="true" data-beacon></span><span>Live</span></span>`
}

const LICENSE_STATE_DOT: Record<SeatLicenseState, { state: StatusDotState; label: string }> = {
  approved: { state: 'live', label: 'Approved' },
  licensed: { state: 'live', label: 'Licensed' },
  pending: { state: 'pending', label: 'Pending' },
  revoked: { state: 'revoked', label: 'Revoked' },
  expired: { state: 'failed', label: 'Expired' },
  unknown: { state: 'idle', label: 'Not reported' }
}

export function licenseStateBadge(state: SeatLicenseState | null | undefined): string {
  const entry = LICENSE_STATE_DOT[state ?? 'unknown']
  return statusDot(entry)
}

export function sessionRow(row: SessionListRow, now: number): DataTableRow {
  const tier = row.tier === 'metis' || row.tier === 'metis-light' ? row.tier : null
  const liveAttrs = row.live ? ` data-live-duration data-started-at="${row.startedAt}"` : ''
  const cells: Record<string, string> = {
    started: timeCell(row.startedAt, now),
    session: shortId(row.id),
    profile: `<span class="session-profile">${avatar({ name: row.hostname || row.email || row.deviceId, email: row.email, live: row.live })}<span class="session-profile-text"><strong>${displayField(row.hostname)}</strong><span class="muted">${displayField(row.email)}</span></span></span>`,
    seat: shortId(row.deviceId, 10),
    place: countryCell(row.country, { secondary: row.city || undefined }),
    os: osChip(row.os) || NOT_REPORTED,
    client: clientChip(row.appVersion) || NOT_REPORTED,
    tier: tierBadge(tier) || NOT_REPORTED,
    duration: `<span class="mono"${liveAttrs}>${esc(formatSessionDuration(row.durationMs))}</span>`,
    events: `<span class="mono">${row.pulses}</span>`,
    asks: `<span class="mono">${row.asks}</span>`,
    recaps: `<span class="mono">${row.recaps}</span>`,
    live: liveCell(row.live)
  }
  // `data-seat-*` (never rendered, kept for a client-side reader only): operator/client/search.ts
  // (the rail's "search seats, licenses, groups" field, plan 3.7 item 7) indexes seat rows by
  // these exact attributes wherever they appear in the document; this page is that index's only
  // source, so a session row keeps carrying them alongside its own data-session-row/data-device
  // rather than only the newer names, or the rail search would silently stop finding seats.
  const haystack = `${row.hostname || ''} ${row.email || ''} ${row.city || ''} ${row.country || ''} ${row.deviceId} ${row.os || ''}`.toLowerCase()
  return {
    cells,
    attrs: `data-session-row="${esc(row.id)}" data-device="${esc(row.deviceId)}" data-seat-row data-seat-computer="${esc(row.hostname || row.deviceId)}" data-seat-identity="${esc(row.email || '')}" data-seat-status-id="${row.live ? 'live' : 'idle'}" data-q="${esc(haystack)}" tabindex="0" role="button" aria-label="Open session ${esc(row.id)}"`
  }
}

/** The table (or its skeleton, or its named empty state) -- exported so
 * operator/client/pages/sessions.ts can re-render exactly this after every fetch, first paint or
 * live refresh, without duplicating the column set or the row shaping. `rows === null` means "not
 * loaded yet" (skeleton); `[]` means "loaded, genuinely empty" (named empty state via `dataTable`
 * itself). */
export function renderSessionsTableBody(rows: SessionListRow[] | null, now: number): string {
  if (rows == null) {
    return `<div class="table-wrap"><div class="sessions-skeleton" data-sessions-skeleton aria-hidden="true">${skeletonRows(8)}</div></div>`
  }
  return dataTable({
    id: 'sessions-table',
    columns: SESSIONS_COLUMNS,
    rows: rows.map((r) => sessionRow(r, now)),
    emptyTitle: 'No sessions yet.',
    emptyDescription: 'A session appears here once a seat sends its first heartbeat or ask.'
  })
}

function rangeSelect(): string {
  return `<label class="tool-select-wrap"><span class="sr-only">Range</span>
    <select class="tool-select" data-sessions-range aria-label="Range">
      <option value="24h" selected>Last 24 h</option>
      <option value="7d">Last 7 d</option>
      <option value="30d">Last 30 d</option>
    </select></label>`
}

function filtersPanel(): string {
  return `<div class="sessions-panel sessions-filters" data-filters-panel hidden role="group" aria-label="Filters">
    <label>Live<select data-filter="live"><option value="">Any</option><option value="live">Live now</option><option value="idle">Idle</option></select></label>
    <label>Tier<select data-filter="tier"><option value="">Any</option><option value="metis">M&eacute;tis</option><option value="metis-light">M&eacute;tis Light</option></select></label>
    <label>OS<select data-filter="os"><option value="">Any</option><option value="darwin">macOS</option><option value="win">Windows</option><option value="linux">Linux</option></select></label>
    <label>Country<input type="text" data-filter="country" placeholder="e.g. CA" maxlength="2" autocomplete="off"></label>
    <label>Version<input type="text" data-filter="version" placeholder="e.g. 1.8.5" autocomplete="off"></label>
  </div>`
}

function viewPanel(): string {
  const items = SESSIONS_COLUMNS.map(
    (c, i) => `<label><input type="checkbox" checked data-col-toggle="${i + 1}"> ${esc(c.label)}</label>`
  ).join('')
  return `<div class="sessions-panel sessions-view" data-view-panel hidden role="group" aria-label="Columns">${items}</div>`
}

function toolbarLeft(): string {
  return `${rangeSelect()}
    <span class="sessions-menu-wrap">${toolbarButton({ label: 'Filters', attrs: 'data-filters-toggle aria-haspopup="true" aria-expanded="false"' })}${filtersPanel()}</span>`
}

function toolbarRight(): string {
  return `<span class="sessions-menu-wrap">${viewButton({ attrs: 'data-view-toggle aria-haspopup="true" aria-expanded="false"' })}${viewPanel()}</span>
    <div class="sessions-export">
      ${exportMenu({ csvHref: '/v1/admin/export.csv?table=sessions', label: 'Export CSV' })}
      ${exportMenu({ csvHref: '/v1/admin/export.xlsx?table=sessions', label: 'Export Excel' })}
    </div>`
}

function sessionsToolbar(): string {
  return toolbar({
    left: toolbarLeft(),
    right: toolbarRight(),
    search: toolbarSearch({ id: 'sessions-toolbar-search', placeholder: 'Search hostname, email, device, city…' })
  })
}

/** The drawer's server-rendered shell: glass header, close button, and a placeholder body.
 * operator/client/pages/sessions.ts fills `[data-drawer-body]` from the two JSON routes on row
 * click (plan 6.5: "session drawer from /v1/admin/sessions/:id.json plus the seat timeline
 * route"), the same "shell now, content on interaction" shape `detailDrawer()` itself uses. */
function sessionDrawerShell(): string {
  return `<aside id="session-drawer" class="seat-overlay session-drawer" hidden role="dialog" aria-modal="true" aria-labelledby="session-drawer-title" data-session-drawer>
    <div class="seat-overlay-head glass">
      <h4 id="session-drawer-title" data-drawer-title>Session</h4>
      <button type="button" class="btn" id="session-drawer-close" aria-label="Close">Close</button>
    </div>
    <div class="session-drawer-body" data-drawer-body>
      ${emptyState({ title: 'Select a session.', description: 'Click a row to see its timeline, asks and connectors.' })}
    </div>
  </aside>`
}

export function renderSessions(data: SessionsPageData, ctx: RenderCtx): string {
  const rows = data.sessions ?? null
  return `${pageHeader({ title: 'Sessions', subtitle: 'Seat sessions built from heartbeats, asks and recaps.' })}
    <div data-sessions-root data-loaded="${rows == null ? 'false' : 'true'}">
      ${sessionsToolbar()}
      <article class="card pad-b10" data-sessions-table-wrap>
        ${renderSessionsTableBody(rows, ctx.now)}
      </article>
    </div>
    ${sessionDrawerShell()}`
}

// ---------------------------------------------------------------------------------------------
// Drawer content (populated client-side from /v1/admin/sessions/:id.json and
// /v1/admin/seats/:id/timeline.json; exported so operator/client/pages/sessions.ts renders it
// through the same pure function first paint would use, never a second hand-built copy).
// ---------------------------------------------------------------------------------------------

export interface SessionAskDetail {
  id: string
  ts: number
  mode: string | null
  provider: string | null
  model: string | null
  outcome: string | null
  rating: string | null
  cacheStatus: string | null
  questionType: string | null
}

export interface SessionEventDetail {
  id: string
  ts: number
  kind: string
  detail: string | null
}

export interface SessionDetailResponse {
  ok: boolean
  session: SessionListRow
  events: SessionEventDetail[]
  asks: SessionAskDetail[]
}

export interface SeatTimelineResponse {
  ok: boolean
  deviceId: string
  seat: { hostname: string | null; email: string | null; os: string; appVersion: string; country: string | null; city: string | null } | null
  approval: string
  tier: string | null
  licenseState: SeatLicenseState
  group: { id: string; name: string } | null
  rows: SeatTimelineRow[]
  nextCursor: string | null
  gatewayCallsAvailable: boolean
}

function timelineEventsSection(events: SessionEventDetail[], startedAt: number): string {
  if (!events.length) return emptyState({ title: 'No events in this session yet.' })
  const sorted = [...events].sort((a, b) => a.ts - b.ts)
  const items = sorted
    .map(
      (e) =>
        `<li class="session-timeline-row"><span class="session-timeline-dot" aria-hidden="true"></span>${kindBadge(e.kind)}<span class="mono session-timeline-offset">${esc(offsetLabel(e.ts, startedAt))}</span></li>`
    )
    .join('')
  return `<div class="session-timeline" data-timeline>
    <svg class="session-timeline-svg" data-timeline-svg aria-hidden="true" focusable="false"><path data-timeline-path d="M1,0 L1,0"/></svg>
    <ol class="session-timeline-list" data-timeline-list>${items}</ol>
  </div>`
}

function asksSection(asks: SessionAskDetail[], startedAt: number): string {
  if (!asks.length) return emptyState({ title: 'No asks in this session.' })
  const items = asks
    .map((a) => {
      const chips = [
        a.mode ? chip({ label: a.mode }) : '',
        a.questionType ? chip({ label: a.questionType }) : '',
        a.provider ? chip({ label: a.provider }) : '',
        a.model ? chip({ label: a.model }) : '',
        a.cacheStatus ? chip({ label: `cache ${a.cacheStatus}` }) : '',
        a.outcome ? chip({ label: a.outcome, tone: a.outcome === 'ok' ? 'ok' : a.outcome === 'error' ? 'danger' : 'default' }) : '',
        a.rating ? chip({ label: `rating ${a.rating}`, tone: 'accent' }) : ''
      ]
        .filter(Boolean)
        .join('')
      return `<li class="session-ask-row" data-stagger><span class="mono session-ask-offset">${esc(offsetLabel(a.ts, startedAt))}</span><span class="session-ask-chips">${chips}</span></li>`
    })
    .join('')
  return `<ul class="session-ask-list">${items}</ul>`
}

function connectorsSection(grants: SeatTimelineRow[] | null, now: number): string {
  if (grants == null) {
    return `<div class="sessions-skeleton" aria-hidden="true">${skeletonRows(2)}</div>`
  }
  if (!grants.length) {
    return emptyState({
      title: 'No connectors delivered to this seat.',
      description: 'A connector appears here once Tony connects it and this seat is entitled to it.'
    })
  }
  const items = grants
    .map((g) => {
      const kind = g.connectorKind || 'custom-mcp'
      const label = g.connectorLabel || kind
      return `<li class="session-connector-row" data-stagger>${logoGlyph(kind, label, { size: 20 })}<span>${esc(label)}</span><span class="muted mono">${esc(relativeTime(g.ts, now))}</span></li>`
    })
    .join('')
  return `<ul class="session-connectors">${items}</ul>`
}

/** Renders the drawer's full body from the two JSON responses. `timeline` is `null` while that
 * fetch is still in flight (or failed) -- the identity header and asks/timeline sections come
 * entirely from `detail`, so the drawer is still useful before `timeline` resolves; only license
 * state, group and connectors wait on it. */
export function renderSessionDrawerBody(detail: SessionDetailResponse, timeline: SeatTimelineResponse | null, now: number): string {
  const session = detail.session
  const tier = session.tier === 'metis' || session.tier === 'metis-light' ? session.tier : null
  const hostname = timeline?.seat?.hostname ?? session.hostname
  const email = timeline?.seat?.email ?? session.email
  const country = timeline?.seat?.country ?? session.country
  const city = timeline?.seat?.city ?? session.city

  return `
    <div class="session-drawer-identity">
      ${avatar({ name: hostname || email || session.deviceId, email, live: session.live })}
      <div>
        <div class="session-drawer-name">${displayField(hostname)}</div>
        <div class="muted">${displayField(email)}</div>
      </div>
    </div>
    <div class="session-drawer-fields">
      <div class="seat-field"><span class="lbl">Session</span><span class="val">${shortId(session.id, 12)}</span></div>
      <div class="seat-field"><span class="lbl">Seat</span><span class="val">${shortId(session.deviceId, 14)} <button type="button" class="btn tiny" data-copy-device="${esc(session.deviceId)}">Copy device id</button></span></div>
      <div class="seat-field"><span class="lbl">Country / City</span><span class="val">${countryCell(country, { secondary: city || undefined })}</span></div>
      <div class="seat-field"><span class="lbl">OS</span><span class="val">${osChip(session.os) || NOT_REPORTED}</span></div>
      <div class="seat-field"><span class="lbl">Client</span><span class="val">${clientChip(session.appVersion) || NOT_REPORTED}</span></div>
      <div class="seat-field"><span class="lbl">Tier</span><span class="val">${tierBadge(tier) || NOT_REPORTED}</span></div>
      <div class="seat-field"><span class="lbl">License</span><span class="val" data-license-state>${timeline ? licenseStateBadge(timeline.licenseState) : `${licenseStateBadge(null)}${sourceTooltip("Loading this seat's license state", '/v1/admin/seats/:id/timeline.json')}`}</span></div>
    </div>
    <div class="session-license-actions" data-license-actions>
      <button type="button" class="btn primary" data-session-approve="${esc(session.deviceId)}">Approve</button>
      <button type="button" class="btn danger" data-session-revoke="${esc(session.deviceId)}">Revoke</button>
    </div>
    <div class="session-drawer-links">
      <a class="chip" href="#licenses">Open in Licenses</a>
      ${timeline?.group ? `<a class="chip" href="#groups/${esc(timeline.group.id)}">${esc(timeline.group.name)}</a>` : '<span class="chip">No group</span>'}
    </div>
    <div class="session-drawer-section">
      <p class="eyebrow">Timeline</p>
      ${timelineEventsSection(detail.events, session.startedAt)}
    </div>
    <div class="session-drawer-section">
      <p class="eyebrow">Asks</p>
      ${asksSection(detail.asks, session.startedAt)}
    </div>
    <div class="session-drawer-section">
      <p class="eyebrow">Connectors this seat received</p>
      ${connectorsSection(timeline ? timeline.rows.filter((r) => r.kind === 'grant') : null, now)}
    </div>`
}

export function sessionDrawerLoadingBody(): string {
  return `<div class="session-drawer-loading" aria-hidden="true">${skeletonRows(6)}</div>`
}
