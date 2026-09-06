/**
 * Licenses page (plan 6.7, P1.6 brief, motion minimums plan 3.5b "Licenses" row).
 *
 * Three blocks. First, "Needs your review" (block 0, `renderNeedsReviewBlock()` below): the only
 * place in the product where a seat is approved or an about-to-expire license is dealt with --
 * Tony 2026-09-06, verbatim: "seats awaiting approval have their own section, in the license
 * section, with a nugget, so I can click and go through them quickly; it shouldn't be mixed with
 * the notifications, it gets confusing." A count-up nugget (hidden at zero, also the value
 * operator/client/pages/licenses.ts pushes into the rail's Licenses badge on mount and after
 * every action -- see that file's header for why a client push, not a shell.ts change, is how
 * this page keeps that badge honest), two `segmented()` queues (Pending approval / Expiring soon,
 * remembered across a reload via a `?queue=` URL param the same way Overview persists `?range=`),
 * `dataTable(variant:'card')` rows with an inline, never-a-modal confirm on Revoke, and j/k/a/r/
 * Enter/Esc keyboard triage (operator/client/pages/licenses.ts). Then two cards: Generate
 * (duration segmented control, optional group and tier, once-string strip with Copy) and Seats
 * (dataTable, Approve / Revoke with confirm). The rule sentence lives in `pageHeader()`'s
 * subtitle.
 *
 * Block 0's Revoke button intentionally has no "Renew 30 days" companion the plan's prose
 * mentions for the expiring queue: the only mutation the backend exposes on an issued license is
 * `POST /v1/admin/licenses/:jti/revoke` (operator/src/routes/admin-core.ts's `licenseOrSeatAction`,
 * not owned by this page) -- there is no renew/extend endpoint to call, and a button that cannot
 * actually renew anything would be exactly the fake affordance lock 3 forbids. Revoke alone (the
 * capability that genuinely exists) is what ships; a real Renew is a routes/admin-core.ts change
 * for whoever owns that file. The same absence of a "set back to pending" endpoint is why Approve
 * offers no Undo action in its toast: the only way to reverse an approval through this API is
 * Revoke, a materially different, non-reversible action (it also stops platform keys and
 * connectors immediately) -- offering "Undo" on top of Approve would silently mean something the
 * word does not.
 *
 * Data gap (documented, not worked around): `DashboardPayload['licenses']['issued']` (operator/
 * src/dashboard.ts, a locked shared file this page does not own) trims the store's
 * `IssuedLicenseRow` down to `{jti, last4, days, exp, revoked, createdAt}`, dropping `tier`,
 * `group_id`, `member`, `created_by`, `activated_device` and `activated_at` even though every one
 * of those already exists on the row `dashboard.ts` reads (`operator/src/store.ts`). Rather than
 * fabricate those columns, this module accepts an optional third argument, `LicensesExtra`,
 * carrying the same fields keyed by `jti` (plus the group/tier picklists for the Generate form).
 * `operator/client/pages/licenses.ts` fills it in after mount from `GET /v1/admin/groups`
 * (already a stated data source for this page) and from every license this session itself
 * generates (the mint response already carries `groupId`/`tier`/`member`). A row with no matching
 * `extra.issued[jti]` entry renders those columns as "not tracked yet" rather than a guess -- see
 * this page's build report for the exact one-line-per-field dashboard.ts patch that removes the
 * gap entirely once applied.
 *
 * The Seats table's own Tier and Connectors columns (plan 6.7) have the same class of gap on
 * `DashboardPayload['licenses']['rows']`, handled two different ways depending on whether the
 * data is actually derivable -- see the doc comment above `seatDeviceTierIndex()` near the seats
 * card for the full reasoning: Tier is resolved for real by cross-referencing a seat's device id
 * against `extra.issued[*].activatedDevice`, no dashboard.ts change needed; Connectors has no
 * data source anywhere yet (no admin route reads `integration_grants` by device) and is a
 * documented, deliberately deferred gap until one exists.
 *
 * `data-license-generate` on the Generate form below (alongside this page's own
 * `data-licenses-generate-form`) is a passive compatibility marker for operator/client/nav.ts's
 * rail "Generate license" quick action, which still looks for the legacy singular
 * `[data-license-generate] select[name="days"]` (plan 3.7b law 1). It carries no handler of its
 * own on this page -- the real submit handling is `data-licenses-generate-form`'s, in operator/
 * client/pages/licenses.ts -- so it is safe to keep even though nav.ts's owner (dev-shell) is the
 * more thorough long-term fix (see this page's build report for that exact patch).
 */
