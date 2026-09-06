/**
 * Audit page client (plan 6.11b, P1.11 brief). Owns everything this page needs client-side:
 *
 *  - Hydrates from the real `GET /v1/admin/audit.json` (richer than the SSR `DashboardPayload`:
 *    it carries `request_id` and `route`, which `data.change.timeline` never does) the moment the
 *    section is visible, and again every time the operator navigates back to it.
 *  - Range (24 h to 365 d, plus Custom with two date inputs) re-fetches from the server (a
 *    different `since` bound); every other filter (actor, action group, route, seat, connector,
 *    request id, the search box) is applied client-side over the currently loaded rows with no
 *    network round trip -- `/v1/admin/audit.json` supports only `since`/`actor`(exact)/`action`
 *    (exact)/`limit` today (operator/src/routes/admin-core.ts's `auditJson()`), nowhere near this
 *    toolbar's six filters, so this page follows the task brief's instruction verbatim: "if
 *    audit.json lacks a filter, apply it client-side over the loaded rows." The exact backend
 *    patch that would widen the route lives in this page's build report.
 *  - Load older: bumps the fetch `limit` (server rows are already newest-first, so a bigger limit
 *    is a strict superset with the same filters producing a matching superset) and appends only
 *    the newly-visible tail, staggered in -- capped at 500 (the route's own ceiling), past which
 *    a named note explains the limit rather than silently doing nothing.
 *  - Live mode is off by default (plan: "audit is not a feed") -- no poll timer at all.
 *  - Export: CSV/Excel hrefs stay in sync with whatever of the current filters the export route
 *    can actually honour (`since`, `until`, `actor`, `q` -- operator/src/export/tables.ts's
 *    `filtersFromSearchParams`); a brief shimmer plays on the clicked link (plan 3.5b).
 *  - Request id copy: click to copy, a check-mark crossfade confirms it (plan 3.5b), never a
 *    silent clipboard write.
 *  - The drawer: every column from the clicked row, plus derived Seat / License / Connector links.
 */
import type { DashboardPayload } from '../../src/dashboard'
import { esc } from '../../src/render'
import {
  auditSummaryHtml,
  auditTargetLabel,
  classifyAuditGroup,
  computeAuditSummary,
  deriveAuditLinks,
  normalizeAuditJsonRow,
  renderAuditRowsHtml,
  renderAuditTableBody,
  AUDIT_GROUP_LABEL,
  AUDIT_OPTIONAL_COLUMNS,
  type AuditGroup,
  type AuditJsonRow,
  type AuditRowLike,
  type AuditOptionalColumn
} from '../../src/render/pages/audit'
import { api } from '../api'
import { bindMotion } from '../motion-bind'
import { press, shimmer, slideIn, staggerIn } from '../motion'
import { toast } from '../toasts'

// -------------------------------------------------------------------------------------------
// State.
// -------------------------------------------------------------------------------------------

interface AuditState {
  rangeId: string
  customSince: number | null
  customUntil: number | null
  actor: string
  group: AuditGroup | ''
  route: string
  seat: string
  connector: string
  requestId: string
  q: string
  limit: number
}

const PAGE_SIZE = 50
const MAX_LIMIT = 500

const RANGE_MS: Record<string, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  '90d': 90 * 24 * 60 * 60 * 1000,
  '365d': 365 * 24 * 60 * 60 * 1000
}

function defaultState(): AuditState {
  return {
    rangeId: '24h',
    customSince: null,
    customUntil: null,
    actor: '',
    group: '',
    route: '',
    seat: '',
    connector: '',
    requestId: '',
    q: '',
    limit: PAGE_SIZE
  }
}

let state: AuditState = defaultState()
let sectionEl: HTMLElement | null = null
let visibilityObserver: MutationObserver | null = null
let globalChromeBound = false
let filterDebounce: ReturnType<typeof setTimeout> | null = null
let searchDebounce: ReturnType<typeof setTimeout> | null = null
/** Every row the server returned for the current range + limit, before any client-side filter. */
let lastRawRows: AuditRowLike[] = []
/** Rows currently rendered (after every client-side filter). */
let currentVisibleRows: AuditRowLike[] = []

interface StoredAuditRow extends AuditRowLike {
  group: AuditGroup
}

