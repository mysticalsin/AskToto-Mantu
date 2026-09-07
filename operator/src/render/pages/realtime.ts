/**
 * Realtime page (plan 6.3, 3.7 item 2, 3.5b Realtime row, P1.3 brief). Order: map panel, strip
 * (Seats 30m / Live / Live events), Geo table, connected seats table.
 *
 * First paint renders everything `DashboardPayload` already carries (plan D2): the map's dots
 * and country pills come from `data.map`, cross-referenced against `data.profiles` for an
 * honest live count per point/country (dashboard.ts's `MapDot` carries no timestamp of its own
 * -- see the report for the exact patch that would let it). The Geo table and the Connected
 * seats table need the richer per-country/per-seat shape the dedicated JSON routes return
 * (`GET /v1/admin/realtime/geo.json`, `GET /v1/admin/realtime/live-seats.json`) -- fields no
 * page-agnostic payload builder has (session start, duration, per-seat asks, live sessions
 * distinct from raw seat count) -- so those two tables render a skeleton (or the honest empty
 * state, when we already know for certain there is nothing to load) and operator/client/pages/
 * realtime.ts hydrates them immediately on mount, then every 5s after. `renderGeoTable` and
 * `renderConnectedSeatsTable` are exported so the client re-renders through the exact same
 * function every time, never a second copy of the row markup.
 */
import type { ConsoleEvent, DashboardPayload, ProfileRow } from '../../dashboard'
import type { GeoTableRow, LiveSeatTableRow } from '../../routes/live'
import { looksLikeSecret } from '../../redact'
import { formatAvgDuration } from '../../realtime-geo'
import {
  COUNTRY_NAMES,
  avatar,
  clientChip,
  countryCell,
  dataTable,
  emptyState,
  esc,
  flag,
  liveCard,
  liveFeed,
  metricTable,
  osChip,
  pageHeader,
  skeletonRows,
  sourceTooltip,
  tierBadge,
  timeCell,
  toolbar,
  visitorsCard,
  iconSvg,
  NAV_ICON_PATHS,
  type RenderCtx
} from '../index'
import { renderRealtimeMapSvg, type RealtimeMapPoint } from '../../world/map'
import { field, MISSING } from './_shared'

// ---------------------------------------------------------------------------------------
// Map model: honest cross-reference of data.map (lat/lon, all-time) against data.profiles
// (live status), since dashboard.ts's MapDot carries no timestamp of its own to scope it to
// the last 30 minutes on its own. See the module doc comment and the task report.
// ---------------------------------------------------------------------------------------

function buildMapModel(data: DashboardPayload): { points: RealtimeMapPoint[] } {
  const liveByCity = new Map<string, number>()
  for (const p of data.profiles) {
    if (!p.live || !p.country) continue
    const iso = p.country.toUpperCase()
    const cityKey = `${iso}\0${(p.city || '').trim()}`
    liveByCity.set(cityKey, (liveByCity.get(cityKey) ?? 0) + 1)
  }

  const points = new Map<string, RealtimeMapPoint>()
  for (const d of data.map.dots) {
    const iso = d.country.toUpperCase()
    if (!iso) continue
    const key = `${iso}\0${d.city ?? ''}\0${d.lat.toFixed(2)}\0${d.lon.toFixed(2)}`
    const existing = points.get(key)
    if (existing) existing.count += 1
    else points.set(key, { country: iso, city: d.city ?? '', lat: d.lat, lon: d.lon, count: 1 })
  }
  // A point is live when at least one seat in that exact city sent a heartbeat inside the live
  // window; `liveSeats` carries how many, for the tooltip. The map draws a pulsing green dot for
  // a live point and a static violet one for a place seen today but quiet now.
  for (const point of points.values()) {
    const live = liveByCity.get(`${point.country}\0${point.city}`) ?? 0
    point.live = live > 0
    point.liveSeats = Math.min(point.count, live)
  }

  return { points: [...points.values()] }
}

function renderMapPanel(data: DashboardPayload): string {
  const { points } = buildMapModel(data)
  // renderRealtimeMapSvg() (operator/src/world/map.ts) renders its own following tooltip
  // (`.rt-map-tooltip[data-map-tooltip]`), populated by operator/src/world/map-dom.ts's
  // attachMapInteraction() -- this card does not carry a second, separate tooltip element.
  return `<article class="card rt-map-card" data-world-map>
    <span class="live rt-map-live" data-world-live aria-live="polite">LIVE ${data.roi.liveSeats}</span>
    ${renderRealtimeMapSvg({ points })}
  </article>`
}

// ---------------------------------------------------------------------------------------
// Strip: Seats 30m, Live, Live events.
// ---------------------------------------------------------------------------------------

function profileIndex(profiles: ProfileRow[]): Map<string, ProfileRow> {
  const map = new Map<string, ProfileRow>()
  for (const p of profiles) {
    map.set(p.deviceId, p)
    map.set(p.device, p)
  }
  return map
}

