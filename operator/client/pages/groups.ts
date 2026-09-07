/**
 * Groups page client init (plan 6.6, P1.10 brief). Fetches GET /v1/admin/groups (the JSON route
 * plan D2 lists for this page, since DashboardPayload carries no group data -- see the top
 * comment in operator/src/render/pages/groups.ts) and renders it through renderGroupsTable(); a
 * row click fetches GET /v1/admin/groups/:id plus GET /v1/admin/integrations (for the Connectors
 * tab's scope filter) and renders the drawer through renderGroupDrawerBody(). Every mutation goes
 * through this file's own request() helper and refreshes only what changed, never a full-document
 * reload (plan D3 retires that pattern from operator/client/**).
 *
 * request() duplicates operator/client/api.ts's session-bearer protocol (ping GET /session once,
 * cache the bearer, attach it as `Authorization: Bearer`) because api() only ever issues GET or
 * POST and this page needs PATCH (edit a group) and DELETE (remove a member) too; api.ts is a
 * shared file this page does not own. See this task's final report for the small, optional patch
 * that would let api() take a method and retire this duplication.
 */
import type { DashboardPayload } from '../../src/dashboard'
import { esc } from '../../src/render'
import {
  DEFAULT_TIER_OPTIONS,
  groupTierBadge,
  renderGroupDrawerBody,
  renderGroupEditForm,
  renderGroupLicenseRowHtml,
  renderGroupRowHtml,
  renderGroupsTable,
  type GroupConnectorItem,
  type GroupDetailPayload,
  type GroupListRow,
  type GroupTabId,
  type TierOption
} from '../../src/render/pages/groups'
import { bindMotion } from '../motion-bind'
import { flash, flip, pop, reduceMotion, sequence, shimmer, slideIn } from '../motion'
import { toast } from '../toasts'

// ---------------------------------------------------------------------------
// Session-aware fetch (see the file doc comment above for why this cannot just be api()).
// ---------------------------------------------------------------------------

let sessionBearer = ''

async function ensureSession(): Promise<void> {
  if (sessionBearer) return
  try {
    const ping = await fetch('/session', { method: 'GET', credentials: 'include', headers: { accept: 'application/json' } })
    const issued = ping.headers && ping.headers.get && ping.headers.get('X-Metis-Session')
    if (issued) sessionBearer = issued
    const text = await ping.text()
    try {
      const j = JSON.parse(text) as { session?: string }
      if (j && j.session) sessionBearer = j.session
    } catch {
      /* not JSON: cookie-only session, nothing to cache */
    }
  } catch {
    /* offline or blocked: request() below still tries with cookies alone */
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function request(path: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', body?: unknown): Promise<any> {
  await ensureSession()
  const headers: Record<string, string> = { accept: 'application/json' }
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (sessionBearer) headers.authorization = 'Bearer ' + sessionBearer
  let res: Response
  try {
    res = await fetch(path, { method, credentials: 'include', headers, body: body !== undefined ? JSON.stringify(body) : undefined })
  } catch {
    return { ok: false, error: 'network failed' }
  }
  try {
    const issued = res.headers && res.headers.get && res.headers.get('X-Metis-Session')
    if (issued) sessionBearer = issued
  } catch {
    /* header read blocked in some test/preview contexts: keep whatever bearer we had */
  }
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    return { ok: false, error: text ? text.slice(0, 180) : 'HTTP ' + res.status }
  }
}

// ---------------------------------------------------------------------------
// Module state. One Groups section exists at a time, so plain module-level state (reset by every
// initGroups() call, which always runs after a fresh render of the section) is enough.
// ---------------------------------------------------------------------------

let cachedTiers: TierOption[] | null = null
let currentGroupId: string | null = null
let currentTab: GroupTabId = 'members'
let listDirty = false

async function ensureTiers(): Promise<TierOption[]> {
  if (cachedTiers) return cachedTiers
  const res = await request('/v1/admin/tiers', 'GET')
  if (res && res.ok !== false && Array.isArray(res.tiers) && res.tiers.length) {
    cachedTiers = (res.tiers as { id: unknown; label: unknown }[])
      .filter((t) => typeof t.id === 'string' && typeof t.label === 'string')
      .map((t) => ({ id: t.id as string, label: t.label as string }))
  }
  return cachedTiers && cachedTiers.length ? cachedTiers : DEFAULT_TIER_OPTIONS
}

function populateTierSelect(select: HTMLSelectElement | null): void {
  if (!select) return
  ensureTiers()
    .then((tiers) => {
      const current = select.value
      select.innerHTML = tiers
        .map((t) => `<option value="${esc(t.id)}"${t.id === current ? ' selected' : ''}>${esc(t.label)}</option>`)
        .join('')
    })
    .catch(() => {
      /* keep the server-rendered default options */
    })
}

// ---------------------------------------------------------------------------
// The list.
// ---------------------------------------------------------------------------

function applySearchFilter(section: HTMLElement): void {
  const input = section.querySelector<HTMLInputElement>('#groups-search')
  const q = (input && input.value ? input.value : '').trim().toLowerCase()
  section.querySelectorAll<HTMLElement>('[data-group-row]').forEach((row) => {
    const haystack = row.getAttribute('data-q') || ''
    row.hidden = q.length > 0 && haystack.indexOf(q) < 0
  })
}

function wireGroupRow(section: HTMLElement, row: HTMLElement): void {
  const open = (): void => {
    const id = row.getAttribute('data-group-id')
    if (id) openGroupDrawer(section, id)
  }
  row.addEventListener('click', open)
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      open()
    }
  })
}

