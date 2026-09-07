/**
 * Realtime page (plan 6.3). Moved out of operator/src/ui.ts (plan P0.4) unchanged in behaviour.
 * Only the inline `style=` attributes became classes (operator/src/spa/css-pages-shared.ts) and
 * the page now opens with pageHeader().
 */
import { shoeyWorld, sparklineLine } from '../../charts'
import type { ConsoleEvent, DashboardPayload, ProfileRow } from '../../dashboard'
import { looksLikeSecret } from '../../redact'
import { formatAvgDuration, geoCountryRollup } from '../../realtime-geo'
import { esc, pageHeader, relativeTime as ago, type RenderCtx } from '../index'
import { field, geoBar, kpiCard, MISSING } from './_shared'

function renderPeopleStrip(rows: ProfileRow[], liveCount: number): string {
  if (!rows.length) {
    return '<div class="empty">No seats yet. A heartbeat writes city from request.cf and lands here.</div>'
  }
  const body = rows
    .slice(0, 12)
    .map((r) => {
      return `<div class="people-row" data-people-row data-live="${r.live ? '1' : '0'}" data-city="${esc(r.city || '')}">
        ${r.live ? '<span class="pill up">live</span>' : '<span class="muted">idle</span>'}
        <span class="who">${field(r.hostname)}</span>
        <span class="muted">${field(r.email)}</span>
        <span>${field(r.city)}</span>
        <span class="muted">${esc(r.device)}</span>
        <span>${field(r.license)}</span>
      </div>`
    })
    .join('')
  const hint = liveCount
    ? `${liveCount} live · heartbeat &lt; 2 min`
    : 'No heartbeat in the last two minutes. Showing last-seen seats with city.'
  return `<div class="sub muted pad-b8">${hint}</div>${body}`
}

function renderEvents(events: ConsoleEvent[], now: number): string {
  if (!events.length) return '<div class="empty">No events yet.</div>'
  return events
    .map((e) => {
      const name = looksLikeSecret(e.name) ? 'event' : e.name
      const chips = e.chips
        .filter((c) => !looksLikeSecret(c.key) && !looksLikeSecret(c.value))
        .map((c) => `<span class="chip">${esc(c.key)} ${esc(c.value)}</span>`)
        .join('')
      const profile = e.hostname || e.email || MISSING
      return `<div class="rt-row" data-event="${esc(e.id)}">
        <div class="event-name">${esc(name)}</div>
        <div class="event-profile">${field(profile === MISSING ? null : profile)}</div>
        <div class="event-chips">${chips}</div>
        <div class="ago">${esc(ago(e.ts, now))}</div>
      </div>`
    })
    .join('')
}

function renderWorldMap(data: DashboardPayload): string {
  return `<article class="card rt-world" data-world-map>
    <div class="kpi-top"><p class="eyebrow">WorldMap</p><span class="live" data-world-live>LIVE ${data.roi.liveSeats}</span></div>
    <div id="map-root" data-geo-widget>${shoeyWorld(data.map.countries, data.map.dots)}</div>
  </article>`
}

