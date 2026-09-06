/**
 * Sessions page client (plan 6.5 + 3.5b "Sessions" motion row). First paint (and every
 * `rerender('sessions')`, operator/client/main.ts) ships the toolbar and a skeleton table: the
 * shared `/v1/admin/dashboard` payload has no session-grain rows, so this page always hydrates
 * itself from the real `GET /v1/admin/sessions.json` (plan D2: "the client fetches the JSON route
 * for the active page"). Row click opens a drawer built from `GET /v1/admin/sessions/:id.json`
 * (the session's own timeline and asks) plus `GET /v1/admin/seats/:id/timeline.json` (task B4:
 * license state, group, and the connectors this seat received). Every mutation (Approve, Revoke)
 * goes through `api()` and reports through `toast()`; this page never reloads the whole document.
 */
import type { DashboardPayload } from '../../src/dashboard'
import { emptyState } from '../../src/render'
import type { SessionListRow } from '../../src/routes/sessions'
import {
  formatSessionDuration,
  licenseStateBadge,
  renderSessionDrawerBody,
  renderSessionsTableBody,
  sessionDrawerLoadingBody,
  type SessionsPageData,
  type SeatTimelineResponse,
  type SessionDetailResponse
} from '../../src/render/pages/sessions'
import { api } from '../api'
import { bindMotion } from '../motion-bind'
import { drawPath, pop, press, sequence, shimmer, slideIn } from '../motion'
import { toast } from '../toasts'

const RANGE_MS: Record<string, number> = { '24h': 24 * 60 * 60 * 1000, '7d': 7 * 24 * 60 * 60 * 1000, '30d': 30 * 24 * 60 * 60 * 1000 }

interface SessionsFilterState {
  q: string
  range: string
  live: string
  tier: string
  os: string
  country: string
  version: string
}

const state: SessionsFilterState = { q: '', range: '24h', live: '', tier: '', os: '', country: '', version: '' }
const hiddenCols = new Set<number>()

let globalListenersWired = false
let tickTimer: ReturnType<typeof setInterval> | null = null
let requestSeq = 0

function pageSection(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-page="sessions"]')
}

function osFamily(os: string | null | undefined): 'darwin' | 'win' | 'linux' | '' {
  const raw = (os || '').toLowerCase()
  if (raw === 'darwin' || raw === 'macos' || raw === 'mac') return 'darwin'
  if (raw === 'win' || raw === 'win32' || raw === 'windows') return 'win'
  if (raw === 'linux') return 'linux'
  return ''
}

function applyClientFilters(rows: SessionListRow[]): SessionListRow[] {
  return rows.filter((r) => {
    if (state.live === 'live' && !r.live) return false
    if (state.live === 'idle' && r.live) return false
    if (state.tier && r.tier !== state.tier) return false
    if (state.os && osFamily(r.os) !== state.os) return false
    if (state.version && !(r.appVersion || '').toLowerCase().includes(state.version.toLowerCase())) return false
    return true
  })
}

function buildServerParams(): URLSearchParams {
  const params = new URLSearchParams()
  params.set('range', state.range)
  params.set('limit', '200')
  if (state.q) params.set('q', state.q)
  if (state.country) params.set('country', state.country)
  return params
}

function updateExportLinks(section: HTMLElement): void {
  const now = Date.now()
  const windowMs = RANGE_MS[state.range] ?? RANGE_MS['24h']
  const since = now - windowMs
  const common = new URLSearchParams()
  common.set('since', String(since))
  common.set('until', String(now))
  if (state.q) common.set('q', state.q)
  if (state.country) common.set('country', state.country)
  section.querySelectorAll<HTMLAnchorElement>('[data-export-link]').forEach((a) => {
    const url = new URL(a.getAttribute('href') || '', window.location.origin)
    for (const [key, value] of common.entries()) url.searchParams.set(key, value)
    a.setAttribute('href', url.pathname + '?' + url.searchParams.toString())
  })
}

function applyColumnVisibility(section: HTMLElement): void {
  const table = section.querySelector<HTMLElement>('#sessions-table')
  if (!table) return
  table.setAttribute('data-hide-col', Array.from(hiddenCols).join(' '))
}

function wireRow(row: HTMLElement): void {
  press(row)
  const open = (): void => {
    const sessionId = row.getAttribute('data-session-row')
    const deviceId = row.getAttribute('data-device')
    if (sessionId && deviceId) openDrawer(sessionId, deviceId)
  }
  row.addEventListener('click', open)
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      open()
    }
  })
}

function startDurationTicker(): void {
  if (tickTimer) clearInterval(tickTimer)
  tickTimer = setInterval(() => {
    const now = Date.now()
    document.querySelectorAll<HTMLElement>('[data-live-duration]').forEach((el) => {
      const startedAt = Number(el.getAttribute('data-started-at'))
      if (!Number.isFinite(startedAt)) return
      el.textContent = formatSessionDuration(now - startedAt)
    })
  }, 1000)
}