// -------------------------------------------------------------------------------------------
// Small DOM helpers, scoped to the audit section.
// -------------------------------------------------------------------------------------------

function q<T extends HTMLElement>(selector: string): T | null {
  return sectionEl ? sectionEl.querySelector<T>(selector) : null
}
function qa<T extends HTMLElement>(selector: string): T[] {
  return sectionEl ? Array.from(sectionEl.querySelectorAll<T>(selector)) : []
}
function tbodyEl(): HTMLTableSectionElement | null {
  return q<HTMLTableSectionElement>('#audit-table tbody')
}
function tableBodyWrap(): HTMLElement | null {
  return q<HTMLElement>('[data-audit-table-body]')
}
function skeletonEl(): HTMLElement | null {
  return q<HTMLElement>('[data-audit-skeleton]')
}
function loadOlderBtn(): HTMLButtonElement | null {
  return q<HTMLButtonElement>('[data-audit-load-older]')
}
function limitNoteEl(): HTMLElement | null {
  return q<HTMLElement>('[data-audit-limit-note]')
}
function summaryHost(): HTMLElement | null {
  return q<HTMLElement>('[data-audit-summary]')
}

// -------------------------------------------------------------------------------------------
// Range resolution (plan: "range 24h to 365d, custom").
// -------------------------------------------------------------------------------------------

function resolvedRange(): { since: number; until: number } {
  if (state.rangeId === 'custom' && state.customSince != null) {
    return { since: state.customSince, until: state.customUntil ?? Date.now() }
  }
  const ms = RANGE_MS[state.rangeId] ?? RANGE_MS['24h']
  return { since: Date.now() - ms, until: Date.now() }
}

// -------------------------------------------------------------------------------------------
// audit.json fetch.
// -------------------------------------------------------------------------------------------

interface AuditJsonResponse {
  ok?: boolean
  audit?: AuditJsonRow[]
  error?: string
}

async function fetchAuditJson(since: number, limit: number): Promise<AuditJsonResponse | null> {
  const params = new URLSearchParams()
  params.set('since', String(since))
  params.set('limit', String(limit))
  const json = (await api(`/v1/admin/audit.json?${params.toString()}`)) as AuditJsonResponse
  if (!json || json.ok === false || !Array.isArray(json.audit)) return null
  return json
}

// -------------------------------------------------------------------------------------------
// Client-side filters (see file header: audit.json supports none of these).
// -------------------------------------------------------------------------------------------

function matchesQuery(row: AuditRowLike, needle: string): boolean {
  const haystack = [row.actor, row.action, row.detail, row.route || '', row.requestId || '']
    .join(' ')
    .toLowerCase()
  return haystack.includes(needle)
}

function applyClientFilters(rows: AuditRowLike[]): AuditRowLike[] {
  const { until } = resolvedRange()
  return rows.filter((row) => {
    if (until != null && row.ts > until) return false
    const group = classifyAuditGroup(row.action)
    if (state.group && group !== state.group) return false
    if (state.actor && !row.actor.toLowerCase().includes(state.actor)) return false
    if (state.route && !(row.route || '').toLowerCase().includes(state.route)) return false
    if (state.requestId && !(row.requestId || '').toLowerCase().includes(state.requestId)) return false
    if (state.seat) {
      const links = deriveAuditLinks(row, group)
      const seatHay = `${row.actor} ${links.seatId || ''}`.toLowerCase()
      if (!seatHay.includes(state.seat)) return false
    }
    if (state.connector) {
      const links = deriveAuditLinks(row, group)
      const connectorHay = `${row.detail} ${row.route || ''} ${links.connectorHint || ''}`.toLowerCase()
      if (!connectorHay.includes(state.connector)) return false
    }
    if (state.q && !matchesQuery(row, state.q)) return false
    return true
  })
}

// -------------------------------------------------------------------------------------------
// Export links: GET /v1/admin/export.<csv|xlsx> reads its own query string, and only understands
// since/until/actor/q for the audit table (operator/src/export/tables.ts's
// filtersFromSearchParams) -- a backend limitation this page cannot widen (matching the precedent
// operator/client/pages/events.ts's own updateExportLinks() sets for its unsupported filters).
// -------------------------------------------------------------------------------------------