function chipVal(chips: { key: string; value: string }[], key: string): string | null {
  const hit = chips.find((c) => c.key === key)
  return hit && !looksLikeSecret(hit.value) ? hit.value : null
}

function renderLiveEventRow(e: ConsoleEvent, byDevice: Map<string, ProfileRow>, now: number) {
  const device = chipVal(e.chips, 'device')
  const profile = device ? byDevice.get(device) : undefined
  const os = profile?.os ?? chipVal(e.chips, 'os')
  const label = field(e.hostname || e.email || profile?.hostname || profile?.email)
  return {
    id: e.id,
    kind: looksLikeSecret(e.name) ? 'seat' : e.name,
    label: label === MISSING ? 'Seat' : label,
    flag: profile?.country ? flag(profile.country) : '',
    osChip: osChip(os) || '',
    ageHtml: timeCell(e.ts, now)
  }
}

/** Plan 6.3: "the last 24", newest first -- data.events already arrives sorted newest-first
 * (dashboard.ts's mergeEvents), so this slice is the 24 most recent, not an arbitrary 24. The
 * badge next to "Live events" reports what is actually on screen, not the pre-slice total: a
 * count that disagreed with the visible rows was its own small version of "feels unbounded". */
const LIVE_FEED_ROW_CAP = 24

function renderStrip(data: DashboardPayload): string {
  const byDevice = profileIndex(data.profiles)
  const events = data.events.slice(0, LIVE_FEED_ROW_CAP).map((e) => renderLiveEventRow(e, byDevice, data.now))
  return `<div class="rt-strip" data-rt-live-strip>
    ${visitorsCard({ title: 'Seats 30m', value: data.roi.seats30m, bars: data.ops.liveSeries })}
    ${liveCard({ title: 'Live', value: data.roi.liveSeats, caption: 'seats online now, heartbeat under 2 min' })}
    ${liveFeed({ rows: events, count: events.length })}
  </div>`
}

// ---------------------------------------------------------------------------------------
// Geo table: metricTable, hydrated from GET /v1/admin/realtime/geo.json (exported so the
// client re-renders through this exact function, never a second copy of the row markup).
// ---------------------------------------------------------------------------------------

export function renderGeoTable(rows: GeoTableRow[]): string {
  const seenIso = new Set<string>()
  const headerFlags: string[] = []
  for (const r of rows) {
    if (seenIso.has(r.iso) || headerFlags.length >= 8) continue
    seenIso.add(r.iso)
    headerFlags.push(flag(r.iso))
  }
  return metricTable({
    title: 'Geo',
    labelHeader: 'Country / City',
    headerIcons: headerFlags,
    columns: [
      { key: 'events', label: 'Events', sortable: true },
      { key: 'live', label: 'Live sessions', sortable: true },
      { key: 'seats', label: 'Seats 30m', sortable: true },
      { key: 'duration', label: 'Duration', sortable: true, hideBelowPx: 350 }
    ],
    rows: rows.map((r) => {
      const countryLabel = COUNTRY_NAMES[r.iso] || r.iso
      const q = `${r.iso} ${countryLabel} ${r.city || ''}`.toLowerCase()
      return {
        // countryCell() (primitives.ts, plan 3.6/6.3) is the whole label: flag, country name and
        // the city as its secondary line, one 32px row -- not a hand-rolled "Country, City"
        // string. metricTable() escapes `label` but renders `icon` raw, so the two-line markup
        // has to live in `icon` with `label` left empty.
        icon: countryCell(r.iso, { secondary: r.city || undefined }),
        label: '',
        barValue: r.seats30m,
        attrs: `data-geo-row data-iso="${esc(r.iso)}" data-q="${esc(q)}"`,
        cells: {
          events: String(r.events),
          live: String(r.liveSessions),
          seats: String(r.seats30m),
          duration: formatAvgDuration(r.avgDurationMs)
        }
      }
    }),
    emptyTitle: 'No seats have checked in during the last 30 minutes.',
    emptyDescription: 'A row appears here within 60 seconds of the first heartbeat from a new country or city.'
  })
}

// ---------------------------------------------------------------------------------------
// Connected seats: dataTable, hydrated from GET /v1/admin/realtime/live-seats.json.
// ---------------------------------------------------------------------------------------

function tierOf(raw: string | null): 'metis' | 'metis-light' | null {
  return raw === 'metis' || raw === 'metis-light' ? raw : null
}