let lastFetchedRows: SessionListRow[] = []

/** Re-renders the table from the last server fetch with the client-only filters (live, tier, os,
 *  version -- plan 6.5's `/v1/admin/sessions.json` has no server-side support for these, and the
 *  raw `os` values are inconsistent enough, plan 3.7b, to make a fuzzy client match safer than a
 *  brittle exact server one) applied fresh. Never re-fetches: a filter that only changes what is
 *  shown from data already in hand should never wait on the network (plan 3.7b law 9, "fast"). */
function renderRows(): void {
  const section = pageSection()
  if (!section) return
  const wrap = section.querySelector<HTMLElement>('[data-sessions-table-wrap]')
  const root = section.querySelector<HTMLElement>('[data-sessions-root]')
  if (!wrap) return
  const rows = applyClientFilters(lastFetchedRows)
  wrap.innerHTML = renderSessionsTableBody(rows, Date.now())
  if (root) root.setAttribute('data-loaded', 'true')
  bindMotion(wrap)
  applyColumnVisibility(section)
  wrap.querySelectorAll<HTMLElement>('[data-session-row]').forEach(wireRow)
}

/** A failed `api()` call's reason plus, when the Worker sent one, the request id to reference when
 *  reporting it (plan 3.7 item 10 / 3.7b law 8: "inline errors with the request id"). `api()` never
 *  throws (network failures already come back as `{ ok:false, error:'network failed' }`), so this
 *  only ever formats what a JSON response actually carried, never a fabricated id. */
function errorDescription(res: { error?: string; requestId?: string } | null | undefined, fallback: string): string {
  const reason = (res && res.error) || fallback
  const requestId = res && typeof res.requestId === 'string' ? res.requestId : ''
  return requestId ? `${reason} Request id: ${requestId}` : reason
}

/** Fetches the server-filtered set (range, country, search) and re-renders. Called on range
 *  change, search input (debounced) and country input (debounced) -- never on the client-only
 *  filters, which call `renderRows()` directly instead. */
async function loadSessions(): Promise<void> {
  const section = pageSection()
  if (!section) return
  const wrap = section.querySelector<HTMLElement>('[data-sessions-table-wrap]')
  if (!wrap) return
  const mySeq = ++requestSeq
  shimmer(wrap, true) // plan 3.5b "same table motion as Events": skeleton shimmer while fetching
  const res = await api('/v1/admin/sessions.json?' + buildServerParams().toString())
  if (mySeq !== requestSeq) return // a newer filter change already superseded this fetch
  shimmer(wrap, false)
  if (!res || res.ok === false) {
    wrap.innerHTML = emptyState({
      title: 'Could not load sessions.',
      description: errorDescription(res, 'Reopen this page to try again.')
    })
    return
  }
  lastFetchedRows = (res.rows || []) as SessionListRow[]
  renderRows()
  updateExportLinks(section)
}

const DEBOUNCE_MS = 250
let debounceTimer: ReturnType<typeof setTimeout> | null = null

function debouncedLoad(): void {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => void loadSessions(), DEBOUNCE_MS)
}

function openPanel(panel: HTMLElement, toggle: HTMLElement): void {
  closeAllPanels()
  panel.hidden = false
  toggle.setAttribute('aria-expanded', 'true')
  requestAnimationFrame(() => panel.classList.add('is-open'))
}

function closeAllPanels(): void {
  document.querySelectorAll<HTMLElement>('.sessions-panel.is-open').forEach((panel) => {
    panel.classList.remove('is-open')
    const toggle = panel.parentElement?.querySelector<HTMLElement>('[data-filters-toggle], [data-view-toggle]')
    toggle?.setAttribute('aria-expanded', 'false')
    setTimeout(() => {
      panel.hidden = true
    }, 180)
  })
}

