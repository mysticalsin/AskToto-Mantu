/**
 * Connectors page client init (plan 6.10c). The catalog, the status strip, "Needs attention" and
 * "Connected" all render server-side from `DashboardPayload.connectors` (operator/src/dashboard.ts)
 * -- this file fetches NOTHING on mount. It only fetches after an interaction (Test, Save, Rotate,
 * Revoke, Delete, a bulk action, opening a drawer for tiers/groups/activity), matching plan D3's
 * "location.reload() is deleted from operator/client/*" and this task's "no first-paint-critical
 * fetch."
 *
 * Every click in this section (catalog tiles, category chips, status-strip filter cells, table
 * rows, tools toggles, history/overflow toggles, Select mode, the bulk bar, and the drawer's
 * Test/Save/Rotate/Revoke/Delete/allow-writes/reveal/tab buttons) is wired through ONE delegated
 * listener bound once on the page's `[data-page="connectors"]` section (wireOnce(), below) rather
 * than re-bound per element -- both the body slot and the drawer regenerate their innerHTML often
 * (every refresh, every open), and delegation means none of that regeneration ever needs to
 * re-attach a listener.
 *
 * request() duplicates operator/client/api.ts's session-bearer protocol (ping GET /session once,
 * cache the bearer, attach it as `Authorization: Bearer`) because api() only ever issues GET or
 * POST and this page needs PATCH too (editing an existing connection's scope/mode); api.ts is a
 * shared file this page does not own. operator/client/pages/groups.ts already carries the same,
 * documented duplication for the same reason.
 */
import type { DashboardPayload } from '../../src/dashboard'
import { esc } from '../../src/render'
import {
  FALLBACK_TIER_OPTIONS,
  catalogByKind,
  connectorsBodyHtml,
  publicConnectorCatalog,
  renderActivityPanelHtml,
  renderConnectionDrawerHtml,
  renderDangerBanner,
  renderProbeResultCard,
  renderStatusStrip,
  type ConnectorActivityPayload,
  type ConnectorDrawerTab,
  type ConnectorSummary,
  type GroupOption,
  type PublicConnectorCatalogEntry,
  type TierOption
} from '../../src/render/pages/connectors'
import { bindMotion } from '../motion-bind'
import { flash, flip, pop, reduceMotion, shimmer, slideIn, staggerIn } from '../motion'
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
// Module state. One Connectors section exists at a time.
// ---------------------------------------------------------------------------

const catalogCache: PublicConnectorCatalogEntry[] = publicConnectorCatalog()
const catalogMap: Record<string, PublicConnectorCatalogEntry> = catalogByKind(catalogCache)

let connectedCache: ConnectorSummary[] = []
let cachedTiers: TierOption[] | null = null
let cachedGroups: GroupOption[] | null = null
let groupNameById: Record<string, string> = {}
let railListenerWired = false

let activeCategory = 'all'
let activeStatusFilter: 'connected' | 'failing' | 'untested' | null = null
let historyExpanded = false
let overflowExpanded = false

let selectMode = false
const selectedIds = new Set<string>()

/** Seeded from server-rendered DashboardPayload.connectors on boot (initConnectors's own
 *  `_data` argument) so filters, the bulk bar and tile connected-dots work immediately -- refreshed
 *  from `GET /v1/admin/integrations` only after a mutation, never on mount. */
function seedFromServerData(data: DashboardPayload | null): void {
  if (!data || !Array.isArray(data.connectors)) return
  connectedCache = data.connectors as unknown as ConnectorSummary[]
}

async function ensureTiers(): Promise<TierOption[]> {
  if (cachedTiers) return cachedTiers
  const res = await request('/v1/admin/tiers', 'GET')
  if (res && res.ok !== false && Array.isArray(res.tiers) && res.tiers.length) {
    cachedTiers = (res.tiers as { id: unknown; label: unknown; seats?: unknown }[])
      .filter((t) => typeof t.id === 'string' && typeof t.label === 'string')
      .map((t) => ({ id: t.id as string, label: t.label as string, seats: typeof t.seats === 'number' ? t.seats : undefined }))
  }
  return cachedTiers && cachedTiers.length ? cachedTiers : FALLBACK_TIER_OPTIONS
}

async function ensureGroups(): Promise<GroupOption[]> {
  if (cachedGroups) return cachedGroups
  const res = await request('/v1/admin/groups', 'GET')
  if (res && res.ok !== false && Array.isArray(res.groups)) {
    const groups = (res.groups as { id: unknown; name: unknown; members?: unknown }[])
      .filter((g) => typeof g.id === 'string' && typeof g.name === 'string')
      .map((g) => ({ id: g.id as string, name: g.name as string, members: typeof g.members === 'number' ? g.members : undefined }))
    cachedGroups = groups
    groupNameById = {}
    for (const g of groups) groupNameById[g.id] = g.name
  }
  return cachedGroups || []
}

/** Fills in every already-rendered group-scope chip's real name once GET /v1/admin/groups answers
 *  (plan honesty: first paint shows the group id itself rather than a fabricated name, since
 *  DashboardPayload carries no group data at all -- this is a background enhancement after paint,
 *  never something first paint waits on). Safe to call repeatedly; a chip already showing its real
 *  name is simply left alone. */
function enhanceScopeChipNames(section: HTMLElement): void {
  section.querySelectorAll<HTMLElement>('[data-group-id]').forEach((el) => {
    const id = el.getAttribute('data-group-id')
    const name = id ? groupNameById[id] : null
    if (name && el.textContent !== name) el.textContent = name
  })
}

// ---------------------------------------------------------------------------
// Filtering: search (catalog + both blocks below), category chips, status-strip filter chip
// (plan 6.10c block 4). One pass recomputes every row/tile's visibility together so the three
// hide reasons (search, category, status filter, plus the Connected table's own history/overflow
// caps) never fight each other.
// ---------------------------------------------------------------------------

function searchQuery(section: HTMLElement): string {
  const input = section.querySelector<HTMLInputElement>('#connectors-search')
  return (input && input.value ? input.value : '').trim().toLowerCase()
}

function applyCatalogFilters(section: HTMLElement, q: string): void {
  const grid = section.querySelector<HTMLElement>('[data-tile-grid]')
  if (!grid) return
  flip(grid, () => {
    grid.querySelectorAll<HTMLElement>('[data-catalog-tile]').forEach((tile) => {
      const hay = tile.getAttribute('data-q') || ''
      const cat = tile.getAttribute('data-category') || ''
      const matchesQ = !q || hay.indexOf(q) >= 0
      const matchesCat = activeCategory === 'all' || cat === activeCategory
      tile.hidden = !(matchesQ && matchesCat)
    })
  })
}

function statusFilterMatchesHealth(health: string): boolean {
  if (!activeStatusFilter) return true
  return health === activeStatusFilter
}

