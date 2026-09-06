/**
 * Notifications page (plan 6.8, P1.7 brief). Full rebuild off the "moved out of ui.ts unchanged"
 * P0.4 prototype: the CRM funnel and the skill diff editor leave this page for good (Events > CRM
 * and Settings > Skills own them now, plan 6.8); this page is the fleet's single "what needs
 * attention" inbox across six notice kinds: Seat, License, CRM, Connector, Skill, Platform.
 *
 * Data sources (plan 6.8: "data.notices + platform notices from health.json"):
 *  - Seat / CRM / Skill notices come straight from `data.notices` (operator/src/dashboard.ts's
 *    `buildNotices()`), whose `id` is a stable `<raw-kind>-<backend-id>` string (`seat-<deviceId>`,
 *    `crm-<crmId>`, `skill-<proposalId>`) -- parsed back into the raw id here so the inline action
 *    button knows which record to act on, rather than duplicating dashboard.ts's id scheme.
 *  - License notices (expiring within 7 days) are computed here, purely from `data.licenses.issued`
 *    (already on DashboardPayload for the Licenses page) -- no dashboard.ts change needed.
 *  - Connector and Platform notices are NOT on DashboardPayload (Connectors is its own JSON route,
 *    `/v1/admin/integrations`; platform health is `/v1/admin/health.json`, plan D2). This render
 *    function stays a pure, synchronous `(data, ctx) -> html` per the page module contract, so
 *    operator/client/pages/notifications.ts fetches both after mount and calls this function again
 *    with `extra` filled in once they resolve. First (server) paint always has `extra` empty; that
 *    is a true reflection of what has loaded, never a stub.
 */
import type { DashboardPayload } from '../../dashboard'
import {
  COUNTRY_NAMES,
  countryCell,
  dataTable,
  esc,
  iconSvg,
  KIND_ICON_PATHS,
  NAV_ICON_PATHS,
  osChip,
  pageHeader,
  timeCell,
  toolbar,
  toolbarButton,
  toolbarSearch,
  viewButton,
  type DataTableRow,
  type RenderCtx
} from '../index'
import { field, MISSING } from './_shared'

const DAY_MS = 24 * 60 * 60 * 1000
const EXPIRING_WINDOW_MS = 7 * DAY_MS

export type NoticeKind = 'seat' | 'license' | 'crm' | 'connector' | 'skill' | 'platform'

export const NOTICE_KIND_ORDER: readonly NoticeKind[] = ['seat', 'license', 'crm', 'connector', 'skill', 'platform']

const NOTICE_KIND_LABEL: Record<NoticeKind, string> = {
  seat: 'Seat',
  license: 'License',
  crm: 'CRM',
  connector: 'Connector',
  skill: 'Skill',
  platform: 'Platform'
}

const NOTICE_KIND_SOURCE: Record<NoticeKind, string> = {
  seat: 'Seats waiting for approval, from the last heartbeat.',
  license: 'Issued licenses expiring within 7 days, from the licenses table.',
  crm: 'CRM pushes that failed or expired, from the last 50 crm_sends rows.',
  connector: 'Connectors whose last test failed, from GET /v1/admin/integrations.',
  skill: 'Skill diffs waiting for a decision, from the proposals table.',
  platform: 'Missing schema or unbound secrets, from GET /v1/admin/health.json.'
}

/** Lucide "graduation-cap" (ISC), copied as inline path data -- the same sourcing convention as
 * operator/src/render/icons.ts, kept local here because no other page needs a Skill-shaped icon
 * and icons.ts is a file this page does not own. */
const SKILL_ICON_PATH =
  '<path d="M21.42 10.922a1 1 0 0 0-.019-1.838L12.83 5.18a2 2 0 0 0-1.66 0L2.6 9.08a1 1 0 0 0 0 1.832l8.57 3.908a2 2 0 0 0 1.66 0z"/><path d="M22 10v6"/><path d="M6 12.5V16a6 3 0 0 0 12 0v-3.5"/>'

/** Lucide "check" (ISC), copied the same way -- the inline action's success mark (plan 3.5b:
 * "the row's action area crossfades to a check mark"). Client-side only (operator/client/pages/
 * notifications.ts imports this), never rendered on first paint. */
export const NOTICE_CHECK_ICON_PATH = '<path d="M20 6 9 17l-5-5"/>'

function kindIconPath(kind: NoticeKind): string {
  if (kind === 'seat') return KIND_ICON_PATHS.seat
  if (kind === 'license') return KIND_ICON_PATHS.license
  if (kind === 'crm') return KIND_ICON_PATHS.crm
  if (kind === 'platform') return KIND_ICON_PATHS.platform
  if (kind === 'connector') return NAV_ICON_PATHS.plug
  return SKILL_ICON_PATH
}

