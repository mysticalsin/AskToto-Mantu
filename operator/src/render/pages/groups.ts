/**
 * Groups page (plan 6.6, P1.10 brief). List from GET /v1/admin/groups (dataTable: Name, Tier,
 * Members, Licenses issued / active, Seats live, Last active, Created) with the reference empty
 * state; Add group is a drawer (name, tier, notes); a row click opens a group drawer (never a
 * sub-page) with tabs Members (add by email or device id, remove with confirm), Licenses
 * (generate for this group with the once-string flow, issued table, Revoke), Seats, Connectors
 * scoped to this group, Activity.
 *
 * Architecture note: operator/src/dashboard.ts's DashboardPayload (a shared file this page does
 * not own) carries no group data -- plan section 4 D2 explicitly lists "groups" among the JSON
 * routes the client fetches per page on navigation (alongside events.json, sessions.json,
 * audit.json), rather than folding into the one shared payload every page's first paint reads.
 * renderGroups() below therefore renders the page shell with a loading skeleton shaped like the
 * final table; operator/client/pages/groups.ts's initGroups() fetches GET /v1/admin/groups (and
 * GET /v1/admin/groups/:id + GET /v1/admin/integrations for the drawer) immediately on mount and
 * replaces the skeleton through the pure renderGroupsTable()/renderGroupDrawerBody() functions
 * below -- the same functions this module's own tests call directly, so the client and the test
 * suite render byte-identical markup from the same wire shapes GET /v1/admin/groups[/:id] return
 * (operator/src/routes/groups.ts, already shipped). A future patch that teaches buildDashboard()
 * to carry a lightweight `groups` summary (see this task's final report) would let this page
 * render real rows on first paint with no client changes; until then the brief loss is one
 * network round trip behind a skeleton, never fake data.
 *
 * Security carry-over (2026-09-06 backend review, verdict SHIP): every interpolation of a group
 * name, notes, member identifier or tier label goes through esc() -- see groups.test.ts's
 * "<script>x</script>" group name case, which exercises the table row, the drawer header and the
 * drawer body all at once.
 */
import type { DashboardPayload } from '../../dashboard'
import {
  chip,
  dataTable,
  esc,
  logoGlyph,
  pageHeader,
  skeletonRows,
  statusDot,
  tabs,
  tierBadge,
  timeCell,
  toolbar,
  toolbarSearch,
  type DataTableRow,
  type RenderCtx,
  type StatusDotState
} from '../index'
import { iconSvg, NAV_ICON_PATHS } from '../icons'

// ---------------------------------------------------------------------------
// Wire types -- mirror operator/src/routes/groups.ts's JSON responses exactly, field for field,
// so a change to that route's shape is a compile error here rather than a silent drift.
// ---------------------------------------------------------------------------

export interface GroupListRow {
  id: string
  name: string
  tier: string
  notes: string | null
  createdAt: number
  createdBy: string | null
  members: number
  licensesIssued: number
  licensesActive: number
  seatsLive: number
  lastActiveAt: number | null
}

export interface GroupMemberItem {
  member: string
  kind: 'email' | 'device'
  addedAt: number
  addedBy: string | null
}

export interface GroupLicenseItem {
  jti: string
  last4: string
  tier: string
  member: string | null
  days: number
  exp: number
  revoked: boolean
  activatedDevice: string | null
  activatedAt: number | null
  createdAt: number
  createdBy: string | null
}

export interface GroupSeatItem {
  deviceId: string
  deviceShortId: string
  hostname: string | null
  email: string | null
  live: boolean
  licenseState: string
}

export interface GroupActivityItem {
  ts: number
  actor: string | null
  action: string
  detail: string | null
  requestId: string | null
  route: string | null
}

export interface GroupDetailPayload {
  group: {
    id: string
    name: string
    tier: string
    notes: string | null
    createdAt: number
    createdBy: string | null
  }
  members: GroupMemberItem[]
  licenses: GroupLicenseItem[]
  seats: GroupSeatItem[]
  activity: GroupActivityItem[]
}

/** Shaped by the client from GET /v1/admin/integrations (operator/src/routes/integrations.ts),
 *  filtered to the rows whose scope.groups includes this group's id -- that route's full summary
 *  carries fields (credential state, usage counters) the Connectors tab here has no use for. */
export interface GroupConnectorItem {
  id: string
  kind: string
  label: string
  transport: string | null
  mode: string | null
  health: 'connected' | 'failing' | 'untested'
}

