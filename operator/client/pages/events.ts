/**
 * Events page client (plan 6.4, P1.4 brief). Owns everything this page needs client-side:
 *
 *  - Hydrates from the real `GET /v1/admin/events.json` (richer than the SSR `DashboardPayload`:
 *    full device id, real client version, an actual cursor) as soon as the section is visible,
 *    and again every time the operator navigates back to it -- the table always shows a fresh
 *    resolved-range read, never a stale first-paint snapshot.
 *  - Listening/Paused: while listening, polls events.json every 5s for rows newer than the last
 *    one seen and prepends them (FLIP + an accent-soft wash on the new rows, plan 3.5b).
 *  - Load older via the route's own cursor, appended with a 40ms stagger.
 *  - Range, Filters (OS, country, version, profile) and Search all resolve to the same
 *    events.json query and re-hydrate; the Events/Asks page tabs are sugar over the kind filter
 *    (Asks = the same table, kind=ask -- never a second table); the CRM tab is fully server
 *    rendered already (DashboardPayload.crm) and only needs its status-chip filter and Retry wired.
 *  - The drawer: every field from the clicked row's own data, plus the ask trace (GET
 *    /v1/admin/asks, joined by findAskTrace()) when the kind is ask, plus seat/license links.
 *  - The export menu's two links (CSV, Excel) are re-targeted with the current filters on every
 *    change, since GET /v1/admin/export.<csv|xlsx> reads its own query string, not page state.
 *
 * Retry (CRM tab) updates its own row in place instead of calling rerender() (operator/client/
 * main.ts): a full rerender() re-fetches /v1/admin/dashboard and re-runs renderEvents() against
 * that plain DashboardPayload, which would silently drop this page's own hydrated rows, filters
 * and Listening state. Retry never re-sends on its own (lock 6): it only ever runs once, on click.
 */
import type { DashboardPayload } from '../../src/dashboard'
import { esc } from '../../src/render'
import {
  findAskTrace,
  formatAskTrace,
  normalizeEventListRow,
  renderEventRowsHtml,
  renderEventsTableBody,
  renderKindChipButtons,
  EVENT_OPTIONAL_COLUMNS,
  type AskTraceLite,
  type EventListRowLike,
  type EventRowLike,
  type EventOptionalColumn
} from '../../src/render/pages/events'
import { api } from '../api'
import { beacon, flash, flip, pop, press, reduceMotion, sequence, shimmer, slideIn, staggerIn } from '../motion'
import { bindMotion } from '../motion-bind'
import { toast } from '../toasts'
import { animate } from 'motion/mini'

// -------------------------------------------------------------------------------------------
// State.
// -------------------------------------------------------------------------------------------

interface EventsState {
  range: string
  kind: string
  os: string
  country: string
  version: string
  q: string
  listening: boolean
  cursor: string | null
  latestTs: number
}

function defaultState(): EventsState {
  return { range: '24h', kind: 'all', os: '', country: '', version: '', q: '', listening: true, cursor: null, latestTs: 0 }
}

let state: EventsState = defaultState()
let sectionEl: HTMLElement | null = null
let pendingPopKind: string | null = null
let listenTimer: ReturnType<typeof setInterval> | null = null
let visibilityObserver: MutationObserver | null = null
let cachedDashboard: DashboardPayload | null = null
let askCache: AskTraceLite[] = []
let askCacheAt = 0
let searchDebounce: ReturnType<typeof setTimeout> | null = null
let globalChromeBound = false

const RANGE_MS: Record<string, number> = {
  '30m': 30 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000
}
const ASK_CACHE_TTL_MS = 15_000
const EASE_SPRING: [number, number, number, number] = [0.23, 1, 0.32, 1]

// -------------------------------------------------------------------------------------------
// Small DOM helpers, scoped to the events section.
// -------------------------------------------------------------------------------------------

function q<T extends HTMLElement>(selector: string): T | null {
  return sectionEl ? sectionEl.querySelector<T>(selector) : null
}
function qa<T extends HTMLElement>(selector: string): T[] {
  return sectionEl ? Array.from(sectionEl.querySelectorAll<T>(selector)) : []
}
function tbodyEl(): HTMLTableSectionElement | null {
  return q<HTMLTableSectionElement>('#ev-table tbody')
}
function tableBodyWrap(): HTMLElement | null {
  return q<HTMLElement>('[data-ev-table-body]')
}
function skeletonEl(): HTMLElement | null {
  return q<HTMLElement>('[data-ev-skeleton]')
}
function loadOlderBtn(): HTMLButtonElement | null {
  return q<HTMLButtonElement>('[data-ev-load-older]')
}
function filteredEmptyEl(): HTMLElement | null {
  return q<HTMLElement>('[data-ev-filtered-empty]')
}
function kindRowEl(): HTMLElement | null {
  return q<HTMLElement>('[data-ev-kind-row]')
}