function applyAttentionFilters(section: HTMLElement, q: string): void {
  // Needs attention only ever holds failing rows (plan 6.10b), so a 'connected'/'untested' status
  // filter hides the whole block rather than row by row.
  const group = section.querySelector<HTMLElement>('#connectors-needs-attention')
  if (!group) return
  const blockMatchesStatus = !activeStatusFilter || activeStatusFilter === 'failing'
  group.querySelectorAll<HTMLElement>('.connector-row[data-connector-id]').forEach((row) => {
    const hay = (row.textContent || '').toLowerCase()
    row.hidden = !blockMatchesStatus || (Boolean(q) && hay.indexOf(q) < 0)
  })
}

function applyConnectedFilters(section: HTMLElement): void {
  const root = section.querySelector<HTMLElement>('[data-connectors-connected-root]')
  if (!root) return
  const q = searchQuery(section)
  root.querySelectorAll<HTMLElement>('[data-connector-row]').forEach((row) => {
    const isHistory = row.hasAttribute('data-connector-history-row')
    const isOverflow = row.hasAttribute('data-connector-overflow-row')
    const cappedHidden = (isHistory && !historyExpanded) || (isOverflow && !overflowExpanded)
    const health = row.getAttribute('data-connector-health') || ''
    const hay = (row.textContent || '').toLowerCase()
    const matchesSearch = !q || hay.indexOf(q) >= 0
    row.hidden = cappedHidden || !statusFilterMatchesHealth(health) || !matchesSearch
  })
}

function applyAllFilters(section: HTMLElement): void {
  const q = searchQuery(section)
  applyCatalogFilters(section, q)
  applyAttentionFilters(section, q)
  applyConnectedFilters(section)
}

function renderFilterChip(): string {
  if (!activeStatusFilter) return ''
  const labels: Record<string, string> = { connected: 'Healthy', failing: 'Failing', untested: 'Never tested' }
  return `<span class="chip chip-accent">${esc(labels[activeStatusFilter] || activeStatusFilter)}<button type="button" data-connectors-filter-clear aria-label="Clear filter">&times;</button></span>`
}

function syncFilterChip(section: HTMLElement): void {
  const slot = section.querySelector<HTMLElement>('[data-connectors-filter-chip-slot]')
  if (slot) slot.innerHTML = renderFilterChip()
  section.querySelectorAll<HTMLElement>('.connectors-status-cell').forEach((cell) => {
    const value = cell.getAttribute('data-status-filter')
    cell.classList.toggle('on', value != null && value !== 'all' && value === activeStatusFilter)
  })
}

function setStatusFilter(section: HTMLElement, value: string | null): void {
  activeStatusFilter = value === 'all' || !value ? null : (value as 'connected' | 'failing' | 'untested')
  syncFilterChip(section)
  applyAllFilters(section)
}

function setCategoryFilter(section: HTMLElement, id: string): void {
  activeCategory = id
  section.querySelectorAll<HTMLElement>('[data-connectors-category-filter] .segmented-item').forEach((btn) => {
    const active = btn.getAttribute('data-segmented') === id
    btn.classList.toggle('on', active)
    btn.setAttribute('aria-checked', active ? 'true' : 'false')
  })
  applyAllFilters(section)
}

function wireToolbar(section: HTMLElement): void {
  const input = section.querySelector<HTMLInputElement>('#connectors-search')
  if (input) input.addEventListener('input', () => applyAllFilters(section))
  const categoryRow = section.querySelector<HTMLElement>('[data-connectors-category-filter]')
  if (categoryRow) {
    categoryRow.addEventListener('click', (e) => {
      const btn = (e.target as Element).closest<HTMLElement>('[data-segmented]')
      if (!btn) return
      const id = btn.getAttribute('data-segmented')
      if (id) setCategoryFilter(section, id)
    })
  }
  const statusStrip = section.querySelector<HTMLElement>('[data-connectors-status-slot]')
  if (statusStrip) {
    statusStrip.addEventListener('click', (e) => {
      const cell = (e.target as Element).closest<HTMLElement>('[data-status-filter]')
      if (cell) {
        const value = cell.getAttribute('data-status-filter')
        setStatusFilter(section, activeStatusFilter && value === activeStatusFilter ? null : value)
        return
      }
      const scrollTarget = (e.target as Element).closest<HTMLElement>('[data-connector-scroll-to]')
      if (scrollTarget) scrollToAndHighlightRow(section, scrollTarget.getAttribute('data-connector-scroll-to'))
    })
  }
}

function scrollToAndHighlightRow(section: HTMLElement, id: string | null): void {
  if (!id) return
  const row = section.querySelector<HTMLElement>(`[data-connector-row="${CSS.escape(id)}"]`)
  if (!row) return
  row.hidden = false
  row.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'center' })
  if (!reduceMotion()) flash(row)
}

// ---------------------------------------------------------------------------
// Catalog tile connected-state markers (plan 3.5b: "the tile gains its green dot with a ping").
// ---------------------------------------------------------------------------

function connectionsCountByKind(rows: ConnectorSummary[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const r of rows) {
    if (r.status !== 'active') continue
    m.set(r.kind, (m.get(r.kind) || 0) + 1)
  }
  return m
}

function markTileConnected(tile: HTMLElement, count: number, animate: boolean): void {
  tile.classList.add('catalog-tile-connected')
  const label = `Connected, ${count} connection${count === 1 ? '' : 's'}`
  const html = `<span class="status-dot status-dot-live"><i aria-hidden="true"></i><span>${esc(label)}</span></span>`
  const existingDot = tile.querySelector<HTMLElement>('.status-dot')
  const existingNote = tile.querySelector<HTMLElement>('.catalog-tile-note')
  if (existingDot) {
    if (existingDot.textContent !== label) existingDot.outerHTML = html
  } else if (existingNote) {
    existingNote.outerHTML = html
  } else {
    tile.insertAdjacentHTML('beforeend', html)
  }
  if (animate && !reduceMotion()) {
    const dot = tile.querySelector<HTMLElement>('.status-dot')
    if (dot) pop(dot)
  }
}

function unmarkTileConnected(tile: HTMLElement): void {
  if (!tile.classList.contains('catalog-tile-connected')) return
  tile.classList.remove('catalog-tile-connected')
  const dot = tile.querySelector<HTMLElement>('.status-dot')
  if (dot) dot.remove()
}

function applyTileConnectionStates(section: HTMLElement, rows: ConnectorSummary[], animate: boolean): void {
  const counts = connectionsCountByKind(rows)
  section.querySelectorAll<HTMLElement>('[data-catalog-tile]').forEach((tile) => {
    const kind = tile.getAttribute('data-catalog-tile')
    const count = kind ? counts.get(kind) || 0 : 0
    if (count > 0) markTileConnected(tile, count, animate)
    else unmarkTileConnected(tile)
  })
}

function markTileConnectedByKind(section: HTMLElement, kind: string, animate: boolean): void {
  const tile = section.querySelector<HTMLElement>(`[data-catalog-tile="${CSS.escape(kind)}"]`)
  if (!tile) return
  const count = connectedCache.filter((c) => c.kind === kind && c.status === 'active').length
  markTileConnected(tile, count, animate)
}

// ---------------------------------------------------------------------------
// Connected table + body (Needs attention / Connected / zero state) -- refreshed after a
// mutation, never fetched on mount (plan 6.10c).
// ---------------------------------------------------------------------------