/** The dataTable "Kind" column badge. Deliberately not operator/src/render/primitives.ts's
 * kindBadge(): that primitive's tint map is the ingest-event taxonomy (heartbeat/ask/recap/...)
 * design-lead owns, and two of these six notice kinds (Connector, Skill) are not ingest events at
 * all -- forcing them through kindBadge() would fall back to the generic grey "seat" tint,
 * making two of six chips indistinguishable. Reuses the shared `.kind-badge`/`.kind-icon` shape
 * from operator/src/spa/css.ts (design-lead's file, read-only here) plus this page's own two new
 * colour classes for connector/skill in operator/src/spa/css-notifications.ts. */
function noticeKindBadge(kind: NoticeKind): string {
  const icon = iconSvg(kindIconPath(kind), { class: 'kind-icon' })
  return `<span class="kind-badge kind-${kind}">${icon}<span>${esc(NOTICE_KIND_LABEL[kind])}</span></span>`
}

/** Connector/Platform notice inputs the client fetches (see file header). Kept as plain data
 * (never a class, never a DOM node) so this stays usable from both the Worker build and the
 * browser client build. */
export interface ConnectorNoticeInput {
  id: string
  label: string
  /** Sanitized probe error/summary text only -- never a raw exception, never a credential. */
  detail: string
  ts: number
}
export interface PlatformNoticeInput {
  id: string
  title: string
  detail: string
  ts: number
}
export interface NotificationsExtra {
  connectors?: ConnectorNoticeInput[]
  platform?: PlatformNoticeInput[]
}

type NoticeAction =
  | { type: 'approve-seat'; deviceId: string }
  | { type: 'revoke-license'; jti: string }
  | { type: 'retry-crm'; crmId: string }
  | { type: 'retest-connector'; connectorId: string }
  | { type: 'open-skill' }

interface NoticeRow {
  id: string
  kind: NoticeKind
  title: string
  detail: string
  /** Used for sort order only (newest/most-urgent first); never rendered directly. */
  sortTs: number
  profile: string | null
  /** ISO 3166-1 alpha-2, for the Country column's countryCell() (plan 3.6, 3.7b law 5: "flags
   * everywhere a country appears"). Null renders "Unknown" with no fabricated flag. */
  country: string | null
  city: string | null
  os: string | null
  /** Only license rows carry this -- the real expiry instant, for the "Expires in Nd" text and
   * its absolute-time tooltip (never reused as `sortTs`: a future timestamp would floor to "now"
   * under primitives.ts's relativeTime(), which assumes a past event). */
  expMs?: number
  action: NoticeAction | null
}

/** `buildNotices()` (operator/src/dashboard.ts) encodes the backend id into `notices[].id` as
 * `<raw-kind>-<backendId>`; this is that encoding's one consumer. A future change to that scheme
 * would need a matching change here -- flagged in this page's build report as a coupling point,
 * not fixed by adding an explicit field to DashboardPayload (out of this page's ownership). */
function stripPrefix(id: string, prefix: string): string {
  return id.startsWith(prefix) ? id.slice(prefix.length) : id
}

/** `DashboardPayload['notices'][number]` does not carry a country ISO yet -- `buildNotices()`
 * (operator/src/dashboard.ts, a shared file this page does not own) only threads `city` through
 * from the seat row, even though the seat itself has `country` (see the build report for the
 * exact patch). Read defensively so this page compiles and renders correctly today (no flag,
 * "Unknown") and picks up the real ISO the moment that patch lands, with no further change here. */
function noticeCountryIso(n: DashboardPayload['notices'][number]): string | null {
  const withCountry = n as { country?: string | null }
  return typeof withCountry.country === 'string' && withCountry.country ? withCountry.country : null
}

function rawNoticeToRow(n: DashboardPayload['notices'][number]): NoticeRow {
  if (n.kind === 'seat-pending') {
    return {
      id: n.id,
      kind: 'seat',
      title: n.title,
      detail: n.detail,
      sortTs: n.ts,
      profile: n.profile,
      country: noticeCountryIso(n),
      city: n.city,
      os: n.os,
      action: { type: 'approve-seat', deviceId: stripPrefix(n.id, 'seat-') }
    }
  }
  if (n.kind === 'crm-failed') {
    return {
      id: n.id,
      kind: 'crm',
      title: n.title,
      detail: n.detail,
      sortTs: n.ts,
      profile: n.profile,
      country: noticeCountryIso(n),
      city: n.city,
      os: n.os,
      action: { type: 'retry-crm', crmId: stripPrefix(n.id, 'crm-') }
    }
  }
  if (n.kind === 'skill-pending') {
    return {
      id: n.id,
      kind: 'skill',
      title: n.title,
      detail: n.detail,
      sortTs: n.ts,
      profile: n.profile,
      country: noticeCountryIso(n),
      city: n.city,
      os: n.os,
      action: { type: 'open-skill' }
    }
  }
  // Defensive: buildNotices() has three raw kinds today. A future fourth one still renders (never
  // a blank row) as an unactionable Platform notice rather than throwing on an unknown shape.
  return {
    id: n.id,
    kind: 'platform',
    title: n.title,
    detail: n.detail,
    sortTs: n.ts,
    profile: n.profile,
    country: noticeCountryIso(n),
    city: n.city,
    os: n.os,
    action: null
  }
}