/**
 * Finishes every WAAPI animation still running on `el`'s subtree. Needed before hydrate() hides
 * `[data-ev-table-body]`: page boot's `bindMotion(document.body)` call (operator/client/main.ts)
 * runs synchronously right before this page's own init and starts the SSR rows' data-stagger
 * entrance animation (staggerIn(), up to ~1.1s worst case for a full page of rows) on these exact
 * `<tr>` elements. If the events.json fetch that follows is slow or fails (cold Worker, a
 * transient 5xx, a rate limit) the ancestor can still be hidden when one of those animations
 * would otherwise settle, and settling an animation whose target has become unrendered throws --
 * leaving the row frozen at opacity 0 forever, with real data underneath and no empty state to
 * explain it. Finishing every animation first jumps each row straight to its resting, fully
 * visible state before the ancestor disappears, so nothing is left in flight to interrupt.
 * `getAnimations` is absent in some test/older environments -- a no-op there, not an error.
 */
function finishAnimations(el: HTMLElement | null): void {
  if (!el || typeof el.getAnimations !== 'function') return
  let animations: Animation[]
  try {
    animations = el.getAnimations({ subtree: true })
  } catch {
    return
  }
  for (const anim of animations) {
    try {
      anim.finish()
    } catch {
      /* already finished/canceled, or unfinishable in its current state: nothing more to do */
    }
  }
}

/** Forces rows to their resting, fully visible state regardless of whatever a still-running or
 *  interrupted entrance animation left them at -- the last-resort guarantee that a failed
 *  events.json fetch never makes a table full of real, already-rendered rows look empty (only
 *  the small error toast would otherwise explain why). */
function forceRowsVisible(rows: HTMLElement[]): void {
  rows.forEach((row) => {
    row.style.opacity = '1'
    row.style.transform = 'none'
  })
}

// -------------------------------------------------------------------------------------------
// Row press: plan 3.5b's own number for Events ("row press: scale(.995)") is more subtle than
// motion.ts's shared press() (scale(.97), tuned for buttons/chips) -- same WAAPI shape, own scale,
// so a full-width dense row does not feel like it jumps.
// -------------------------------------------------------------------------------------------

function pressRow(el: HTMLElement): void {
  if (reduceMotion()) return
  const down = (): void => {
    animate(el, { transform: ['scale(1)', 'scale(0.995)'] }, { duration: 0.12, ease: EASE_SPRING })
  }
  const up = (): void => {
    animate(el, { transform: ['scale(0.995)', 'scale(1)'] }, { duration: 0.18, ease: EASE_SPRING })
  }
  el.addEventListener('pointerdown', down)
  el.addEventListener('pointerup', up)
  el.addEventListener('pointercancel', up)
  el.addEventListener('pointerleave', up)
}

function wireRowClicks(rows: HTMLElement[]): void {
  rows.forEach((row) => {
    row.addEventListener('click', () => openDrawerForRow(row))
    pressRow(row)
  })
}

// -------------------------------------------------------------------------------------------
// events.json fetch + query building.
// -------------------------------------------------------------------------------------------

interface EventsJsonResponse {
  ok?: boolean
  rows?: EventListRowLike[]
  nextCursor?: string | null
  counts?: Record<string, number>
  error?: string
}

function buildParams(extra?: { cursor?: string; since?: number; until?: number }): URLSearchParams {
  const p = new URLSearchParams()
  if (extra?.since != null && extra?.until != null) {
    p.set('since', String(extra.since))
    p.set('until', String(extra.until))
  } else {
    p.set('range', state.range)
  }
  if (state.kind !== 'all') p.set('kinds', state.kind)
  if (state.os) p.set('os', state.os)
  if (state.country) p.set('country', state.country)
  if (state.version) p.set('version', state.version)
  if (state.q) p.set('q', state.q)
  if (extra?.cursor) p.set('cursor', extra.cursor)
  p.set('limit', '50')
  return p
}

async function fetchEventsJson(params: URLSearchParams): Promise<EventsJsonResponse | null> {
  const json = (await api(`/v1/admin/events.json?${params.toString()}`)) as EventsJsonResponse
  if (!json || json.ok === false || !Array.isArray(json.rows)) return null
  return json
}