function wireGroupRows(section: HTMLElement, root: ParentNode): void {
  root.querySelectorAll<HTMLElement>('[data-group-row]').forEach((row) => wireGroupRow(section, row))
}

async function loadGroupsList(section: HTMLElement): Promise<void> {
  const root = section.querySelector<HTMLElement>('[data-groups-root]')
  const errorEl = section.querySelector<HTMLElement>('[data-groups-error]')
  if (!root) return
  if (errorEl) errorEl.hidden = true
  const res = await request('/v1/admin/groups', 'GET')
  if (!res || res.ok === false) {
    root.setAttribute('data-groups-state', 'error')
    if (errorEl) {
      errorEl.hidden = false
      errorEl.textContent = (res && res.error) || 'Could not load groups. Reopen this page to retry.'
    }
    return
  }
  const groups = (Array.isArray(res.groups) ? res.groups : []) as GroupListRow[]
  root.setAttribute('data-groups-state', 'ready')
  root.innerHTML = renderGroupsTable(groups, Date.now())
  bindMotion(root)
  wireGroupRows(section, root)
  applySearchFilter(section)
  listDirty = false
}

/** Inserts one freshly created group's row with FLIP + a 600ms accent wash (plan 3.5b Groups row)
 *  instead of redrawing the whole table, so the rows that were already there do not re-animate. */
function insertNewGroupRow(
  section: HTMLElement,
  g: { id: string; name: string; tier: string; notes: string | null; createdAt: number; createdBy: string | null }
): void {
  const root = section.querySelector<HTMLElement>('[data-groups-root]')
  const table = root ? root.querySelector<HTMLElement>('#groups-table') : null
  const tbody = table ? table.querySelector('tbody') : null
  if (!root || !tbody) {
    // No table yet (the empty state was showing, or the list has not loaded): a full load
    // renders the real table now that there is at least one row.
    void loadGroupsList(section)
    return
  }
  const row: GroupListRow = {
    id: g.id,
    name: g.name,
    tier: g.tier,
    notes: g.notes || null,
    createdAt: g.createdAt,
    createdBy: g.createdBy || null,
    members: 0,
    licensesIssued: 0,
    licensesActive: 0,
    seatsLive: 0,
    lastActiveAt: null
  }
  const html = renderGroupRowHtml(row, Date.now())
  flip(tbody as HTMLElement, () => {
    ;(tbody as HTMLElement).insertAdjacentHTML('beforeend', html)
  })
  const inserted = tbody.querySelector<HTMLElement>(`[data-group-id="${CSS.escape(row.id)}"]`)
  if (inserted) {
    bindMotion(inserted)
    flash(inserted)
    wireGroupRow(section, inserted)
  }
  applySearchFilter(section)
}