function licenseRows(data: DashboardPayload, now: number): NoticeRow[] {
  return data.licenses.issued
    .filter((r) => !r.revoked)
    .filter((r) => r.exp * 1000 > now && r.exp * 1000 <= now + EXPIRING_WINDOW_MS)
    .map((r) => ({
      id: `license-${r.jti}`,
      kind: 'license' as const,
      title: 'License expiring soon',
      detail: `··${r.last4} · ${r.days} day license`,
      // The moment this notice entered the 7-day window -- a real past instant once it is showing
      // at all, so it sorts alongside the other "needs attention" rows the same way they do
      // (newest-into-the-window first), without needing a second sort dimension.
      sortTs: r.exp * 1000 - EXPIRING_WINDOW_MS,
      profile: null,
      country: null,
      city: null,
      os: null,
      expMs: r.exp * 1000,
      action: { type: 'revoke-license', jti: r.jti }
    }))
}

function connectorRows(extra: NotificationsExtra | undefined): NoticeRow[] {
  return (extra?.connectors ?? []).map((c) => ({
    id: `connector-${c.id}`,
    kind: 'connector' as const,
    title: `${c.label} test failing`,
    detail: c.detail,
    sortTs: c.ts,
    profile: null,
    country: null,
    city: null,
    os: null,
    action: { type: 'retest-connector', connectorId: c.id }
  }))
}

function platformRows(extra: NotificationsExtra | undefined): NoticeRow[] {
  return (extra?.platform ?? []).map((p) => ({
    id: `platform-${p.id}`,
    kind: 'platform' as const,
    title: p.title,
    detail: p.detail,
    sortTs: p.ts,
    profile: null,
    country: null,
    city: null,
    os: null,
    action: null
  }))
}

/** Every notice this page shows, newest/most-urgent first. Exported so the client can compute
 * kind counts and the true unseen total from the exact same rows the table renders. */
export function buildNoticeRows(data: DashboardPayload, now: number, extra?: NotificationsExtra): NoticeRow[] {
  return [...data.notices.map(rawNoticeToRow), ...licenseRows(data, now), ...connectorRows(extra), ...platformRows(extra)].sort(
    (a, b) => b.sortTs - a.sortTs
  )
}

export function countsByKind(rows: NoticeRow[]): Record<NoticeKind, number> {
  const counts: Record<NoticeKind, number> = { seat: 0, license: 0, crm: 0, connector: 0, skill: 0, platform: 0 }
  for (const row of rows) counts[row.kind] += 1
  return counts
}

function renderWhen(row: NoticeRow, now: number): string {
  if (row.kind === 'license' && row.expMs != null) {
    const daysLeft = Math.max(0, Math.ceil((row.expMs - now) / DAY_MS))
    const iso = new Date(row.expMs).toISOString().replace('T', ' ').slice(0, 16)
    const label = daysLeft <= 0 ? 'Expires today' : daysLeft === 1 ? 'Expires in 1 day' : `Expires in ${daysLeft} days`
    return `<span class="notice-expiry" title="Expires ${esc(iso)} UTC">${esc(label)}</span>`
  }
  return timeCell(row.sortTs, now)
}

function actionCell(action: NoticeAction | null): string {
  if (!action) return ''
  if (action.type === 'approve-seat') {
    return `<button type="button" class="btn primary" data-notice-action="approve-seat" data-device="${esc(action.deviceId)}">Approve</button>`
  }
  if (action.type === 'revoke-license') {
    return `<button type="button" class="btn danger" data-notice-action="revoke-license" data-jti="${esc(action.jti)}">Revoke</button>`
  }
  if (action.type === 'retry-crm') {
    return `<button type="button" class="btn" data-notice-action="retry-crm" data-crm="${esc(action.crmId)}">Retry</button>`
  }
  if (action.type === 'retest-connector') {
    return `<button type="button" class="btn" data-notice-action="retest-connector" data-connector="${esc(action.connectorId)}">Re-test</button>`
  }
  // 'open-skill' -- a plain hash link (plan 6.8: "Open skill routes to #settings"), not a mutation:
  // no press/crossfade/collapse sequence applies, the existing hash router does the rest.
  return `<a class="btn" href="#settings" data-notice-action="open-skill">Open</a>`
}