import type { DashboardPayload } from '../../dashboard'
import { ONLINE_MS } from '../../dashboard'
import {
  avatar,
  chip,
  dataTable,
  detailDrawer,
  emptyState,
  esc,
  osChip,
  pageHeader,
  relativeTime,
  segmented,
  statusDot,
  tierBadge,
  timeCell,
  type DataTableColumn,
  type DataTableRow,
  type RenderCtx,
  type StatusDotState
} from '../index'
import { field, MISSING } from './_shared'

const DAY_MS = 24 * 60 * 60 * 1000
const EXPIRING_WINDOW_MS = 7 * DAY_MS

// ── extra (group/tier enrichment the client fetches after mount) ───────────────────────────────

export interface LicensesGroupOption {
  id: string
  name: string
  tier: string
}

export interface LicensesTierOption {
  id: string
  label: string
}

/** The fields `dashboard.ts` currently drops from `licenses.issued` (see file header), keyed by
 *  `jti`. `null` is a real, known value ("no group", "not yet activated"); a missing key means
 *  simply not loaded yet -- the two render differently (MISSING vs. a plain sentence). */
export interface IssuedLicenseExtraFields {
  tier: string | null
  groupId: string | null
  groupName: string | null
  member: string | null
  issuedBy: string | null
  activatedDevice: string | null
  activatedAt: number | null
}

export interface LicensesExtra {
  groups?: LicensesGroupOption[]
  tiers?: LicensesTierOption[]
  issued?: Record<string, IssuedLicenseExtraFields>
}

// ── issued licenses: a superset view combining the base row with the optional extra ────────────

export interface IssuedLicenseViewRow {
  jti: string
  last4: string
  days: number
  exp: number
  revoked: boolean
  createdAt: number
  tier: string | null
  groupId: string | null
  groupName: string | null
  member: string | null
  issuedBy: string | null
  activatedDevice: string | null
  activatedAt: number | null
  /** True once tier/group/member/issuedBy/activation are real values from `extra` (or this row
   *  was generated client-side this session, which always knows them); false renders MISSING for
   *  those columns instead of a guess. */
  known: boolean
}

type BaseIssuedRow = DashboardPayload['licenses']['issued'][number]

function toViewRow(base: BaseIssuedRow, extra: LicensesExtra | undefined): IssuedLicenseViewRow {
  const ex = extra?.issued?.[base.jti]
  return {
    jti: base.jti,
    last4: base.last4,
    days: base.days,
    exp: base.exp,
    revoked: Boolean(base.revoked),
    createdAt: base.createdAt,
    tier: ex?.tier ?? null,
    groupId: ex?.groupId ?? null,
    groupName: ex?.groupName ?? null,
    member: ex?.member ?? null,
    issuedBy: ex?.issuedBy ?? null,
    activatedDevice: ex?.activatedDevice ?? null,
    activatedAt: ex?.activatedAt ?? null,
    known: Boolean(ex)
  }
}

/** Builds a full view row from a fresh `POST /v1/admin/licenses/generate` or `POST /v1/admin/
 *  groups/:id/licenses/generate` response (operator/client/pages/licenses.ts, right after a
 *  successful Generate) -- always `known: true`, since a license this session just minted has no
 *  "not tracked yet" fields: everything about it is either in the response or is "not yet"
 *  (not activated, just issued). */
export function viewRowFromGenerate(
  input: { jti: string; last4: string; days: number; exp: number; groupId?: string | null; tier?: string | null; member?: string | null },
  groupName: string | null,
  issuedBy: string | null,
  createdAt: number
): IssuedLicenseViewRow {
  return {
    jti: input.jti,
    last4: input.last4,
    days: input.days,
    exp: input.exp,
    revoked: false,
    createdAt,
    tier: input.tier ?? null,
    groupId: input.groupId ?? null,
    groupName,
    member: input.member ?? null,
    issuedBy,
    activatedDevice: null,
    activatedAt: null,
    known: true
  }
}

export type IssuedLicenseStatus = 'revoked' | 'expiring' | 'active' | 'expired'

export function issuedLicenseStatus(row: Pick<IssuedLicenseViewRow, 'revoked' | 'exp'>, now: number): IssuedLicenseStatus {
  if (row.revoked) return 'revoked'
  const expMs = row.exp * 1000
  if (expMs <= now) return 'expired'
  if (expMs - now <= EXPIRING_WINDOW_MS) return 'expiring'
  return 'active'
}

/** Shared by the issued table's Tier column and the seats table's Tier column (see
 *  `seatTierCell()` below) -- `unknownLabel` is the only difference between "not loaded yet"
 *  (issued rows without an `extra` entry) and "loaded, but this seat has no active license"
 *  (seats without a matching issued license), so both real, distinct states get their own
 *  sentence instead of collapsing to the same MISSING placeholder. */
