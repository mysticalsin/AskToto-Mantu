/**
 * Realtime page client init (plan 6.3, 3.7 item 2, 3.5b Realtime row). Wires:
 *  - the map's zoom/pan/hover/click interaction (operator/src/world/map-dom.ts) plus the
 *    following tooltip and the first-paint land-draw + graticule-fade entrance;
 *  - country click -> Geo table filter with a spring highlight and a toolbar chip, toggling;
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
import { esc, flag, relativeTime } from '../../src/render'
import { formatAvgDuration } from '../../src/realtime-geo'
import type { GeoTableRow, LiveSeatTableRow } from '../../src/routes/live'
import { renderConnectedSeatsTable, renderGeoTable } from '../../src/render/pages/realtime'
import { attachMapInteraction, type CountryHit, type MapInteractionHandle } from '../../src/world/map-dom'
import { api } from '../api'
import { bindMotion } from '../motion-bind'
import { drawPath, follow, pop } from '../motion'
import { toast } from '../toasts'

const MAP_WIDTH = 1152
const MAP_HEIGHT = 576
const TOOLTIP_OFFSET_X = 14
const TOOLTIP_OFFSET_Y = 18

/** Only this module's own teardown, so repeated calls (rerender, or navigating back to this
 * page) never accumulate a second window-level listener or a second ticker. */
let teardown: (() => void) | null = null

function tierLabel(hit: CountryHit): string {
  const bits: string[] = []
  if (hit.seats != null) bits.push(`${hit.seats} seat${hit.seats === 1 ? '' : 's'}`)
  if (hit.live != null) bits.push(`${hit.live} live`)
  if (hit.places != null && hit.places > 1) bits.push(`${hit.places} places`)
  return bits.join(', ')
}

function showTooltip(section: HTMLElement, hit: CountryHit): void {
  const tt = section.querySelector<HTMLElement>('[data-rt-tooltip]')
  if (!tt) return
  const flagEl = tt.querySelector<HTMLElement>('[data-tt-flag]')
  const countryEl = tt.querySelector<HTMLElement>('[data-tt-country]')
  const rowsEl = tt.querySelector<HTMLElement>('[data-tt-rows]')
  if (flagEl) flagEl.innerHTML = flag(hit.iso)
  if (countryEl) countryEl.textContent = hit.country
  if (rowsEl) {
    const summary = tierLabel(hit)
    // Asks in the last 30 min and time saved are omitted, never a fabricated number: no route
    // yet reports either broken out per country (see the task report for the exact patch).
    rowsEl.textContent = summary || 'No seats reported here yet.'
  }
  tt.hidden = false
}

function hideTooltip(section: HTMLElement): void {
  const tt = section.querySelector<HTMLElement>('[data-rt-tooltip]')
  if (tt) tt.hidden = true
}

function positionTooltip(section: HTMLElement, clientX: number, clientY: number): void {
  const tt = section.querySelector<HTMLElement>('[data-rt-tooltip]')
  if (!tt || tt.hidden) return
  follow(tt, { clientX: clientX + TOOLTIP_OFFSET_X, clientY: clientY + TOOLTIP_OFFSET_Y })
}

// ---------------------------------------------------------------------------------------
// Country filter: click a country (land, dot or pill) to filter the Geo table; click the same
// one again, or blank map, clears it. Combined with the free-text search below.
// ---------------------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------------------
// Map interaction + first-paint entrance.
// ---------------------------------------------------------------------------------------

function playMapEntrance(section: HTMLElement): void {
  const svg = section.querySelector<SVGSVGElement>('.rt-map-svg')
  if (!svg) return
  svg.querySelectorAll<SVGPathElement>('.world-land').forEach((p) => drawPath(p, 800))
}

function attachMap(section: HTMLElement): MapInteractionHandle | null {
  const root = section.querySelector<HTMLElement>('[data-map-root]')
  if (!root) return null
  return attachMapInteraction(root, {
    width: MAP_WIDTH,
    height: MAP_HEIGHT,
    onPointerMove(clientX, clientY) {
      positionTooltip(section, clientX, clientY)
    },
    onHoverChange(hit) {
      if (hit) showTooltip(section, hit)
      else hideTooltip(section)
    },
    onCountryClick(hit) {
      setCountryFilter(section, hit)
    }
  })
}

// ---------------------------------------------------------------------------------------
// Geo table + Connected seats table hydration.
// ---------------------------------------------------------------------------------------

let lastSeats: LiveSeatTableRow[] = []

function hydrateGeoTable(section: HTMLElement): void {
  const host = section.querySelector<HTMLElement>('[data-geo-table-body]')
  if (!host) return
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

  playMapEntrance(section)
  const mapHandle = attachMap(section)
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
    mapHandle?.destroy()
    untrackSearch()
    untrackDrawer()
    window.removeEventListener('metis:live', onLive)
    clearInterval(tickTimer)
  }
}