/** Rebuilds the danger banner, status strip and body slot from a fresh `connectedCache` (plan
 *  6.10c: "no first-paint-critical fetch," but a mutation needs a way back to server truth without
 *  `location.reload()`, plan D3). Tile connected-dots and the active filter are reapplied after. */
function renderFromCache(section: HTMLElement, animateNewRow?: string): void {
  const now = Date.now()
  const active = connectedCache.filter((c) => c.status === 'active')
  const failing = active.filter((c) => c.health === 'failing').length

  const dangerSlot = section.querySelector<HTMLElement>('[data-connectors-danger-slot]')
  if (dangerSlot) dangerSlot.innerHTML = renderDangerBanner(failing)

  const statusSlot = section.querySelector<HTMLElement>('[data-connectors-status-slot]')
  if (statusSlot) {
    statusSlot.innerHTML = renderStatusStrip(connectedCache)
    bindMotion(statusSlot)
  }

  const bodySlot = section.querySelector<HTMLElement>('[data-connectors-body-slot]')
  if (bodySlot) {
    historyExpanded = false
    overflowExpanded = false
    bodySlot.innerHTML = connectorsBodyHtml(connectedCache, now, catalogCache, catalogMap, groupNameById)
    bindMotion(bodySlot)
    if (animateNewRow) {
      const inserted = bodySlot.querySelector<HTMLElement>(`[data-connector-row="${CSS.escape(animateNewRow)}"]`)
      if (inserted) flash(inserted)
    }
  }

  applyTileConnectionStates(section, connectedCache, false)
  syncFilterChip(section)
  applyAllFilters(section)
}

/** The only fetch this page ever makes outside a drawer action: after a mutation, to bring
 *  `connectedCache` back in step with the server before re-rendering from it. */
async function refreshConnectors(section: HTMLElement): Promise<void> {
  const res = await request('/v1/admin/integrations', 'GET')
  if (!res || res.ok === false) return
  connectedCache = Array.isArray(res.integrations) ? (res.integrations as ConnectorSummary[]) : []
  await ensureGroups()
  renderFromCache(section)
}

function toggleTools(section: HTMLElement, btn: HTMLElement): void {
  const id = btn.getAttribute('data-tools-toggle')
  const list = id ? section.querySelector<HTMLElement>(`[data-tools-list="${CSS.escape(id)}"]`) : null
  if (!list) return
  const next = btn.getAttribute('aria-expanded') !== 'true'
  list.hidden = !next
  btn.setAttribute('aria-expanded', next ? 'true' : 'false')
  if (next) bindMotion(list)
}

function toggleConnectorsHistory(section: HTMLElement, btn: HTMLElement): void {
  historyExpanded = btn.getAttribute('aria-expanded') !== 'true'
  btn.setAttribute('aria-expanded', historyExpanded ? 'true' : 'false')
  btn.textContent = (historyExpanded ? btn.getAttribute('data-hide-label') : btn.getAttribute('data-show-label')) || btn.textContent || ''
  applyAllFilters(section)
  if (historyExpanded && !reduceMotion()) {
    const root = section.querySelector<HTMLElement>('[data-connectors-connected-root]')
    if (root) staggerIn(Array.from(root.querySelectorAll<HTMLElement>('[data-connector-history-row]:not([hidden])')))
  }
}

function toggleConnectorsOverflow(section: HTMLElement, btn: HTMLElement): void {
  overflowExpanded = btn.getAttribute('aria-expanded') !== 'true'
  btn.setAttribute('aria-expanded', overflowExpanded ? 'true' : 'false')
  btn.textContent = (overflowExpanded ? btn.getAttribute('data-hide-label') : btn.getAttribute('data-show-label')) || btn.textContent || ''
  applyAllFilters(section)
  if (overflowExpanded && !reduceMotion()) {
    const root = section.querySelector<HTMLElement>('[data-connectors-connected-root]')
    if (root) staggerIn(Array.from(root.querySelectorAll<HTMLElement>('[data-connector-overflow-row]:not([hidden])')))
  }
}

// ---------------------------------------------------------------------------
// Select mode + bulk bar (plan 6.10c block 4: "a footer bar naming every affected connection by
// label before running, never inline in the resting toolbar").
// ---------------------------------------------------------------------------

function connectorLabel(id: string): string {
  return connectedCache.find((c) => c.id === id)?.label || id
}

function updateBulkBar(section: HTMLElement): void {
  const bar = section.querySelector<HTMLElement>('[data-connectors-bulk-bar]')
  const text = section.querySelector<HTMLElement>('[data-connectors-bulk-text]')
  if (!bar || !text) return
  if (!selectMode || selectedIds.size === 0) {
    bar.hidden = true
    return
  }
  bar.hidden = false
  const labels = Array.from(selectedIds).map(connectorLabel)
  text.textContent = `${labels.length} selected: ${labels.join(', ')}`
}

function setSelectMode(section: HTMLElement, on: boolean): void {
  selectMode = on
  if (!on) selectedIds.clear()
  const card = section.querySelector<HTMLElement>('[data-connectors-connected-card]')
  if (card) {
    if (on) card.setAttribute('data-select-mode', '')
    else card.removeAttribute('data-select-mode')
  }
  const toggle = section.querySelector<HTMLElement>('[data-connectors-select-toggle]')
  if (toggle) toggle.setAttribute('aria-pressed', on ? 'true' : 'false')
  section.querySelectorAll<HTMLInputElement>('.connector-select-check').forEach((cb) => {
    cb.checked = false
  })
  updateBulkBar(section)
}

function toggleRowSelected(section: HTMLElement, id: string, checked: boolean): void {
  if (checked) selectedIds.add(id)
  else selectedIds.delete(id)
  updateBulkBar(section)
}

async function runBulk(section: HTMLElement, action: (id: string) => Promise<unknown>): Promise<void> {
  const ids = Array.from(selectedIds)
  for (const id of ids) await action(id)
  setSelectMode(section, false)
  await refreshConnectors(section)
}

async function handleBulkRetest(section: HTMLElement): Promise<void> {
  await runBulk(section, (id) => request(`/v1/admin/integrations/${encodeURIComponent(id)}/test`, 'POST', {}))
  toast({ kind: 'ok', text: 'Re-test finished for the selected connections.' })
}

async function handleBulkRevoke(section: HTMLElement): Promise<void> {
  const labels = Array.from(selectedIds).map(connectorLabel)
  // Same real-numbers standard as the single-row Revoke confirm above: sum the selected
  // connections' own grantsCount/uses rather than a generic "they lose access" line with no scale.
  const rows = Array.from(selectedIds)
    .map((id) => connectedCache.find((c) => c.id === id))
    .filter((r): r is ConnectorSummary => Boolean(r))
  const seats = rows.reduce((n, r) => n + r.grantsCount, 0)
  const calls = rows.reduce((n, r) => n + r.uses, 0)
  const usage = rows.length ? `${seats} seat grant${seats === 1 ? '' : 's'} across them have used it${calls ? `, ${calls} call${calls === 1 ? '' : 's'} total` : ''}.` : ''
  if (!window.confirm(`Revoke ${labels.join(', ')}? This ends these connections for every seat immediately.${usage ? ` ${usage}` : ''}`)) return
  await runBulk(section, (id) => request(`/v1/admin/integrations/${encodeURIComponent(id)}/revoke`, 'POST', {}))
  toast({ kind: 'ok', text: 'Selected connections revoked.' })
}

