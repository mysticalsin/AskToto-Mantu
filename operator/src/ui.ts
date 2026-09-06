import { choroplethMini, shoeyWorld, sparklineLine } from './charts'
import { statusBadge } from './components/ui/status-badge'
import { CRM_FILTER_ORDER } from './crm'
import { CF_TOKEN_MISSING, type CloudflareOverview } from './cloudflare'
import { CF_OAUTH_MISSING } from './cloudflare-connect'
import type { ConsoleEvent, DashboardPayload, ProfileRow } from './dashboard'
import { looksLikeSecret } from './redact'
import { formatAvgDuration, geoCountryRollup } from './realtime-geo'
import { detailDrawer, esc, relativeTime as ago, shell, type RenderCtx } from './render'
import { SPA_CSS_PATH, SPA_JS_PATH } from './spa/manifest'

const MISSING = '—'

function when(ts: number): string {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 16)
}

function field(value: string | null | undefined): string {
  if (!value || looksLikeSecret(value)) return MISSING
  return esc(value)
}

function renderCloudflare(cf: CloudflareOverview): string {
  if (cf.error === CF_TOKEN_MISSING) {
    return `<div class="sub muted" data-cf-idle>${esc(cf.error)} Connect Cloudflare (login) on Keys.</div>`
  }
  if (cf.error) {
    return `<div class="fail-loud" data-cf-error>${esc(cf.error)}</div>
      <div class="sub muted" style="padding-bottom:8px">Worker ${esc(cf.worker)}. Connect Cloudflare (login) on Keys. No token on seats.</div>`
  }
  const workers = cf.workers.length ? cf.workers.map((w) => esc(w)).join(', ') : 'none listed'
  const req = cf.requests == null ? 'not reported' : String(cf.requests)
  const err = cf.errors == null ? 'not reported' : String(cf.errors)
  const cpu = cf.cpuMs == null ? 'not reported' : `${cf.cpuMs} ms`
  return `<div class="kpis">
      ${kpiCard({ title: 'Requests', value: req, sub: `${cf.worker} · ${cf.range}`, spark: '' })}
      ${kpiCard({ title: 'Errors', value: err, sub: cf.worker, spark: '' })}
      ${kpiCard({ title: 'CPU', value: cpu, sub: 'cpuTimeMs', spark: '' })}
    </div>
    <div class="sub muted" style="padding-bottom:8px">Workers: ${workers}. D1 ${esc(cf.d1Name || 'metis-operator')} ${esc(cf.d1Id || '')}.</div>`
}

function kpiCard(opts: {
  title: string
  value: string
  sub: string
  spark: string
  pill?: string
}): string {
  return `<article class="card kpi">
    <div class="kpi-top"><h3>${esc(opts.title)}</h3>${opts.pill ?? ''}</div>
    <div class="n">${esc(opts.value)}</div>
    <div class="sub">${esc(opts.sub)}</div>
    ${opts.spark}
  </article>`
}

function approvalPill(approval: string): string {
  const v = approval.trim().toLowerCase() || 'pending'
  return `<span class="approval ${esc(v)}">${esc(v)}</span>`
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
  return `<div class="sub muted" style="padding-bottom:8px">${hint}</div>${body}`
}

