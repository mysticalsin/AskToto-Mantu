/**
 * Overview page (plan 6.2). Moved out of operator/src/ui.ts (plan P0.4) unchanged in behaviour:
 * same data, same data-* hooks the client (operator/client/filters.ts, actions.ts) already
 * queries. Only the inline `style=` attributes became classes (operator/src/spa/
 * css-pages-shared.ts) and the page now opens with pageHeader() (plan law 6: one sentence under
 * every title).
 */
import { choroplethMini, sparklineLine } from '../../charts'
import type { ConsoleEvent, DashboardPayload, ProfileRow } from '../../dashboard'
import { looksLikeSecret } from '../../redact'
import { formatAvgDuration, geoCountryRollup } from '../../realtime-geo'
import { esc, pageHeader, relativeTime as ago, type RenderCtx } from '../index'
import { approvalPill, field, geoBar, kpiCard, MISSING, percentBar } from './_shared'

function renderLicenseGenerateForm(): string {
  return `<form class="key-form license-gen" data-license-generate method="post" action="/v1/admin/licenses/generate" autocomplete="off">
      <p class="sub muted">Pick how long it stays active. Paste the string into Métis → Identity → License. Shown once. last4 after that.</p>
      <div class="row">
        <label>Active for
          <select name="days" required>
            <option value="1">1 day</option>
            <option value="7">7 days</option>
            <option value="30" selected>30 days</option>
            <option value="90">90 days</option>
            <option value="365">1 year</option>
          </select>
        </label>
        <button class="primary" type="submit">Generate license</button>
      </div>
    </form>
    <div class="license-once" hidden data-license-once>
      <p class="sub">Copy this once. It will not be shown again.</p>
      <input data-license-once-value readonly spellcheck="false" />
      <button type="button" class="primary" data-license-once-copy>Copy</button>
    </div>`
}

function renderInstallWorks(data: DashboardPayload): string {
  const pending = data.licenses.rows.filter((r) => r.approval !== 'approved')
  const vaulted = data.keys.vault.some((v) => v.status === 'active')
  const approved = data.roi.approved
  const seats = data.profiles.length
  const body = pending.length
    ? `<table data-pending-seats><thead><tr><th>Computer</th><th>SSO email</th><th>License</th><th>Approval</th><th></th></tr></thead><tbody>${pending
        .map((r) => {
          const id = esc(r.device)
          return `<tr data-device="${id}" data-approval="${esc(r.approval)}">
            <td>${field(r.hostname)}</td>
            <td>${field(r.email)}</td>
            <td>${field(r.license)}</td>
            <td>${approvalPill(r.approval)}</td>
            <td>${
              r.approval === 'approved'
                ? ''
                : `<button class="primary" data-license-approve="${id}">Approve</button>`
            }</td>
          </tr>`
        })
        .join('')}</tbody></table>`
    : '<div class="empty">No seats waiting. A new heartbeat lands pending until Tony approves it.</div>'
  return `<article class="card works" data-install-works>
    <p class="eyebrow">Install → works</p>
    <ol class="works-path">
      <li data-step="checkin" class="${seats ? 'done' : 'need'}"><b>Check in</b><span>Seat checks in</span><small>${seats ? `${seats} real` : 'waiting for heartbeat'}</small></li>
      <li data-step="approve" class="${pending.length ? 'need' : approved ? 'done' : ''}"><b>Approve</b><span>Approve or license</span><small>${pending.length ? `${pending.length} pending` : approved ? `${approved} approved` : 'no seats yet'}</small></li>
      <li data-step="keys" class="${vaulted && approved ? 'done' : 'need'}"><b>Keys</b><span>Platform keys</span><small>${vaulted ? 'vault ready' : 'add a key on Keys'}</small></li>
    </ol>
    ${renderLicenseGenerateForm()}
    ${body}
  </article>`
}

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

function renderGeoCorner(data: DashboardPayload): string {
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
  return `<div class="ov-pair" data-geo-corner>
    <article class="card pad-b10">
      <p class="eyebrow">Places</p>
      <div class="tabs" id="geo-tabs">
        <button class="tab on" data-geo-tab="countries" type="button">Countries</button>
        <button class="tab" data-geo-tab="regions" type="button">Regions</button>
        <button class="tab" data-geo-tab="cities" type="button">Cities</button>
      </div>
      <input class="search-bar" data-geo-search type="search" placeholder="Search places…" autocomplete="off">
      <div data-geo-pane="countries">
        ${
          countryRows
            ? `<table data-geo-table="countries"><thead><tr><th>Country</th><th>Seats</th><th>Sess.</th><th>Avg</th></tr></thead><tbody>${countryRows}</tbody></table>`
            : '<div class="empty">No country geo yet.</div>'
        }
      </div>
      <div data-geo-pane="regions" hidden>
        ${
          regionRows
            ? `<table data-geo-table="regions"><thead><tr><th>Region</th><th>Country</th><th>Seats</th><th>Sess.</th><th>Avg</th></tr></thead><tbody>${regionRows}</tbody></table>`
            : '<div class="empty">No region yet. Next heartbeat writes request.cf.region.</div>'
        }
      </div>
      <div data-geo-pane="cities" hidden>
        ${
          cityRows
            ? `<table data-geo-table="cities"><thead><tr><th>City</th><th>Country</th><th>Seats</th><th>Sess.</th><th>Avg</th></tr></thead><tbody>${cityRows}</tbody></table>`
            : '<div class="empty">No city geo yet. Heartbeats write request.cf city.</div>'
        }
      </div>
    </article>
    <article class="card geo-map-card" data-geo-widget>
      <p class="eyebrow">Map</p>
      ${choroplethMini(data.map.countries)}
    </article>
  </div>`
}