// ---------------------------------------------------------------------------
// Add group drawer.
// ---------------------------------------------------------------------------

function wireAddGroupDrawer(section: HTMLElement): void {
  const drawer = section.querySelector<HTMLElement>('#group-add-drawer')
  const openBtn = section.querySelector<HTMLElement>('[data-add-group-open]')
  const closeBtn = section.querySelector<HTMLElement>('#group-add-drawer-close')
  const form = section.querySelector<HTMLFormElement>('[data-add-group-form]')
  if (!drawer) return

  const open = (): void => {
    drawer.hidden = false
    slideIn(drawer, 'right')
    populateTierSelect(drawer.querySelector<HTMLSelectElement>('[data-add-group-tier]'))
    drawer.querySelector<HTMLInputElement>('[data-add-group-name]')?.focus()
  }
  const close = (): void => {
    drawer.hidden = true
  }
  if (openBtn) openBtn.addEventListener('click', open)
  if (closeBtn) closeBtn.addEventListener('click', close)

  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault()
      const errorEl = section.querySelector<HTMLElement>('[data-add-group-error]')
      if (errorEl) {
        errorEl.hidden = true
        errorEl.textContent = ''
      }
      const fd = new FormData(form)
      const body = {
        name: String(fd.get('name') || ''),
        tier: String(fd.get('tier') || 'metis'),
        notes: String(fd.get('notes') || '')
      }
      const res = await request('/v1/admin/groups', 'POST', body)
      if (!res || res.ok === false) {
        if (errorEl) {
          errorEl.hidden = false
          errorEl.textContent = (res && res.error) || 'Could not add the group. Its name and notes are kept above.'
        }
        return
      }
      toast({ kind: 'ok', text: `${res.group.name} added.` })
      close()
      form.reset()
      insertNewGroupRow(section, res.group)
    })
  }

  section.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !drawer.hidden) close()
  })
}

// ---------------------------------------------------------------------------
// Group detail drawer.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractScopedConnectors(res: any, groupId: string): GroupConnectorItem[] {
  if (!res || res.ok === false || !Array.isArray(res.integrations)) return []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return res.integrations
    .filter((i: any) => i && i.scope && Array.isArray(i.scope.groups) && i.scope.groups.indexOf(groupId) >= 0)
    .map((i: any) => ({
      id: String(i.id),
      kind: String(i.kind),
      label: String(i.label),
      transport: typeof i.transport === 'string' ? i.transport : null,
      mode: typeof i.mode === 'string' ? i.mode : null,
      health: i.health === 'connected' || i.health === 'failing' ? i.health : 'untested'
    }))
}

function drawerHeaderEls(drawer: HTMLElement): { title: HTMLElement | null; tier: HTMLElement | null; body: HTMLElement | null } {
  return {
    title: drawer.querySelector<HTMLElement>('[data-drawer-title]'),
    tier: drawer.querySelector<HTMLElement>('[data-group-drawer-tier]'),
    body: drawer.querySelector<HTMLElement>('[data-drawer-body]')
  }
}

function renderDrawer(
  section: HTMLElement,
  drawer: HTMLElement,
  detail: GroupDetailPayload,
  connectors: GroupConnectorItem[],
  tiers: TierOption[],
  activeTab: GroupTabId
): void {
  const { title, tier, body } = drawerHeaderEls(drawer)
  if (title) title.textContent = detail.group.name
  if (tier) tier.innerHTML = groupTierBadge(detail.group.tier)
  if (!body) return
  currentTab = activeTab
  body.innerHTML = renderGroupDrawerBody(detail, connectors, Date.now(), { activeTab, tiers })
  bindMotion(body)
  wireTabs(drawer)
  wireEdit(section, drawer, detail, connectors, tiers)
  wireMembersPanel(drawer, detail)
  wireLicensesPanel(drawer, detail)
}

function wireTabs(drawer: HTMLElement): void {
  const buttons = Array.from(drawer.querySelectorAll<HTMLElement>('[data-group-tabs] [data-tab]'))
  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.getAttribute('data-tab') as GroupTabId | null
      if (!tab) return
      buttons.forEach((b) => {
        const active = b === btn
        b.classList.toggle('on', active)
        b.setAttribute('aria-selected', active ? 'true' : 'false')
      })
      drawer.querySelectorAll<HTMLElement>('[data-group-panel]').forEach((panel) => {
        panel.hidden = panel.getAttribute('data-group-panel') !== tab
      })
      currentTab = tab
    })
  })
}

