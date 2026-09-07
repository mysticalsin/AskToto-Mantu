/**
 * Realtime page client init (plan 6.3, 3.7 item 2, 3.5b Realtime row). Wires:
 *  - the map's zoom/pan/hover interaction, following tooltip and first-paint land-draw +
 *    graticule-fade entrance -- all self-contained in operator/src/world/map-dom.ts's
 *    attachMapInteraction() since the world-map rebuild (not this task's file to touch);
 *  - country click -> Geo table filter with a spring highlight and a toolbar chip, toggling --
 *    a second, independent click listener on the same map root, reading the same `data-iso` /
 *    `data-country` attributes map-dom.ts's own tooltip reads, since attachMapInteraction() no
 *    longer takes a click callback;
 *  - the Geo table and Connected seats table hydration from their own JSON routes, refreshed
 *    every time the shared 5s live poll (operator/client/live.ts) dispatches `metis:live` --
 *    never a second independent timer;
 *  - the seat drawer on a connected-seat row click;
 *  - a 1s ticker for every relative time and running-duration cell in this section only.
 *
 * Called with the page's own `[data-page="realtime"]` section element and, on a rerender()
 * (operator/client/main.ts), the freshly fetched DashboardPayload; `null` at first paint (the
 * section is already server-rendered, there is no freshly fetched payload yet). Either way the
 * whole section's innerHTML was just replaced, so this always re-attaches from scratch.
 */
import type { DashboardPayload } from '../../src/dashboard'
import { emptyState, esc, relativeTime } from '../../src/render'
import { formatAvgDuration } from '../../src/realtime-geo'
import type { GeoTableRow, LiveSeatTableRow } from '../../src/routes/live'
import { renderConnectedSeatsTable, renderGeoTable } from '../../src/render/pages/realtime'
import { attachMapInteraction, type MapInteractionHandle } from '../../src/world/map-dom'
import { api, hasBackend } from '../api'
import { bindMotion } from '../motion-bind'
import { pop } from '../motion'
import { toast } from '../toasts'

const MAP_WIDTH = 1152
const MAP_HEIGHT = 576

/** Only this module's own teardown, so repeated calls (rerender, or navigating back to this
 * page) never accumulate a second window-level listener or a second ticker. */
let teardown: (() => void) | null = null

// ---------------------------------------------------------------------------------------
// Country filter: click a country (land, dot or pill) to filter the Geo table; click the same
// one again, or blank map, clears it. Combined with the free-text search below.
// ---------------------------------------------------------------------------------------

interface CountryHit {
  iso: string
  country: string
}

let activeFilterIso: string | null = null
let searchQuery = ''

function applyGeoFilters(section: HTMLElement): void {
  const rows = section.querySelectorAll<HTMLElement>('[data-geo-row]')
  rows.forEach((row) => {
    const matchesCountry = !activeFilterIso || row.getAttribute('data-iso') === activeFilterIso
    const q = row.getAttribute('data-q') || ''
    const matchesSearch = !searchQuery || q.includes(searchQuery)
    row.hidden = !(matchesCountry && matchesSearch)
  })
}

function setCountryFilter(section: HTMLElement, hit: CountryHit | null): void {
  const nextIso = hit && hit.iso !== activeFilterIso ? hit.iso : null
  activeFilterIso = nextIso
  const chipEl = section.querySelector<HTMLElement>('[data-country-chip]')
  const labelEl = section.querySelector<HTMLElement>('[data-country-chip-label]')
  if (chipEl) chipEl.hidden = !nextIso
  if (labelEl) labelEl.textContent = nextIso ? hit!.country : ''
  applyGeoFilters(section)
  if (nextIso) {
    section.querySelectorAll<HTMLElement>('[data-geo-row]:not([hidden])').forEach((row) => pop(row))
  }
}

/** Reads the same `data-iso` / `data-country` pair map-dom.ts's own tooltipHtml() reads off a
 * `.world-land`, `.rt-pin` or `.rt-pill` hit (operator/src/world/map.ts renders both on every
 * one of them) -- never a fabricated country for an element that carries neither. */
function countryHitFrom(el: Element): CountryHit | null {
  const iso = el.getAttribute('data-iso')
  const country = el.getAttribute('data-country')
  return iso && country ? { iso, country } : null
}

