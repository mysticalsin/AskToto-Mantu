/**
 * Realtime page (operator UX plan, Rock 1). Reference layout: a full-bleed live world map with a
 * glass overlay column (the 30 min seat KPI and the live feed), then three cards underneath
 * (locations, ask modes, seats). Everything on the map and in the feed comes from
 * `data.realtime`, built by the same functions as live.json, so operator/client/realtime-map.ts
 * repaints the exact same markup in place every 5 s through the row renderers exported here.
 */
import { sparklineLine } from '../../charts'
import type { ConsoleEvent, DashboardPayload, ProfileRow, RecentEvent } from '../../dashboard'
import type { PlaceActivity, RealtimePlace } from '../../realtime-geo'
import { looksLikeSecret } from '../../redact'
import { isFreshLiveEvent } from '../../theme-preference'
import { countryName, placeToPoint, renderRealtimeMapSvg } from '../../world/map'
import { esc, kindBadge, pageHeader, relativeTime as ago, tabs, type RenderCtx } from '../index'
import { geoBar } from './_shared'

/** Fresh heartbeats and asks for the live strip only. Stale rows stay on Events. */
export function liveStripEvents(events: ConsoleEvent[], now: number): ConsoleEvent[] {
  return events.filter((e) => isFreshLiveEvent(e.ts, now)).slice(0, 30)
}

/** Seats heard from in the last 30 min, summed over places (the KPI's headline number). */
export function realtimeSeatTotal(places: RealtimePlace[]): number {
  return places.reduce((sum, p) => sum + p.seats, 0)
}

/** One live-feed row. Shared by SSR and the client repaint (operator/client/realtime-map.ts). */
export function rtFeedRow(e: RecentEvent, now: number): string {
  const who = e.actor && !looksLikeSecret(e.actor) ? e.actor : 'Unknown seat'
  const where = [e.city, e.country].filter(Boolean).join(', ')
  return `<li class="rt-feed-row" data-rt-feed-row="${esc(e.id)}">
      ${kindBadge(e.kind)}
      <span class="rt-feed-who">${esc(who)}</span>
      <span class="rt-feed-where">${esc(where || 'Location not set')}</span>
      <time class="rt-feed-ago" datetime="${new Date(e.ts).toISOString()}">${esc(ago(e.ts, now))}</time>
    </li>`
}

export function rtFeedRows(events: RecentEvent[], now: number): string {
  const fresh = events.filter((e) => isFreshLiveEvent(e.ts, now)).slice(0, 12)
  if (!fresh.length) {
    return '<li class="rt-feed-empty">No events in the last 30 minutes. A fresh heartbeat or ask lands here.</li>'
  }
  return fresh.map((e) => rtFeedRow(e, now)).join('')
}

interface LocationRow {
  key: string
  iso2: string
  label: string
  seats: number
  sessions: number
}

type LocationGrain = 'country' | 'region' | 'city'

function locationRows(places: RealtimePlace[], by: LocationGrain): LocationRow[] {
  const rows = new Map<string, LocationRow>()
  for (const p of places) {
    const sub = by === 'region' ? p.region : by === 'city' ? p.city : null
    const key = by === 'country' ? p.iso2 : `${p.iso2}|${sub ?? ''}`
    const label = by === 'country' ? p.country : sub || 'Not set'
    const cur = rows.get(key)
    if (cur) {
      cur.seats += p.seats
      cur.sessions += p.sessions
    } else {
      rows.set(key, { key, iso2: p.iso2, label, seats: p.seats, sessions: p.sessions })
    }
  }
  return [...rows.values()].sort((a, b) => b.seats - a.seats || a.label.localeCompare(b.label))
}

/** Flag + one label (country name, or the region/city name with the country in the tooltip). */
function locationCell(iso2: string, label: string): string {
  const code = /^[A-Z]{2}$/.test(iso2) ? iso2 : ''
  const flagImg = code ? `<img class="country-flag" src="/assets/flags/${code.toLowerCase()}.svg" width="16" height="12" alt="">` : ''
  return `<span class="rt-loc" title="${esc(countryName(code) || 'Unknown country')}">${flagImg}<span class="rt-loc-label">${esc(label)}</span></span>`
}

/** Locations card body for one tab. Shared by SSR and the client repaint. */
export function rtLocationTable(places: RealtimePlace[], by: LocationGrain): string {
  const rows = locationRows(places, by)
  if (!rows.length) {
    return '<div class="rt-card-empty">No seat locations in the last 30 minutes.</div>'
  }
  const max = Math.max(1, ...rows.map((r) => r.seats))
  const body = rows
    .map(
      (r) => `<tr data-rt-location="${esc(r.key)}">
        <td class="rt-loc-name">${geoBar(r.seats, max)}${locationCell(r.iso2, r.label)}</td>
        <td class="num">${r.seats}</td>
        <td class="num muted">${r.sessions}</td>
      </tr>`
    )
    .join('')
  return `<table class="rt-table"><thead><tr><th>${by === 'country' ? 'Country' : by === 'region' ? 'Region' : 'City'}</th><th class="num">Seats</th><th class="num">Sessions</th></tr></thead><tbody>${body}</tbody></table>`
}