export interface TierOption {
  id: string
  label: string
}

/** Fallback shown until GET /v1/admin/tiers answers (it always resolves to at least these two,
 *  ensureTiersSeeded() in routes/groups.ts seeds them the first time the table is empty). */
export const DEFAULT_TIER_OPTIONS: TierOption[] = [
  { id: 'metis', label: 'Métis' },
  { id: 'metis-light', label: 'Métis Light' }
]

export const GROUP_TABS = ['members', 'licenses', 'seats', 'connectors', 'activity'] as const
export type GroupTabId = (typeof GROUP_TABS)[number]

const GROUP_TAB_LABEL: Record<GroupTabId, string> = {
  members: 'Members',
  licenses: 'Licenses',
  seats: 'Seats',
  connectors: 'Connectors',
  activity: 'Activity'
}

const GROUP_LIST_COLUMNS: { key: string; label: string }[] = [
  { key: 'name', label: 'Name' },
  { key: 'tier', label: 'Tier' },
  { key: 'members', label: 'Members' },
  { key: 'licenses', label: 'Licenses' },
  { key: 'seatsLive', label: 'Seats live' },
  { key: 'lastActive', label: 'Last active' },
  { key: 'created', label: 'Created' }
]

// ---------------------------------------------------------------------------
// Small local helpers. Every one that touches a name, note, member id or tier label calls esc().
// ---------------------------------------------------------------------------

/** tierBadge() (design-lead's primitive) only knows the two shipped tier ids; a future custom
 *  tier still renders, escaped, as a plain chip rather than silently dropping the label. Exported
 *  so the client can render the drawer header's tier badge (outside `[data-drawer-body]`, so it
 *  survives a tab switch or an in-body edit-form swap) through the same function this page's
 *  table and drawer body use, rather than a second copy of the fallback rule. */
export function groupTierBadge(tier: string): string {
  if (tier === 'metis' || tier === 'metis-light') return tierBadge(tier)
  return chip({ label: tier })
}

function tierOptionsHtml(tiers: TierOption[], selected: string): string {
  return tiers
    .map((t) => `<option value="${esc(t.id)}"${t.id === selected ? ' selected' : ''}>${esc(t.label)}</option>`)
    .join('')
}

function licenseDurationOptionsHtml(): string {
  const options: { days: number; label: string }[] = [
    { days: 1, label: '1 day' },
    { days: 7, label: '7 days' },
    { days: 30, label: '30 days' },
    { days: 90, label: '90 days' },
    { days: 365, label: '1 year' }
  ]
  return options.map((o) => `<option value="${o.days}"${o.days === 30 ? ' selected' : ''}>${esc(o.label)}</option>`).join('')
}

function statusChip(state: StatusDotState, label: string): string {
  return statusDot({ state, label })
}

function licenseStatus(l: GroupLicenseItem, now: number): string {
  if (l.revoked) return statusChip('revoked', 'Revoked')
  if (l.exp * 1000 <= now) return statusChip('idle', 'Expired')
  return statusChip('live', 'Active')
}

function licenseStateLabel(state: string): string {
  const known: Record<string, string> = {
    approved: 'Approved',
    licensed: 'Licensed',
    expired: 'Expired',
    revoked: 'Revoked',
    pending: 'Pending'
  }
  return known[state] || state
}

function groupNameCell(name: string, notes: string | null): string {
  const noteLine = notes ? `<div class="group-notes" title="${esc(notes)}">${esc(notes)}</div>` : ''
  return `<div class="group-name-cell"><strong>${esc(name)}</strong>${noteLine}</div>`
}

function licenseCountsCell(issued: number, active: number): string {
  const activeCls = active > 0 ? ' group-count-active' : ' group-count-muted'
  return `<span class="${activeCls.trim()}">${active} active</span><span class="group-count-sep">/</span><span class="group-count-muted">${issued} issued</span>`
}

function seatsLiveCell(count: number): string {
  if (count <= 0) return '<span class="group-count-muted">0 live</span>'
  return statusChip('live', `${count} live`)
}

function lastActiveCell(ts: number | null, now: number): string {
  return ts ? timeCell(ts, now) : '<span class="group-count-muted">Not active yet</span>'
}