async function refreshDrawer(section: HTMLElement, drawer: HTMLElement, groupId: string, activeTab: GroupTabId): Promise<void> {
  const [detailRes, integrationsRes, tiers] = await Promise.all([
    request(`/v1/admin/groups/${encodeURIComponent(groupId)}`, 'GET'),
    request('/v1/admin/integrations', 'GET'),
    ensureTiers()
  ])
  if (currentGroupId !== groupId) return
  if (!detailRes || detailRes.ok === false) {
    toast({ kind: 'error', text: (detailRes && detailRes.error) || 'Could not refresh this group.' })
    return
  }
  const detail: GroupDetailPayload = {
    group: detailRes.group,
    members: detailRes.members,
    licenses: detailRes.licenses,
    seats: detailRes.seats,
    activity: detailRes.activity
  }
  renderDrawer(section, drawer, detail, extractScopedConnectors(integrationsRes, groupId), tiers, activeTab)
  listDirty = true
}

function wireEdit(
  section: HTMLElement,
  drawer: HTMLElement,
  detail: GroupDetailPayload,
  connectors: GroupConnectorItem[],
  tiers: TierOption[]
): void {
  const editBtn = drawer.querySelector<HTMLElement>('[data-group-edit-open]')
  if (!editBtn) return
  editBtn.addEventListener('click', () => {
    const body = drawer.querySelector<HTMLElement>('[data-drawer-body]')
    if (!body) return
    body.innerHTML = renderGroupEditForm(detail, tiers)
    bindMotion(body)
    const form = body.querySelector<HTMLFormElement>('[data-group-edit-form]')
    const cancelBtn = body.querySelector<HTMLElement>('[data-group-edit-cancel]')
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => renderDrawer(section, drawer, detail, connectors, tiers, currentTab))
    }
    if (form) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault()
        const errorEl = form.querySelector<HTMLElement>('[data-group-edit-error]')
        if (errorEl) errorEl.hidden = true
        const fd = new FormData(form)
        const patch = {
          name: String(fd.get('name') || ''),
          tier: String(fd.get('tier') || ''),
          notes: String(fd.get('notes') || '')
        }
        const res = await request(`/v1/admin/groups/${encodeURIComponent(detail.group.id)}`, 'PATCH', patch)
        if (!res || res.ok === false) {
          if (errorEl) {
            errorEl.hidden = false
            errorEl.textContent = (res && res.error) || 'Could not save this group.'
          }
          return
        }
        toast({ kind: 'ok', text: 'Group saved.' })
        await refreshDrawer(section, drawer, detail.group.id, currentTab)
      })
    }
  })
}

function wireMembersPanel(drawer: HTMLElement, detail: GroupDetailPayload): void {
  const panel = drawer.querySelector<HTMLElement>('[data-group-panel="members"]')
  if (!panel) return
  const form = panel.querySelector<HTMLFormElement>('[data-member-form]')
  if (form) {
    const kindSelect = form.querySelector<HTMLSelectElement>('[data-member-kind]')
    const memberInput = form.querySelector<HTMLInputElement>('[data-member-input]')
    if (kindSelect && memberInput) {
      kindSelect.addEventListener('change', () => {
        memberInput.placeholder = kindSelect.value === 'device' ? 'Device id, from Sessions' : 'name@example.com'
      })
    }
    form.addEventListener('submit', async (e) => {
      e.preventDefault()
      const errorEl = panel.querySelector<HTMLElement>('[data-member-error]')
      if (errorEl) errorEl.hidden = true
      const fd = new FormData(form)
      const body = { member: String(fd.get('member') || ''), kind: String(fd.get('kind') || 'email') }
      const res = await request(`/v1/admin/groups/${encodeURIComponent(detail.group.id)}/members`, 'POST', body)
      if (!res || res.ok === false) {
        if (errorEl) {
          errorEl.hidden = false
          errorEl.textContent = (res && res.error) || 'Could not add this member.'
        }
        return
      }
      toast({ kind: 'ok', text: 'Member added.' })
      form.reset()
      if (memberInput) memberInput.placeholder = 'name@example.com'
      addMemberChip(panel, detail, res.member, res.kind === 'device' ? 'device' : 'email')
      listDirty = true
    })
  }
  panel.querySelectorAll<HTMLElement>('[data-remove-member]').forEach((btn) => wireRemoveMemberButton(panel, detail, btn))
  wireBulkMemberAdd(panel, detail)
}