function toggleBulkRescopePanel(section: HTMLElement, btn: HTMLElement): void {
  const panel = section.querySelector<HTMLElement>('[data-connectors-bulk-rescope-panel]')
  if (!panel) return
  const next = btn.getAttribute('aria-expanded') !== 'true'
  panel.hidden = !next
  btn.setAttribute('aria-expanded', next ? 'true' : 'false')
  if (next) bindMotion(panel)
}

async function handleBulkRescopeApply(section: HTMLElement): Promise<void> {
  const panel = section.querySelector<HTMLElement>('[data-connectors-bulk-rescope-panel]')
  if (!panel) return
  const tiers = Array.from(panel.querySelectorAll<HTMLInputElement>('input[name="scopeTier"]:checked')).map((i) => i.value)
  const groups = Array.from(panel.querySelectorAll<HTMLInputElement>('input[name="scopeGroup"]:checked')).map((i) => i.value)
  const labels = Array.from(selectedIds).map(connectorLabel)
  if (!window.confirm(`Set this scope on ${labels.join(', ')}?`)) return
  await runBulk(section, (id) => request(`/v1/admin/integrations/${encodeURIComponent(id)}`, 'PATCH', { scope: { tiers, groups } }))
  toast({ kind: 'ok', text: 'Scope updated for the selected connections.' })
}

// ---------------------------------------------------------------------------
// The connection drawer.
// ---------------------------------------------------------------------------

let scopeSnapshot: { tiers: string[]; groups: string[]; mode: string } | null = null

function closeDrawer(section: HTMLElement): void {
  const drawer = section.querySelector<HTMLElement>('#connection-drawer')
  if (drawer) drawer.hidden = true
  scopeSnapshot = null
}

function currentScopeAndMode(drawer: HTMLElement): { tiers: string[]; groups: string[]; mode: string } {
  return {
    tiers: Array.from(drawer.querySelectorAll<HTMLInputElement>('input[name="scopeTier"]:checked')).map((i) => i.value),
    groups: Array.from(drawer.querySelectorAll<HTMLInputElement>('input[name="scopeGroup"]:checked')).map((i) => i.value),
    mode: drawer.querySelector<HTMLInputElement>('input[name="mode"]:checked')?.value || 'brokered'
  }
}

function sameStringSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const s = new Set(a)
  return b.every((v) => s.has(v))
}

/** plan 6.10c Scope tab: recomputes the live "adds/removes access for N seats" sentence and
 *  enables Save only once the scope or mode genuinely differs from what the drawer opened with. */
function updateScopePreviewAndSave(drawer: HTMLElement): void {
  const preview = drawer.querySelector<HTMLElement>('[data-scope-preview]')
  const saveBtn = drawer.querySelector<HTMLButtonElement>('[data-connector-save]')
  if (!scopeSnapshot) return
  const current = currentScopeAndMode(drawer)
  const changed = !sameStringSet(current.tiers, scopeSnapshot.tiers) || !sameStringSet(current.groups, scopeSnapshot.groups) || current.mode !== scopeSnapshot.mode
  if (saveBtn && saveBtn.getAttribute('data-connector-save')) saveBtn.disabled = !changed
  if (!preview) return

  const added = { tiers: current.tiers.filter((t) => !scopeSnapshot!.tiers.includes(t)), groups: current.groups.filter((g) => !scopeSnapshot!.groups.includes(g)) }
  const removed = { tiers: scopeSnapshot.tiers.filter((t) => !current.tiers.includes(t)), groups: scopeSnapshot.groups.filter((g) => !current.groups.includes(g)) }
  const countAndNames = (checkboxNames: string[], selector: string): { count: number; names: string[] } => {
    let count = 0
    const names: string[] = []
    checkboxNames.forEach((value) => {
      const input = drawer.querySelector<HTMLInputElement>(`${selector}[value="${CSS.escape(value)}"]`)
      if (!input) return
      count += Number(input.getAttribute('data-count') || 0)
      const label = input.closest('label')
      names.push((label?.textContent || value).trim())
    })
    return { count, names }
  }
  const addedTiers = countAndNames(added.tiers, 'input[name="scopeTier"]')
  const addedGroups = countAndNames(added.groups, 'input[name="scopeGroup"]')
  const removedTiers = countAndNames(removed.tiers, 'input[name="scopeTier"]')
  const removedGroups = countAndNames(removed.groups, 'input[name="scopeGroup"]')
  const addedCount = addedTiers.count + addedGroups.count
  const addedNames = [...addedTiers.names, ...addedGroups.names]
  const removedCount = removedTiers.count + removedGroups.count
  const removedNames = [...removedTiers.names, ...removedGroups.names]

  const parts: string[] = []
  if (addedNames.length) parts.push(`Adds access for ${addedCount} seat${addedCount === 1 ? '' : 's'}: ${addedNames.join(', ')}`)
  if (removedNames.length) parts.push(`Removes access for ${removedCount} seat${removedCount === 1 ? '' : 's'}: ${removedNames.join(', ')}`)
  // The one Scope-tab change that is not about *who* has access: switching mode moves *where* the
  // credential itself lives, stated plainly before Save is ever clickable (plan: "scope
  // consequence stated before saving").
  if (current.mode !== scopeSnapshot.mode) {
    parts.push(
      current.mode === 'direct'
        ? 'Switches to Direct: the seat will hold this credential in memory instead of the Operator'
        : 'Switches to Brokered: the Operator will hold this credential instead of the seat'
    )
  }
  preview.textContent = parts.length ? parts.join('. ') + '.' : 'No change to who has access.'
}

/**
 * plan 3.5b: "the drawer slides in with the logo growing from the tile (shared-element feel: the
 * drawer logo starts at the tile position and springs into place)." Built entirely from the
 * sanctioned motion.ts vocabulary (this page never writes its own WAAPI calls or keyframes): the
 * panel itself uses slideIn() (state change, plan 3.5), and the header logo uses pop() -- the same
 * helper already used everywhere else in this app for something appearing from nothing (delta
 * chips, tier badges, city dots) -- for its own "growing" entrance, rather than hand-computing a
 * FLIP offset from the tile's screen position for one image.
 */