export function renderConnectedSeatsTable(rows: LiveSeatTableRow[], now: number): string {
  return dataTable({
    columns: [
      { key: 'seat', label: 'Seat' },
      { key: 'country', label: 'Country / City' },
      { key: 'os', label: 'OS' },
      { key: 'client', label: 'Client' },
      { key: 'tier', label: 'Tier' },
      { key: 'started', label: 'Session started' },
      { key: 'duration', label: 'Duration' },
      { key: 'events', label: 'Events' },
      { key: 'asks', label: 'Asks' }
    ],
    rows: rows.map((r) => {
      const name = r.hostname || r.email || 'Unnamed seat'
      const durationAttr = r.live && r.sessionStartedAt != null ? ` data-duration-since="${r.sessionStartedAt}"` : ''
      const place = [r.country ? COUNTRY_NAMES[r.country] || r.country : null, r.city].filter(Boolean).join(', ')
      return {
        attrs: `data-rt-seat="${esc(r.deviceId)}"${durationAttr}`,
        cells: {
          seat: `${avatar({ name, email: r.email, live: r.live })}<span class="seat-name">${esc(name)}</span>${r.email ? `<span class="muted">${esc(r.email)}</span>` : ''}`,
          country: `${r.country ? flag(r.country) : ''}<span>${esc(place || MISSING)}</span>`,
          os: osChip(r.os) || MISSING,
          client: clientChip(r.appVersion) || MISSING,
          tier: tierBadge(tierOf(r.tier)) || MISSING,
          started: r.sessionStartedAt != null ? timeCell(r.sessionStartedAt, now) : MISSING,
          duration: r.durationMs != null ? `<span data-duration-value>${esc(formatAvgDuration(r.durationMs))}</span>` : MISSING,
          events: r.eventsThisSession != null ? String(r.eventsThisSession) : MISSING,
          asks: r.asksThisSession != null ? String(r.asksThisSession) : MISSING
        }
      }
    }),
    emptyTitle: 'No seats have checked in during the last 30 minutes.',
    emptyDescription: 'A seat appears here within 60 seconds of its next heartbeat.'
  })
}

/** First-paint placeholder for both hydrated tables: an honest empty state when we already
 * know for certain nothing will load (no seat active in the last 30 minutes), a skeleton sized
 * to the fleet otherwise -- operator/client/pages/realtime.ts replaces this within one fetch of
 * mount, and every 5s after. */
function loadingOrEmpty(data: DashboardPayload, emptyTitle: string, emptyDescription: string): string {
  if (data.roi.seats30m <= 0) return emptyState({ title: emptyTitle, description: emptyDescription })
  return `<div class="table-frame" data-rt-skeleton>${skeletonRows(Math.min(8, Math.max(3, data.roi.seats30m)))}</div>`
}

function renderRealtimeGeo(data: DashboardPayload): string {
  return `<article class="card pad-b10" data-realtime-geo>
    <div class="kpi-top"><p class="eyebrow eyebrow-flush">Geo${sourceTooltip('Country and city rollup of seats active in the last 30 minutes', 'realtime/geo.json, sessions and events tables')}</p></div>
    <input class="table-search" data-geo-search type="search" placeholder="Search countries, cities" autocomplete="off">
    <div data-geo-table-body>${loadingOrEmpty(data, 'No seats have checked in during the last 30 minutes.', 'A row appears here within 60 seconds of the first heartbeat from a new country or city.')}</div>
  </article>`
}

function renderConnectedSeats(data: DashboardPayload): string {
  return `<article class="card pad-b10" data-realtime-seats>
    <div class="kpi-top"><p class="eyebrow eyebrow-flush">Connected seats${sourceTooltip('Every seat with a heartbeat in the last 30 minutes', 'realtime/live-seats.json')}</p></div>
    <div data-seats-table-body>${loadingOrEmpty(data, 'No seats have checked in during the last 30 minutes.', 'A seat appears here within 60 seconds of its next heartbeat.')}</div>
  </article>`
}

// ---------------------------------------------------------------------------------------
// Country filter chip + seat drawer shells (client-populated).
// ---------------------------------------------------------------------------------------

function renderToolbar(): string {
  const chip = `<span class="chip rt-country-chip" data-country-chip hidden>Country: <b data-country-chip-label></b><button type="button" class="chip-clear" data-country-chip-clear aria-label="Clear country filter">${iconSvg(NAV_ICON_PATHS.x, { class: 'tool-ic' })}</button></span>`
  return toolbar({ left: chip, right: '' })
}

function renderSeatDrawer(): string {
  return `<aside id="rt-seat-drawer" class="seat-overlay" hidden role="dialog" aria-modal="true" aria-labelledby="rt-seat-drawer-title">
    <div class="seat-overlay-head glass">
      <h4 id="rt-seat-drawer-title" data-drawer-title></h4>
      <button type="button" class="btn" id="rt-seat-drawer-close" aria-label="Close">Close</button>
    </div>
    <div class="seat-overlay-grid" data-drawer-body></div>
  </aside>`
}

export function renderRealtime(data: DashboardPayload, _ctx: RenderCtx): string {
  return `${pageHeader({ title: 'Realtime', subtitle: 'Live seats, the world map and events, refreshed every 5 seconds.' })}
    ${renderToolbar()}
    ${renderMapPanel(data)}
    ${renderStrip(data)}
    ${renderRealtimeGeo(data)}
    ${renderConnectedSeats(data)}
    ${renderSeatDrawer()}`
}