function updateExportLinks(): void {
  const { since, until } = resolvedRange()
  const params = new URLSearchParams()
  params.set('since', String(since))
  params.set('until', String(until))
  if (state.actor) params.set('actor', state.actor)
  if (state.q) params.set('q', state.q)
  qa<HTMLAnchorElement>('[data-export-link]').forEach((link) => {
    const format = link.getAttribute('data-export-link') || 'csv'
    link.href = `/v1/admin/export.${format}?table=audit&${params.toString()}`
  })
}

function wireExportMenu(): void {
  qa<HTMLAnchorElement>('[data-export-link]').forEach((link) => {
    link.addEventListener('click', () => {
      shimmer(link, true)
      setTimeout(() => shimmer(link, false), 700)
      closeAllMenus()
    })
  })
}

// -------------------------------------------------------------------------------------------
// Summary strip.
// -------------------------------------------------------------------------------------------

function updateSummary(rows: AuditRowLike[]): void {
  const host = summaryHost()
  if (!host) return
  const truncated = lastRawRows.length >= state.limit
  host.innerHTML = auditSummaryHtml(computeAuditSummary(rows), Date.now(), truncated)
  bindMotion(host)
}

// -------------------------------------------------------------------------------------------
// Request id copy (plan 3.5b: "check mark crossfade").
// -------------------------------------------------------------------------------------------

async function copyRequestId(btn: HTMLButtonElement): Promise<void> {
  const id = btn.getAttribute('data-copy-reqid')
  if (!id) return
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(id)
  } catch {
    /* clipboard unavailable: the crossfade still confirms the click, the id stays visible either way */
  }
  btn.classList.add('is-copied')
  setTimeout(() => btn.classList.remove('is-copied'), 1200)
}

function wireRequestIdButtons(rows: HTMLElement[]): void {
  rows.forEach((row) => {
    row.querySelectorAll<HTMLButtonElement>('[data-copy-reqid]').forEach((btn) => {
      press(btn)
      btn.addEventListener('click', (event) => {
        event.stopPropagation()
        void copyRequestId(btn)
      })
    })
  })
}

// -------------------------------------------------------------------------------------------
// Row rendering (hydrate / filter change replaces the whole visible set; Load older appends).
// -------------------------------------------------------------------------------------------

function wireRowClicks(rows: HTMLElement[]): void {
  rows.forEach((row) => {
    row.addEventListener('click', () => openDrawerForRow(row))
    press(row)
  })
}

function renderVisible(rows: AuditRowLike[]): void {
  const bodyWrap = tableBodyWrap()
  if (bodyWrap) {
    bodyWrap.innerHTML = renderAuditTableBody(rows, Date.now())
    const tbody = tbodyEl()
    if (tbody) {
      const trs = Array.from(tbody.children) as HTMLElement[]
      staggerIn(trs)
      wireRowClicks(trs)
      wireRequestIdButtons(trs)
    }
  }
  currentVisibleRows = rows
  updateSummary(rows)
}

function appendVisible(newRows: AuditRowLike[]): void {
  if (!newRows.length) {
    currentVisibleRows = currentVisibleRows.concat(newRows)
    return
  }
  const tbody = tbodyEl()
  if (!tbody) {
    renderVisible(currentVisibleRows.concat(newRows))
    return
  }
  tbody.insertAdjacentHTML('beforeend', renderAuditRowsHtml(newRows, Date.now()))
  const trs = Array.from(tbody.children) as HTMLElement[]
  const added = trs.slice(-newRows.length)
  staggerIn(added)
  wireRowClicks(added)
  wireRequestIdButtons(added)
  currentVisibleRows = currentVisibleRows.concat(newRows)
  updateSummary(currentVisibleRows)
}

function applyFiltersAndRender(): void {
  renderVisible(applyClientFilters(lastRawRows))
}

// -------------------------------------------------------------------------------------------
// Hydrate / Load older.
// -------------------------------------------------------------------------------------------

function updateLoadOlderVisibility(): void {
  const btn = loadOlderBtn()
  const note = limitNoteEl()
  const mightHaveMore = lastRawRows.length >= state.limit
  if (btn) btn.hidden = !mightHaveMore || state.limit >= MAX_LIMIT
  if (note) note.hidden = !(mightHaveMore && state.limit >= MAX_LIMIT)
}