// -------------------------------------------------------------------------------------------
// Export links: GET /v1/admin/export.<csv|xlsx> reads its own query string (table B10's
// filtersFromSearchParams supports since/until/q/kinds/country/os -- not version or profile, a
// backend limitation this page cannot widen, since it does not own operator/src/export/tables.ts).
// -------------------------------------------------------------------------------------------

function updateExportLinks(): void {
  const since = Date.now() - (RANGE_MS[state.range] ?? RANGE_MS['24h'])
  const until = Date.now()
  const params = new URLSearchParams()
  params.set('since', String(since))
  params.set('until', String(until))
  if (state.kind !== 'all') params.set('kinds', state.kind)
  if (state.country) params.set('country', state.country)
  if (state.os) params.set('os', state.os)
  if (state.q) params.set('q', state.q)
  const query = params.toString()
  qa<HTMLAnchorElement>('[data-export-group] [data-export-link]').forEach((link) => {
    const format = link.href.includes('export.xlsx') ? 'xlsx' : 'csv'
    link.href = `/v1/admin/export.${format}?table=events&${query}`
  })
}

// -------------------------------------------------------------------------------------------
// Kind chips.
// -------------------------------------------------------------------------------------------

function updateKindChips(counts: Record<string, number>): void {
  const row = kindRowEl()
  if (!row) return
  row.innerHTML = renderKindChipButtons(counts, state.kind)
  bindMotion(row)
  wireKindChipButtons(row)
}

function wireKindChipButtons(container: HTMLElement): void {
  const chips = Array.from(container.querySelectorAll<HTMLButtonElement>('[data-kind-chip]'))
  chips.forEach((chip) => {
    press(chip)
    chip.addEventListener('click', () => void selectKind(chip.getAttribute('data-kind-chip') || 'all'))
  })
  if (pendingPopKind) {
    const active = chips.find((c) => c.getAttribute('data-kind-chip') === pendingPopKind)
    if (active) pop(active)
    pendingPopKind = null
  }
}

async function selectKind(kind: string): Promise<void> {
  if (state.kind === kind) return
  state.kind = kind
  pendingPopKind = kind
  syncPageTabActive(kind)
  await hydrate()
}

/** The Events/Asks page tabs are sugar over the kind filter (file header): keep the tab strip's
 *  own visual state honest when a kind chip click (not a tab click) is what changed the kind. */
function syncPageTabActive(kind: string): void {
  const wantId = kind === 'ask' ? 'asks' : kind === 'all' ? 'events' : null
  if (!wantId) return
  qa<HTMLButtonElement>('[data-page-tab]').forEach((tab) => {
    const id = tab.getAttribute('data-page-tab')
    if (id === 'crm') return
    const on = id === wantId
    tab.classList.toggle('on', on)
    tab.setAttribute('aria-selected', String(on))
  })
}

// -------------------------------------------------------------------------------------------
// Hydrate / Load older / Listening.
// -------------------------------------------------------------------------------------------

async function hydrate(): Promise<void> {
  const skeleton = skeletonEl()
  const bodyWrap = tableBodyWrap()
  if (skeleton) {
    skeleton.hidden = false
    shimmer(skeleton, true)
  }
  if (bodyWrap) {
    finishAnimations(bodyWrap)
    bodyWrap.hidden = true
  }
  const json = await fetchEventsJson(buildParams())
  if (skeleton) {
    shimmer(skeleton, false)
    skeleton.hidden = true
  }
  if (bodyWrap) bodyWrap.hidden = false
  if (!json || !json.rows) {
    toast({ kind: 'error', text: 'Could not load events. Try again.' })
    // The fetch failed: the pre-existing rows are still in the DOM untouched, but force their
    // visibility back regardless of whatever the boot stagger-in animation was interrupted into
    // (finishAnimations() above is the primary defense; this is the guaranteed fallback) -- a
    // failed refresh must never look like an empty table when real rows are still there.
    const tbody = tbodyEl()
    if (tbody) forceRowsVisible(Array.from(tbody.children) as HTMLElement[])
    return
  }
  const rows = json.rows.map(normalizeEventListRow)
  if (bodyWrap) {
    bodyWrap.innerHTML = renderEventsTableBody(rows, Date.now())
    const tbody = tbodyEl()
    if (tbody) {
      const trs = Array.from(tbody.children) as HTMLElement[]
      staggerIn(trs)
      wireRowClicks(trs)
    }
  }
  state.cursor = json.nextCursor ?? null
  state.latestTs = rows.reduce((max, r) => Math.max(max, r.ts), state.latestTs)
  updateKindChips(json.counts ?? {})
  updateLoadOlderVisibility()
  updateExportLinks()
  const emptyEl = filteredEmptyEl()
  if (emptyEl) emptyEl.hidden = true
}