function attachCountryClickFilter(root: HTMLElement, section: HTMLElement): () => void {
  const onClick = (e: Event): void => {
    const target = e.target as Element | null
    const hit = target?.closest('.world-land, .rt-pin, .rt-pill')
    if (!hit) return
    setCountryFilter(section, countryHitFrom(hit))
  }
  root.addEventListener('click', onClick)
  return () => root.removeEventListener('click', onClick)
}

// ---------------------------------------------------------------------------------------
// Map interaction: zoom/pan/hover/tooltip/first-paint entrance are all internal to
// attachMapInteraction() now (operator/src/world/map-dom.ts) -- this page only adds the
// country-click filter on top of it.
// ---------------------------------------------------------------------------------------

function attachMap(section: HTMLElement): { handle: MapInteractionHandle; untrackClick: () => void } | null {
  const root = section.querySelector<HTMLElement>('[data-map-root]')
  if (!root) return null
  const handle = attachMapInteraction(root, { width: MAP_WIDTH, height: MAP_HEIGHT })
  const untrackClick = attachCountryClickFilter(root, section)
  return { handle, untrackClick }
}

// ---------------------------------------------------------------------------------------
// Geo table + Connected seats table hydration.
// ---------------------------------------------------------------------------------------

let lastSeats: LiveSeatTableRow[] = []

/** Both tables' honest state when this page is a standalone preview (see api.ts's `hasBackend`)
 *  -- no Worker is behind either JSON route here, so the fetch this function's caller would
 *  otherwise make can never succeed. Skipping it outright, in favour of this named state,
 *  replaces what a real network failure would show (a "could not load" toast on top of a
 *  skeleton stuck loading forever, since nothing ever replaces it -- task report findings 6/7)
 *  with an honest one: this route has no Worker to answer it here, not "something went wrong". */
function offlinePreviewState(routeLabel: string): string {
  return emptyState({
    title: 'Offline preview.',
    description: `No Worker is answering ${routeLabel} here -- this table fills in once the page runs against a deployed Worker.`
  })
}

function hydrateGeoTable(section: HTMLElement): void {
  const host = section.querySelector<HTMLElement>('[data-geo-table-body]')
  if (!host) return
  if (!hasBackend()) {
    host.innerHTML = offlinePreviewState('realtime/geo.json')
    return
  }
  api('/v1/admin/realtime/geo.json')
    .then((res) => {
      if (!res || res.ok === false) throw new Error(res && res.error)
      const rows = (res.rows || []) as GeoTableRow[]
      host.innerHTML = renderGeoTable(rows)
      bindMotion(host)
      applyGeoFilters(section)
    })
    .catch(() => {
      toast({ kind: 'error', text: 'Could not load the geo table. It will retry on the next refresh.' })
    })
}

function hydrateSeatsTable(section: HTMLElement, now: number): void {
  const host = section.querySelector<HTMLElement>('[data-seats-table-body]')
  if (!host) return
  if (!hasBackend()) {
    host.innerHTML = offlinePreviewState('realtime/live-seats.json')
    return
  }
  api('/v1/admin/realtime/live-seats.json')
    .then((res) => {
      if (!res || res.ok === false) throw new Error(res && res.error)
      const rows = (res.rows || []) as LiveSeatTableRow[]
      lastSeats = rows
      host.innerHTML = renderConnectedSeatsTable(rows, now)
      bindMotion(host)
    })
    .catch(() => {
      toast({ kind: 'error', text: 'Could not load the connected seats. It will retry on the next refresh.' })
    })
}

function refreshTables(section: HTMLElement): void {
  hydrateGeoTable(section)
  hydrateSeatsTable(section, Date.now())
}

// ---------------------------------------------------------------------------------------
// Seat drawer (row click on the Connected seats table).
// ---------------------------------------------------------------------------------------

/** `value` is untrusted (seat-reported email, city, OS...) and this fills innerHTML, so it is
 * always esc()-aped here -- callers never need to remember to do it themselves. */
function seatField(label: string, value: string): string {
  return `<div class="seat-field"><span class="lbl">${esc(label)}</span><span class="val">${esc(value)}</span></div>`
}