async function hydrate(): Promise<void> {
  const skeleton = skeletonEl()
  const bodyWrap = tableBodyWrap()
  if (skeleton) {
    skeleton.hidden = false
    shimmer(skeleton, true)
  }
  if (bodyWrap) bodyWrap.hidden = true
  const { since } = resolvedRange()
  const json = await fetchAuditJson(since, state.limit)
  if (skeleton) {
    shimmer(skeleton, false)
    skeleton.hidden = true
  }
  if (bodyWrap) bodyWrap.hidden = false
  if (!json || !json.audit) {
    toast({ kind: 'error', text: 'Could not load the audit log. Try again.' })
    return
  }
  lastRawRows = json.audit.map(normalizeAuditJsonRow)
  renderVisible(applyClientFilters(lastRawRows))
  updateLoadOlderVisibility()
  updateExportLinks()
}

async function loadOlder(): Promise<void> {
  const btn = loadOlderBtn()
  const originalLabel = btn?.textContent ?? 'Load older'
  if (btn) {
    btn.disabled = true
    btn.textContent = 'Loading…'
  }
  const previousCount = currentVisibleRows.length
  state.limit = Math.min(MAX_LIMIT, state.limit + PAGE_SIZE)
  const { since } = resolvedRange()
  const json = await fetchAuditJson(since, state.limit)
  if (btn) {
    btn.disabled = false
    btn.textContent = originalLabel
  }
  if (!json || !json.audit) {
    toast({ kind: 'error', text: 'Could not load older audit rows.' })
    return
  }
  lastRawRows = json.audit.map(normalizeAuditJsonRow)
  const visible = applyClientFilters(lastRawRows)
  const appended = visible.slice(previousCount)
  if (appended.length) appendVisible(appended)
  else {
    currentVisibleRows = visible
    updateSummary(visible)
  }
  updateLoadOlderVisibility()
}

function wireLoadOlder(): void {
  const btn = loadOlderBtn()
  if (!btn) return
  press(btn)
  btn.addEventListener('click', () => void loadOlder())
}

// -------------------------------------------------------------------------------------------
// Menus (Range, Filters, View, Export) -- one open/close pattern, scale + opacity from CSS.
// -------------------------------------------------------------------------------------------

function closeAllMenus(): void {
  document.querySelectorAll<HTMLElement>('.au-menu-panel:not([hidden])').forEach((panel) => {
    panel.hidden = true
    panel.setAttribute('aria-hidden', 'true')
  })
  document
    .querySelectorAll<HTMLElement>('[data-menu-toggle][aria-expanded="true"], [data-view-toggle][aria-expanded="true"]')
    .forEach((btn) => btn.setAttribute('aria-expanded', 'false'))
}

function ensureGlobalChrome(): void {
  if (globalChromeBound) return
  globalChromeBound = true
  document.addEventListener('click', closeAllMenus)
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeAllMenus()
      closeDrawer()
    }
  })
}

function openMenu(toggle: HTMLButtonElement, panel: HTMLElement): void {
  const willOpen = panel.hidden
  closeAllMenus()
  panel.hidden = !willOpen
  panel.setAttribute('aria-hidden', String(!willOpen))
  toggle.setAttribute('aria-expanded', String(willOpen))
}

function wireMenus(): void {
  qa<HTMLButtonElement>('[data-menu-toggle]').forEach((toggle) => {
    const key = toggle.getAttribute('data-menu-toggle')
    const panel = q<HTMLElement>(`[data-menu-panel="${key}"]`)
    if (!panel) return
    toggle.addEventListener('click', (event) => {
      event.stopPropagation()
      openMenu(toggle, panel)
    })
    panel.addEventListener('click', (event) => event.stopPropagation())
  })
  const viewToggle = q<HTMLButtonElement>('[data-view-toggle]')
  const viewPanel = q<HTMLElement>('[data-view-menu]')
  if (viewToggle && viewPanel) {
    viewToggle.addEventListener('click', (event) => {
      event.stopPropagation()
      openMenu(viewToggle, viewPanel)
    })
    viewPanel.addEventListener('click', (event) => event.stopPropagation())
  }
}

// -------------------------------------------------------------------------------------------
// Range menu (plan: "range 24h to 365d, custom").
// -------------------------------------------------------------------------------------------