async function openDrawer(section: HTMLElement, kind: string, existingId: string | null, tab?: ConnectorDrawerTab): Promise<void> {
  const entry = catalogMap[kind]
  const slot = section.querySelector<HTMLElement>('[data-connectors-drawer-slot]')
  if (!entry || !slot) return

  // `connectedCache` is deliberately empty on a real first boot (seedFromServerData() above only
  // ever runs with `data: null` -- see initConnectors()'s own comment) and stays empty until some
  // other mutation happens to call refreshConnectors() first. Without this, the very first click
  // on ANY already-rendered Connected/Needs-attention row -- the single most common way into this
  // drawer -- found nothing in the cache and silently fell through to the brand-new-connection
  // form: right kind, wrong everything else (no tabs, no real scope/mode/tools/usage, Danger tab
  // absent). A row only ever carries a real `existingId` when the server actually rendered it, so
  // a cache miss here means "not fetched yet," never "doesn't exist" -- the same one GET this page
  // already makes after every mutation (refreshConnectors(), see its own doc comment) resolves it,
  // and only on this first miss: every later open of the same or another row is instant.
  if (existingId && !connectedCache.some((c) => c.id === existingId)) {
    await refreshConnectors(section)
  }
  const existing = existingId ? connectedCache.find((c) => c.id === existingId) || null : null
  const needsTiersAndGroups = entry.availability !== 'needs-oauth'
  const [tiers, groups] = needsTiersAndGroups ? await Promise.all([ensureTiers(), ensureGroups()]) : [[], []]

  slot.innerHTML = renderConnectionDrawerHtml(entry, { tiers, groups, existing, activeTab: tab })
  const drawer = slot.querySelector<HTMLElement>('#connection-drawer')
  if (!drawer) return
  drawer.hidden = false
  slideIn(drawer, 'right')
  bindMotion(drawer)
  const logo = drawer.querySelector<HTMLElement>('.logo-glyph')
  if (logo && !reduceMotion()) pop(logo)

  if (existing) {
    scopeSnapshot = { tiers: existing.scope.tiers || [], groups: existing.scope.groups || [], mode: existing.mode }
    updateScopePreviewAndSave(drawer)
    void loadActivityPanel(drawer, existing.id)
  } else {
    // A brand-new connection starts with no tiers/groups checked and mode brokered (exactly what
    // scopeFieldsHtml(ctx.tiers, ctx.groups, {}) and modeFieldHtml('brokered') just rendered into
    // this drawer -- render/pages/connectors.ts's renderConnectionDrawerHtml, new-connection
    // branch). Snapshotting that starting point here (rather than `null`) is what lets the Scope
    // tab's live consequence sentence recompute as tier/group boxes are checked: `null` made the
    // change listener's `if (drawer && scopeSnapshot)` guard skip updateScopePreviewAndSave()
    // entirely, so granting a brand-new connector's first scope -- the highest-stakes case this
    // sentence exists for -- silently stayed frozen at the hardcoded default. This does not affect
    // Save's own enable/disable logic: that reads `saveBtn.getAttribute('data-connector-save')`,
    // which newConnectionFooterHtml() leaves valueless, so the "only enable Save once scope
    // differs from the snapshot" rule below still applies to an existing connection only.
    scopeSnapshot = { tiers: [], groups: [], mode: 'brokered' }
    updateScopePreviewAndSave(drawer)
    const firstInput = drawer.querySelector<HTMLInputElement>('input:not([type="hidden"])')
    if (firstInput) firstInput.focus()
  }
}

async function loadActivityPanel(drawer: HTMLElement, connectionId: string): Promise<void> {
  const panel = drawer.querySelector<HTMLElement>(`[data-connector-activity-panel="${CSS.escape(connectionId)}"]`)
  if (!panel) return
  const res = await request(`/v1/admin/integrations/${encodeURIComponent(connectionId)}/activity.json`, 'GET')
  if (!res || res.ok === false) {
    panel.innerHTML = '<p class="muted">Could not load activity.</p>'
    return
  }
  const payload = res as ConnectorActivityPayload
  panel.innerHTML = renderActivityPanelHtml(payload, Date.now())
  bindMotion(panel)
}

function switchDrawerTab(drawer: HTMLElement, btn: HTMLElement): void {
  const tab = btn.getAttribute('data-tab')
  if (!tab) return
  const buttons = Array.from(drawer.querySelectorAll<HTMLElement>('[data-connector-tabs] [data-tab]'))
  buttons.forEach((b) => {
    const active = b === btn
    b.classList.toggle('on', active)
    b.setAttribute('aria-selected', active ? 'true' : 'false')
  })
  drawer.querySelectorAll<HTMLElement>('[data-connector-panel]').forEach((panel) => {
    panel.hidden = panel.getAttribute('data-connector-panel') !== tab
  })
}

function collectConfig(drawer: HTMLElement, entry: PublicConnectorCatalogEntry): Record<string, string> {
  const config: Record<string, string> = {}
  entry.fields.forEach((f) => {
    if (f.key === 'credential') return
    const input = drawer.querySelector<HTMLInputElement>(`input[name="cfg_${f.key}"]`)
    if (input) config[f.key] = input.value.trim()
  })
  return config
}

function collectScope(drawer: HTMLElement): { tiers: string[]; groups: string[] } {
  const c = currentScopeAndMode(drawer)
  return { tiers: c.tiers, groups: c.groups }
}

function collectMode(drawer: HTMLElement): 'brokered' | 'direct' {
  return currentScopeAndMode(drawer).mode === 'direct' ? 'direct' : 'brokered'
}

function toggleCredentialReveal(btn: HTMLElement): void {
  const wrap = btn.closest<HTMLElement>('.connector-credential-wrap')
  const input = wrap ? wrap.querySelector<HTMLInputElement>('input[name="credential"]') : null
  if (!input) return
  const next = btn.getAttribute('aria-pressed') !== 'true'
  const swap = (): void => {
    input.type = next ? 'text' : 'password'
    btn.setAttribute('aria-pressed', next ? 'true' : 'false')
    btn.textContent = next ? 'Hide' : 'Show'
  }
  if (reduceMotion()) {
    swap()
    return
  }
  const CROSSFADE_MS = 90
  input.classList.add('is-crossfading')
  window.setTimeout(() => {
    swap()
    window.setTimeout(() => input.classList.remove('is-crossfading'), CROSSFADE_MS)
  }, CROSSFADE_MS)
}

/** plan 3.5b: "Test connection: the button shows a running shimmer, then the result card slides
 *  in; the tool list reveals row by row; read/write marks pop." A drawer Test on an existing
 *  connection also refreshes the page from the server so its status dot and last-test tooltip
 *  agree with what the drawer just showed. */
async function handleTestClick(section: HTMLElement, btn: HTMLElement): Promise<void> {
  const drawer = btn.closest<HTMLElement>('#connection-drawer')
  if (!drawer) return
  const kind = drawer.getAttribute('data-connector') || ''
  const entry = catalogMap[kind]
  if (!entry) return
  const existingId = btn.getAttribute('data-connector-test') || ''
  const resultEl = drawer.querySelector<HTMLElement>('[data-connector-test-result]')
  const saveBtn = drawer.querySelector<HTMLButtonElement>('[data-connector-save]')

  shimmer(btn, true)
  btn.setAttribute('disabled', 'true')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let res: any
  if (existingId) {
    res = await request(`/v1/admin/integrations/${encodeURIComponent(existingId)}/test`, 'POST', {})
  } else {
    const credentialInput = drawer.querySelector<HTMLInputElement>('input[name="credential"]')
    const credential = credentialInput ? credentialInput.value.trim() : ''
    const config = collectConfig(drawer, entry)
    res = await request('/v1/admin/integrations/test', 'POST', { kind, credential, config })
  }
  shimmer(btn, false)
  btn.removeAttribute('disabled')

  if (!res || res.ok === false) {
    toast({ kind: 'error', text: (res && res.error) || 'Could not run the test.' })
    if (saveBtn && !existingId) saveBtn.disabled = true
    return
  }
  if (resultEl) {
    resultEl.hidden = false
    resultEl.innerHTML = renderProbeResultCard(res.result)
    if (!reduceMotion()) slideIn(resultEl, 'bottom')
    bindMotion(resultEl)
  }
  if (saveBtn && !existingId) saveBtn.disabled = !res.result?.ok
  if (existingId) await refreshConnectors(section)
}