function openSeatDrawer(row: LiveSeatTableRow, now: number): void {
  const drawer = document.getElementById('rt-seat-drawer')
  if (!drawer) return
  const title = drawer.querySelector<HTMLElement>('[data-drawer-title]')
  const body = drawer.querySelector<HTMLElement>('[data-drawer-body]')
  const name = row.hostname || row.email || 'Unnamed seat'
  if (title) title.textContent = name
  if (body) {
    const place = [row.country, row.city].filter(Boolean).join(', ') || 'Not reported'
    body.innerHTML = [
      seatField('Email', row.email || 'Not reported'),
      seatField('Country / city', place),
      seatField('OS', row.os || 'Not reported'),
      seatField('Client', row.appVersion || 'Not reported'),
      seatField('Tier', row.tier || 'Not reported'),
      seatField('License state', row.licenseState),
      seatField('Live', row.live ? 'Live now' : 'Not live'),
      seatField('Session started', row.sessionStartedAt ? new Date(row.sessionStartedAt).toISOString() : 'Not reported'),
      seatField('Duration so far', row.durationMs != null ? formatAvgDuration(row.durationMs) : 'Not reported'),
      seatField('Events this session', row.eventsThisSession != null ? String(row.eventsThisSession) : 'Not reported'),
      seatField('Asks this session', row.asksThisSession != null ? String(row.asksThisSession) : 'Not reported'),
      seatField('Last seen', relativeTime(row.lastSeen, now) + ' ago')
    ].join('')
  }
  drawer.hidden = false
}

function attachSeatDrawer(section: HTMLElement): () => void {
  const onClick = (e: Event): void => {
    const target = e.target as HTMLElement
    const row = target.closest<HTMLElement>('[data-rt-seat]')
    if (row) {
      const id = row.getAttribute('data-rt-seat')
      const seat = lastSeats.find((s) => s.deviceId === id)
      if (seat) openSeatDrawer(seat, Date.now())
      return
    }
    if (target.closest('[data-country-chip-clear]')) {
      setCountryFilter(section, null)
      return
    }
    if (target.id === 'rt-seat-drawer-close' || target.closest('#rt-seat-drawer-close')) {
      const drawer = document.getElementById('rt-seat-drawer')
      if (drawer) drawer.hidden = true
    }
  }
  section.addEventListener('click', onClick)
  return () => section.removeEventListener('click', onClick)
}

function attachGeoSearch(section: HTMLElement): () => void {
  const input = section.querySelector<HTMLInputElement>('[data-geo-search]')
  if (!input) return () => {}
  const onInput = (): void => {
    searchQuery = input.value.trim().toLowerCase()
    applyGeoFilters(section)
  }
  input.addEventListener('input', onInput)
  return () => input.removeEventListener('input', onInput)
}

// ---------------------------------------------------------------------------------------
// 1s ticker for ages and running durations, scoped to this section only.
// ---------------------------------------------------------------------------------------

function tick(section: HTMLElement): void {
  const now = Date.now()
  section.querySelectorAll<HTMLElement>('.time-cell[data-ts]').forEach((el) => {
    const ts = Number(el.getAttribute('data-ts'))
    if (Number.isFinite(ts)) el.textContent = relativeTime(ts, now)
  })
  section.querySelectorAll<HTMLElement>('[data-duration-since]').forEach((el) => {
    const since = Number(el.getAttribute('data-duration-since'))
    if (!Number.isFinite(since)) return
    const valueEl = el.querySelector<HTMLElement>('[data-duration-value]')
    if (valueEl) valueEl.textContent = formatAvgDuration(Math.max(0, now - since))
  })
}

export function initRealtime(section: HTMLElement, _data: DashboardPayload | null): void {
  teardown?.()

  const map = attachMap(section)
  const untrackSearch = attachGeoSearch(section)
  const untrackDrawer = attachSeatDrawer(section)

  // Restore whatever filter/search was active across a rerender (the section's own markup was
  // just replaced) so the operator never loses their place mid-investigation.
  searchQuery = ''
  const searchInput = section.querySelector<HTMLInputElement>('[data-geo-search]')
  if (searchInput) searchInput.value = ''
  activeFilterIso = null

  refreshTables(section)

  const onLive = (): void => refreshTables(section)
  window.addEventListener('metis:live', onLive)

  const tickTimer = setInterval(() => tick(section), 1000)

  teardown = () => {
    map?.handle.destroy()
    map?.untrackClick()
    untrackSearch()
    untrackDrawer()
    window.removeEventListener('metis:live', onLive)
    clearInterval(tickTimer)
  }
}