// ---------------------------------------------------------------------------------------------
// Bulk member add (plan 6.7b "Groups: paste a member list to add many at once, with the same
// preview of duplicates and malformed lines"). Reuses the single `POST .../members` endpoint one
// line at a time (this page owns no batch route) rather than duplicating server-side validation
// client-side; the preview below is informational only, same caveat as the Licenses batch preview
// (operator/src/render/pages/licenses.ts): a line that is not email-shaped might still be a valid
// device id, which only the server can confirm.
// ---------------------------------------------------------------------------------------------

const GROUP_BULK_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function renderBulkMemberPreview(panel: HTMLElement, existing: Set<string>): void {
  const textarea = panel.querySelector<HTMLTextAreaElement>('[data-member-bulk-textarea]')
  const preview = panel.querySelector<HTMLElement>('[data-member-bulk-preview]')
  if (!textarea || !preview) return
  const lines = textarea.value
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  if (!lines.length) {
    preview.hidden = true
    preview.innerHTML = ''
    return
  }
  const seen = new Set<string>()
  const rows: string[] = []
  let dup = 0
  let already = 0
  for (const line of lines) {
    const key = line.toLowerCase()
    if (existing.has(key)) {
      already++
      rows.push(`<div class="batch-preview-line is-dup">${esc(line)}, already a member</div>`)
      continue
    }
    if (seen.has(key)) {
      dup++
      rows.push(`<div class="batch-preview-line is-dup">${esc(line)}, duplicate, will be added once</div>`)
      continue
    }
    seen.add(key)
    const looksEmail = GROUP_BULK_EMAIL_RE.test(line)
    rows.push(`<div class="batch-preview-line${looksEmail ? '' : ' is-bad'}">${esc(line)}${looksEmail ? '' : ', not an email, checked as a device id'}</div>`)
  }
  preview.hidden = false
  preview.innerHTML = `<div class="batch-preview-count">${lines.length} lines, ${dup} duplicate, ${already} already a member</div>${rows.join('')}`
}

function wireBulkMemberAdd(panel: HTMLElement, detail: GroupDetailPayload): void {
  const toggle = panel.querySelector<HTMLButtonElement>('[data-member-bulk-toggle]')
  const fields = panel.querySelector<HTMLElement>('[data-member-bulk-fields]')
  const textarea = panel.querySelector<HTMLTextAreaElement>('[data-member-bulk-textarea]')
  const submitBtn = panel.querySelector<HTMLButtonElement>('[data-member-bulk-submit]')
  if (!toggle || !fields || !textarea || !submitBtn) return

  function existingMembers(): Set<string> {
    return new Set(Array.from(panel.querySelectorAll<HTMLElement>('[data-member-chip]')).map((el) => (el.getAttribute('data-member-chip') || '').toLowerCase()))
  }

  toggle.addEventListener('click', () => {
    const opening = fields!.hidden
    fields!.hidden = !opening
    toggle.setAttribute('aria-expanded', String(opening))
    if (opening) textarea!.focus()
  })
  textarea.addEventListener('input', () => renderBulkMemberPreview(panel, existingMembers()))

  submitBtn.addEventListener('click', async () => {
    const lines = Array.from(new Set(textarea.value.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)))
    if (!lines.length) return
    submitBtn.disabled = true
    const original = submitBtn.textContent
    let ok = 0
    let failed = 0
    const failedLines: string[] = []
    for (let i = 0; i < lines.length; i++) {
      submitBtn.textContent = `Adding ${i + 1}/${lines.length}...`
      const line = lines[i]
      const kind = GROUP_BULK_EMAIL_RE.test(line) ? 'email' : 'device'
      const res = await request(`/v1/admin/groups/${encodeURIComponent(detail.group.id)}/members`, 'POST', { member: line, kind })
      if (res && res.ok !== false) {
        ok++
        addMemberChip(panel, detail, res.member || line, res.kind === 'device' ? 'device' : 'email')
      } else {
        failed++
        failedLines.push(line)
      }
    }
    submitBtn.disabled = false
    submitBtn.textContent = original
    textarea.value = ''
    renderBulkMemberPreview(panel, existingMembers())
    if (ok) listDirty = true
    if (failed) {
      toast({ kind: ok ? 'info' : 'error', text: `${ok} added, ${failed} failed: ${failedLines.join(', ')}` })
    } else {
      toast({ kind: 'ok', text: `${ok} member${ok === 1 ? '' : 's'} added.` })
    }
  })
}