function wireRangeMenu(): void {
  const customBlock = q<HTMLElement>('[data-custom-range]')
  qa<HTMLButtonElement>('[data-range-option]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-range-option') || '24h'
      qa<HTMLButtonElement>('[data-range-option]').forEach((b) => b.setAttribute('aria-checked', String(b === btn)))
      if (id === 'custom') {
        if (customBlock) customBlock.hidden = false
        return
      }
      if (customBlock) customBlock.hidden = true
      state.rangeId = id
      state.customSince = null
      state.customUntil = null
      const label = q<HTMLElement>('[data-menu-toggle="range"] span')
      if (label) label.textContent = btn.textContent
      closeAllMenus()
      state.limit = PAGE_SIZE
      void hydrate()
    })
  })
  const applyBtn = q<HTMLButtonElement>('[data-range-apply]')
  if (applyBtn) {
    applyBtn.addEventListener('click', () => {
      const from = q<HTMLInputElement>('[data-range-from]')?.value
      const to = q<HTMLInputElement>('[data-range-to]')?.value
      if (!from) return
      state.rangeId = 'custom'
      state.customSince = Date.parse(`${from}T00:00:00.000Z`)
      state.customUntil = to ? Date.parse(`${to}T23:59:59.999Z`) : Date.now()
      const label = q<HTMLElement>('[data-menu-toggle="range"] span')
      if (label) label.textContent = 'Custom'
      closeAllMenus()
      state.limit = PAGE_SIZE
      void hydrate()
    })
  }
}

// -------------------------------------------------------------------------------------------
// Filters menu (plan: "actor, action group, route, seat, connector, request id").
// -------------------------------------------------------------------------------------------

function wireFiltersMenu(): void {
  const actorInput = q<HTMLInputElement>('[data-filter="actor"]')
  const groupSelect = q<HTMLSelectElement>('[data-filter="group"]')
  const routeInput = q<HTMLInputElement>('[data-filter="route"]')
  const seatInput = q<HTMLInputElement>('[data-filter="seat"]')
  const connectorInput = q<HTMLInputElement>('[data-filter="connector"]')
  const requestIdInput = q<HTMLInputElement>('[data-filter="requestId"]')
  const textInputs = [actorInput, routeInput, seatInput, connectorInput, requestIdInput]

  const commitTextFilters = (): void => {
    state.actor = (actorInput?.value || '').trim().toLowerCase()
    state.route = (routeInput?.value || '').trim().toLowerCase()
    state.seat = (seatInput?.value || '').trim().toLowerCase()
    state.connector = (connectorInput?.value || '').trim().toLowerCase()
    state.requestId = (requestIdInput?.value || '').trim().toLowerCase()
    applyFiltersAndRender()
    updateExportLinks()
  }

  textInputs.forEach((input) => {
    if (!input) return
    input.addEventListener('input', () => {
      if (filterDebounce) clearTimeout(filterDebounce)
      filterDebounce = setTimeout(commitTextFilters, 250)
    })
  })

  if (groupSelect) {
    groupSelect.addEventListener('change', () => {
      state.group = groupSelect.value as AuditGroup | ''
      applyFiltersAndRender()
      updateExportLinks()
    })
  }

  const clear = q<HTMLButtonElement>('[data-filters-clear]')
  if (clear) {
    clear.addEventListener('click', () => {
      textInputs.forEach((input) => {
        if (input) input.value = ''
      })
      if (groupSelect) groupSelect.value = ''
      state.actor = ''
      state.group = ''
      state.route = ''
      state.seat = ''
      state.connector = ''
      state.requestId = ''
      closeAllMenus()
      applyFiltersAndRender()
      updateExportLinks()
    })
  }
}

// -------------------------------------------------------------------------------------------
// View menu (column visibility), persisted per-viewer.
// -------------------------------------------------------------------------------------------

const COLUMNS_STORAGE_KEY = 'metis-audit-hidden-columns'