function renderTierValue(tier: string | null, known: boolean, unknownLabel: string): string {
  if (!known) return MISSING
  if (!tier) return `<span class="muted">${esc(unknownLabel)}</span>`
  if (tier === 'metis' || tier === 'metis-light') return tierBadge(tier)
  return chip({ label: tier })
}

function tierCell(row: IssuedLicenseViewRow): string {
  return renderTierValue(row.tier, row.known, 'Not set')
}

function groupCell(row: IssuedLicenseViewRow): string {
  if (!row.known) return MISSING
  if (!row.groupId) return '<span class="muted">No group</span>'
  return esc(row.groupName || row.groupId)
}

function memberCell(row: IssuedLicenseViewRow): string {
  if (!row.known) return MISSING
  return row.member ? esc(row.member) : '<span class="muted">Not specified</span>'
}

function issuedByCell(row: IssuedLicenseViewRow): string {
  if (!row.known) return MISSING
  return row.issuedBy ? esc(row.issuedBy) : '<span class="muted">Not specified</span>'
}

function expiresCell(row: IssuedLicenseViewRow, now: number): string {
  const expMs = row.exp * 1000
  const iso = new Date(expMs).toISOString().replace('T', ' ').slice(0, 16)
  const diffDays = Math.round(Math.abs(expMs - now) / DAY_MS)
  let label: string
  if (row.revoked) label = `Was set to expire ${diffDays <= 0 ? 'today' : `in ${diffDays}d`}`
  else if (expMs <= now) label = diffDays <= 0 ? 'Expired today' : `Expired ${diffDays}d ago`
  else if (diffDays <= 0) label = 'Expires today'
  else if (diffDays === 1) label = 'Expires in 1 day'
  else label = `Expires in ${diffDays} days`
  return `<span title="${esc(iso)} UTC">${esc(label)}</span>`
}

function activatedCell(row: IssuedLicenseViewRow, now: number): string {
  if (!row.known) return MISSING
  if (!row.activatedDevice) return '<span class="muted">Not yet activated</span>'
  const short = `<code class="mono-id" title="${esc(row.activatedDevice)}">${esc(row.activatedDevice.slice(0, 8))}</code>`
  return row.activatedAt ? `${short} ${timeCell(row.activatedAt, now)}` : short
}

function statusCell(status: IssuedLicenseStatus): string {
  if (status === 'revoked') return statusDot({ state: 'revoked', label: 'Revoked' })
  if (status === 'expired') return statusDot({ state: 'idle', label: 'Expired' })
  if (status === 'expiring') {
    // Amber pulse on the dot only (plan 3.5b): the shared beacon() halo (operator/client/
    // motion.ts) is hard-coded to --live (green, "this is online"), a different signal than
    // "this is about to expire" -- reusing it here would be visually correct only by accident.
    // `.lic-expiring-dot` (this page's own css-licenses.ts) plays the identical halo mechanic,
    // amber, keyed off `.status-dot-live` so it stops the moment Revoke swaps that class client
    // side; it inherits the same global `prefers-reduced-motion` collapse (spa/css.ts) every
    // other animation on the page does, so no separate reduced-motion rule is needed here.
    return `<span class="lic-expiring-dot" data-license-expiring>${statusDot({ state: 'live', label: 'Expiring soon' })}</span>`
  }
  return statusDot({ state: 'live', label: 'Active' })
}

function revokeCell(row: IssuedLicenseViewRow, status: IssuedLicenseStatus): string {
  if (status === 'revoked') return ''
  return `<button type="button" class="btn danger" data-license-revoke="${esc(row.jti)}">Revoke</button>`
}

const ISSUED_COLUMNS: DataTableColumn[] = [
  { key: 'last4', label: 'Last4' },
  { key: 'tier', label: 'Tier' },
  { key: 'group', label: 'Group' },
  { key: 'member', label: 'Member' },
  { key: 'issuedBy', label: 'Issued by' },
  { key: 'expires', label: 'Expires' },
  { key: 'activated', label: 'Activated seat' },
  { key: 'status', label: 'Status' },
  { key: 'action', label: '' }
]

function issuedRowCells(row: IssuedLicenseViewRow, now: number, status: IssuedLicenseStatus): Record<string, string> {
  return {
    last4: `<code>··${esc(row.last4)}</code>`,
    tier: tierCell(row),
    group: groupCell(row),
    member: memberCell(row),
    issuedBy: issuedByCell(row),
    expires: expiresCell(row, now),
    activated: activatedCell(row, now),
    status: statusCell(status),
    action: revokeCell(row, status)
  }
}