function memberChipHtml(member: string, kind: 'email' | 'device'): string {
  return `<span class="chip member-chip" data-member-chip="${esc(member)}">
    <span class="member-chip-name">${esc(member)}</span>
    <span class="member-chip-kind">${kind}</span>
    <button type="button" class="member-remove" data-remove-member="${esc(member)}" aria-label="Remove ${esc(member)}">×</button>
  </span>`
}

function addMemberChip(panel: HTMLElement, detail: GroupDetailPayload, member: string, kind: 'email' | 'device'): void {
  let list = panel.querySelector<HTMLElement>('[data-member-list]')
  if (!list || list.classList.contains('empty-data')) {
    if (list) list.remove()
    list = document.createElement('div')
    list.className = 'group-member-list'
    list.setAttribute('data-member-list', '')
    panel.appendChild(list)
  }
  list.insertAdjacentHTML('beforeend', memberChipHtml(member, kind))
  const chip = list.querySelector<HTMLElement>(`[data-member-chip="${CSS.escape(member)}"]`)
  if (chip) {
    pop(chip)
    const btn = chip.querySelector<HTMLElement>('[data-remove-member]')
    if (btn) wireRemoveMemberButton(panel, detail, btn)
  }
}

/**
 * Plan 3.5b Groups row: "remove: fades and collapses height 200ms." Members lay out in a
 * wrapping row of chips, not a column of rows, so "collapse" here means the chip's own box
 * shrinking to nothing (the equivalent reflow for a wrapping flex layout) rather than a literal
 * height animation. A CSS class toggle (operator/src/spa/css-groups.ts's `.member-chip` /
 * `.member-chip-removing` transition, driven by the `--ease-color` token) rather than any
 * per-instance inline style, per the non-negotiable "no inline style=" rule. Reduced motion:
 * removes the node immediately with no transition.
 */
function collapseAndRemove(chip: HTMLElement): void {
  if (reduceMotion()) {
    finishRemove(chip)
    return
  }
  chip.classList.add('member-chip-removing')
  window.setTimeout(() => finishRemove(chip), 220)
}

function finishRemove(chip: HTMLElement): void {
  const list = chip.parentElement
  chip.remove()
  if (list && !list.querySelector('[data-member-chip]')) {
    const panel = list.parentElement
    list.remove()
    if (panel) {
      panel.insertAdjacentHTML(
        'beforeend',
        '<div class="empty-data group-member-list" data-member-list role="status"><strong>No members yet.</strong><p>Add a member by email or device id.</p></div>'
      )
    }
  }
}

function wireRemoveMemberButton(panel: HTMLElement, detail: GroupDetailPayload, btn: HTMLElement): void {
  btn.addEventListener('click', () => {
    const member = btn.getAttribute('data-remove-member')
    const chip = btn.closest<HTMLElement>('[data-member-chip]')
    if (!member || !chip) return
    void (async () => {
      if (!window.confirm(`Remove ${member} from ${detail.group.name}?`)) return
      const res = await request(`/v1/admin/groups/${encodeURIComponent(detail.group.id)}/members/${encodeURIComponent(member)}`, 'DELETE')
      if (!res || res.ok === false) {
        toast({ kind: 'error', text: (res && res.error) || 'Could not remove this member.' })
        return
      }
      toast({ kind: 'ok', text: 'Member removed.' })
      collapseAndRemove(chip)
      listDirty = true
    })()
  })
}