function updateLoadOlderVisibility(): void {
  const btn = loadOlderBtn()
  if (btn) btn.hidden = !state.cursor
}

function wireLoadOlder(): void {
  const btn = loadOlderBtn()
  if (!btn) return
  press(btn)
  btn.addEventListener('click', () => void loadOlder())
}

async function loadOlder(): Promise<void> {
  if (!state.cursor) return
  const btn = loadOlderBtn()
  const originalLabel = btn?.textContent ?? 'Load older'
  if (btn) {
    btn.disabled = true
    btn.textContent = 'Loading…'
  }
  const json = await fetchEventsJson(buildParams({ cursor: state.cursor }))
  if (btn) {
    btn.disabled = false
    btn.textContent = originalLabel
  }
  if (!json || !json.rows) {
    toast({ kind: 'error', text: 'Could not load older events.' })
    return
  }
  const rows = json.rows.map(normalizeEventListRow)
  const tbody = tbodyEl()
  if (tbody && rows.length) {
    const before = tbody.children.length
    tbody.insertAdjacentHTML('beforeend', renderEventRowsHtml(rows, Date.now()))
    const added = (Array.from(tbody.children) as HTMLElement[]).slice(before)
    staggerIn(added)
    wireRowClicks(added)
  } else if (rows.length) {
    // The table was showing the empty state (no rows to page from in the first place): render
    // straight into the wrap the same way hydrate() does.
    const bodyWrap = tableBodyWrap()
    if (bodyWrap) {
      bodyWrap.innerHTML = renderEventsTableBody(rows, Date.now())
      const freshTbody = tbodyEl()
      if (freshTbody) {
        const trs = Array.from(freshTbody.children) as HTMLElement[]
        staggerIn(trs)
        wireRowClicks(trs)
      }
    }
  }
  state.cursor = json.nextCursor ?? null
  updateLoadOlderVisibility()
}

function prependRows(rows: EventRowLike[]): void {
  const tbody = tbodyEl()
  if (!tbody) {
    const bodyWrap = tableBodyWrap()
    if (bodyWrap && rows.length) {
      bodyWrap.innerHTML = renderEventsTableBody(rows, Date.now())
      const freshTbody = tbodyEl()
      if (freshTbody) {
        const trs = Array.from(freshTbody.children) as HTMLElement[]
        staggerIn(trs)
        wireRowClicks(trs)
      }
    }
    return
  }
  if (!rows.length) return
  const html = renderEventRowsHtml(rows, Date.now())
  flip(tbody, () => {
    tbody.insertAdjacentHTML('afterbegin', html)
  })
  const newRows = (Array.from(tbody.children) as HTMLElement[]).slice(0, rows.length)
  newRows.forEach((row) => {
    flash(row)
    row.addEventListener('click', () => openDrawerForRow(row))
    pressRow(row)
  })
  const emptyEl = filteredEmptyEl()
  if (emptyEl) emptyEl.hidden = true
}

// -------------------------------------------------------------------------------------------
// Listening.
// -------------------------------------------------------------------------------------------

function setListeningVisual(on: boolean): void {
  const toggle = q<HTMLButtonElement>('[data-listen-toggle]')
  const dot = q<HTMLElement>('.ev-listen-dot')
  const label = q<HTMLElement>('[data-listen-label]')
  if (toggle) toggle.setAttribute('aria-pressed', String(on))
  if (toggle) toggle.classList.toggle('is-paused', !on)
  if (label) label.textContent = on ? 'Listening' : 'Paused'
  if (dot) {
    if (on) beacon(dot)
    else dot.style.animation = ''
  }
}

function stopListening(): void {
  if (listenTimer != null) {
    clearInterval(listenTimer)
    listenTimer = null
  }
}

function startListening(): void {
  stopListening()
  listenTimer = setInterval(() => void pollListening(), 5000)
}

async function pollListening(): Promise<void> {
  if (!state.listening || !sectionEl || sectionEl.hidden) return
  const since = state.latestTs + 1
  const until = Date.now()
  if (since >= until) return
  const json = await fetchEventsJson(buildParams({ since, until }))
  if (!json || !json.rows || !json.rows.length) return
  const rows = json.rows.map(normalizeEventListRow).sort((a, b) => a.ts - b.ts)
  prependRows(rows)
  state.latestTs = rows.reduce((max, r) => Math.max(max, r.ts), state.latestTs)
}