async function handleSaveClick(section: HTMLElement, btn: HTMLElement): Promise<void> {
  const drawer = btn.closest<HTMLElement>('#connection-drawer')
  if (!drawer) return
  const kind = drawer.getAttribute('data-connector') || ''
  const entry = catalogMap[kind]
  if (!entry) return
  const existingId = btn.getAttribute('data-connector-save') || ''
  const scope = collectScope(drawer)
  const mode = collectMode(drawer)

  if (existingId) {
    const res = await request(`/v1/admin/integrations/${encodeURIComponent(existingId)}`, 'PATCH', { scope, mode })
    if (!res || res.ok === false) {
      toast({ kind: 'error', text: (res && res.error) || 'Could not save this connector.' })
      return
    }
    toast({ kind: 'ok', text: 'Connector saved.' })
    closeDrawer(section)
    await refreshConnectors(section)
    return
  }

  const labelInput = drawer.querySelector<HTMLInputElement>('input[name="label"]')
  const credentialInput = drawer.querySelector<HTMLInputElement>('input[name="credential"]')
  const label = (labelInput && labelInput.value.trim()) || entry.label
  const credential = credentialInput ? credentialInput.value.trim() : ''
  const config = collectConfig(drawer, entry)
  const res = await request('/v1/admin/integrations', 'POST', { kind, label, credential, config, scope, mode })
  if (!res || res.ok === false) {
    toast({ kind: 'error', text: (res && res.error) || 'Could not add this connector.' })
    return
  }
  toast({ kind: 'ok', text: `${label} added.` })
  closeDrawer(section)
  const added = res.integration as ConnectorSummary
  connectedCache = [added, ...connectedCache.filter((c) => c.id !== added.id)]
  renderFromCache(section, added.id)
  markTileConnectedByKind(section, kind, true)
}

async function handleRevokeClick(section: HTMLElement, btn: HTMLElement): Promise<void> {
  const id = btn.getAttribute('data-connector-revoke')
  if (!id) return
  const label = btn.getAttribute('data-connector-revoke-label') || 'this connector'
  // Same real numbers the Danger tab's own Revoke row states (render/pages/connectors.ts's
  // dangerPanelHtml()) -- this quick-access route to the identical destructive action must not
  // carry materially less consequence information than the drawer route to it.
  const row = connectedCache.find((c) => c.id === id)
  const usage = row ? `${row.grantsCount} seat${row.grantsCount === 1 ? ' has' : 's have'} used it${row.uses ? `, ${row.uses} call${row.uses === 1 ? '' : 's'} total` : ''}.` : ''
  if (!window.confirm(`Revoke ${label}? This ends the connection for every seat immediately.${usage ? ` ${usage}` : ''}`)) return
  const res = await request(`/v1/admin/integrations/${encodeURIComponent(id)}/revoke`, 'POST', {})
  if (!res || res.ok === false) {
    toast({ kind: 'error', text: (res && res.error) || 'Could not revoke this connector.' })
    return
  }
  toast({ kind: 'ok', text: 'Connector revoked.' })
  closeDrawer(section)
  await refreshConnectors(section)
}

async function handleDeleteClick(section: HTMLElement, btn: HTMLElement): Promise<void> {
  const id = btn.getAttribute('data-connector-delete')
  if (!id) return
  const label = btn.getAttribute('data-connector-delete-label') || 'this connector'
  if (!window.confirm(`Delete ${label} permanently? This cannot be undone.`)) return
  const res = await request(`/v1/admin/integrations/${encodeURIComponent(id)}`, 'DELETE')
  if (!res || res.ok === false) {
    toast({ kind: 'error', text: (res && res.error) || 'Could not delete this connector.' })
    return
  }
  toast({ kind: 'ok', text: 'Connector deleted.' })
  closeDrawer(section)
  await refreshConnectors(section)
}

/** plan 6.10c Tools tab: "the one real, working control ... flipping it restates the blast radius
 *  in one sentence naming the vendor and verbs before it takes effect." Reverts the checkbox
 *  visually if the admin cancels the confirm, and never persists a change that was not confirmed. */
async function handleAllowWritesChange(section: HTMLElement, input: HTMLInputElement): Promise<void> {
  const id = input.getAttribute('data-connector-allow-writes')
  const label = input.getAttribute('data-connector-allow-writes-label') || 'This connector'
  if (!id) return
  const turningOn = input.checked
  if (turningOn) {
    const row = connectedCache.find((c) => c.id === id)
    const writeTools = row?.tools?.filter((t) => t.write).map((t) => t.name) || []
    const verbs = writeTools.length ? `run ${writeTools.slice(0, 3).join(', ')}${writeTools.length > 3 ? ` and ${writeTools.length - 3} more` : ''}` : 'create, update and delete data it can reach'
    if (!window.confirm(`${label} will be able to ${verbs}. Turn write access on?`)) {
      input.checked = false
      return
    }
  }
  const res = await request(`/v1/admin/integrations/${encodeURIComponent(id)}`, 'PATCH', { allowWrites: turningOn })
  if (!res || res.ok === false) {
    input.checked = !turningOn
    toast({ kind: 'error', text: (res && res.error) || 'Could not change write access.' })
    return
  }
  toast({ kind: 'ok', text: turningOn ? 'Write access turned on.' : 'Write access turned off.' })
  await refreshConnectors(section)
}

/** The Tools tab's real per-tool enable switch (plan 6.10c, finding 8: the blanket allowWrites
 *  toggle above is the only category-level control; this is the finer, per-tool one). PATCHes the
 *  connection's `disabledTools` list -- gateway.ts refuses that exact tool name on every
 *  `tools/call` from then on, for both REST-adapter and MCP-proxy connections. Same shape as
 *  handleAllowWritesChange() above: no confirm dialog either direction (turning a tool off only
 *  narrows what the connection can do; turning one back on does not bypass allowWrites -- a write
 *  tool still needs both switches on), refreshConnectors() after a successful PATCH so the cache
 *  stays server truth rather than a hand-maintained copy, drawer left open (unlike Save, this is
 *  not "done with the drawer," just one more field flipped). */