function readHiddenColumns(): string[] {
  try {
    const raw = window.localStorage.getItem(COLUMNS_STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function syncColumnAttr(): void {
  const shell = q<HTMLElement>('[data-audit-table-wrap]')
  const hidden = AUDIT_OPTIONAL_COLUMNS.filter((key: AuditOptionalColumn) => {
    const checkbox = q<HTMLInputElement>(`[data-col-toggle="${key}"]`)
    return checkbox ? !checkbox.checked : false
  })
  if (shell) shell.setAttribute('data-hide-cols', hidden.join(' '))
  try {
    window.localStorage.setItem(COLUMNS_STORAGE_KEY, JSON.stringify(hidden))
  } catch {
    /* storage unavailable: column choice just does not persist this time */
  }
}

function initColumnVisibility(): void {
  const hidden = readHiddenColumns()
  AUDIT_OPTIONAL_COLUMNS.forEach((key: AuditOptionalColumn) => {
    const checkbox = q<HTMLInputElement>(`[data-col-toggle="${key}"]`)
    if (checkbox) checkbox.checked = !hidden.includes(key)
  })
  const shell = q<HTMLElement>('[data-audit-table-wrap]')
  if (shell) shell.setAttribute('data-hide-cols', hidden.join(' '))
}

function wireViewMenu(): void {
  qa<HTMLInputElement>('[data-col-toggle]').forEach((checkbox) => checkbox.addEventListener('change', syncColumnAttr))
}

// -------------------------------------------------------------------------------------------
// Search.
// -------------------------------------------------------------------------------------------

function wireSearch(): void {
  const input = q<HTMLInputElement>('#audit-search')
  if (!input) return
  const commit = (): void => {
    state.q = input.value.trim().toLowerCase()
    applyFiltersAndRender()
    updateExportLinks()
  }
  const run = (): void => {
    if (searchDebounce) clearTimeout(searchDebounce)
    searchDebounce = setTimeout(commit, 250)
  }
  input.addEventListener('input', run)
  input.addEventListener('search', run)
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      if (searchDebounce) clearTimeout(searchDebounce)
      commit()
    }
  })
}

// -------------------------------------------------------------------------------------------
// Drawer.
// -------------------------------------------------------------------------------------------

function fieldHtml(label: string, value: string, opts?: { wide?: boolean }): string {
  const cls = ['seat-field', opts?.wide ? 'seat-overlay-wide' : ''].filter(Boolean).join(' ')
  return `<div class="${cls}"><span class="lbl">${esc(label)}</span><span class="val">${esc(value)}</span></div>`
}

function drawerEl(): HTMLElement | null {
  return document.getElementById('audit-drawer')
}
function backdropEl(): HTMLElement | null {
  return document.querySelector('[data-drawer-backdrop="audit-drawer"]')
}

function openDrawer(): void {
  const drawer = drawerEl()
  const backdrop = backdropEl()
  if (!drawer) return
  drawer.hidden = false
  slideIn(drawer, 'right')
  if (backdrop) {
    backdrop.hidden = false
    requestAnimationFrame(() => backdrop.classList.add('show'))
  }
}

function closeDrawer(): void {
  const drawer = drawerEl()
  const backdrop = backdropEl()
  if (drawer && !drawer.hidden) drawer.hidden = true
  if (backdrop) {
    backdrop.classList.remove('show')
    backdrop.hidden = true
  }
}

function fillDrawerLinks(row: StoredAuditRow, container: HTMLElement): void {
  const links = deriveAuditLinks(row, row.group)
  const parts: string[] = []
  if (links.seatId) {
    parts.push(
      `<div class="au-drawer-link-row"><span class="lbl">Seat</span><code class="au-mono">${esc(links.seatId)}</code><a class="btn" href="#sessions">Open in Sessions</a></div>`
    )
  } else {
    parts.push('<div class="au-drawer-link-row"><span class="lbl">Seat</span><span class="val muted">Not reported</span></div>')
  }
  if (links.licenseLast4) {
    parts.push(
      `<div class="au-drawer-link-row"><span class="lbl">License</span><span class="val">··${esc(links.licenseLast4)}</span><a class="btn" href="#licenses">Open in Licenses</a></div>`
    )
  } else {
    parts.push('<div class="au-drawer-link-row"><span class="lbl">License</span><span class="val muted">Not reported</span></div>')
  }
  if (links.connectorHint) {
    parts.push(
      `<div class="au-drawer-link-row"><span class="lbl">Connector</span><span class="val">${esc(links.connectorHint)}</span><a class="btn" href="#connectors">Open in Connectors</a></div>`
    )
  } else {
    parts.push('<div class="au-drawer-link-row"><span class="lbl">Connector</span><span class="val muted">Not reported</span></div>')
  }
  container.innerHTML = parts.join('')
}