function groupRowCells(g: GroupListRow, now: number): Record<string, string> {
  return {
    name: groupNameCell(g.name, g.notes),
    tier: `<span data-pop>${groupTierBadge(g.tier)}</span>`,
    members: String(g.members),
    licenses: licenseCountsCell(g.licensesIssued, g.licensesActive),
    seatsLive: seatsLiveCell(g.seatsLive),
    lastActive: lastActiveCell(g.lastActiveAt, now),
    created: timeCell(g.createdAt, now)
  }
}

function groupRowAttrs(g: GroupListRow): string {
  const q = `${g.name} ${g.tier} ${g.notes || ''}`.toLowerCase()
  return `data-group-row data-group-id="${esc(g.id)}" data-q="${esc(q)}" role="button" tabindex="0" aria-label="Open ${esc(g.name)}"`
}

// ---------------------------------------------------------------------------
// List table -- exported so operator/client/pages/groups.ts can render fetched rows through the
// exact same function this module's tests exercise (plan D2, "re-renders through the page
// module"). Sorted by name so the table reads the same regardless of store row order.
// ---------------------------------------------------------------------------

export function renderGroupsTable(groups: GroupListRow[], now: number): string {
  const sorted = groups.slice().sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
  const rows: DataTableRow[] = sorted.map((g) => ({ cells: groupRowCells(g, now), attrs: groupRowAttrs(g) }))
  return dataTable({
    columns: GROUP_LIST_COLUMNS,
    rows,
    emptyTitle: 'No groups yet.',
    emptyDescription: 'A group gives a team a tier and its own licenses.',
    id: 'groups-table',
    rowClass: 'group-row',
    variant: 'card'
  })
}

/**
 * One `<tr>`, in the exact shape dataTable() would have produced for this row inside
 * renderGroupsTable() above (same columns, same `data-stagger`, same row class) -- used for the
 * plan 3.5b "after save the new row inserts with FLIP and a 600ms accent wash" motion: the client
 * inserts this single row into the existing `<tbody>` rather than replacing the whole table, so
 * motion.ts's flip() sees the other rows as unmoved and this one as genuinely new. Small,
 * deliberate duplication of dataTable()'s row markup (that primitive has no per-row export) kept
 * to these few lines and documented rather than reshaping a file this page does not own.
 */
export function renderGroupRowHtml(g: GroupListRow, now: number): string {
  const cells = groupRowCells(g, now)
  const tds = GROUP_LIST_COLUMNS.map((c) => `<td>${cells[c.key] ?? ''}</td>`).join('')
  return `<tr class="group-row" data-stagger ${groupRowAttrs(g)}>${tds}</tr>`
}

/** Loading state shaped like the final table (plan 3.7b law 8: "skeletons shaped like the final
 *  layout") while the client's first GET /v1/admin/groups is in flight. Not a `<table>` itself
 *  (skeletonRows() renders `<div>` rows, invalid as direct `<tbody>` children), so it sits beside
 *  the real table markup rather than inside a fake one. */
function renderGroupsSkeleton(): string {
  return `<div class="table-wrap"><div class="group-skeleton" role="status" aria-label="Loading groups">${skeletonRows(5)}</div></div>`
}

// ---------------------------------------------------------------------------
// Add group drawer.
// ---------------------------------------------------------------------------

function renderAddGroupDrawer(): string {
  return `<aside id="group-add-drawer" class="seat-overlay" hidden role="dialog" aria-modal="true" aria-labelledby="group-add-drawer-title">
    <div class="seat-overlay-head glass">
      <h4 id="group-add-drawer-title">Add group</h4>
      <button type="button" class="btn" id="group-add-drawer-close" aria-label="Close">Close</button>
    </div>
    <div class="group-form-grid">
      <form class="group-form" data-add-group-form autocomplete="off">
        <label>Name
          <input name="name" type="text" minlength="2" maxlength="60" required placeholder="Sales Paris" data-add-group-name>
        </label>
        <label>Tier
          <select name="tier" required data-add-group-tier>${tierOptionsHtml(DEFAULT_TIER_OPTIONS, 'metis')}</select>
        </label>
        <label>Notes
          <textarea name="notes" maxlength="500" placeholder="Optional"></textarea>
        </label>
        <div class="group-form-error" data-add-group-error hidden role="alert"></div>
        <button class="primary" type="submit">Add group</button>
      </form>
    </div>
  </aside>`
}

// ---------------------------------------------------------------------------
// Group detail drawer -- shell (rendered once, first paint) plus the body content the client
// fills in on row click (plan 6.6: "row click opens a group drawer (not a sub page) with tabs").
// ---------------------------------------------------------------------------