/** One detached `<tr>...</tr>`, structurally identical to what `dataTable()` would emit for the
 *  same row (same columns, same `data-stagger` marker) -- exported so operator/client/pages/
 *  licenses.ts can build the exact same markup for a FLIP insert after a successful Generate,
 *  with zero duplicated cell logic between the server render path and the client one. */
export function renderIssuedLicenseRowHtml(row: IssuedLicenseViewRow, now: number): string {
  const status = issuedLicenseStatus(row, now)
  const cells = issuedRowCells(row, now, status)
  const tds = ISSUED_COLUMNS.map((c) => `<td>${cells[c.key] ?? ''}</td>`).join('')
  return `<tr data-stagger data-license-jti="${esc(row.jti)}" data-license-status="${status}">${tds}</tr>`
}

/** A full `<table>` for exactly the rows given -- exported for the one client-side case
 *  `renderIssuedLicenseRowHtml()` cannot cover: the issued table was showing `emptyState()`
 *  (zero rows) and a Generate just produced the first one, so there is no existing `<tbody>` to
 *  insert a `<tr>` into. */
export function renderIssuedLicenseTable(rows: IssuedLicenseViewRow[], now: number): string {
  return dataTable({
    id: 'licenses-issued-table',
    columns: ISSUED_COLUMNS,
    rows: rows.map((r) => {
      const status = issuedLicenseStatus(r, now)
      return { attrs: `data-license-jti="${esc(r.jti)}" data-license-status="${status}"`, cells: issuedRowCells(r, now, status) }
    }),
    emptyTitle: 'No Operator licenses generated yet',
    emptyDescription: 'Generate a duration above to create the first one time string.'
  })
}

// ── generate card ────────────────────────────────────────────────────────────────────────────

export const DURATION_OPTIONS: readonly { value: number; label: string }[] = [
  { value: 1, label: '1 day' },
  { value: 7, label: '7 days' },
  { value: 30, label: '30 days' },
  { value: 90, label: '90 days' },
  { value: 365, label: '1 year' }
]

const DEFAULT_DURATION_DAYS = 30

/** Duration control (plan 3.5b: "a sliding thumb (spring)"). The real, submitted control is the
 *  native `<select name="days">`, kept in the DOM via the shared `.sr-only` class (spa/css.ts) --
 *  present in the accessibility tree and in tab order, just not painted -- so a screen reader or
 *  keyboard user gets a plain five-option select, and operator/client/nav.ts's rail "Generate
 *  license" button (`select[name="days"]`) keeps finding a real, focusable element. The five
 *  buttons beside it are `tabindex="-1"` (pointer-only): the select is the one control announced
 *  to assistive tech, so nothing is ever presented twice. operator/client/pages/licenses.ts syncs
 *  the two directions (click a button -> set the select's value and fire `change`; change the
 *  select -> move the thumb) so either input method always agrees with the other. */
function durationControl(selectedDays: number): string {
  const activeIndex = Math.max(
    0,
    DURATION_OPTIONS.findIndex((o) => o.value === selectedDays)
  )
  const options = DURATION_OPTIONS.map(
    (o) => `<option value="${o.value}"${o.value === selectedDays ? ' selected' : ''}>${esc(o.label)}</option>`
  ).join('')
  const buttons = DURATION_OPTIONS.map(
    (o, i) =>
      `<button type="button" tabindex="-1" class="duration-seg-btn${i === activeIndex ? ' on' : ''}" data-duration-btn="${o.value}" aria-pressed="${i === activeIndex}">${esc(o.label)}</button>`
  ).join('')
  return `<span class="duration-control" data-duration-control>
    <select name="days" class="sr-only" data-duration-select aria-label="License duration">${options}</select>
    <span class="duration-seg" data-duration-seg aria-hidden="true">
      <span class="duration-thumb" data-duration-thumb data-thumb-index="${activeIndex}"></span>
      ${buttons}
    </span>
  </span>`
}