function wireLicensesPanel(drawer: HTMLElement, detail: GroupDetailPayload): void {
  const panel = drawer.querySelector<HTMLElement>('[data-group-panel="licenses"]')
  if (!panel) return
  const form = panel.querySelector<HTMLFormElement>('[data-group-license-generate]')
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault()
      const errorEl = panel.querySelector<HTMLElement>('[data-group-license-error]')
      if (errorEl) errorEl.hidden = true
      const fd = new FormData(form)
      const body = {
        days: Number(fd.get('days')),
        tier: String(fd.get('tier') || detail.group.tier),
        member: String(fd.get('member') || '')
      }
      const res = await request(`/v1/admin/groups/${encodeURIComponent(detail.group.id)}/licenses/generate`, 'POST', body)
      if (!res || res.ok === false) {
        if (errorEl) {
          errorEl.hidden = false
          errorEl.textContent = (res && res.error) || 'Could not generate a license.'
        }
        return
      }
      toast({ kind: 'ok', text: 'License generated. Copy it now, it will not be shown again.' })
      revealOnceString(panel, res.license)
      insertNewLicenseRow(panel, {
        jti: res.jti,
        last4: res.last4,
        tier: res.tier || detail.group.tier,
        member: res.member || null,
        days: res.days,
        exp: res.exp,
        revoked: false,
        activatedDevice: null,
        activatedAt: null,
        createdAt: res.iat ? res.iat * 1000 : Date.now(),
        createdBy: null
      })
      const memberField = form.querySelector<HTMLInputElement>('[data-group-license-member]')
      if (memberField) memberField.value = ''
      listDirty = true
    })
  }
  const copyBtn = panel.querySelector<HTMLElement>('[data-group-license-once-copy]')
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      const input = panel.querySelector<HTMLInputElement>('[data-group-license-once-value]')
      if (input && input.value && navigator.clipboard) {
        try {
          await navigator.clipboard.writeText(input.value)
          toast({ kind: 'ok', text: 'Copied.' })
        } catch {
          input.focus()
          input.select()
        }
      } else if (input) {
        input.focus()
        input.select()
      }
    })
  }
  wireRevokeButtons(panel)
}

/** Exact markup statusDot({ state: 'revoked', label: 'Revoked' }) (operator/src/render/
 *  primitives.ts) produces -- patched in directly so a revoke never needs to reconstruct the
 *  whole GroupLicenseItem just to re-render one row. */
function markLicenseRowRevoked(row: HTMLElement): void {
  const cells = row.querySelectorAll('td')
  const statusCell = cells[4]
  const actionCell = cells[5]
  if (statusCell) {
    statusCell.innerHTML = '<span class="status-dot status-dot-revoked"><i aria-hidden="true"></i><span>Revoked</span></span>'
  }
  if (actionCell) actionCell.textContent = ''
}

/** Wires every `[data-group-license-revoke]` button under `container` (the whole Licenses panel
 *  on first render, or just a single freshly-inserted row from insertNewLicenseRow()); a
 *  `data-wired` marker keeps a button already bound this way from being bound twice when a
 *  container it belongs to is re-wired. */
function wireRevokeButtons(container: ParentNode): void {
  container.querySelectorAll<HTMLElement>('[data-group-license-revoke]').forEach((btn) => {
    if (btn.dataset.wired === '1') return
    btn.dataset.wired = '1'
    btn.addEventListener('click', async () => {
      const jti = btn.getAttribute('data-group-license-revoke')
      const row = btn.closest<HTMLElement>('[data-license-row]')
      if (!jti || !row) return
      if (!window.confirm('Revoke this license? Any seat using it loses access immediately.')) return
      const res = await request(`/v1/admin/licenses/${encodeURIComponent(jti)}/revoke`, 'POST', {})
      if (!res || res.ok === false) {
        toast({ kind: 'error', text: (res && res.error) || 'Could not revoke the license.' })
        return
      }
      toast({ kind: 'ok', text: 'License revoked.' })
      markLicenseRowRevoked(row)
      flash(row)
      listDirty = true
    })
  })
}