function fillDrawer(row: StoredAuditRow): void {
  const drawer = drawerEl()
  const body = drawer?.querySelector<HTMLElement>('[data-drawer-body]')
  const title = drawer?.querySelector<HTMLElement>('[data-drawer-title]')
  const linksHost = drawer?.querySelector<HTMLElement>('[data-drawer-links]')
  if (!drawer || !body) return
  if (title) title.textContent = AUDIT_GROUP_LABEL[row.group]

  const target = auditTargetLabel(row, row.group, deriveAuditLinks(row, row.group))
  const fields: { label: string; value: string; wide?: boolean }[] = [
    { label: 'When', value: `${new Date(row.ts).toISOString().replace('T', ' ').slice(0, 19)} UTC` },
    { label: 'Actor', value: row.actor || 'Not reported' },
    { label: 'Action', value: row.action },
    { label: 'Action group', value: AUDIT_GROUP_LABEL[row.group] },
    { label: 'Target', value: target },
    { label: 'Route', value: row.route || 'Not reported' },
    { label: 'Ask id', value: row.askId || 'Not reported' },
    { label: 'Detail', value: row.detail || 'Not reported', wide: true }
  ]
  const requestIdRow = row.requestId
    ? `<div class="seat-field seat-overlay-wide"><span class="lbl">Request id</span><span class="val au-mono">${esc(row.requestId)}</span><button type="button" class="btn" data-copy-reqid="${esc(row.requestId)}">Copy</button></div>`
    : '<div class="seat-field seat-overlay-wide"><span class="lbl">Request id</span><span class="val muted">Not reported</span></div>'

  body.innerHTML = fields.map((f) => fieldHtml(f.label, f.value, { wide: f.wide })).join('') + requestIdRow
  const copyBtn = body.querySelector<HTMLButtonElement>('[data-copy-reqid]')
  if (copyBtn) {
    press(copyBtn)
    copyBtn.addEventListener('click', () => void copyRequestId(copyBtn))
  }
  if (linksHost) fillDrawerLinks(row, linksHost)
}

function openDrawerForRow(row: HTMLElement): void {
  const raw = row.getAttribute('data-row')
  if (!raw) return
  let parsed: StoredAuditRow
  try {
    parsed = JSON.parse(raw) as StoredAuditRow
  } catch {
    return
  }
  openDrawer()
  fillDrawer(parsed)
}

function wireDrawerChrome(): void {
  const closeBtn = document.getElementById('audit-drawer-close')
  if (closeBtn) closeBtn.addEventListener('click', closeDrawer)
  const backdrop = backdropEl()
  if (backdrop) backdrop.addEventListener('click', closeDrawer)
}

// -------------------------------------------------------------------------------------------
// Visibility: hydrate when the audit section becomes visible (no live poll -- plan: "live mode
// off by default, audit is not a feed").
// -------------------------------------------------------------------------------------------

function onSectionVisible(): void {
  void hydrate()
}

function wireVisibility(section: HTMLElement): void {
  if (visibilityObserver) visibilityObserver.disconnect()
  visibilityObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type !== 'attributes' || mutation.attributeName !== 'hidden') continue
      if (!section.hidden) onSectionVisible()
    }
  })
  visibilityObserver.observe(section, { attributes: true, attributeFilter: ['hidden'] })
  if (!section.hidden) onSectionVisible()
}

// -------------------------------------------------------------------------------------------
// Entry point.
// -------------------------------------------------------------------------------------------

function wireSection(section: HTMLElement): void {
  sectionEl = section
  ensureGlobalChrome()
  wireMenus()
  wireRangeMenu()
  wireFiltersMenu()
  wireViewMenu()
  initColumnVisibility()
  wireSearch()
  wireLoadOlder()
  wireExportMenu()
  wireDrawerChrome()
  wireRowClicks(qa<HTMLElement>('#audit-table tbody tr'))
  wireRequestIdButtons(qa<HTMLElement>('#audit-table tbody tr'))
  updateExportLinks()
}

export function initAudit(section: HTMLElement, data: DashboardPayload | null): void {
  void data
  if (visibilityObserver) {
    visibilityObserver.disconnect()
    visibilityObserver = null
  }
  state = defaultState()
  lastRawRows = []
  currentVisibleRows = []
  wireSection(section)
  wireVisibility(section)
}