function groupSelectOptions(extra: LicensesExtra | undefined): string {
  const groups = extra?.groups ?? []
  const opts = groups.map((g) => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('')
  return `<option value="">No group</option>${opts}`
}

function tierSelectOptions(extra: LicensesExtra | undefined): string {
  const tiers = extra?.tiers ?? []
  const opts = tiers.map((t) => `<option value="${esc(t.id)}">${esc(t.label)}</option>`).join('')
  return `<option value="">Default</option>${opts}`
}

function renderGenerateCard(data: DashboardPayload, ctx: RenderCtx, extra: LicensesExtra | undefined): string {
  const rows = (data.licenses.issued || []).slice().sort((a, b) => b.createdAt - a.createdAt)
  const viewRows = rows.map((r) => toViewRow(r, extra))
  return `<article class="card pad-b10">
    <p class="eyebrow">Generate license</p>
    <p class="muted licenses-hint">Pick how long it stays active. Optionally scope it to a group and a tier. Paste the string into Métis, Identity, License. Shown once, last4 after that.</p>
    <form class="key-form licenses-generate-form" data-licenses-generate-form data-license-generate autocomplete="off">
      <div class="row licenses-generate-row">
        <label class="licenses-field">
          <span class="licenses-field-label">Active for</span>
          ${durationControl(DEFAULT_DURATION_DAYS)}
        </label>
        <label class="licenses-field">
          <span class="licenses-field-label">Group</span>
          <select name="groupId" data-licenses-group>${groupSelectOptions(extra)}</select>
        </label>
        <label class="licenses-field">
          <span class="licenses-field-label">Tier</span>
          <select name="tier" data-licenses-tier>${tierSelectOptions(extra)}</select>
        </label>
        <button class="primary" type="submit" data-licenses-generate-submit>Generate license</button>
      </div>
    </form>
    <div class="license-once" hidden data-licenses-once>
      <p class="muted">Copy this now. It will not be shown again.</p>
      <div class="license-once-row">
        <input data-licenses-once-value readonly spellcheck="false" aria-label="Generated license" />
        <button type="button" class="primary" data-licenses-once-copy>Copy</button>
        <button type="button" class="tool" data-licenses-once-dismiss aria-label="Dismiss">Dismiss</button>
      </div>
    </div>
    <div data-licenses-issued-wrap>${renderIssuedLicenseTable(viewRows, ctx.now)}</div>
  </article>`
}

// ── seats card ───────────────────────────────────────────────────────────────────────────────

function seatComputerCell(r: DashboardPayload['licenses']['rows'][number]): string {
  const hostname = field(r.hostname)
  if (hostname !== MISSING) return hostname
  return `<code class="mono-id" title="${esc(r.device)}">${esc(r.device.slice(0, 8))}</code>`
}

function seatApprovalState(approval: string): { state: StatusDotState; label: string } {
  if (approval === 'approved') return { state: 'live', label: 'Approved' }
  if (approval === 'revoked') return { state: 'revoked', label: 'Revoked' }
  return { state: 'pending', label: 'Pending' }
}

function seatActionCell(r: DashboardPayload['licenses']['rows'][number]): string {
  const id = esc(r.device)
  return r.approval === 'approved'
    ? `<button type="button" class="btn danger" data-license-revoke="${id}">Revoke</button>`
    : `<button type="button" class="btn primary" data-license-approve="${id}">Approve</button>`
}

/**
 * Plan 6.7's Seats table spec ("Computer, Email, OS, Version, License state, Tier, Approval, Keys
 * authorized, Connectors, Last seen") lists two columns `DashboardPayload['licenses']['rows']`
 * (operator/src/dashboard.ts, locked/shared) has no field for. Tier and Connectors get different
 * treatment because only one of them is honestly derivable from data this page already has:
 *
 * - Tier: every issued license's `extra.issued[jti]` (see the file header) already carries both
 *   `tier` and `activatedDevice`, and `activatedDevice` is the same full device id this table's
 *   rows use (`operator/src/store.ts`'s `SeatRow.device_id`, unsliced, on both). This index maps
 *   a seat's device id to the tier of whichever issued license activated it -- no dashboard.ts
 *   change needed. A seat that is approved without ever activating an Operator license genuinely
 *   has no tier by this path, which reads "No active license" (a real, known value), distinct
 *   from `extra` simply not having loaded yet, which reads MISSING like every other enrichment
 *   column on this page.
 * - Connectors: no admin route returns per-device connector grants today (`operator/src/routes/
 *   integrations.ts` is still an empty stub, ground truth section 1) and `integration_grants`
 *   has no device-scoped read path this page could call, so there is nothing genuine to derive.
 *   This is a documented, deliberately deferred gap (not fabricated, not silently dropped): the
 *   column always renders MISSING until a route exists. The one-line patch that would close it,
 *   once `operator/src/routes/integrations.ts` has a real implementation: add a `connectorsCount:
 *   number` field to `DashboardPayload['licenses']['rows'][number]` in dashboard.ts, computed as
 *   `SELECT COUNT(*) FROM integration_grants WHERE device_id = ?` (or the group-scoped equivalent
 *   for a seat with no per-device grant), and swap `seatConnectorsCell()` below for a `chip()`
 *   reading it -- see this page's build report for the exact diff.
 */
function seatDeviceTierIndex(extra: LicensesExtra | undefined): Map<string, string | null> | null {
  if (!extra) return null
  const index = new Map<string, string | null>()
  for (const issued of Object.values(extra.issued ?? {})) {
    if (issued.activatedDevice) index.set(issued.activatedDevice, issued.tier)
  }
  return index
}

function seatTierCell(device: string, tierIndex: Map<string, string | null> | null): string {
  if (!tierIndex) return MISSING
  if (!tierIndex.has(device)) return '<span class="muted">No active license</span>'
  return renderTierValue(tierIndex.get(device) ?? null, true, 'Not set')
}

function seatConnectorsCell(): string {
  // Always MISSING today -- see the doc comment above seatDeviceTierIndex() for why this is a
  // documented gap, not an oversight or a guess.
  return MISSING
}

function seatRowData(r: DashboardPayload['licenses']['rows'][number], now: number, tierIndex: Map<string, string | null> | null): DataTableRow {
  const approval = seatApprovalState(r.approval)
  return {
    attrs: `data-device="${esc(r.device)}" data-approval="${esc(r.approval)}"`,
    cells: {
      computer: seatComputerCell(r),
      email: field(r.email),
      os: osChip(r.os) || MISSING,
      version: r.appVersion ? `Métis ${esc(r.appVersion)}` : MISSING,
      license: field(r.license),
      tier: seatTierCell(r.device, tierIndex),
      approval: statusDot(approval),
      keys: r.keysAuthorized ? chip({ label: 'Yes', tone: 'ok' }) : chip({ label: 'No' }),
      connectors: seatConnectorsCell(),
      lastSeen: timeCell(r.lastSeen, now),
      action: seatActionCell(r)
    }
  }
}

const SEATS_COLUMNS: DataTableColumn[] = [
  { key: 'computer', label: 'Computer' },
  { key: 'email', label: 'Email' },
  { key: 'os', label: 'OS' },
  { key: 'version', label: 'Version' },
  { key: 'license', label: 'License state' },
  { key: 'tier', label: 'Tier' },
  { key: 'approval', label: 'Approval' },
  { key: 'keys', label: 'Keys authorized' },
  { key: 'connectors', label: 'Connectors' },
  { key: 'lastSeen', label: 'Last seen' },
  { key: 'action', label: '' }
]

function renderSeatsCard(data: DashboardPayload, now: number, extra: LicensesExtra | undefined): string {
  if (data.licenses.empty) {
    return `<article class="card pad-b10">
      <p class="eyebrow">Seats</p>
      <div class="fail-loud" data-licenses-empty>${esc(data.licenses.error || 'No licenses in D1')}</div>
      <p class="muted">A seat appears within 60 seconds of its first heartbeat. Approve it here once it does, or it can activate an Operator license itself.</p>
    </article>`
  }
  const tierIndex = seatDeviceTierIndex(extra)
  const table = dataTable({
    id: 'licenses-seats-table',
    columns: SEATS_COLUMNS,
    rows: data.licenses.rows.map((r) => seatRowData(r, now, tierIndex)),
    emptyTitle: 'No seats have checked in yet',
    emptyDescription: 'A seat appears within 60 seconds of its first heartbeat.'
  })
  return `<article class="card pad-b10">
    <p class="eyebrow">Seats</p>
    ${table}
    <p class="muted licenses-hint">Tony approves a seat, or the seat activates an Operator license. Revoke always stops platform keys and connectors immediately. last4 only, never a raw key.</p>
  </article>`
}

// ── needs your review (block 0, plan 6.7) ───────────────────────────────────────────────────

type SeatViewRow = DashboardPayload['licenses']['rows'][number]

interface ReviewField {
  label: string
  value: string
}

/** One row's full detail, rendered once here and carried on the row itself as a `data-review-
 *  json` attribute (operator/client/pages/licenses.ts's Enter-to-open drawer reads it straight
 *  off the DOM, no second fetch, no re-implementation of these cell renderers) -- so the drawer
 *  never drifts from what the row already says: same `tierCell()`/`groupCell()`/... functions
 *  the Generate card's issued table uses, same "not tracked yet" / "no active license" sentences
 *  where the data genuinely is not there. */
interface ReviewRowPayload {
  kind: 'seat' | 'license'
  id: string
  title: string
  fields: ReviewField[]
}

function pendingReviewPayload(r: SeatViewRow, tierIndex: Map<string, string | null> | null): ReviewRowPayload {
  return {
    kind: 'seat',
    id: r.device,
    title: r.hostname || `Seat ··${r.device.slice(-8)}`,
    fields: [
      { label: 'Computer', value: seatComputerCell(r) },
      { label: 'Email', value: field(r.email) },
      { label: 'OS', value: osChip(r.os) || MISSING },
      { label: 'Version', value: r.appVersion ? `Métis ${esc(r.appVersion)}` : MISSING },
      { label: 'Tier', value: seatTierCell(r.device, tierIndex) },
      { label: 'Device id', value: `<code class="mono-id">${esc(r.device)}</code>` }
    ]
  }
}

function expiringReviewPayload(view: IssuedLicenseViewRow, seatByDevice: Map<string, SeatViewRow>, now: number): ReviewRowPayload {
  const seat = view.activatedDevice ? seatByDevice.get(view.activatedDevice) : undefined
  const title = seat ? seat.hostname || `Seat ··${seat.device.slice(-8)}` : `License ··${view.last4}`
  const fields: ReviewField[] = [
    { label: 'Last4', value: `<code>··${esc(view.last4)}</code>` },
    { label: 'Tier', value: tierCell(view) },
    { label: 'Group', value: groupCell(view) },
    { label: 'Member', value: memberCell(view) },
    { label: 'Issued by', value: issuedByCell(view) },
    { label: 'Expires', value: expiresCell(view, now) },
    { label: 'Activated seat', value: activatedCell(view, now) }
  ]
  if (seat) fields.push({ label: 'Email', value: field(seat.email) })
  return { kind: 'license', id: view.jti, title, fields }
}

/** Seat identity cell shared by both queues: avatar with a live dot (plan 6.7), hostname (or a
 *  short device id when none is on file), and a secondary line -- the SSO email for a pending
 *  seat, or the activated seat's email / "Not yet activated" for an expiring license that has no
 *  seat identity to show yet (fixture L2: issued, expiring, never claimed). `subMuted` renders
 *  that secondary line as the quieter "nothing real to say" tone rather than as if it were data. */
function reviewSeatIdentityCell(name: string, sub: string, subMuted: boolean, email: string | null, live: boolean): string {
  const subHtml = subMuted ? `<span class="muted">${esc(sub)}</span>` : esc(sub)
  return `<span class="review-seat">${avatar({ name, email, live })}<span class="review-seat-body"><span class="review-seat-name">${esc(name)}</span><span class="review-seat-sub">${subHtml}</span></span></span>`
}

const REVIEW_PENDING_COLUMNS: DataTableColumn[] = [
  { key: 'seat', label: 'Seat' },
  { key: 'os', label: 'OS' },
  { key: 'tier', label: 'Tier' },
  { key: 'lastSeen', label: 'Last seen' },
  { key: 'action', label: '' }
]

function reviewPendingRow(r: SeatViewRow, now: number, tierIndex: Map<string, string | null> | null): DataTableRow {
  const live = now - r.lastSeen < ONLINE_MS
  const name = r.hostname || `Seat ··${r.device.slice(-8)}`
  const seatCell = reviewSeatIdentityCell(name, r.email || 'No SSO email on file', !r.email, r.email, live)
  const versionChip = r.appVersion ? ` <span class="mono-id">${esc(r.appVersion)}</span>` : ''
  const payload = pendingReviewPayload(r, tierIndex)
  const actions = `<span class="review-actions">
    <button type="button" class="btn primary" data-review-approve="${esc(r.device)}">Approve</button>
    <button type="button" class="btn danger" data-review-revoke="${esc(r.device)}">Revoke</button>
  </span>`
  return {
    attrs: `data-review-row data-review-kind="seat" data-review-id="${esc(r.device)}" data-review-json="${esc(JSON.stringify(payload))}"`,
    cells: {
      seat: seatCell,
      os: `${osChip(r.os) || MISSING}${versionChip}`,
      tier: seatTierCell(r.device, tierIndex),
      lastSeen: timeCell(r.lastSeen, now),
      action: actions
    }
  }
}

const REVIEW_EXPIRING_COLUMNS: DataTableColumn[] = [
  { key: 'seat', label: 'Seat' },
  { key: 'tier', label: 'Tier' },
  { key: 'expires', label: 'Expires' },
  { key: 'action', label: '' }
]

function reviewExpiringRow(view: IssuedLicenseViewRow, seatByDevice: Map<string, SeatViewRow>, now: number): DataTableRow {
  const seat = view.activatedDevice ? seatByDevice.get(view.activatedDevice) : undefined
  const live = seat ? now - seat.lastSeen < ONLINE_MS : false
  const name = seat ? seat.hostname || `Seat ··${seat.device.slice(-8)}` : `License ··${view.last4}`
  const sub = seat ? seat.email || 'No SSO email on file' : 'Not yet activated'
  const seatCell = reviewSeatIdentityCell(name, sub, !seat || !seat.email, seat?.email ?? null, live)
  const payload = expiringReviewPayload(view, seatByDevice, now)
  const actions = `<span class="review-actions">
    <button type="button" class="btn danger" data-review-revoke="${esc(view.jti)}">Revoke</button>
  </span>`
  return {
    attrs: `data-review-row data-review-kind="license" data-review-id="${esc(view.jti)}" data-review-json="${esc(JSON.stringify(payload))}"`,
    cells: {
      seat: seatCell,
      tier: tierCell(view),
      expires: expiresCell(view, now),
      action: actions
    }
  }
}

/**
 * Block 0 (plan 6.7): above the Generate card, the only place a seat is approved or an expiring
 * license is dealt with. Both queues are derived from data this page already receives -- no
 * dashboard.ts change (see the file header for the one deliberate scope cut: no "Renew"). The
 * nugget and each segment's count are always the real row counts, never a separate number that
 * could drift from the rows underneath.
 */
function renderNeedsReviewBlock(data: DashboardPayload, ctx: RenderCtx, extra: LicensesExtra | undefined): string {
  const now = ctx.now
  const tierIndex = seatDeviceTierIndex(extra)
  const seatByDevice = new Map(data.licenses.rows.map((r) => [r.device, r]))
  const pending = data.licenses.rows
    .filter((r) => r.approval === 'pending')
    .slice()
    .sort((a, b) => b.lastSeen - a.lastSeen)
  const expiringViews = (data.licenses.issued || [])
    .map((r) => toViewRow(r, extra))
    .filter((v) => issuedLicenseStatus(v, now) === 'expiring')
    .sort((a, b) => a.exp - b.exp)
  const total = pending.length + expiringViews.length
  const activeSegment: 'pending' | 'expiring' = pending.length === 0 && expiringViews.length > 0 ? 'expiring' : 'pending'

  const nugget = `<span class="chip chip-accent lic-review-nugget" data-review-nugget data-count-to="${total}"${total === 0 ? ' hidden' : ''}>${total}</span>`

  const body =
    total === 0
      ? emptyState({
          title: 'Nothing waiting.',
          description: 'New seats appear here within a minute of their first heartbeat.'
        })
      : `<p class="muted lic-review-hint" data-review-hint>Keyboard: j and k move, a approves, r revokes, Enter opens, Esc closes.</p>
    ${segmented({
      items: [
        { id: 'pending', label: `Pending approval (${pending.length})`, active: activeSegment === 'pending' },
        { id: 'expiring', label: `Expiring soon (${expiringViews.length})`, active: activeSegment === 'expiring' }
      ],
      attrs: 'data-review-segmented'
    })}
    <div data-review-pane="pending"${activeSegment === 'pending' ? '' : ' hidden'}>${dataTable({
        id: 'licenses-review-pending-table',
        variant: 'card',
        rowClass: 'lic-review-row',
        columns: REVIEW_PENDING_COLUMNS,
        rows: pending.map((r) => reviewPendingRow(r, now, tierIndex)),
        emptyTitle: 'No seats pending approval',
        emptyDescription: 'Every seat that has checked in is already approved or revoked.'
      })}</div>
    <div data-review-pane="expiring"${activeSegment === 'expiring' ? '' : ' hidden'}>${dataTable({
        id: 'licenses-review-expiring-table',
        variant: 'card',
        rowClass: 'lic-review-row',
        columns: REVIEW_EXPIRING_COLUMNS,
        rows: expiringViews.map((v) => reviewExpiringRow(v, seatByDevice, now)),
        emptyTitle: 'Nothing expiring within 7 days',
        emptyDescription: 'Licenses due to expire soon will line up here, soonest first.'
      })}</div>`

  return `<article class="card pad-b10 lic-review-card" data-review-block>
    <div class="lic-review-head"><h3>Needs your review</h3>${nugget}</div>
    ${body}
    ${detailDrawer({ id: 'licenses-review-drawer' })}
  </article>`
}

// ── page ─────────────────────────────────────────────────────────────────────────────────────

export function renderLicenses(data: DashboardPayload, ctx: RenderCtx, extra?: LicensesExtra): string {
  return `<div class="licenses-page" data-email="${esc(data.email)}">
    ${pageHeader({
      title: 'Licenses',
      subtitle: 'A seat may use vault keys and connectors when it is approved or holds an active license. Revoke always wins.'
    })}
    ${renderNeedsReviewBlock(data, ctx, extra)}
    ${renderGenerateCard(data, ctx, extra)}
    ${renderSeatsCard(data, ctx.now, extra)}
  </div>`
}