function wireListenToggle(): void {
  const toggle = q<HTMLButtonElement>('[data-listen-toggle]')
  if (!toggle) return
  press(toggle)
  toggle.addEventListener('click', () => {
    state.listening = !state.listening
    setListeningVisual(state.listening)
    if (state.listening) startListening()
    else stopListening()
  })
}

// -------------------------------------------------------------------------------------------
// Menus (Range, Filters, View) -- one open/close pattern, scale + opacity from CSS.
// -------------------------------------------------------------------------------------------

function closeAllMenus(): void {
  document.querySelectorAll<HTMLElement>('.ev-menu-panel:not([hidden])').forEach((panel) => {
    panel.hidden = true
    panel.setAttribute('aria-hidden', 'true')
  })
  document.querySelectorAll<HTMLElement>('[data-menu-toggle][aria-expanded="true"], [data-view-toggle][aria-expanded="true"]').forEach((btn) => {
    btn.setAttribute('aria-expanded', 'false')
  })
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

function wireRangeMenu(): void {
  qa<HTMLButtonElement>('[data-range-option]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.range = btn.getAttribute('data-range-option') || '24h'
      const toggle = q<HTMLButtonElement>('[data-menu-toggle="range"] span')
      if (toggle) toggle.textContent = btn.textContent
      qa<HTMLButtonElement>('[data-range-option]').forEach((b) => b.setAttribute('aria-checked', String(b === btn)))
      closeAllMenus()
      void hydrate()
    })
  })
}

/** The toolbar's Search field and the Filters menu's Profile field both write the one `state.q`
 *  (the server-side substring match already covers hostname/email/device/kind/country, see
 *  operator/src/routes/events.ts's `eventMatchesSeat`) -- keeping the field the operator is not
 *  typing in mirrored to the same value means neither one silently overwrites the other. */
function syncSearchInputs(value: string): void {
  const search = q<HTMLInputElement>('#ev-search')
  const profile = q<HTMLInputElement>('[data-filter="profile"]')
  if (search && search.value !== value) search.value = value
  if (profile && profile.value !== value) profile.value = value
}

function readNonSearchFilters(): void {
  const os = q<HTMLElement>('[data-os-filter] .segmented-item.on')
  state.os = os?.getAttribute('data-segmented') || ''
  state.country = (q<HTMLInputElement>('[data-filter="country"]')?.value || '').trim().toUpperCase()
  state.version = (q<HTMLInputElement>('[data-filter="version"]')?.value || '').trim()
}

function wireFiltersMenu(): void {
  qa<HTMLElement>('[data-os-filter] .segmented-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      qa<HTMLElement>('[data-os-filter] .segmented-item').forEach((b) => b.classList.toggle('on', b === btn))
      readNonSearchFilters()
      void hydrate()
    })
  })
  const country = q<HTMLInputElement>('[data-filter="country"]')
  const version = q<HTMLInputElement>('[data-filter="version"]')
  const profile = q<HTMLInputElement>('[data-filter="profile"]')
  ;[country, version].forEach((input) => {
    if (!input) return
    input.addEventListener('change', () => {
      readNonSearchFilters()
      void hydrate()
    })
  })
  if (profile) {
    profile.addEventListener('input', () => {
      if (searchDebounce) clearTimeout(searchDebounce)
      searchDebounce = setTimeout(() => {
        state.q = profile.value.trim()
        syncSearchInputs(state.q)
        void hydrate()
      }, 300)
    })
  }
  const clear = q<HTMLButtonElement>('[data-filters-clear]')
  if (clear) {
    clear.addEventListener('click', () => {
      if (country) country.value = ''
      if (version) version.value = ''
      qa<HTMLElement>('[data-os-filter] .segmented-item').forEach((b, i) => b.classList.toggle('on', i === 0))
      state.os = ''
      state.country = ''
      state.version = ''
      state.q = ''
      syncSearchInputs('')
      closeAllMenus()
      void hydrate()
    })
  }
}

// -------------------------------------------------------------------------------------------
// View menu (column visibility), persisted per-viewer.
// -------------------------------------------------------------------------------------------