/** Ask modes over every place in the last 30 min (placeActivity is already capped per place). */
export function rtModeTable(activity: Record<string, PlaceActivity>): string {
  const totals = new Map<string, number>()
  for (const a of Object.values(activity)) for (const [mode, n] of a.modes) totals.set(mode, (totals.get(mode) ?? 0) + n)
  const rows = [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  if (!rows.length) return '<div class="rt-card-empty">No asks in the last 30 minutes.</div>'
  const max = Math.max(1, ...rows.map((r) => r[1]))
  const body = rows
    .map(([mode, n]) => `<tr data-rt-mode="${esc(mode)}"><td>${geoBar(n, max)}<span class="rt-mode-name">${esc(mode)}</span></td><td class="num">${n}</td></tr>`)
    .join('')
  return `<table class="rt-table"><thead><tr><th>Mode</th><th class="num">Asks</th></tr></thead><tbody>${body}</tbody></table>`
}

function rtSeatList(rows: ProfileRow[]): string {
  if (!rows.length) return '<div class="rt-card-empty">No seats yet. A heartbeat writes city from request.cf and lands here.</div>'
  return `<ul class="rt-seats">${rows
    .map(
      (r) => `<li class="rt-seat" data-people-row data-live="${r.live ? '1' : '0'}">
        <span class="rt-seat-dot" data-live="${r.live ? '1' : '0'}" aria-hidden="true"></span>
        <span class="rt-seat-who">${esc(r.hostname || r.email || 'Unknown seat')}</span>
        <span class="rt-seat-where">${esc(r.city || 'Location not set')}</span>
        <span class="rt-seat-state">${r.live ? 'live' : 'idle'}</span>
      </li>`
    )
    .join('')}</ul>`
}

function peopleTitle(rows: ProfileRow[]): string {
  const live = rows.filter((r) => r.live).length
  return `People · ${rows.length} seats${live ? ` · ${live} live` : ''}`
}

function renderStage(data: DashboardPayload): string {
  const rt = data.realtime
  const seats30 = realtimeSeatTotal(rt.places)
  const map = renderRealtimeMapSvg({ points: rt.places.map(placeToPoint) })
  // Initial client state for zoom re-clustering before the first 5 s poll lands. Place metadata
  // only (the same rows live.json ships); esc() makes it attribute-safe.
  const state = esc(JSON.stringify({ now: data.now, places: rt.places, placeActivity: rt.placeActivity }))
  return `<section class="rt-stage" data-world-map data-rt-stage data-rt-state="${state}" aria-label="Live world map">
    <div id="map-root" class="rt-map-root" data-geo-widget>${map}</div>
    <div class="rt-overlay">
      <article class="rt-glass rt-kpi" data-rt-live-strip>
        <p class="rt-kpi-label">Unique seats · last 30 min</p>
        <p class="rt-kpi-value" data-rt-seats>${seats30}</p>
        <p class="rt-kpi-sub"><span class="rt-live-dot" aria-hidden="true"></span><span data-world-live>LIVE ${rt.liveSeats}</span><span class="muted">online now</span></p>
        <div class="rt-kpi-spark">${sparklineLine(data.kpis.liveSeries)}</div>
      </article>
      <article class="rt-glass rt-feed" data-live-feed>
        <p class="rt-card-title">Live feed</p>
        <ol class="rt-feed-list" data-rt-feed aria-live="polite">${rtFeedRows(rt.recentEvents, data.now)}</ol>
      </article>
    </div>
    <div class="rt-popover-host" data-rt-popover-host></div>
  </section>`
}

function renderCards(data: DashboardPayload): string {
  const rt = data.realtime
  return `<div class="rt-cards">
    <article class="card rt-card" data-realtime-geo>
      <header class="rt-card-head"><p class="rt-card-title">Locations</p>${tabs({
        items: [
          { id: 'country', label: 'Countries', active: true },
          { id: 'region', label: 'Regions' },
          { id: 'city', label: 'Cities' }
        ],
        attrs: 'data-rt-loc-tabs'
      })}</header>
      <div data-rt-loc-pane="country">${rtLocationTable(rt.places, 'country')}</div>
      <div data-rt-loc-pane="region" hidden>${rtLocationTable(rt.places, 'region')}</div>
      <div data-rt-loc-pane="city" hidden>${rtLocationTable(rt.places, 'city')}</div>
    </article>
    <article class="card rt-card" data-rt-modes>
      <header class="rt-card-head"><p class="rt-card-title">Ask modes · last 30 min</p></header>
      <div data-rt-modes-body>${rtModeTable(rt.placeActivity)}</div>
    </article>
    <article class="card rt-card" data-live-presence>
      <header class="rt-card-head"><p class="rt-card-title">${peopleTitle(data.profiles)}</p></header>
      ${rtSeatList(data.profiles)}
    </article>
  </div>`
}

export function renderRealtime(data: DashboardPayload, _ctx: RenderCtx): string {
  return `${pageHeader({ title: 'Realtime', subtitle: 'Seats heard from in the last 30 minutes, refreshed every 5 seconds.' })}
    ${renderStage(data)}
    ${renderCards(data)}`
}