async function handleToolToggleChange(section: HTMLElement, input: HTMLInputElement): Promise<void> {
  const id = input.getAttribute('data-connector-tool-toggle')
  const toolName = input.getAttribute('data-connector-tool-name')
  if (!id || !toolName) return
  const turningOn = input.checked
  const row = connectedCache.find((c) => c.id === id)
  const current = row?.disabledTools || []
  const nextDisabled = turningOn ? current.filter((t) => t !== toolName) : current.includes(toolName) ? current : [...current, toolName]
  const labelSpan = input.closest('label')?.querySelector('span')
  if (labelSpan) labelSpan.textContent = turningOn ? 'Enabled' : 'Off'
  const res = await request(`/v1/admin/integrations/${encodeURIComponent(id)}`, 'PATCH', { disabledTools: nextDisabled })
  if (!res || res.ok === false) {
    input.checked = !turningOn
    if (labelSpan) labelSpan.textContent = !turningOn ? 'Enabled' : 'Off'
    toast({ kind: 'error', text: (res && res.error) || `Could not change ${toolName}.` })
    return
  }
  toast({ kind: 'ok', text: turningOn ? `${toolName} turned on.` : `${toolName} turned off.` })
  await refreshConnectors(section)
}

// ---------------------------------------------------------------------------
// Rotate dialog (plan 9, "no window.prompt": operator/src/render/pages/connectors.ts's
// renderRotateDialog() renders the shared masked dialog() primitive once; wired the same way
// operator/client/pages/keys.ts wires its own instance of the same primitive).
// ---------------------------------------------------------------------------

let rotateTargetId: string | null = null

function openRotateDialog(id: string): void {
  const overlay = document.getElementById('connector-rotate-dialog')
  if (!overlay) return
  rotateTargetId = id
  overlay.hidden = false
  const input = overlay.querySelector<HTMLInputElement>('.dialog-input')
  if (input) input.focus()
}

function wireRotateDialog(section: HTMLElement): void {
  const overlay = section.querySelector<HTMLElement>('#connector-rotate-dialog')
  if (!overlay) return
  const input = overlay.querySelector<HTMLInputElement>('.dialog-input')
  const reveal = overlay.querySelector<HTMLElement>('[data-dialog-reveal]')
  const cancel = overlay.querySelector<HTMLElement>('[data-dialog-cancel]')
  const confirm = overlay.querySelector<HTMLElement>('[data-dialog-confirm]')
  const panel = overlay.querySelector<HTMLElement>('.dialog-panel')

  const close = (): void => {
    overlay.hidden = true
    rotateTargetId = null
    if (input) input.value = ''
  }
  if (reveal && input) {
    reveal.addEventListener('click', () => {
      const showing = reveal.getAttribute('aria-pressed') === 'true'
      input.type = showing ? 'password' : 'text'
      reveal.setAttribute('aria-pressed', showing ? 'false' : 'true')
      reveal.textContent = showing ? 'Show' : 'Hide'
    })
  }
  if (cancel) cancel.addEventListener('click', close)
  if (confirm) {
    confirm.addEventListener('click', async () => {
      const credential = input ? input.value.trim() : ''
      const id = rotateTargetId
      if (!credential || !id) return
      const res = await request(`/v1/admin/integrations/${encodeURIComponent(id)}/rotate`, 'POST', { credential })
      close()
      if (!res || res.ok === false) {
        toast({ kind: 'error', text: (res && res.error) || 'Could not rotate this credential.' })
        return
      }
      toast({ kind: 'ok', text: 'Credential rotated.' })
      await refreshConnectors(section)
    })
  }
  if (panel) {
    const observer = new MutationObserver(() => {
      if (!overlay.hidden && !reduceMotion()) pop(panel)
    })
    observer.observe(overlay, { attributes: true, attributeFilter: ['hidden'] })
  }
}

// ---------------------------------------------------------------------------
// "Add connector" (plan 6.10c block 1): the page header's own action button scrolls to and
// focuses the catalog search, rather than opening a drawer blind. The rail's separate "Add
// connector" button (operator/client/nav.ts, a shell file this page does not own) dispatches the
// same `metis:add-connector` window event it always has; this page now answers it the same way,
// for one coherent "start at the catalog" story across both entry points.
// ---------------------------------------------------------------------------

function scrollToCatalogSearch(section: HTMLElement): void {
  const input = section.querySelector<HTMLInputElement>('#connectors-search')
  if (!input) return
  input.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'center' })
  input.focus()
}

function wireRailAddConnector(section: HTMLElement): void {
  if (railListenerWired) return
  railListenerWired = true
  window.addEventListener('metis:add-connector', () => {
    scrollToCatalogSearch(section)
  })
}

// ---------------------------------------------------------------------------
// Delegated, bind-once wiring (survives every re-render of the body slot, the status strip and the
// drawer, since all three live inside this same, never-replaced `section` element).
// ---------------------------------------------------------------------------