const COLUMNS_STORAGE_KEY = 'metis-events-hidden-columns'

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
  const shell = q<HTMLElement>('[data-ev-table-wrap]')
  const hidden = EVENT_OPTIONAL_COLUMNS.filter((key: EventOptionalColumn) => {
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
  EVENT_OPTIONAL_COLUMNS.forEach((key: EventOptionalColumn) => {
    const checkbox = q<HTMLInputElement>(`[data-col-toggle="${key}"]`)
    if (checkbox) checkbox.checked = !hidden.includes(key)
  })
  const shell = q<HTMLElement>('[data-ev-table-wrap]')
  if (shell) shell.setAttribute('data-hide-cols', hidden.join(' '))
}

function wireViewMenu(): void {
  qa<HTMLInputElement>('[data-col-toggle]').forEach((checkbox) => {
    checkbox.addEventListener('change', syncColumnAttr)
  })
}

// -------------------------------------------------------------------------------------------
// Search.
// -------------------------------------------------------------------------------------------

function wireSearch(): void {
  const input = q<HTMLInputElement>('#ev-search')
  if (!input) return
  const run = (): void => {
    if (searchDebounce) clearTimeout(searchDebounce)
    searchDebounce = setTimeout(() => {
      state.q = input.value.trim()
      syncSearchInputs(state.q)
      void hydrate()
    }, 300)
  }
  input.addEventListener('input', run)
  input.addEventListener('search', run)
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      if (searchDebounce) clearTimeout(searchDebounce)
      state.q = input.value.trim()
      syncSearchInputs(state.q)
      void hydrate()
    }
  })
}

// -------------------------------------------------------------------------------------------
// Page tabs (Events / Asks / CRM).
// -------------------------------------------------------------------------------------------

function wirePageTabs(): void {
  const tabs = qa<HTMLButtonElement>('[data-page-tab]')
  const eventsPane = q<HTMLElement>('[data-ev-pane="events"]')
  const crmPane = q<HTMLElement>('[data-ev-pane="crm"]')
  tabs.forEach((tab) => {
    press(tab)
    tab.addEventListener('click', () => {
      const id = tab.getAttribute('data-page-tab') || 'events'
      tabs.forEach((t) => {
        const on = t === tab
        t.classList.toggle('on', on)
        t.setAttribute('aria-selected', String(on))
      })
      if (id === 'crm') {
        // Same hazard finishAnimations() guards against in hydrate() (see its own doc comment):
        // on first mount, page boot's bindMotion(document.body) call (operator/client/main.ts)
        // is still mid-flight animating the SSR events rows' opacity 0->1 via WAAPI for up to
        // ~1.1s, and a fast click straight to the CRM tab hides this pane while that is still
        // running. Verified with Playwright that clicking through Events -> CRM -> Events inside
        // that window leaves every row's opacity back at 1 (not frozen) with this guard in place;
        // finishing each animation first jumps it to its resting, visible state before the pane
        // disappears, so nothing this page owns is left in flight to interrupt when the ancestor
        // goes unrendered.
        if (eventsPane) {
          finishAnimations(eventsPane)
          eventsPane.hidden = true
        }
        if (crmPane) {
          crmPane.hidden = false
          // Mirror-image hazard to the one this branch's own doc comment (above) explains for
          // the events pane: page boot's bindMotion(document.body) call (operator/client/main.ts)
          // starts staggerIn()'s WAAPI opacity animation on every [data-stagger] element site-wide
          // before wirePageTabs() ever runs, including the CRM funnel rows and sends-table rows
          // that live inside this pane while it is still `hidden` (display:none). An animation
          // whose ancestor is display:none when it would run/settle never reaches its resting
          // state, so on a fresh page load those rows are stuck at opacity 0 forever the first
          // time this tab is revealed. Finishing any in-flight animation now jumps them straight
          // to fully visible before the pane is shown, so nothing is left stuck mid-flight.
          finishAnimations(crmPane)
        }
        return
      }
      if (eventsPane) eventsPane.hidden = false
      if (crmPane) {
        finishAnimations(crmPane)
        crmPane.hidden = true
      }
      void selectKind(id === 'asks' ? 'ask' : 'all')
    })
  })
}

// -------------------------------------------------------------------------------------------
// CRM tab: status chips + Retry (never auto-sends -- one click, one request, no timer).
// -------------------------------------------------------------------------------------------

function wireCrmStatusChips(): void {
  const chips = qa<HTMLButtonElement>('[data-crm-status-chip]')
  chips.forEach((chip) => {
    press(chip)
    chip.addEventListener('click', () => {
      const status = chip.getAttribute('data-crm-status-chip') || 'all'
      chips.forEach((c) => {
        const on = c === chip
        c.classList.toggle('is-active', on)
        c.setAttribute('aria-pressed', String(on))
      })
      pop(chip)
      qa<HTMLElement>('[data-crm-row]').forEach((row) => {
        row.hidden = status !== 'all' && row.getAttribute('data-crm-status') !== status
      })
    })
  })
}