function wireToolbar(section: HTMLElement): void {
  // A page-specific id (not the legacy "sessions-search"): operator/client/filters.ts's
  // initSessionsFilter() still binds that id globally (plan P0.4 leftover, see this file's
  // header note); a distinct id here means this page never races that legacy client-only filter
  // against its own server-backed search.
  const search = section.querySelector<HTMLInputElement>('#sessions-toolbar-search')
  if (search) {
    search.value = state.q
    search.addEventListener('input', () => {
      state.q = search.value.trim()
      debouncedLoad()
    })
  }

  const range = section.querySelector<HTMLSelectElement>('[data-sessions-range]')
  if (range) {
    range.value = state.range
    range.addEventListener('change', () => {
      state.range = range.value
      void loadSessions()
    })
  }

  const filtersToggle = section.querySelector<HTMLElement>('[data-filters-toggle]')
  const filtersPanel = section.querySelector<HTMLElement>('[data-filters-panel]')
  if (filtersToggle && filtersPanel) {
    filtersPanel.querySelector<HTMLSelectElement>('[data-filter="live"]')!.value = state.live
    filtersPanel.querySelector<HTMLSelectElement>('[data-filter="tier"]')!.value = state.tier
    filtersPanel.querySelector<HTMLSelectElement>('[data-filter="os"]')!.value = state.os
    filtersPanel.querySelector<HTMLInputElement>('[data-filter="country"]')!.value = state.country
    filtersPanel.querySelector<HTMLInputElement>('[data-filter="version"]')!.value = state.version
    filtersToggle.addEventListener('click', (e) => {
      e.stopPropagation()
      if (filtersPanel.classList.contains('is-open')) closeAllPanels()
      else openPanel(filtersPanel, filtersToggle)
    })
    filtersPanel.addEventListener('click', (e) => e.stopPropagation())
    filtersPanel.querySelectorAll<HTMLSelectElement | HTMLInputElement>('[data-filter]').forEach((el) => {
      const key = el.getAttribute('data-filter') as keyof SessionsFilterState
      const isServerFilter = key === 'country'
      const handler = (): void => {
        state[key] = el.value.trim()
        if (isServerFilter) debouncedLoad()
        else renderRows()
      }
      el.addEventListener(isServerFilter || key === 'version' ? 'input' : 'change', handler)
    })
  }

  const viewToggle = section.querySelector<HTMLElement>('[data-view-toggle]')
  const viewPanel = section.querySelector<HTMLElement>('[data-view-panel]')
  if (viewToggle && viewPanel) {
    viewPanel.querySelectorAll<HTMLInputElement>('[data-col-toggle]').forEach((cb) => {
      const idx = Number(cb.getAttribute('data-col-toggle'))
      cb.checked = !hiddenCols.has(idx)
      cb.addEventListener('change', () => {
        if (cb.checked) hiddenCols.delete(idx)
        else hiddenCols.add(idx)
        applyColumnVisibility(section)
      })
    })
    viewToggle.addEventListener('click', (e) => {
      e.stopPropagation()
      if (viewPanel.classList.contains('is-open')) closeAllPanels()
      else openPanel(viewPanel, viewToggle)
    })
    viewPanel.addEventListener('click', (e) => e.stopPropagation())
  }

  updateExportLinks(section)
}

// ---------------------------------------------------------------------------------------------
// Drawer
// ---------------------------------------------------------------------------------------------

function drawerEl(): HTMLElement | null {
  return document.getElementById('session-drawer')
}

function closeDrawer(): void {
  const drawer = drawerEl()
  if (drawer) drawer.hidden = true
}

function mountTimelineLine(container: HTMLElement): void {
  const svg = container.querySelector<SVGSVGElement>('[data-timeline-svg]')
  const path = container.querySelector<SVGPathElement>('[data-timeline-path]')
  const list = container.querySelector<HTMLElement>('[data-timeline-list]')
  if (!svg || !path || !list) return
  const items = Array.from(list.children).filter((el): el is HTMLElement => el instanceof HTMLElement)
  if (!items.length) return
  const height = Math.max(1, Math.round(list.getBoundingClientRect().height))
  svg.setAttribute('height', String(height))
  svg.setAttribute('viewBox', `0 0 2 ${height}`)
  path.setAttribute('d', `M1,0 L1,${height}`)
  drawPath(path, 500)
  sequence(items.map((el, i) => ({ run: () => pop(el), delayMs: i === 0 ? 150 : 40 })))
}

/** Two-click destructive confirm (plan 3.7b law 7: "confirm only destructive actions"), never a
 *  native `window.confirm`: the button becomes its own confirmation, auto-reverting after 4s so an
 *  armed Revoke button never sits waiting indefinitely. */
function wireConfirmButton(el: HTMLElement, onConfirm: () => void | Promise<void>): void {
  const original = el.textContent || 'Revoke'
  let confirming = false
  let revert: ReturnType<typeof setTimeout> | null = null
  el.addEventListener('click', () => {
    if (!confirming) {
      confirming = true
      el.textContent = 'Confirm revoke'
      el.classList.add('is-confirming')
      revert = setTimeout(() => {
        confirming = false
        el.textContent = original
        el.classList.remove('is-confirming')
      }, 4000)
      return
    }
    if (revert) clearTimeout(revert)
    confirming = false
    el.textContent = original
    el.classList.remove('is-confirming')
    void onConfirm()
  })
}

async function copyDeviceId(deviceId: string): Promise<void> {
  try {
    if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('no clipboard api')
    await navigator.clipboard.writeText(deviceId)
    toast({ kind: 'ok', text: 'Device id copied.' })
  } catch {
    toast({ kind: 'info', text: deviceId })
  }
}