function noticeRowHtml(row: NoticeRow, now: number): DataTableRow {
  const countryName = row.country ? COUNTRY_NAMES[row.country.toUpperCase()] || '' : ''
  const q =
    `${NOTICE_KIND_LABEL[row.kind]} ${row.title} ${row.detail} ${row.profile || ''} ${countryName} ${row.city || ''} ${row.os || ''}`.toLowerCase()
  return {
    attrs: `data-notice-row data-notice-id="${esc(row.id)}" data-notice-kind="${esc(row.kind)}" data-q="${esc(q)}"`,
    cells: {
      kind: noticeKindBadge(row.kind),
      title: `<strong>${esc(row.title)}</strong>`,
      detail: field(row.detail),
      profile: field(row.profile),
      country: countryCell(row.country, { secondary: row.city || undefined }),
      os: osChip(row.os) || MISSING,
      when: renderWhen(row, now),
      action: `<span class="notice-action-cell" data-notice-action-cell>${actionCell(row.action)}</span>`
    }
  }
}

const OPTIONAL_COLUMN_KEYS = ['detail', 'profile', 'country', 'os'] as const
export type NoticeOptionalColumn = (typeof OPTIONAL_COLUMN_KEYS)[number]

const OPTIONAL_COLUMN_LABEL: Record<NoticeOptionalColumn, string> = {
  detail: 'Detail',
  profile: 'Profile',
  country: 'Country',
  os: 'OS'
}

function viewMenuHtml(): string {
  const items = OPTIONAL_COLUMN_KEYS.map(
    (key) =>
      `<label class="view-menu-item"><input type="checkbox" data-col-toggle="${key}" checked> ${esc(OPTIONAL_COLUMN_LABEL[key])}</label>`
  ).join('')
  return `<div class="view-menu-wrap">
    ${viewButton({ attrs: 'data-view-toggle aria-haspopup="true" aria-expanded="false"' })}
    <div class="view-menu" hidden data-view-menu role="menu">
      <p class="view-menu-title">Columns</p>
      ${items}
    </div>
  </div>`
}

function kindChipsHtml(counts: Record<NoticeKind, number>): string {
  return NOTICE_KIND_ORDER.map((kind) => {
    const icon = iconSvg(kindIconPath(kind), { class: 'tool-ic' })
    return `<button type="button" class="chip notice-kind-chip" data-kind-chip="${kind}" aria-pressed="false" title="${esc(
      NOTICE_KIND_SOURCE[kind]
    )}">${icon}<span>${esc(NOTICE_KIND_LABEL[kind])}</span><span class="notice-kind-count" data-kind-count="${kind}">${counts[kind]}</span></button>`
  }).join('')
}

export function renderNotifications(data: DashboardPayload, ctx: RenderCtx, extra?: NotificationsExtra): string {
  const rows = buildNoticeRows(data, ctx.now, extra)
  const counts = countsByKind(rows)
  const table = dataTable({
    id: 'notifications-table',
    columns: [
      { key: 'kind', label: 'Kind' },
      { key: 'title', label: 'Title' },
      { key: 'detail', label: 'Detail' },
      { key: 'profile', label: 'Profile' },
      { key: 'country', label: 'Country' },
      { key: 'os', label: 'OS' },
      { key: 'when', label: 'When' },
      { key: 'action', label: '' }
    ],
    rows: rows.map((r) => noticeRowHtml(r, ctx.now)),
    emptyTitle: 'Nothing needs attention',
    emptyDescription: 'New notices appear here as seats, licenses, CRM pushes, connectors, skills and the platform need it.'
  })
  return `${pageHeader({ title: 'Notifications', subtitle: 'What needs attention.' })}
    <article class="card notice-toolbar-card">
      ${toolbar({
        left: kindChipsHtml(counts),
        search: toolbarSearch({ id: 'notifications-search', placeholder: 'Search notices' }),
        right: `${toolbarButton({ label: 'Mark all seen', icon: NAV_ICON_PATHS['badge-check'], attrs: 'data-mark-all-seen' })}${viewMenuHtml()}`
      })}
    </article>
    <article class="card pad-b10">
      <div class="notice-table-shell" data-notice-table-wrap data-hide-cols="">${table}</div>
      <p class="sub muted pad-b8" data-notice-filtered-empty hidden>No notices match this filter.</p>
    </article>`
}