function chipVal(chips: { key: string; value: string }[], key: string): string | null {
  const hit = chips.find((c) => c.key === key)
  return hit && !looksLikeSecret(hit.value) ? hit.value : null
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

function renderTopLists(data: DashboardPayload): string {
  const byDevice = new Map<string, number>()
  for (const e of data.events) {
    const id = e.hostname || e.email || chipVal(e.chips, 'device') || ''
    if (!id) continue
    byDevice.set(id, (byDevice.get(id) ?? 0) + 1)
  }
  const devices = data.profiles
    .slice()
    .sort((a, b) => {
      const an = byDevice.get(a.hostname || a.email || a.device) ?? 0
      const bn = byDevice.get(b.hostname || b.email || b.device) ?? 0
      return bn - an || b.lastSeen - a.lastSeen
    })
    .slice(0, 8)
  const kinds = new Map<string, number>()
  for (const e of data.events) {
    const name = looksLikeSecret(e.name) ? 'event' : e.name
    kinds.set(name, (kinds.get(name) ?? 0) + 1)
  }
  const kindRows = [...kinds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
  const maxKind = Math.max(1, ...kindRows.map(([, n]) => n))
  const maxDev = Math.max(1, ...devices.map((r) => byDevice.get(r.hostname || r.email || r.device) ?? 1))
  const osRows = data.scale.os.slice(0, 8)
  const maxOs = Math.max(1, ...osRows.map((r) => r.value))
  const deviceBody = devices
    .map((r) => {
      const who = r.hostname || r.email || r.device
      const n = byDevice.get(who) ?? 0
      const pct = Math.max(10, Math.round((Math.max(n, 1) / maxDev) * 100))
      const q = `${who} ${r.city || ''} ${r.os}`.toLowerCase()
      return `<div class="vol-row" data-toplist-device="${esc(r.device)}" data-q="${esc(q)}">
        ${percentBar(pct, 'vol-bar')}
        <span>${field(who)}</span>
        <span class="muted">${n || 1}</span>
        <span>${r.live ? '<span class="pill up">live</span>' : '<span class="muted">idle</span>'}</span>
      </div>`
    })
    .join('')
  const osBody = osRows
    .map((r) => {
      const pct = Math.max(10, Math.round((r.value / maxOs) * 100))
      return `<div class="vol-row" data-toplist-os="${esc(r.label)}" data-q="${esc(r.label.toLowerCase())}">
        ${percentBar(pct, 'vol-bar')}
        <span>${esc(r.label)}</span>
        <span class="muted">${r.value}</span>
        <span></span>
      </div>`
    })
    .join('')
  const kindBody = kindRows
    .map(([name, n]) => {
      const pct = Math.max(10, Math.round((n / maxKind) * 100))
      return `<div class="vol-row" data-toplist-event="${esc(name)}" data-q="${esc(name.toLowerCase())}">
        ${percentBar(pct, 'vol-bar')}
        <span>${esc(name)}</span>
        <span class="muted">${n}</span>
        <span></span>
      </div>`
    })
    .join('')
  return `<div class="ov-pair" data-overview-toplists>
    <article class="card pad-b10" data-device-card>
      <p class="eyebrow">Devices</p>
      <div class="tabs" data-device-tabs>
        <button class="tab on" data-device-tab="devices" type="button">Devices</button>
        <button class="tab" data-device-tab="os" type="button">OS</button>
      </div>
      <input class="search-bar" data-list-search="devices" type="search" placeholder="Search devices…" autocomplete="off">
      <div class="vol-head"><span></span><span>Seats</span><span>Live</span></div>
      <div data-device-pane="devices">${deviceBody || '<div class="empty">No seats yet.</div>'}</div>
      <div data-device-pane="os" hidden>${osBody || '<div class="empty">No OS mix yet.</div>'}</div>
    </article>
    <article class="card pad-b10">
      <p class="eyebrow">Events</p>
      <input class="search-bar" data-list-search="events" type="search" placeholder="Search events…" autocomplete="off">
      <div class="vol-head"><span></span><span>Count</span><span></span></div>
      ${kindBody || '<div class="empty">No events yet.</div>'}
    </article>
  </div>`
}

export function renderOverview(data: DashboardPayload, _ctx: RenderCtx): string {
  const k = data.kpis
  const liveSeats = data.profiles.filter((p) => p.live)
  return `${pageHeader({ title: 'Overview', subtitle: "What's happening across the fleet right now." })}
    <div class="kpis glance" data-overview-kpis>
      ${kpiCard({ title: 'Live seats', value: String(data.roi.liveSeats), sub: 'heartbeat &lt; 2 min · real devices', spark: sparklineLine(k.liveSeries) })}
      ${kpiCard({ title: 'Time saved', value: data.roi.timeSaved, sub: data.roi.timeSavedSub, spark: '' })}
      ${kpiCard({ title: 'Value', value: data.roi.value, sub: data.roi.valueSub, spark: '' })}
    </div>
    ${renderTopLists(data)}
    ${renderGeoCorner(data)}
    <article class="card activity-feed pad-b10" data-overview-activity>
      <p class="eyebrow">Activity</p>
      ${
        data.events.length
          ? `<div class="sub muted pad-b6">Seats, heartbeats, asks, recaps. City from request.cf. Not pageviews.</div>
             <div data-activity-stream>${renderEvents(data.events.slice(0, 24), data.now)}</div>`
          : '<div class="empty">No activity yet. A heartbeat writes city and lands here.</div>'
      }
    </article>
    <article class="card pad-b10" data-overview-people>
      <p class="eyebrow">${liveSeats.length ? 'Live people' : 'People'}</p>
      ${renderPeopleStrip(liveSeats.length ? liveSeats : data.profiles, liveSeats.length)}
    </article>
    ${renderInstallWorks(data)}`
}