function wireDelegatedEvents(section: HTMLElement): void {
  section.addEventListener('click', (e) => {
    const target = e.target
    if (!(target instanceof Element)) return

    if (target.closest('[data-connectors-header-add]')) {
      scrollToCatalogSearch(section)
      return
    }

    if (target.closest('[data-connectors-scroll-attention]')) {
      e.preventDefault()
      const el = section.querySelector<HTMLElement>('#connectors-needs-attention')
      if (el) el.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' })
      return
    }

    const filterClear = target.closest<HTMLElement>('[data-connectors-filter-clear]')
    if (filterClear) {
      setStatusFilter(section, null)
      return
    }

    const selectToggle = target.closest<HTMLElement>('[data-connectors-select-toggle]')
    if (selectToggle) {
      setSelectMode(section, selectToggle.getAttribute('aria-pressed') !== 'true')
      return
    }

    if (target.closest('[data-connectors-bulk-cancel]')) {
      setSelectMode(section, false)
      return
    }
    if (target.closest('[data-connectors-bulk-retest]')) {
      void handleBulkRetest(section)
      return
    }
    if (target.closest('[data-connectors-bulk-revoke]')) {
      void handleBulkRevoke(section)
      return
    }
    const rescopeToggle = target.closest<HTMLElement>('[data-connectors-bulk-rescope]')
    if (rescopeToggle) {
      toggleBulkRescopePanel(section, rescopeToggle)
      return
    }
    if (target.closest('[data-connectors-bulk-rescope-apply]')) {
      void handleBulkRescopeApply(section)
      return
    }

    const toolsToggle = target.closest<HTMLElement>('[data-tools-toggle]')
    if (toolsToggle) {
      e.stopPropagation()
      toggleTools(section, toolsToggle)
      return
    }

    const historyToggle = target.closest<HTMLElement>('[data-connectors-history-toggle]')
    if (historyToggle) {
      toggleConnectorsHistory(section, historyToggle)
      return
    }
    const overflowToggle = target.closest<HTMLElement>('[data-connectors-overflow-toggle]')
    if (overflowToggle) {
      toggleConnectorsOverflow(section, overflowToggle)
      return
    }

    const revealBtn = target.closest<HTMLElement>('[data-credential-reveal]')
    if (revealBtn) {
      toggleCredentialReveal(revealBtn)
      return
    }

    const tabBtn = target.closest<HTMLElement>('[data-connector-tabs] [data-tab]')
    if (tabBtn) {
      const drawer = tabBtn.closest<HTMLElement>('#connection-drawer')
      if (drawer) switchDrawerTab(drawer, tabBtn)
      return
    }

    const testBtn = target.closest<HTMLElement>('[data-connector-test]')
    if (testBtn) {
      e.stopPropagation()
      void handleTestClick(section, testBtn)
      return
    }

    const rotateBtn = target.closest<HTMLElement>('[data-connector-rotate]')
    if (rotateBtn) {
      e.stopPropagation()
      const id = rotateBtn.getAttribute('data-connector-rotate')
      if (id) openRotateDialog(id)
      return
    }

    const revokeBtn = target.closest<HTMLElement>('[data-connector-revoke]')
    if (revokeBtn) {
      e.stopPropagation()
      void handleRevokeClick(section, revokeBtn)
      return
    }

    const deleteBtn = target.closest<HTMLElement>('[data-connector-delete]')
    if (deleteBtn) {
      e.stopPropagation()
      void handleDeleteClick(section, deleteBtn)
      return
    }

    const saveBtn = target.closest<HTMLElement>('[data-connector-save]')
    if (saveBtn) {
      e.stopPropagation()
      void handleSaveClick(section, saveBtn)
      return
    }

    if (target.closest('#connection-drawer-close')) {
      closeDrawer(section)
      return
    }

    const auditLink = target.closest<HTMLElement>('[data-connector-activity-audit-link]')
    if (auditLink) return // a plain hash link to Audit; no extra handling owned by this page

    const selectCheck = target.closest<HTMLElement>('[data-connector-select]')
    if (selectCheck) {
      e.stopPropagation()
      return // the row's own change listener (below) does the work; this only stops the row-click
    }

    const tile = target.closest<HTMLElement>('[data-catalog-tile]')
    if (tile) {
      if (tile.hasAttribute('data-inert')) return
      const kind = tile.getAttribute('data-catalog-tile')
      if (!kind) return
      if (tile.classList.contains('catalog-tile-connected')) {
        const firstRow = section.querySelector<HTMLElement>(`[data-connector-row][data-connector-kind="${CSS.escape(kind)}"]`)
        if (firstRow) {
          scrollToAndHighlightRow(section, firstRow.getAttribute('data-connector-row'))
          return
        }
      }
      void openDrawer(section, kind, null)
      return
    }

    const attentionRow = target.closest<HTMLElement>('.connector-row[data-connector-id]')
    if (attentionRow) {
      const id = attentionRow.getAttribute('data-connector-id')
      const kind = attentionRow.getAttribute('data-connector-kind')
      if (id && kind) void openDrawer(section, kind, id)
      return
    }

    const row = target.closest<HTMLElement>('[data-connector-row]')
    if (row) {
      const id = row.getAttribute('data-connector-row')
      const kind = row.getAttribute('data-connector-kind')
      if (id && kind) void openDrawer(section, kind, id)
    }
  })

  section.addEventListener('change', (e) => {
    const target = e.target
    if (!(target instanceof HTMLInputElement)) return
    const selectId = target.getAttribute('data-connector-select')
    if (selectId) {
      toggleRowSelected(section, selectId, target.checked)
      return
    }
    const allowWritesId = target.getAttribute('data-connector-allow-writes')
    if (allowWritesId) {
      void handleAllowWritesChange(section, target)
      return
    }
    const toolToggleId = target.getAttribute('data-connector-tool-toggle')
    if (toolToggleId) {
      void handleToolToggleChange(section, target)
      return
    }
    if (target.matches('#connection-drawer input[name="scopeTier"], #connection-drawer input[name="scopeGroup"], #connection-drawer input[name="mode"]')) {
      const drawer = target.closest<HTMLElement>('#connection-drawer')
      if (drawer && scopeSnapshot) updateScopePreviewAndSave(drawer)
    }
  })

  section.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const drawer = section.querySelector<HTMLElement>('#connection-drawer')
      if (drawer && !drawer.hidden) {
        closeDrawer(section)
        return
      }
    }
    if ((e.key === 'Enter' || e.key === ' ') && e.target instanceof HTMLElement) {
      const row = e.target.closest<HTMLElement>('[data-connector-row], .connector-row[data-connector-id]')
      if (row && e.target === row) {
        e.preventDefault()
        const id = row.getAttribute('data-connector-row') || row.getAttribute('data-connector-id')
        const kind = row.getAttribute('data-connector-kind')
        if (id && kind) void openDrawer(section, kind, id)
      }
    }
  })

  // plan 3.5b: Save is enabled only after a passing test (new connection); editing any field after
  // a pass invalidates it, so a stale "passing" state can never be saved without a fresh test.
  section.addEventListener('input', (e) => {
    const target = e.target
    if (!(target instanceof Element)) return
    if (target.matches('#connection-drawer input[name="credential"], #connection-drawer input[name^="cfg_"]')) {
      const saveBtn = section.querySelector<HTMLButtonElement>('#connection-drawer [data-connector-save]')
      if (saveBtn && !saveBtn.getAttribute('data-connector-save')) saveBtn.disabled = true
    }
  })
}

// ---------------------------------------------------------------------------
// Boot.
// ---------------------------------------------------------------------------

const WIRED_FLAG = 'connectorsWired'

export function initConnectors(section: HTMLElement, data: DashboardPayload | null): void {
  // operator/client/main.ts's boot sequence calls every PAGE_INIT with `data: null` on first
  // paint -- the section is already fully server-rendered, so there is deliberately nothing to
  // hydrate yet (see main.ts's own comment on that loop). `connectedCache` therefore starts empty
  // on a real boot, not just in this preview harness; `data` only ever arrives non-null through
  // the generic `rerender()` path, which this page does not use (it refreshes through
  // refreshConnectors() below instead). Never treat an empty `connectedCache` as "zero
  // connections" -- it means "not loaded yet," and the tile connected-dots below must be left
  // exactly as the server rendered them (already correct, from the same real data) rather than
  // wiped by a reconciliation pass with nothing to reconcile against.
  seedFromServerData(data)

  // operator/client/main.ts's boot sequence calls bindMotion(document.body) once, across every
  // server-rendered [data-page] section at once, before any PAGE_INIT runs -- staggerIn()'s delay
  // is `index * 40ms` against that single, whole-document [data-stagger] list, so a page as far
  // down NAV_IDS as this one (9th of 11) could inherit a multi-second delay before its own catalog
  // tiles' entrance animation even starts if they shared that default 40ms bucket with every
  // earlier page's rows. They do not: catalog tiles (25ms), Needs attention rows (30ms,
  // connectors-list.ts) and Connected rows (35ms) each carry their own cadence, so even that very
  // first, whole-document bindMotion() call already groups them with only this page's own
  // elements. Re-binding motion here, scoped to just this section, is still done as a second,
  // defence-in-depth pass for the case a later page's own client init throws before this one runs
  // (main.ts's boot loop has no per-page try/catch) -- it simply restarts the same small,
  // section-local stagger, which is harmless to repeat.
  bindMotion(section)
  wireToolbar(section)
  wireRailAddConnector(section)
  if (connectedCache.length) applyTileConnectionStates(section, connectedCache, false)
  if (section.querySelector('[data-group-id]')) {
    void ensureGroups().then(() => enhanceScopeChipNames(section))
  }
  if (section.dataset[WIRED_FLAG] !== '1') {
    section.dataset[WIRED_FLAG] = '1'
    wireDelegatedEvents(section)
    wireRotateDialog(section)
  }
}