function renderGroupDrawerShell(): string {
  return `<aside id="group-drawer" class="seat-overlay group-drawer" hidden role="dialog" aria-modal="true" aria-labelledby="group-drawer-title">
    <div class="seat-overlay-head glass">
      <div class="group-drawer-heading">
        <h4 id="group-drawer-title" data-drawer-title></h4>
        <span data-group-drawer-tier></span>
      </div>
      <button type="button" class="btn" data-group-edit-open>Edit</button>
      <button type="button" class="btn" id="group-drawer-close" aria-label="Close">Close</button>
    </div>
    <div class="group-drawer-body" data-drawer-body role="status" aria-live="polite">${skeletonRows(4)}</div>
  </aside>`
}

function renderMembersPanel(detail: GroupDetailPayload): string {
  const chips = detail.members
    .map(
      (m) => `<span class="chip member-chip" data-member-chip="${esc(m.member)}">
        <span class="member-chip-name">${esc(m.member)}</span>
        <span class="member-chip-kind">${m.kind === 'email' ? 'email' : 'device'}</span>
        <button type="button" class="member-remove" data-remove-member="${esc(m.member)}" aria-label="Remove ${esc(m.member)}">${iconSvg(NAV_ICON_PATHS.x, { class: 'tool-ic' })}</button>
      </span>`
    )
    .join('')
  const list = chips
    ? `<div class="group-member-list" data-member-list>${chips}</div>`
    : `<div class="empty-data group-member-list" data-member-list role="status"><strong>No members yet.</strong><p>Add a member by email or device id.</p></div>`
  return `<form class="group-form group-member-form" data-member-form autocomplete="off">
      <select name="kind" data-member-kind aria-label="Member kind">
        <option value="email">Email</option>
        <option value="device">Device id</option>
      </select>
      <input name="member" type="text" placeholder="name@example.com" required data-member-input>
      <button class="primary" type="submit">Add member</button>
    </form>
    <div class="group-form-error" data-member-error hidden role="alert"></div>
    <div class="group-bulk-add">
      <button type="button" class="link-btn" data-member-bulk-toggle aria-expanded="false">Add many at once</button>
      <div class="group-bulk-fields" data-member-bulk-fields hidden>
        <textarea rows="4" placeholder="One email or device id per line" data-member-bulk-textarea></textarea>
        <div class="batch-preview" data-member-bulk-preview hidden></div>
        <button type="button" class="primary" data-member-bulk-submit>Add members</button>
      </div>
    </div>
    ${list}`
}

const GROUP_LICENSE_COLUMNS: { key: string; label: string }[] = [
  { key: 'member', label: 'Member' },
  { key: 'last4', label: 'Last4' },
  { key: 'expires', label: 'Expires' },
  { key: 'activated', label: 'Activated seat' },
  { key: 'status', label: 'Status' },
  { key: 'action', label: '' }
]

function groupLicenseRowCells(l: GroupLicenseItem, now: number): Record<string, string> {
  return {
    member: l.member ? esc(l.member) : '<span class="group-count-muted">No member set</span>',
    last4: `<span class="mono">••${esc(l.last4)}</span>`,
    expires: timeCell(l.exp * 1000, now),
    activated: l.activatedDevice
      ? `<span class="mono">${esc(l.activatedDevice.slice(0, 8))}</span>`
      : '<span class="group-count-muted">Not activated</span>',
    status: licenseStatus(l, now),
    action: l.revoked ? '' : `<button type="button" class="danger" data-group-license-revoke="${esc(l.jti)}">Revoke</button>`
  }
}

/** One `<tr>` for the group licenses table, same shape renderLicensesPanel() below produces
 *  (plan 3.5b Licenses row pattern reused for the group-scoped generate flow: "the issued table
 *  inserts the new row with FLIP and an accent wash") -- the client inserts this single row
 *  rather than redrawing the whole panel so the once-string reveal it plays at the same moment is
 *  never interrupted by a redraw. */
export function renderGroupLicenseRowHtml(l: GroupLicenseItem, now: number): string {
  const cells = groupLicenseRowCells(l, now)
  const tds = GROUP_LICENSE_COLUMNS.map((c) => `<td>${cells[c.key] ?? ''}</td>`).join('')
  return `<tr data-stagger data-license-row="${esc(l.jti)}">${tds}</tr>`
}