/** Plan 3.5b Groups row: "the once-string strip reveals with a shimmer sweep, then the Copy
 *  button pulses once." */
function revealOnceString(panel: HTMLElement, license: string): void {
  const box = panel.querySelector<HTMLElement>('[data-group-license-once]')
  const input = panel.querySelector<HTMLInputElement>('[data-group-license-once-value]')
  const copyBtn = panel.querySelector<HTMLElement>('[data-group-license-once-copy]')
  if (input) input.value = license
  if (!box) return
  box.hidden = false
  sequence([
    { run: () => shimmer(box, true) },
    { run: () => shimmer(box, false), delayMs: 550 },
    { run: () => (copyBtn ? pop(copyBtn) : undefined), delayMs: 0 }
  ])
}

function insertNewLicenseRow(
  panel: HTMLElement,
  l: {
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
): void {
  const tableHost = panel.querySelector<HTMLElement>('[data-group-licenses-table]')
  const tbody = tableHost ? tableHost.querySelector('tbody') : null
  if (!tableHost || !tbody) return
  const html = renderGroupLicenseRowHtml(l, Date.now())
  flip(tbody as HTMLElement, () => {
    ;(tbody as HTMLElement).insertAdjacentHTML('afterbegin', html)
  })
  const inserted = tbody.querySelector<HTMLElement>(`[data-license-row="${CSS.escape(l.jti)}"]`)
  if (inserted) {
    flash(inserted)
    wireRevokeButtons(inserted)
  }
}

async function openGroupDrawer(section: HTMLElement, id: string): Promise<void> {
  const drawer = section.querySelector<HTMLElement>('#group-drawer')
  if (!drawer) return
  currentGroupId = id
  drawer.setAttribute('data-group-id-active', id)
  drawer.hidden = false
  slideIn(drawer, 'right')
  const { title, tier, body } = drawerHeaderEls(drawer)
  if (title) title.textContent = 'Loading'
  if (tier) tier.innerHTML = ''
  if (body) body.innerHTML = '<div class="group-skeleton" role="status" aria-label="Loading group"><div class="skeleton-row"><i></i></div><div class="skeleton-row"><i></i></div><div class="skeleton-row"><i></i></div></div>'

  const [detailRes, integrationsRes, tiers] = await Promise.all([
    request(`/v1/admin/groups/${encodeURIComponent(id)}`, 'GET'),
    request('/v1/admin/integrations', 'GET'),
    ensureTiers()
  ])
  if (currentGroupId !== id) return
  if (!detailRes || detailRes.ok === false) {
    if (title) title.textContent = 'Could not open this group'
    if (body) {
      body.textContent = ''
      const err = document.createElement('div')
      err.className = 'group-inline-error'
      err.setAttribute('role', 'alert')
      err.textContent = (detailRes && detailRes.error) || 'Could not load this group. Close and try again.'
      body.appendChild(err)
    }
    return
  }
  const detail: GroupDetailPayload = {
    group: detailRes.group,
    members: detailRes.members,
    licenses: detailRes.licenses,
    seats: detailRes.seats,
    activity: detailRes.activity
  }
  renderDrawer(section, drawer, detail, extractScopedConnectors(integrationsRes, id), tiers, 'members')
}

function wireGroupDrawer(section: HTMLElement): void {
  const drawer = section.querySelector<HTMLElement>('#group-drawer')
  const closeBtn = section.querySelector<HTMLElement>('#group-drawer-close')
  if (!drawer) return
  const close = (): void => {
    drawer.hidden = true
    currentGroupId = null
    if (listDirty) void loadGroupsList(section)
  }
  if (closeBtn) closeBtn.addEventListener('click', close)
  section.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !drawer.hidden) close()
  })
}

// ---------------------------------------------------------------------------
// Boot.
// ---------------------------------------------------------------------------

function wireToolbar(section: HTMLElement): void {
  const input = section.querySelector<HTMLInputElement>('#groups-search')
  if (!input) return
  input.addEventListener('input', () => applySearchFilter(section))
}

export function initGroups(section: HTMLElement, _data: DashboardPayload | null): void {
  wireToolbar(section)
  wireAddGroupDrawer(section)
  wireGroupDrawer(section)
  void loadGroupsList(section)
}