function wireDrawerActions(body: HTMLElement): void {
  body.querySelectorAll<HTMLElement>('[data-copy-device]').forEach((btn) => {
    btn.addEventListener('click', () => {
      void copyDeviceId(btn.getAttribute('data-copy-device') || '')
    })
  })

  const approveBtn = body.querySelector<HTMLElement>('[data-session-approve]')
  if (approveBtn) {
    press(approveBtn)
    approveBtn.addEventListener('click', async () => {
      const deviceId = approveBtn.getAttribute('data-session-approve') || ''
      if (!deviceId) return
      const res = await api('/v1/admin/licenses/' + encodeURIComponent(deviceId) + '/approve', {})
      if (res && res.ok) {
        toast({ kind: 'ok', text: 'Seat approved.' })
        const badge = body.querySelector<HTMLElement>('[data-license-state]')
        if (badge) badge.innerHTML = licenseStateBadge('approved')
        void loadSessions()
      } else {
        toast({ kind: 'error', text: (res && res.error) || 'Could not approve the seat.' })
      }
    })
  }

  const revokeBtn = body.querySelector<HTMLElement>('[data-session-revoke]')
  if (revokeBtn) {
    press(revokeBtn)
    wireConfirmButton(revokeBtn, async () => {
      const deviceId = revokeBtn.getAttribute('data-session-revoke') || ''
      if (!deviceId) return
      const res = await api('/v1/admin/licenses/' + encodeURIComponent(deviceId) + '/revoke', {})
      if (res && res.ok) {
        toast({ kind: 'ok', text: 'License revoked.' })
        const badge = body.querySelector<HTMLElement>('[data-license-state]')
        if (badge) badge.innerHTML = licenseStateBadge('revoked')
        void loadSessions()
      } else {
        toast({ kind: 'error', text: (res && res.error) || 'Could not revoke the license.' })
      }
    })
  }
}

async function loadDrawer(sessionId: string, deviceId: string): Promise<void> {
  const [detail, timeline] = await Promise.all([
    api('/v1/admin/sessions/' + encodeURIComponent(sessionId) + '.json'),
    api('/v1/admin/seats/' + encodeURIComponent(deviceId) + '/timeline.json?limit=50')
  ])
  const drawer = drawerEl()
  const body = drawer && drawer.querySelector<HTMLElement>('[data-drawer-body]')
  if (!drawer || !body || drawer.hidden) return // the drawer closed while these were in flight
  if (!detail || detail.ok === false) {
    body.innerHTML = emptyState({
      title: 'Could not load this session.',
      description: errorDescription(detail, 'Reopen this row to try again.')
    })
    return
  }
  const timelineOk = timeline && timeline.ok !== false ? (timeline as SeatTimelineResponse) : null
  body.innerHTML = renderSessionDrawerBody(detail as SessionDetailResponse, timelineOk, Date.now())
  bindMotion(body)
  mountTimelineLine(body)
  wireDrawerActions(body)
  startDurationTicker()
}

function openDrawer(sessionId: string, deviceId: string): void {
  const drawer = drawerEl()
  if (!drawer) return
  const title = drawer.querySelector('[data-drawer-title]')
  const body = drawer.querySelector<HTMLElement>('[data-drawer-body]')
  if (title) title.textContent = 'Session ' + sessionId.slice(0, 8)
  if (body) body.innerHTML = sessionDrawerLoadingBody()
  drawer.hidden = false
  slideIn(drawer, 'right')
  void loadDrawer(sessionId, deviceId)
}

function wireDrawerShell(section: HTMLElement): void {
  const closeBtn = section.querySelector<HTMLElement>('#session-drawer-close')
  if (closeBtn) closeBtn.addEventListener('click', closeDrawer)
}

function wireGlobalListenersOnce(): void {
  if (globalListenersWired) return
  globalListenersWired = true
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    const drawer = drawerEl()
    if (drawer && !drawer.hidden) {
      closeDrawer()
      return
    }
    closeAllPanels()
  })
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null
    if (target && target.closest('.sessions-menu-wrap')) return
    closeAllPanels()
  })
}

export function initSessions(section: HTMLElement, data: DashboardPayload | null): void {
  wireToolbar(section)
  wireDrawerShell(section)
  wireGlobalListenersOnce()
  startDurationTicker()
  // The shared `/v1/admin/dashboard` payload never carries session rows today, so this is always
  // a fresh fetch in production; a caller that already has them (this page's own fixture, and any
  // future first-paint enhancement, plan D2) skips the redundant round trip and shows them at once.
  const preloaded = (data as SessionsPageData | null)?.sessions
  if (preloaded) {
    lastFetchedRows = preloaded
    renderRows()
    updateExportLinks(section)
  } else {
    void loadSessions()
  }
}