function renderLicensesPanel(detail: GroupDetailPayload, now: number, tiers: TierOption[]): string {
  const rows: DataTableRow[] = detail.licenses
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((l) => ({ cells: groupLicenseRowCells(l, now), attrs: `data-license-row="${esc(l.jti)}"` }))
  const table = dataTable({
    columns: GROUP_LICENSE_COLUMNS,
    rows,
    emptyTitle: 'No licenses issued to this group yet.',
    emptyDescription: 'Generate one above; it carries this group’s tier by default.',
    id: 'group-licenses-table',
    variant: 'card'
  })
  return `<form class="group-form group-license-form" data-group-license-generate autocomplete="off">
      <label>Active for
        <select name="days" required>${licenseDurationOptionsHtml()}</select>
      </label>
      <label>Tier
        <select name="tier" required data-group-license-tier>${tierOptionsHtml(tiers, detail.group.tier)}</select>
      </label>
      <input name="member" type="text" placeholder="Member email or device id (optional)" data-group-license-member>
      <button class="primary" type="submit">Generate license</button>
    </form>
    <div class="group-form-error" data-group-license-error hidden role="alert"></div>
    <div class="license-once" hidden data-group-license-once>
      <p class="sub">Copy this once. It will not be shown again.</p>
      <input data-group-license-once-value readonly spellcheck="false">
      <button type="button" class="primary" data-group-license-once-copy>Copy</button>
    </div>
    <div data-group-licenses-table>${table}</div>`
}

function renderSeatsPanel(detail: GroupDetailPayload): string {
  const rows: DataTableRow[] = detail.seats.map((s) => ({
    cells: {
      seat: `<div class="group-name-cell"><strong>${s.hostname ? esc(s.hostname) : 'Unnamed device'}</strong>${
        s.email ? `<div class="group-notes">${esc(s.email)}</div>` : ''
      }</div>`,
      device: `<span class="mono">${esc(s.deviceShortId)}</span>`,
      live: s.live ? statusChip('live', 'Live') : statusChip('idle', 'Idle'),
      license: esc(licenseStateLabel(s.licenseState))
    },
    attrs: `data-seat-device="${esc(s.deviceId)}"`
  }))
  return dataTable({
    columns: [
      { key: 'seat', label: 'Seat' },
      { key: 'device', label: 'Device' },
      { key: 'live', label: 'Live' },
      { key: 'license', label: 'License state' }
    ],
    rows,
    emptyTitle: 'No seats resolve to this group yet.',
    emptyDescription: 'A seat joins this group through a group-issued license or a matching member email or device id.',
    id: 'group-seats-table',
    variant: 'card'
  })
}

function renderConnectorsPanel(connectors: GroupConnectorItem[]): string {
  const rows: DataTableRow[] = connectors.map((c) => ({
    cells: {
      connector: `<div class="group-connector-cell">${logoGlyph(c.kind, c.label, { size: 20 })}<span>${esc(c.label)}</span></div>`,
      transport: c.transport ? chip({ label: c.transport === 'mcp' ? 'MCP' : 'API' }) : '',
      mode: esc(c.mode === 'direct' ? 'Direct' : 'Brokered'),
      status:
        c.health === 'connected'
          ? statusChip('live', 'Connected')
          : c.health === 'failing'
            ? statusChip('failed', 'Failing')
            : statusChip('pending', 'Untested')
    },
    attrs: `data-connector-row="${esc(c.id)}"`
  }))
  return dataTable({
    columns: [
      { key: 'connector', label: 'Connector' },
      { key: 'transport', label: 'Transport' },
      { key: 'mode', label: 'Mode' },
      { key: 'status', label: 'Status' }
    ],
    rows,
    emptyTitle: 'No connector is scoped to this group.',
    emptyDescription: 'Scope a connector to this group from its connection drawer on Connectors.',
    id: 'group-connectors-table',
    variant: 'card'
  })
}

function renderActivityPanel(detail: GroupDetailPayload, now: number): string {
  const rows: DataTableRow[] = detail.activity.map((a) => ({
    cells: {
      when: timeCell(a.ts, now),
      actor: esc(a.actor || 'system'),
      action: esc(a.action),
      detail: a.detail ? esc(a.detail) : '<span class="group-count-muted">No detail</span>'
    }
  }))
  return dataTable({
    columns: [
      { key: 'when', label: 'When' },
      { key: 'actor', label: 'Actor' },
      { key: 'action', label: 'Action' },
      { key: 'detail', label: 'Detail' }
    ],
    rows,
    emptyTitle: 'No activity for this group yet.',
    emptyDescription: 'Actions on this group (create, edit, member, license) are audited and appear here.',
    id: 'group-activity-table',
    variant: 'card'
  })
}