function renderRealtimeGeo(data: DashboardPayload): string {
  const cities = data.geo
  const regions = data.geoRegions
  const countries = geoCountryRollup(cities)
  const maxCity = Math.max(1, ...cities.map((r) => r.count))
  const maxRegion = Math.max(1, ...regions.map((r) => r.count))
  const maxCountry = Math.max(1, ...countries.map((r) => r.count))
  const cityRows = cities
    .map(
      (r) =>
        `<tr data-geo-city="${esc(r.city)}" data-q="${esc(`${r.city} ${r.country}`.toLowerCase())}"><td>${geoBar(r.count, maxCity)}${esc(r.city)}</td><td class="muted">${esc(r.country)}</td><td>${r.count}</td><td class="muted">${r.unique_sessions}</td><td class="muted">${formatAvgDuration(r.avg_duration)}</td></tr>`
    )
    .join('')
  const regionRows = regions
    .map(
      (r) =>
        `<tr data-q="${esc(`${r.region} ${r.country}`.toLowerCase())}"><td>${geoBar(r.count, maxRegion)}${esc(r.region)}</td><td class="muted">${esc(r.country)}</td><td>${r.count}</td><td class="muted">${r.unique_sessions}</td><td class="muted">${formatAvgDuration(r.avg_duration)}</td></tr>`
    )
    .join('')
  const countryRows = countries
    .map(
      (r) =>
        `<tr data-q="${esc(r.country.toLowerCase())}"><td>${geoBar(r.count, maxCountry)}${esc(r.country)}</td><td>${r.count}</td><td class="muted">${r.unique_sessions}</td><td class="muted">${formatAvgDuration(r.avg_duration)}</td></tr>`
    )
    .join('')
  return `<article class="card" data-realtime-geo>
    <p class="eyebrow">GeoTable</p>
    <div class="tabs" data-geo-tabs="realtime">
      <button class="tab on" data-geo-tab="cities" type="button">City</button>
      <button class="tab" data-geo-tab="regions" type="button">Regions</button>
      <button class="tab" data-geo-tab="countries" type="button">Country</button>
    </div>
    <input class="search-bar" data-geo-search type="search" placeholder="Search cities…" autocomplete="off">
    <div class="geo-live">
      <div data-geo-pane="cities">
        ${
          cityRows
            ? `<table data-geo-table="realtime"><thead><tr><th>City</th><th>Country</th><th>Count</th><th>Sessions</th><th>Avg</th></tr></thead><tbody>${cityRows}</tbody></table>`
            : '<div class="empty">No city geo on live heartbeats yet.</div>'
        }
      </div>
      <div data-geo-pane="regions" hidden>
        ${
          regionRows
            ? `<table data-geo-table="regions"><thead><tr><th>Region</th><th>Country</th><th>Count</th><th>Sessions</th><th>Avg</th></tr></thead><tbody>${regionRows}</tbody></table>`
            : '<div class="empty">No region yet. Next heartbeat writes request.cf.region.</div>'
        }
      </div>
      <div data-geo-pane="countries" hidden>
        ${
          countryRows
            ? `<table data-geo-table="countries"><thead><tr><th>Country</th><th>Count</th><th>Sessions</th><th>Avg</th></tr></thead><tbody>${countryRows}</tbody></table>`
            : '<div class="empty">No country geo yet.</div>'
        }
      </div>
    </div>
  </article>`
}

export function renderRealtime(data: DashboardPayload, _ctx: RenderCtx): string {
  const k = data.kpis
  const liveSeats = data.profiles.filter((p) => p.live)
  return `${pageHeader({ title: 'Realtime', subtitle: 'Live seats, events and the world map, refreshed continuously.' })}
    ${renderWorldMap(data)}
    <div class="rt-live" data-rt-live-strip>
      ${kpiCard({ title: 'Seats 30m', value: String(data.roi.seats30m), sub: 'unique seats last 30 min', spark: sparklineLine(k.liveSeries) })}
      ${kpiCard({ title: 'Live', value: String(data.roi.liveSeats), sub: 'seats online now · heartbeat &lt; 2 min', pill: '<span class="live">live</span>', spark: '' })}
      <article class="card activity-feed pad-b10" data-live-feed>
        <p class="eyebrow">Live events</p>
        ${
          data.events.length
            ? `<div id="rt-stream">${renderEvents(data.events.slice(0, 30), data.now)}</div>`
            : '<div class="empty">No live events yet. A heartbeat writes city and lands here.</div>'
        }
      </article>
    </div>
    ${renderRealtimeGeo(data)}
    <article class="card pad-b10" data-live-presence>
      <p class="eyebrow">${liveSeats.length ? 'Live people' : 'People'}</p>
      ${
        liveSeats.length
          ? renderPeopleStrip(liveSeats, liveSeats.length)
          : data.profiles.length
            ? renderPeopleStrip(data.profiles, 0)
            : '<div class="empty">No seats yet. Heartbeat writes city from request.cf.</div>'
      }
    </article>`
}