async function runCrmRetry(button: HTMLButtonElement): Promise<void> {
  const id = button.getAttribute('data-crm-retry')
  if (!id) return
  button.disabled = true
  const json = await api(`/v1/admin/crm/${encodeURIComponent(id)}/retry`, {})
  if (json && json.ok) {
    toast({ kind: 'ok', text: 'Retry queued.' })
    const cell = button.parentElement
    if (cell) cell.innerHTML = '<span class="muted">Retry asked</span>'
    return
  }
  button.disabled = false
  toast({ kind: 'error', text: (json && json.error) || 'Could not queue the retry.' })
}

function wireCrmRetry(): void {
  qa<HTMLButtonElement>('[data-crm-retry]').forEach((btn) => {
    press(btn)
    btn.addEventListener('click', () => void runCrmRetry(btn))
  })
}

// -------------------------------------------------------------------------------------------
// Dashboard cache (for the drawer's license lookup only -- DashboardPayload.events itself is not
// reused once the table has hydrated from the richer events.json).
// -------------------------------------------------------------------------------------------

async function ensureDashboard(initial: DashboardPayload | null): Promise<DashboardPayload | null> {
  if (initial) {
    cachedDashboard = initial
    return initial
  }
  if (cachedDashboard) return cachedDashboard
  const json = (await api('/v1/admin/dashboard')) as (DashboardPayload & { ok?: boolean }) | null
  if (json && (json as { ok?: boolean }).ok !== false) {
    cachedDashboard = json as DashboardPayload
    return cachedDashboard
  }
  return null
}

// -------------------------------------------------------------------------------------------
// Ask trace cache.
// -------------------------------------------------------------------------------------------

interface AskListResponse {
  ok?: boolean
  asks?: AskTraceLite[]
}

async function getAskCache(): Promise<AskTraceLite[]> {
  const now = Date.now()
  if (askCache.length && now - askCacheAt < ASK_CACHE_TTL_MS) return askCache
  const json = (await api('/v1/admin/asks')) as AskListResponse
  if (json && json.ok !== false && Array.isArray(json.asks)) {
    askCache = json.asks
    askCacheAt = now
  }
  return askCache
}

// -------------------------------------------------------------------------------------------
// Drawer.
// -------------------------------------------------------------------------------------------

function fieldHtml(label: string, value: string, opts?: { wide?: boolean; extraClass?: string }): string {
  const classes = ['seat-field', opts?.wide ? 'seat-overlay-wide' : '', opts?.extraClass || ''].filter(Boolean).join(' ')
  return `<div class="${classes}"><span class="lbl">${esc(label)}</span><span class="val">${esc(value)}</span></div>`
}

function drawerEl(): HTMLElement | null {
  return document.getElementById('event-drawer')
}
function backdropEl(): HTMLElement | null {
  return document.querySelector('[data-drawer-backdrop="event-drawer"]')
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

async function copyText(text: string, button: HTMLButtonElement): Promise<void> {
  const original = button.textContent || 'Copy'
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text)
      button.textContent = 'Copied'
      setTimeout(() => {
        button.textContent = original
      }, 1500)
      return
    }
  } catch {
    /* fall through to the selectable fallback */
  }
  button.textContent = 'Select the id above'
}

function fillDrawerLinks(row: EventRowLike, container: HTMLElement): void {
  const parts: string[] = []
  if (row.deviceId) {
    parts.push(
      `<div class="ev-drawer-link-row"><span class="lbl">Seat</span><code class="ev-device-id">${esc(row.deviceId)}</code><button type="button" class="btn" data-copy-device>Copy</button><a class="btn" href="#sessions">Open in Sessions</a></div>`
    )
  } else {
    parts.push('<div class="ev-drawer-link-row"><span class="lbl">Seat</span><span class="val muted">Not reported</span></div>')
  }
  const licenses = cachedDashboard?.licenses.rows ?? []
  const license = row.deviceId
    ? licenses.find((r) => r.device === row.deviceId || r.device.startsWith(row.deviceId as string) || (row.deviceId as string).startsWith(r.device))
    : undefined
  if (license && license.license) {
    parts.push(
      `<div class="ev-drawer-link-row"><span class="lbl">License</span><span class="val">${esc(license.license)}</span><a class="btn" href="#licenses">Open in Licenses</a></div>`
    )
  } else {
    parts.push('<div class="ev-drawer-link-row"><span class="lbl">License</span><span class="val muted">Not licensed</span></div>')
  }
  container.innerHTML = parts.join('')
  const copyBtn = container.querySelector<HTMLButtonElement>('[data-copy-device]')
  if (copyBtn && row.deviceId) {
    copyBtn.addEventListener('click', () => void copyText(row.deviceId as string, copyBtn))
    press(copyBtn)
  }
}