function renderGroupPanel(
  id: GroupTabId,
  detail: GroupDetailPayload,
  connectors: GroupConnectorItem[],
  now: number,
  tiers: TierOption[]
): string {
  if (id === 'members') return renderMembersPanel(detail)
  if (id === 'licenses') return renderLicensesPanel(detail, now, tiers)
  if (id === 'seats') return renderSeatsPanel(detail)
  if (id === 'connectors') return renderConnectorsPanel(connectors)
  return renderActivityPanel(detail, now)
}

/**
 * The group drawer's `[data-drawer-body]` content: notes, a created-by line, the tab strip and
 * every panel (all rendered up front, non-active ones `hidden`, so switching tabs client-side is
 * a plain `hidden` toggle with no re-fetch). Exported so both operator/client/pages/groups.ts and
 * this module's tests build the drawer through one function.
 */
export function renderGroupDrawerBody(
  detail: GroupDetailPayload,
  connectors: GroupConnectorItem[],
  now: number,
  opts?: { activeTab?: GroupTabId; tiers?: TierOption[] }
): string {
  const activeTab = opts?.activeTab ?? 'members'
  const tiers = opts?.tiers ?? DEFAULT_TIER_OPTIONS
  const notes = detail.group.notes ? `<p class="group-drawer-notes">${esc(detail.group.notes)}</p>` : ''
  const meta = `<p class="group-drawer-meta muted">Created ${timeCell(detail.group.createdAt, now)} by ${esc(detail.group.createdBy || 'operator')}.</p>`
  const tabsHtml = tabs({
    items: GROUP_TABS.map((id) => ({ id, label: GROUP_TAB_LABEL[id], active: id === activeTab })),
    attrs: 'data-group-tabs'
  })
  const panels = GROUP_TABS.map((id) => {
    const hiddenAttr = id === activeTab ? '' : ' hidden'
    return `<div class="group-tab-panel" data-group-panel="${id}"${hiddenAttr}>${renderGroupPanel(id, detail, connectors, now, tiers)}</div>`
  }).join('')
  return `${notes}${meta}${tabsHtml}${panels}`
}

/** Replaces the drawer body with an inline edit form for name / tier / notes (the drawer header's
 *  Edit button, plan 6.6: "header with tier badge and Edit"). Cancel re-renders the normal body;
 *  the client owns both transitions, this is markup only. */
export function renderGroupEditForm(detail: GroupDetailPayload, tiers: TierOption[]): string {
  return `<form class="group-form group-edit-form" data-group-edit-form autocomplete="off">
    <label>Name
      <input name="name" type="text" minlength="2" maxlength="60" required value="${esc(detail.group.name)}">
    </label>
    <label>Tier
      <select name="tier" required>${tierOptionsHtml(tiers, detail.group.tier)}</select>
    </label>
    <label>Notes
      <textarea name="notes" maxlength="500" placeholder="Optional">${esc(detail.group.notes || '')}</textarea>
    </label>
    <div class="group-form-error" data-group-edit-error hidden role="alert"></div>
    <div class="row group-edit-actions">
      <button type="button" class="btn" data-group-edit-cancel>Cancel</button>
      <button class="primary" type="submit">Save</button>
    </div>
  </form>`
}

// ---------------------------------------------------------------------------
// Page shell (first paint / operator/client/main.ts's rerender('groups')).
// ---------------------------------------------------------------------------

export function renderGroups(_data: DashboardPayload, _ctx: RenderCtx): string {
  const addAction = `<button type="button" class="primary" data-add-group-open>${iconSvg(NAV_ICON_PATHS.plus, { class: 'tool-ic' })}<span>Add group</span></button>`
  return `${pageHeader({ title: 'Groups', subtitle: 'Teams, tiers and the licenses they hold.', action: addAction })}
    ${toolbar({ left: toolbarSearch({ id: 'groups-search', placeholder: 'Search groups' }), right: '' })}
    <article class="card pad-b10" data-groups-card>
      <div data-groups-root data-groups-state="loading">${renderGroupsSkeleton()}</div>
      <div class="group-inline-error" data-groups-error hidden role="alert"></div>
    </article>
    ${renderAddGroupDrawer()}
    ${renderGroupDrawerShell()}`
}