function geoBar(count: number, max: number): string {
  const pct = max <= 0 ? 0 : Math.max(6, Math.round((count / max) * 100))
  return `<span class="geo-bar" style="width:${pct}%"></span>`
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
    <article class="card" style="padding-bottom:10px">
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

function renderWorldMap(data: DashboardPayload): string {
  return `<article class="card rt-world" data-world-map>
    <div class="kpi-top"><p class="eyebrow">WorldMap</p><span class="live" data-world-live>LIVE ${data.roi.liveSeats}</span></div>
    <div id="map-root" data-geo-widget>${shoeyWorld(data.map.countries, data.map.dots)}</div>
  </article>`
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
        <span class="vol-bar" style="width:${pct}%"></span>
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
        <span class="vol-bar" style="width:${pct}%"></span>
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
        <span class="vol-bar" style="width:${pct}%"></span>
        <span>${esc(name)}</span>
        <span class="muted">${n}</span>
        <span></span>
      </div>`
    })
    .join('')
  return `<div class="ov-pair" data-overview-toplists>
    <article class="card" style="padding-bottom:10px" data-device-card>
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
    <article class="card" style="padding-bottom:10px">
      <p class="eyebrow">Events</p>
      <input class="search-bar" data-list-search="events" type="search" placeholder="Search events…" autocomplete="off">
      <div class="vol-head"><span></span><span>Count</span><span></span></div>
      ${kindBody || '<div class="empty">No events yet.</div>'}
    </article>
  </div>`
}

function renderProfiles(rows: ProfileRow[], osFilter?: string): string {
  const filtered = osFilter
    ? rows.filter((r) => (osFilter === 'darwin' ? r.os === 'darwin' : r.os === 'win' || r.os === 'win32' || r.os === 'windows'))
    : rows
  if (!filtered.length) return '<div class="empty">No seats on the fleet yet.</div>'
  const body = filtered
    .map(
      (r) => {
        const q = `${r.hostname || ''} ${r.email || ''} ${r.city || ''} ${r.country || ''} ${r.deviceId} ${r.os}`.toLowerCase()
        return `<tr data-seat-row data-country="${esc(r.country || '')}" data-os="${esc(r.os)}" data-q="${esc(q)}" data-seat-computer="${esc(r.hostname || r.device)}" data-seat-location="${esc([r.city, r.region, r.country].filter(Boolean).join(' · '))}" data-seat-license="${esc(r.license || '')}" data-seat-identity="${esc(r.email || '')}" data-seat-last="${esc(when(r.lastSeen))}" data-seat-version="${esc(r.appVersion)}" data-seat-status="${r.live ? 'Live' : 'Idle'}" data-seat-status-id="${r.live ? 'live' : 'inactive'}">
        <td>${field(r.hostname)}</td>
        <td>${field(r.city)}</td>
        <td class="muted">${esc(r.country || MISSING)}</td>
        <td class="muted">${esc(r.device)}</td>
        <td>${field(r.email)}</td>
        <td class="muted">${esc(r.os)}</td>
        <td class="muted">${esc(r.appVersion)}</td>
        <td>${field(r.license)}</td>
        <td>${approvalPill(r.approval)}</td>
        <td class="muted">${esc(when(r.lastSeen))}</td>
        <td>${r.live ? '<span class="pill up">live</span>' : '<span class="muted">idle</span>'}</td>
      </tr>`
      }
    )
    .join('')
  return `<table><thead><tr><th>Computer</th><th>City</th><th>Country</th><th>Device</th><th>SSO email</th><th>OS</th><th>Version</th><th>License</th><th>Approval</th><th>Seen</th><th></th></tr></thead><tbody>${body}</tbody></table>`
}

function renderSessions(data: DashboardPayload): string {
  return `<article class="card" style="padding-bottom:10px" data-sessions>
    <p class="eyebrow">Sessions</p>
    <input class="search-bar" id="sessions-search" type="search" placeholder="Search city, device, computer…" autocomplete="off">
    <div class="sub muted" style="padding-bottom:8px">Real seats. City from request.cf. usage-import filtered. Idle is last seen, not missing.</div>
    ${renderProfiles(data.profiles)}
    <div id="sessions-empty" class="empty" hidden>No matching sessions.</div>
  </article>`
}

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

function renderLicenseGenerate(data: DashboardPayload): string {
  const issued = (data.licenses.issued || [])
    .map((r) => {
      const active = !r.revoked && r.exp * 1000 > Date.now()
      return `<tr>
        <td class="muted">··${esc(r.last4)}</td>
        <td class="muted">${r.days}d</td>
        <td class="muted">${esc(when(r.exp * 1000))}</td>
        <td>${r.revoked ? '<span class="pill">revoked</span>' : active ? '<span class="pill up">active</span>' : '<span class="muted">expired</span>'}</td>
      </tr>`
    })
    .join('')
  return `${renderLicenseGenerateForm()}
    ${
      issued
        ? `<table data-issued-licenses><thead><tr><th>Last4</th><th>Duration</th><th>Expires</th><th></th></tr></thead><tbody>${issued}</tbody></table>`
        : '<div class="empty">No Operator licenses generated yet.</div>'
    }`
}

function renderLicenses(data: DashboardPayload): string {
  if (data.licenses.empty) {
    return `<div class="fail-loud" data-licenses-empty>${esc(data.licenses.error || 'No licenses in D1')}</div>
      <div class="sub muted">Real Métis heartbeats only. No demo or usage-import rows. Approve a seat or activate an Operator license before platform keys work.</div>`
  }
  const body = data.licenses.rows
    .map((r) => {
      const id = esc(r.device)
      const act =
        r.approval === 'approved'
          ? `<button class="danger" data-license-revoke="${id}">Revoke</button>`
          : `<button class="primary" data-license-approve="${id}">Approve</button>`
      return `<tr data-device="${id}" data-approval="${esc(r.approval)}">
        <td>${field(r.hostname)}</td>
        <td>${field(r.email)}</td>
        <td>${field(r.license)}</td>
        <td>${approvalPill(r.approval)}</td>
        <td class="muted">${esc(r.os)}</td>
        <td class="muted">${esc(r.appVersion)}</td>
        <td>${act}</td>
      </tr>`
    })
    .join('')
  return `<table><thead><tr><th>Computer</th><th>SSO email</th><th>License</th><th>Approval</th><th>OS</th><th>Version</th><th></th></tr></thead><tbody>${body}</tbody></table>
    <div class="sub muted" style="padding-bottom:8px">Tony approves a seat or the seat activates an Operator license. Revoke still stops platform keys. last4 only. Never a raw key.</div>`
}

/**
 * Composes the shell() render primitive (operator/src/render/shell.ts) with every page body.
 * `opts.theme` is server-rendered `data-theme` from the `metis-operator-theme` cookie (the
 * Worker route owns cookie parsing; pass the parsed value through here). `opts.nonce` is a
 * per-request CSP nonce printed on both the stylesheet link and the script tag; omit it and
 * neither carries a nonce attribute. No inline `<style>` or `<script>` — the hashed CSS/JS
 * bundle from operator/src/spa/manifest.ts is the only script/style source (plan D3).
 */
export function renderConsole(
  data: DashboardPayload,
  opts: { nonce?: string; theme?: 'light' | 'dark' | 'system' } = {}
): string {
  const k = data.kpis
  const canRetry = (status: string): boolean => status === 'failed' || status === 'expired'
  const crmRows = data.crm.rows
    .map((r) => {
      const remote = r.remoteUrl
        ? `<a href="${esc(r.remoteUrl)}" rel="noreferrer">${esc(r.remoteId || 'open')}</a>`
        : r.remoteId
          ? esc(r.remoteId)
          : ''
      const retry =
        canRetry(r.status)
          ? `<button data-retry="${esc(r.id)}">Retry</button>`
          : r.retryRequested
            ? '<span class="muted">retry asked</span>'
            : ''
      return `<tr data-status="${esc(r.status)}">
        <td>${statusBadge(r.status)}</td>
        <td>${esc(r.title)}${r.error ? `<div class="muted">${esc(r.error)}</div>` : ''}</td>
        <td class="muted">${esc(r.connector)}${r.action ? ` · ${esc(r.action)}` : ''}</td>
        <td class="muted remote">${remote}</td>
        <td class="muted">${r.attempt || ''}</td>
        <td class="muted">${esc(r.meetingHash || '')}</td>
        <td class="muted">${esc(when(r.ts))}</td>
        <td>${retry}</td>
      </tr>`
    })
    .join('')
  const landing = data.crm.landing
  const failRate = landing.failRatePct == null ? 'hidden' : `${landing.failRatePct}%`
  const funnelRows = data.crm.funnel
    .map((f) => {
      const att = Math.max(f.attempted, 1)
      const okW = Math.round((f.success / att) * 100)
      const failW = Math.round((f.failed / att) * 100)
      return `<div class="crm-funnel-row">
        <span class="muted">${esc(f.connector)}</span>
        <div class="crm-funnel-track" title="attempted ${f.attempted}">
          <span class="crm-funnel-ok" style="width:${okW}%"></span>
          <span class="crm-funnel-fail" style="width:${failW}%"></span>
        </div>
        <span class="muted">${f.attempted} att · ${f.submitted} sub · ${f.success} ok · ${f.failed} fail</span>
      </div>`
    })
    .join('')
  const noticeRows = data.notices
    .map(
      (n) => `<tr data-q="${esc(`${n.kind} ${n.title} ${n.detail} ${n.profile || ''} ${n.city || ''}`.toLowerCase())}">
        <td>${esc(n.kind)}</td>
        <td>${esc(n.title)}</td>
        <td>${field(n.profile)}</td>
        <td>${field(n.city)}</td>
        <td class="muted">${esc(n.os || MISSING)}</td>
        <td class="muted">${esc(when(n.ts))}</td>
      </tr>`
    )
    .join('')
  const eventRows = data.events
    .map((e) => {
      const chips = e.chips.map((c) => `${c.key} ${c.value}`).join(' ')
      const q = `${e.name} ${e.hostname || ''} ${e.email || ''} ${chips}`.toLowerCase()
      return `<tr data-event="${esc(e.id)}" data-q="${esc(q)}">
        <td class="muted">${esc(when(e.ts))}</td>
        <td>${esc(looksLikeSecret(e.name) ? 'event' : e.name)}</td>
        <td>${field(e.hostname || e.email)}</td>
        <td>${field(chipVal(e.chips, 'city'))}</td>
        <td class="muted">${esc(chipVal(e.chips, 'device') || MISSING)}</td>
        <td class="muted">${esc(chipVal(e.chips, 'os') || MISSING)}</td>
      </tr>`
    })
    .join('')
  const props = data.proposals
    .map(
      (p) => `<div class="card" data-proposal="${esc(p.id)}">
        <div class="row"><strong>${esc(p.skill_id)}</strong> <span class="pill">${esc(p.status)}</span> <span class="muted">from ${esc(p.from_version)}</span></div>
        <div class="muted">${esc(p.rationale)}</div>
        <div class="muted">${esc(p.created_by)} · ${esc(when(p.created_at))}</div>
        <textarea data-diff="${esc(p.id)}">${esc(p.diff)}</textarea>
        <div class="row">
          ${p.status === 'pending' ? `<button class="primary" data-approve="${esc(p.id)}">Approve</button><button class="danger" data-reject="${esc(p.id)}">Reject</button>` : ''}
          ${p.status === 'approved' ? `<button class="primary" data-push="${esc(p.id)}">Push</button>` : ''}
        </div>
      </div>`
    )
    .join('')
  const funnelTabs = CRM_FILTER_ORDER.map(
    (s) =>
      `<button class="tab" data-crm-filter="${s}" type="button">${statusBadge(s)} ${data.crm.counts[s]}</button>`
  ).join('')
  const liveSeats = data.profiles.filter((p) => p.live)
  const vaultRows = data.keys.vault
    .map(
      (v) => `<tr data-key="${esc(v.id)}">
        <td>${esc(v.provider)}</td>
        <td>${esc(v.label)}</td>
        <td class="muted">··${esc(v.last4)}</td>
        <td>${esc(v.status)}</td>
        <td>${v.status === 'revoked' ? '' : `<button data-rotate="${esc(v.id)}">Rotate</button>`}</td>
        <td>${v.status === 'revoked' ? '' : `<button class="danger" data-revoke="${esc(v.id)}">Revoke</button>`}</td>
      </tr>`
    )
    .join('')
  const pendingApprovals = data.licenses.rows.filter((r) => r.approval !== 'approved').length
  const theme = opts.theme ?? 'light'
  const ctx: RenderCtx = { now: data.now, theme }
  const nonceAttr = opts.nonce ? ` nonce="${esc(opts.nonce)}"` : ''
  const htmlThemeAttr = theme === 'system' ? '' : ` data-theme="${theme}"`

  const bodyHtml = `
    <section class="page wrap" data-page="overview">
      <div class="kpis glance" data-overview-kpis>
        ${kpiCard({ title: 'Live seats', value: String(data.roi.liveSeats), sub: 'heartbeat &lt; 2 min · real devices', spark: sparklineLine(k.liveSeries) })}
        ${kpiCard({ title: 'Time saved', value: data.roi.timeSaved, sub: data.roi.timeSavedSub, spark: '' })}
        ${kpiCard({ title: 'Value', value: data.roi.value, sub: data.roi.valueSub, spark: '' })}
      </div>
      ${renderTopLists(data)}
      ${renderGeoCorner(data)}
      <article class="card activity-feed" style="padding-bottom:10px" data-overview-activity>
        <p class="eyebrow">Activity</p>
        ${
          data.events.length
            ? `<div class="sub muted" style="padding-bottom:6px">Seats, heartbeats, asks, recaps. City from request.cf. Not pageviews.</div>
               <div data-activity-stream>${renderEvents(data.events.slice(0, 24), data.now)}</div>`
            : '<div class="empty">No activity yet. A heartbeat writes city and lands here.</div>'
        }
      </article>
      <article class="card" style="padding-bottom:10px" data-overview-people>
        <p class="eyebrow">${liveSeats.length ? 'Live people' : 'People'}</p>
        ${renderPeopleStrip(liveSeats.length ? liveSeats : data.profiles, liveSeats.length)}
      </article>
      ${renderInstallWorks(data)}
    </section>

    <section class="page wrap" data-page="realtime" hidden>
      ${renderWorldMap(data)}
      <div class="rt-live" data-rt-live-strip>
        ${kpiCard({ title: 'Seats 30m', value: String(data.roi.seats30m), sub: 'unique seats last 30 min', spark: sparklineLine(k.liveSeries) })}
        ${kpiCard({ title: 'Live', value: String(data.roi.liveSeats), sub: 'seats online now · heartbeat &lt; 2 min', pill: '<span class="live">live</span>', spark: '' })}
        <article class="card activity-feed" style="padding-bottom:10px" data-live-feed>
          <p class="eyebrow">Live events</p>
          ${
            data.events.length
              ? `<div id="rt-stream">${renderEvents(data.events.slice(0, 30), data.now)}</div>`
              : '<div class="empty">No live events yet. A heartbeat writes city and lands here.</div>'
          }
        </article>
      </div>
      ${renderRealtimeGeo(data)}
      <article class="card" style="padding-bottom:10px" data-live-presence>
        <p class="eyebrow">${liveSeats.length ? 'Live people' : 'People'}</p>
        ${
          liveSeats.length
            ? renderPeopleStrip(liveSeats, liveSeats.length)
            : data.profiles.length
              ? renderPeopleStrip(data.profiles, 0)
              : '<div class="empty">No seats yet. Heartbeat writes city from request.cf.</div>'
        }
      </article>
    </section>

    <section class="page wrap" data-page="map" hidden aria-hidden="true"></section>

    <section class="page wrap" data-page="sessions" hidden>
      ${renderSessions(data)}
      ${detailDrawer({ id: 'seat-overlay' })}
    </section>

    <section class="page wrap" data-page="events" hidden>
      <article class="card" style="padding-bottom:10px">
        <p class="eyebrow">Events</p>
        <input class="search-bar" id="events-search" type="search" placeholder="Search events, computers, SSO, country…" autocomplete="off">
        <table id="events-table"><thead><tr><th>Created at</th><th>Name</th><th>Profile</th><th>City</th><th>Device</th><th>OS</th></tr></thead><tbody>${eventRows}</tbody></table>
        ${
          eventRows
            ? '<div class="sub muted" style="padding-bottom:8px">Real HMAC ingest only. Token-shaped values are dropped. Empty search shows every row.</div>'
            : '<div class="empty">No events yet.</div>'
        }
      </article>
    </section>

    <section class="page wrap" data-page="licenses" hidden>
      <article class="card" style="padding-bottom:10px">
        <p class="eyebrow">Generate license</p>
        ${renderLicenseGenerate(data)}
      </article>
      <article class="card" style="padding-bottom:10px">
        <p class="eyebrow">Licenses</p>
        ${renderLicenses(data)}
      </article>
    </section>

    <section class="page wrap" data-page="notifications" hidden>
      <article class="card" style="padding-bottom:10px">
        <p class="eyebrow">Notifications</p>
        <div class="sub muted" style="padding-bottom:8px">Pending seat approvals, failed CRM pushes, and skill diffs. Real D1. Not a stub.</div>
        ${
          noticeRows
            ? `<table data-notice-table><thead><tr><th>Kind</th><th>Title</th><th>Profile</th><th>City</th><th>OS</th><th>When</th></tr></thead><tbody>${noticeRows}</tbody></table>`
            : '<div class="empty">Nothing needs Tony right now.</div>'
        }
      </article>
      <article class="card" style="padding-bottom:10px" data-crm-notices>
        <p class="eyebrow">Data-push telemetry</p>
        <div class="sub muted" style="padding-bottom:8px">Outbound Métis → CRM / DB. Seat HMAC ingest <code>event=crm</code> → Operator D1 <code>crm_sends</code> → named connector. Retry marks retry_requested; the seat processes it. Never auto-send.</div>
        <div class="crm-kpis">
          ${kpiCard({ title: 'Landed today', value: String(landing.landedToday), sub: 'success with a remote id', spark: '' })}
          ${kpiCard({ title: 'Fail rate', value: failRate, sub: 'failed + expired over attempted', spark: '' })}
          ${kpiCard({ title: 'Retries', value: String(landing.retries), sub: 'Tony Retry or attempt over 1', spark: '' })}
          ${kpiCard({ title: 'Dead letters', value: String(landing.deadLetters), sub: 'max attempts, Expired', spark: '' })}
        </div>
        ${funnelRows ? `<p class="eyebrow">Funnel by connector</p><div class="crm-funnel">${funnelRows}</div>` : ''}
        <div class="funnel tabs" id="crm-filters">
          <button class="tab on" data-crm-filter="all">All ${data.crm.rows.length}</button>
          ${funnelTabs}
        </div>
        ${
          crmRows
            ? `<table id="crm-table"><thead><tr><th>Status</th><th>Title</th><th>Connector</th><th>Remote</th><th>Try</th><th>Meeting</th><th>When</th><th></th></tr></thead><tbody>${crmRows}</tbody></table>`
            : '<div class="empty">No outbound pushes ingested yet.</div>'
        }
      </article>
      <article class="card" style="padding-bottom:10px" data-skill-notices>
        <div class="row" style="margin-bottom:8px">
          <p class="eyebrow" style="margin:0">Skill upgrades</p>
          <button data-draft="interview">Draft interview</button>
          <button data-draft="recruiting">Draft recruiting</button>
          <button data-draft="support">Draft support</button>
        </div>
        ${props || '<div class="empty">No skill upgrades waiting. Use Ask in a mode, then Draft.</div>'}
      </article>
    </section>

    <section class="page wrap" data-page="keys" hidden>
      <article class="card" style="padding-bottom:10px">
        <p class="eyebrow">Keys</p>
        <div class="sub muted" style="padding-bottom:8px">Tony adds LLM APIs and Cloudflare here. last4 only. Never a secret, cipher, token, or grant. After a seat is approved, these keys are the default Ask path. CLI tokens stay on the seat.</div>
        <table>
          <thead><tr><th>Binding</th><th>Status</th></tr></thead>
          <tbody>
            <tr><td>Ingest HMAC</td><td>${data.keys.ingestBound ? 'bound' : 'missing'}</td></tr>
            <tr><td>Prompt key</td><td>${data.keys.promptBound ? 'bound' : 'missing'}</td></tr>
            <tr><td>Skill signing</td><td>${data.keys.skillBound ? 'bound' : 'missing'}</td></tr>
            <tr><td>Vault key</td><td>${data.keys.vaultBound ? 'bound' : 'missing'}</td></tr>
          </tbody>
        </table>
        <p class="eyebrow" style="margin-top:14px">Add an API</p>
        <form class="key-form" id="key-add" autocomplete="off">
          <div class="row">
            <select name="provider" required>
              <option value="anthropic">Anthropic</option>
              <option value="openai">OpenAI</option>
              <option value="gemini">Gemini</option>
              <option value="nvidia">NVIDIA NIM</option>
              <option value="deepseek">DeepSeek</option>
              <option value="minimax">MiniMax</option>
              <option value="qwen">Qwen</option>
              <option value="kimi">Kimi</option>
              <option value="openrouter">OpenRouter</option>
              <option value="groq">Groq</option>
              <option value="mistral">Mistral</option>
              <option value="grok">Grok</option>
              <option value="custom">Custom</option>
            </select>
            <input name="label" type="text" placeholder="Label" maxlength="80">
            <input name="secret" type="password" placeholder="API key" required autocomplete="off">
            <button class="primary" type="submit">Add</button>
          </div>
        </form>
        <p class="eyebrow">Cloudflare · AI Gateway</p>
        <p class="sub muted">Choose Cloudflare. Log in to the Cloudflare account. Operator adds the API key. No paste. Métis Settings tile stays on KineticGrid.</p>
        ${
          data.keys.oauthBound
            ? ''
            : `<div class="fail-loud" data-cf-oauth-missing>${esc(CF_OAUTH_MISSING)}</div>`
        }
        <div data-cf-overview>${renderCloudflare(data.cloudflare)}</div>
        <p><a class="btn primary" id="cf-connect" data-cf-aig-connect href="/cloudflare/connect">Log in to Cloudflare</a></p>
        <p id="cf-connect-msg" class="muted" style="padding:8px 0"></p>
        <p class="eyebrow" style="margin-top:14px">Vault</p>
        <table>
          <thead><tr><th>Provider</th><th>Label</th><th>Last4</th><th>Status</th><th>Rotate</th><th>Revoke</th></tr></thead>
          <tbody>${vaultRows || ''}</tbody>
        </table>
        ${vaultRows ? '' : '<div class="empty">No provider keys on Operator yet. Add an API or Cloudflare here so seats can be funded.</div>'}
        <div id="key-msg" class="muted" style="padding:8px 0"></div>
      </article>
    </section>

    <section class="page wrap" data-page="settings" hidden>
      <article class="card" style="padding-bottom:10px">
        <p class="eyebrow">Settings</p>
        <div class="rule"><h3>Access keep</h3><p>Cloudflare Access email-code only. Allowlist tony.walteur@gmail.com and twalteur@amaris.com. No homemade login.</p></div>
        <div class="rule"><h3>Generate license</h3><p>Licenses → duration → Generate license. Paste the once-string into Métis Identity. last4 after reload.</p></div>
        <div class="rule"><h3>Geo</h3><p>City / region / country come from request.cf on heartbeat. Never client GPS. Never IP.</p></div>
        <p id="key-msg-settings" class="muted"></p>
      </article>
    </section>
  `

  const shellHtml = shell(ctx, {
    page: 'overview',
    title: 'Overview',
    live: k.live,
    email: data.email,
    navCounts: { licenses: pendingApprovals, notifications: data.notices.length },
    bodyHtml
  })

  return `<!doctype html>
<html lang="en"${htmlThemeAttr}><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Métis Operator</title>
<link rel="stylesheet" href="${SPA_CSS_PATH}"${nonceAttr}>
</head>
<body>
<svg id="spark-defs"><defs>
  <linearGradient id="spark-fill" x1="0" x2="0" y1="0" y2="1">
    <stop offset="0" stop-color="#e4e4e7" stop-opacity="0.28"/>
    <stop offset="1" stop-color="#e4e4e7" stop-opacity="0"/>
  </linearGradient>
</defs></svg>
${shellHtml}
<script src="${SPA_JS_PATH}" defer${nonceAttr}></script>
</body></html>`
}