async function fillDrawer(row: EventRowLike): Promise<void> {
  const drawer = drawerEl()
  const body = drawer?.querySelector<HTMLElement>('[data-drawer-body]')
  const title = drawer?.querySelector<HTMLElement>('[data-drawer-title]')
  const linksHost = drawer?.querySelector<HTMLElement>('[data-drawer-links]')
  if (!drawer || !body) return
  if (title) title.textContent = row.hostname || row.email || row.kind

  const generalFields: { label: string; value: string; wide?: boolean }[] = [
    { label: 'Kind', value: row.kind },
    { label: 'When', value: `${new Date(row.ts).toISOString().replace('T', ' ').slice(0, 19)} UTC` },
    { label: 'Hostname', value: row.hostname || 'Not reported' },
    { label: 'Email', value: row.email || 'Not reported' },
    { label: 'Country', value: row.country || 'Not reported' },
    { label: 'City', value: row.city || 'Not reported' },
    { label: 'OS', value: row.os || 'Not reported' },
    { label: 'Client version', value: row.appVersion || 'Not reported' },
    { label: 'Detail', value: row.detail || 'Not reported', wide: true }
  ]
  body.innerHTML = generalFields.map((f) => fieldHtml(f.label, f.value, { wide: f.wide })).join('')

  if (linksHost) fillDrawerLinks(row, linksHost)

  if (row.kind === 'ask') {
    const asks = await getAskCache()
    const trace = findAskTrace({ ts: row.ts, deviceId: row.deviceId }, asks)
    const traceWrap = document.createElement('div')
    traceWrap.className = 'seat-overlay-wide'
    if (!trace) {
      traceWrap.innerHTML =
        '<p class="ev-trace-title">Ask trace</p><p class="muted">Not available for this row yet. It appears once the ask is within the most recent 100.</p>'
      body.appendChild(traceWrap)
      return
    }
    const traceFields = formatAskTrace(trace)
    traceWrap.innerHTML =
      '<p class="ev-trace-title">Ask trace</p>' +
      traceFields.map((f) => fieldHtml(f.label, f.value, { extraClass: 'ev-trace-field' })).join('')
    body.appendChild(traceWrap)
    const traceEls = Array.from(traceWrap.querySelectorAll<HTMLElement>('.ev-trace-field'))
    sequence(
      traceEls.map((el) => ({
        run: () => el.classList.add('show'),
        delayMs: 30
      }))
    )
  }
}

function openDrawerForRow(row: HTMLElement): void {
  const raw = row.getAttribute('data-row')
  if (!raw) return
  let parsed: EventRowLike
  try {
    parsed = JSON.parse(raw) as EventRowLike
  } catch {
    return
  }
  openDrawer()
  void fillDrawer(parsed)
}

function wireDrawerChrome(): void {
  const closeBtn = document.getElementById('event-drawer-close')
  if (closeBtn) closeBtn.addEventListener('click', closeDrawer)
  const backdrop = backdropEl()
  if (backdrop) backdrop.addEventListener('click', closeDrawer)
}

// -------------------------------------------------------------------------------------------
// Visibility: hydrate + (re)start Listening when the events section becomes visible; stop the
// poll while it is hidden so a Listening tab does not keep hitting the Worker in the background.
// -------------------------------------------------------------------------------------------

function onSectionVisible(): void {
  void hydrate()
  if (state.listening) startListening()
}

function wireVisibility(section: HTMLElement): void {
  if (visibilityObserver) visibilityObserver.disconnect()
  visibilityObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type !== 'attributes' || mutation.attributeName !== 'hidden') continue
      if (section.hidden) stopListening()
      else onSectionVisible()
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
  setListeningVisual(state.listening)
  wireListenToggle()
  wireMenus()
  wireRangeMenu()
  wireFiltersMenu()
  wireViewMenu()
  initColumnVisibility()
  wireSearch()
  wireLoadOlder()
  wirePageTabs()
  wireCrmStatusChips()
  wireCrmRetry()
  wireDrawerChrome()
  wireKindChipButtons(section)
  wireRowClicks(qa<HTMLElement>('#ev-table tbody tr'))
  updateExportLinks()
}

export function initEvents(section: HTMLElement, data: DashboardPayload | null): void {
  stopListening()
  if (visibilityObserver) {
    visibilityObserver.disconnect()
    visibilityObserver = null
  }
  state = defaultState()
  wireSection(section)
  void ensureDashboard(data)
  wireVisibility(section)
}
