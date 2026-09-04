import {
  bars,
  blueArea,
  blueBars,
  dualLine,
  heatmapGrid,
  shoeyWorld,
  sparklineArea,
  sparklineLine,
  stackedTokens
} from './charts'
import { statusBadge } from './components/ui/status-badge'
import { renderOverviewMini10 } from './overview-cards'
import { SPA_CSS_PATH, SPA_JS_PATH } from './spa/manifest'
import { CRM_FILTER_ORDER } from './crm'
import type { CloudflareOverview } from './cloudflare'
import { ONLINE_MS, type ConsoleEvent, type DashboardPayload, type ProfileRow } from './dashboard'
import { EXTRA_PAGES, FORBIDDEN_NAV, NAV_IDS, NAV_SECTIONS } from './nav'
import { looksLikeSecret } from './redact'
import { productLabel } from './product'
import { countryName, flagMark } from './countries'

const MISSING = '—'

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;')
}

function when(ts: number): string {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 16)
}

function ago(ts: number, now: number): string {
  const d = now - ts
  if (d < 90_000) return 'just now'
  if (d < 3_600_000) {
    const m = Math.max(1, Math.round(d / 60_000))
    return m === 1 ? '1 minute ago' : `${m} minutes ago`
  }
  if (d < 86_400_000) {
    const h = Math.max(1, Math.round(d / 3_600_000))
    return h === 1 ? '1 hour ago' : `${h} hours ago`
  }
  return when(ts)
}

function field(value: string | null | undefined): string {
  if (!value || looksLikeSecret(value)) return MISSING
  return esc(value)
}

function renderCloudflare(cf: CloudflareOverview): string {
  if (!cf.connected) {
    return `<div class="kpis" data-cf-idle>
      ${kpiCard({ title: 'Requests', value: '0', sub: `${cf.worker} · ${cf.range}`, spark: '' })}
      ${kpiCard({ title: 'Errors', value: '0', sub: cf.worker, spark: '' })}
      ${kpiCard({ title: 'CPU', value: '0', sub: 'cpuTimeMs', spark: '' })}
    </div>
    <div class="sub muted" style="padding-bottom:8px">Connect Cloudflare (login) on Keys. No token on seats. Worker ${esc(cf.worker)}.</div>`
  }
  if (cf.error) {
    return `<div class="fail-loud" data-cf-error>${esc(cf.error)}</div>
      <div class="sub muted" style="padding-bottom:8px">Worker ${esc(cf.worker)}. Connect Cloudflare (login) on Keys. No token on seats.</div>`
  }
  const workers = cf.workers.length ? cf.workers.map((w) => esc(w)).join(', ') : 'none listed'
  const req = cf.requests == null ? '0' : String(cf.requests)
  const err = cf.errors == null ? '0' : String(cf.errors)
  const cpu = cf.cpuMs == null ? '0' : `${cf.cpuMs} ms`
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

function renderNav(): string {
  const sections = NAV_SECTIONS.map((sec) => {
    const items = sec.items
      .map(
        (item) =>
          `<a class="nav-item" data-nav="${item.id}" href="#${item.id}">${esc(item.label)}</a>`
      )
      .join('')
    const heading = sec.label ? `<p>${esc(sec.label)}</p>` : ''
    return `<div class="nav-sec">${heading}${items}</div>`
  }).join('')
  return `<nav id="rail-nav">${sections}</nav>`
}

function seriesDelta(values: number[]): { text: string; cls: string } | null {
  if (values.length < 4) return null
  const mid = Math.floor(values.length / 2)
  const a = values.slice(0, mid).reduce((n, v) => n + v, 0) / mid
  const b = values.slice(mid).reduce((n, v) => n + v, 0) / (values.length - mid)
  if (a < 1) return null
  const pct = ((b - a) / a) * 100
  if (!Number.isFinite(pct) || Math.abs(pct) > 400) return null
  const rounded = Math.abs(pct) < 0.05 ? 0 : Math.round(pct * 10) / 10
  if (rounded === 0) return null
  const sign = rounded > 0 ? '↑' : '↓'
  return { text: `${sign} ${Math.abs(rounded)}%`, cls: rounded > 0 ? 'up' : 'down' }
}

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`
  if (n >= 1000) return `${Math.round(n / 100) / 10}K`
  return String(n)
}

function reported(value: string | number | null | undefined, format?: (n: number) => string): string {
  if (value == null) return '0'
  if (typeof value === 'number') return format ? format(value) : formatCompact(value)
  return value
}

function formatPct(n: number | null): string {
  if (n == null) return '0%'
  return `${n}%`
}

function shoeyKpi(title: string, value: string, series: number[]): string {
  const d = seriesDelta(series)
  return `<article class="card kpi">
    <p class="eyebrow">${esc(title)}</p>
    <div class="kpi-top">
      <div class="n">${esc(value)}</div>
      ${d ? `<span class="delta ${d.cls}">${esc(d.text)}</span>` : ''}
    </div>
    ${blueBars(series)}
  </article>`
}

function volumeTable(
  id: string,
  tabs: { id: string; label: string }[],
  groups: Record<string, { name: string; views: number; sess: number }[]>,
  searchPh: string,
  cols: { value: string; sess: string } = { value: 'Views', sess: 'Sess' },
  bar: 'gray' | 'blue' = 'gray'
): string {
  const tabBtns = tabs
    .map((t, i) => `<button class="tab${i === 0 ? ' on' : ''}" data-vol-tab="${id}:${t.id}" type="button">${esc(t.label)}</button>`)
    .join('')
  const barCls = bar === 'blue' ? 'vol-bar blue' : 'vol-bar'
  const panes = tabs
    .map((t, i) => {
      const rows = rollupVol(groups[t.id] || [])
      const max = Math.max(1, ...rows.map((r) => r.views))
      const body = rows.length
        ? rows
            .map((r) => {
              const w = Math.round((r.views / max) * 100)
              return `<div class="vol-row" data-q="${esc(r.name.toLowerCase())}">
                <span class="${barCls}" style="width:${w}%"></span>
                <span>${esc(r.name)}</span>
                <span class="muted">${r.views}</span>
                <span class="muted">${r.sess}</span>
              </div>`
            })
            .join('')
        : `<div class="empty">No ${esc(t.label.toLowerCase())} in this window.</div>`
      return `<div data-vol-pane="${id}:${t.id}" ${i === 0 ? '' : 'hidden'}>
        <div class="vol-row muted" style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase">
          <span></span><span>${esc(cols.value)}</span><span>${esc(cols.sess)}</span>
        </div>
        ${body}
      </div>`
    })
    .join('')
  return `<article class="card table-card" style="padding-bottom:10px">
    <div class="tabs">${tabBtns}</div>
    <input class="table-search" data-vol-search="${id}" type="search" placeholder="${esc(searchPh)}" autocomplete="off">
    ${panes}
  </article>`
}

function rollupVol(rows: { name: string; views: number; sess: number }[]): { name: string; views: number; sess: number }[] {
  const by = new Map<string, { name: string; views: number; sess: number }>()
  for (const row of rows) {
    const hit = by.get(row.name)
    if (hit) {
      hit.views += row.views
      hit.sess += row.sess
    } else {
      by.set(row.name, { ...row })
    }
  }
  return [...by.values()].sort((a, b) => b.views - a.views)
}

function osKind(os: string): 'mac' | 'windows' | 'linux' | 'desk' {
  const k = os.toLowerCase()
  if (k.includes('darwin') || k.includes('mac')) return 'mac'
  if (k.includes('win')) return 'windows'
  if (k.includes('linux')) return 'linux'
  return 'desk'
}

function osIcon(os: string): string {
  const kind = osKind(os)
  if (kind === 'mac') {
    return '<span class="brand-mark os-mark mac" title="macOS" aria-label="macOS"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M16.5 3.2c-.9.1-2 .7-2.6 1.5-.6.7-1.1 1.8-.9 2.8 1 .1 2-.5 2.6-1.3.6-.8 1-1.9.9-3zM19.8 12.3c-.1-2.1 1.7-3.1 1.8-3.2-1-1.4-2.5-1.6-3-1.7-1.3-.1-2.5.8-3.1.8-.7 0-1.7-.7-2.8-.7-1.4 0-2.8.9-3.5 2.2-1.5 2.6-.4 6.5 1.1 8.6.7 1 1.6 2.2 2.7 2.1 1.1 0 1.5-.7 2.8-.7s1.6.7 2.8.7c1.2 0 1.9-1 2.6-2 .8-1.2 1.1-2.3 1.1-2.4-.1 0-2.2-.9-2.5-3.7z"/></svg></span>'
  }
  if (kind === 'windows') {
    return '<span class="brand-mark os-mark win" title="Windows" aria-label="Windows"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M3 5.5l8-.9v7.2H3V5.5zm9-.9l9-1.1v8.3h-9V4.6zM3 12.9h8v7.3l-8-.9v-6.4zm9 0h9v8.4l-9-1.2v-7.2z"/></svg></span>'
  }
  if (kind === 'linux') {
    return '<span class="brand-mark os-mark linux" title="Linux" aria-label="Linux"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M12.5 2.2c-.6 0-1.2.5-1.4 1.2-.3 1.1.1 2.3.7 3.3-.9.3-1.7 1-2.2 1.9-.8 1.4-.8 3.2-.2 5.1.4 1.3.4 2.2-.2 3.1-.5.7-1.4 1.1-2.2 1.5-.6.3-1.1.8-1 1.4.1.7.8 1 1.5 1.1 1.2.2 2.4-.2 3.3-.9.4 1.2 1.2 2.2 2.4 2.2 1.1 0 1.9-.9 2.3-2 .8.5 1.8.8 2.8.6.8-.1 1.5-.6 1.5-1.3 0-.6-.5-1-1.1-1.3-.7-.3-1.5-.7-1.9-1.3-.5-.8-.5-1.7-.1-3 .6-1.9.7-3.7-.1-5.1-.5-.9-1.3-1.6-2.3-1.9.4-.9.6-1.9.3-2.8-.3-.9-1-1.5-1.8-1.5z"/></svg></span>'
  }
  if (!os) return ''
  return '<span class="brand-mark os-mark desk" title="device" aria-label="device"><i class="ic-desk"></i></span>'
}

function browserIcon(browser: string | null | undefined): string {
  if (!browser || looksLikeSecret(browser)) return ''
  const k = browser.toLowerCase()
  if (k.includes('electron') || k.includes('metis') || k.includes('métis')) {
    return '<span class="brand-mark browser-mark electron" title="Electron" aria-label="Electron"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><circle cx="12" cy="12" r="2.2" fill="currentColor"/><ellipse cx="12" cy="12" rx="10" ry="4.2" fill="none" stroke="currentColor" stroke-width="1.4"/><ellipse cx="12" cy="12" rx="10" ry="4.2" fill="none" stroke="currentColor" stroke-width="1.4" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="10" ry="4.2" fill="none" stroke="currentColor" stroke-width="1.4" transform="rotate(120 12 12)"/></svg></span>'
  }
  return `<span class="brand-mark browser-mark" title="${esc(browser)}">${esc(browser.slice(0, 2).toUpperCase())}</span>`
}

function countryCell(country: string | null | undefined, city: string | null | undefined): string {
  const cc = country && !looksLikeSecret(country) ? country.trim().toUpperCase() : ''
  const cityOk = city && !looksLikeSecret(city) ? city : ''
  if (!cc && !cityOk) return MISSING
  const flag = cc ? `<span class="flag-mark" title="${esc(countryName(cc) || cc)}">${flagMark(cc)}</span>` : ''
  const label = [cityOk, cc ? countryName(cc) || cc : ''].filter(Boolean).join(' · ')
  return `<span class="country-cell">${flag}<span>${esc(label)}</span></span>`
}

function profileCell(profile: string | null | undefined): string {
  if (!profile || looksLikeSecret(profile)) return MISSING
  return `<span class="profile-cell">${seatAvatar(profile)}<span>${esc(profile)}</span></span>`
}

function osBadge(os: string): string {
  const kind = osKind(os)
  const label = kind === 'desk' ? 'os' : kind
  return `<span class="os-badge ${kind}" title="${esc(os || 'os')}">${osIcon(os)}<span class="os-badge-label">${label === 'windows' ? 'win' : label}</span></span>`
}

function seatStatus(lastSeen: number, now: number): { id: 'active' | 'paused' | 'inactive'; label: string } {
  const age = now - lastSeen
  if (age <= ONLINE_MS) return { id: 'active', label: 'Active' }
  if (age <= 30 * 60 * 1000) return { id: 'paused', label: 'Paused' }
  return { id: 'inactive', label: 'Inactive' }
}

function emptyPage(id: string, title: string, hook: string): string {
  return `<section class="page wrap" data-page="${id}" hidden>
    <div class="empty-card">
      <h3>${esc(title)}</h3>
      <p>${esc(hook)}</p>
    </div>
  </section>`
}

function mixRows(items: { label: string; value: number }[]): { name: string; views: number; sess: number }[] {
  return items
    .filter((i) => i.label && !looksLikeSecret(i.label))
    .map((i) => ({ name: i.label, views: i.value, sess: i.value }))
}

function dayLabel(ts: number): string {
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

function emptyData(copy = 'We could not find any data here yet'): string {
  return `<div class="empty-data">
      <div class="empty-dash" aria-hidden="true"></div>
      <strong>No data</strong>
      <p>${esc(copy)}</p>
    </div>`
}

function renderEvents(events: ConsoleEvent[], now: number): string {
  const head = `<div class="event event-head" aria-hidden="true">
      <div>Created at</div><div>Name</div><div>Profile</div><div>Country</div><div>OS</div><div>Browser</div>
    </div>`
  if (!events.length) return `${head}${emptyData('No events yet.')}`
  const rows = events
    .map((e) => {
      const name = looksLikeSecret(e.name) ? 'event' : e.name
      const profile = e.hostname || e.email || null
      const place = [e.city, e.country].filter((v) => v && !looksLikeSecret(v)).join(' · ')
      const browser = e.browser && !looksLikeSecret(e.browser) ? e.browser : null
      const chips = e.chips.map((c) => `${c.key} ${c.value}`).join(' ')
      const path = e.chips.find((c) => c.key === 'path')?.value || '/'
      const q = `${name} ${path} ${profile || ''} ${place} ${e.os || ''} ${browser || ''} ${chips}`.toLowerCase()
      const browserCell = browser
        ? `<span class="browser-cell">${browserIcon(browser)}<span>${esc(browser)}</span></span>`
        : MISSING
      const osCell = e.os ? `<span class="os-cell">${osIcon(e.os)}<span>${esc(e.os)}</span></span>` : MISSING
      return `<div class="event" data-event="${esc(e.id)}" data-q="${esc(q)}">
        <div class="event-time" title="${esc(when(e.ts))}">${esc(ago(e.ts, now))}</div>
        <div class="event-name">${esc(name)}</div>
        <div class="event-profile">${profileCell(profile)}</div>
        <div class="event-country">${countryCell(e.country, e.city)}</div>
        <div class="event-os">${osCell}</div>
        <div class="event-browser">${browserCell}</div>
      </div>`
    })
    .join('')
  return `${head}${rows}`
}

function eventStats(events: ConsoleEvent[]): string {
  const counts = new Map<string, number>()
  for (const e of events) {
    const name = looksLikeSecret(e.name) ? 'event' : e.name
    counts.set(name, (counts.get(name) || 0) + 1)
  }
  if (!counts.size) return emptyData()
  const rows = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => `<div class="stat-line"><span>${esc(name)}</span><b>${n}</b></div>`)
    .join('')
  return `<p class="eyebrow">Live ingest</p>${rows}`
}

function sessionPath(events: ConsoleEvent[], which: 'entry' | 'exit'): string {
  if (!events.length) return 'heartbeat'
  const row = which === 'entry' ? events[events.length - 1] : events[0]
  const path = row.chips.find((c) => c.key === 'path')?.value
  if (path && path !== '/' && !looksLikeSecret(path)) return path
  const name = looksLikeSecret(row.name) ? 'event' : row.name
  return name || 'heartbeat'
}

function sessionDuration(ms: number): string {
  if (ms < 1000) return '0s'
  if (ms < 60_000) {
    const s = ms / 1000
    return s < 10 && s % 1 >= 0.05 ? `${Math.round(s * 10) / 10}s` : `${Math.round(s)}s`
  }
  return `${Math.round(ms / 60_000)}m`
}

function heartbeatFreshness(lastSeen: number, now: number): number {
  const age = now - lastSeen
  if (age <= ONLINE_MS) return 100
  if (age <= 30 * 60 * 1000) return Math.max(36, Math.round(100 - (age / (30 * 60 * 1000)) * 64))
  const hours = age / (60 * 60 * 1000)
  return Math.max(8, Math.round(28 - Math.min(20, hours)))
}

const AVATAR_PASTELS = ['#BBF7D0', '#BFDBFE', '#FBCFE8', '#FDE68A', '#DDD6FE', '#FED7AA']

function seatAvatar(seed: string): string {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  const bg = AVATAR_PASTELS[h % AVATAR_PASTELS.length]
  const initial = (seed.replace(/[^A-Za-z0-9]/g, '')[0] || 'M').toUpperCase()
  return `<span class="sess-avatar" style="background:${bg}" aria-hidden="true">${esc(initial)}</span>`
}

function iconSearch(): string {
  return '<svg class="tool-ic" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M10.4 10.4L14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>'
}

function iconFilter(): string {
  return '<svg class="tool-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 3.5h12L9.5 9v4l-3 1.2V9L2 3.5z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>'
}

function iconView(): string {
  return '<svg class="tool-ic" viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2" width="5" height="5" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="9" y="2" width="5" height="5" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="2" y="9" width="5" height="5" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="9" y="9" width="5" height="5" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>'
}

function seatOverlayChrome(): string {
  return `<div class="seat-overlay" id="seat-overlay" hidden>
      <div class="seat-overlay-head">
        <div>
          <p class="eyebrow">Seat <span data-seat-no></span></p>
          <h4 data-seat-title>Seat</h4>
        </div>
        <button type="button" id="seat-overlay-close">Close</button>
      </div>
      <div class="seat-overlay-grid" data-seat-body></div>
    </div>`
}

function eventsForSeat(events: ConsoleEvent[], r: ProfileRow): ConsoleEvent[] {
  return events
    .filter(
      (e) =>
        (e.device && e.device === r.device) ||
        (r.hostname && e.hostname === r.hostname) ||
        (r.email && e.email === r.email)
    )
    .sort((a, b) => b.ts - a.ts)
}

function renderSeatTable(rows: ProfileRow[], events: ConsoleEvent[], now: number): string {
  const head = `<div class="seat-head sess-head" aria-hidden="true">
      <div>Started</div><div>Session id</div><div>Profile</div><div>Entry page</div><div>Exit page</div><div>Duration</div>
    </div>`
  if (!rows.length) {
    return `<div class="seat-card" data-seat-table>${head}<div class="empty" style="padding:28px 16px">No seats on the fleet yet. Heartbeats will fill this. Empty is an empty card, not sample servers.</div>
    ${seatOverlayChrome()}
  </div>`
  }
  const body = rows
    .map((r, i) => {
      const status = seatStatus(r.lastSeen, now)
      const computer = r.hostname && !looksLikeSecret(r.hostname) ? r.hostname : MISSING
      const identity = r.email && !looksLikeSecret(r.email) ? r.email : computer
      const loc = [r.city, r.country].filter((v) => v && !looksLikeSecret(v)).join(' · ') || MISSING
      const license = r.license && !looksLikeSecret(r.license) ? r.license : MISSING
      const mine = eventsForSeat(events, r)
      const recent = mine
        .slice(0, 6)
        .map((e) => `${ago(e.ts, now)} · ${looksLikeSecret(e.name) ? 'event' : e.name}`)
        .join(' | ')
      const started = r.firstSeen || r.lastSeen
      const entry = sessionPath(mine, 'entry')
      const exit = sessionPath(mine, 'exit')
      const dur = sessionDuration(Math.max(0, r.lastSeen - started))
      const meter = heartbeatFreshness(r.lastSeen, now)
      const bars = (mine.length ? mine.slice(0, 8).map((e) => e.ts) : [r.lastSeen])
        .map((t) => String(heartbeatFreshness(t, now)))
        .join(',')
      const q = `${computer} ${r.device} ${identity} ${r.os} ${entry} ${exit} ${loc} ${status.label} ${license}`.toLowerCase()
      const no = String(i + 1).padStart(2, '0')
      return `<div class="seat-row sess-row" data-seat-row data-q="${esc(q)}" data-country="${esc(r.country || '')}" data-os="${esc(r.os)}" data-seat-name="${esc(computer)}" data-seat-computer="${esc(computer)}" data-seat-identity="${esc(identity)}" data-seat-location="${esc(loc)}" data-seat-ip="${MISSING}" data-seat-license="${esc(license)}" data-seat-status="${esc(status.label)}" data-seat-status-id="${status.id}" data-seat-meter="${meter}" data-seat-bars="${esc(bars)}" data-seat-last="${esc(when(r.lastSeen))}" data-seat-version="${esc(r.appVersion || MISSING)}" data-seat-session="${esc(r.device)}" data-seat-recent="${esc(recent)}" data-seat-no="${no}">
        <div class="muted">${esc(ago(started, now))}</div>
        <div class="sess-id" title="${esc(r.device)}">${esc(r.device)}${r.device.length >= 8 ? '…' : ''}</div>
        <div class="sess-profile">${seatAvatar(computer === MISSING ? r.device : computer)} ${osBadge(r.os)} <span class="sess-host">${computer === MISSING ? MISSING : esc(computer)}</span></div>
        <div class="muted">${esc(entry)}</div>
        <div class="muted">${esc(exit)}</div>
        <div>${esc(dur)}</div>
      </div>`
    })
    .join('')
  return `<div class="seat-card" data-seat-table>
    ${head}${body}
    ${seatOverlayChrome()}
  </div>`
}

function renderLicenses(rows: ProfileRow[]): string {
  if (!rows.length) return '<div class="empty">No seats on the fleet yet.</div>'
  const body = rows
    .map(
      (r) => `<tr>
        <td>${field(r.hostname)}</td>
        <td>${field(r.email)}</td>
        <td>${field(r.license)}</td>
        <td class="muted">${esc(r.os)}</td>
        <td class="muted">${esc(r.appVersion)}</td>
      </tr>`
    )
    .join('')
  return `<table><thead><tr><th>Computer</th><th>SSO email</th><th>License</th><th>OS</th><th>Version</th></tr></thead><tbody>${body}</tbody></table>`
}

export function renderConsole(data: DashboardPayload): string {
  const k = data.kpis
  const ops = data.ops
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
  const funnelTabs = CRM_FILTER_ORDER.map(
    (s) =>
      `<button class="tab" data-crm-filter="${s}" type="button">${statusBadge(s)} ${data.crm.counts[s]}</button>`
  ).join('')
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
  const notifyRows = [
    ...data.crm.rows.map((r) => {
      const seat = data.profiles.find((p) => r.device && p.device === r.device)
      const unread = r.status === 'pending' || r.status === 'draft' || r.status === 'failed'
      return `<tr data-status="${esc(r.status)}" data-nt-row${unread ? ' class="nt-unread"' : ''}>
        <td>${esc(r.title)}</td>
        <td class="muted">${esc(r.connector)}</td>
        <td class="muted">${esc(seat?.country || MISSING)}</td>
        <td class="muted">${esc(seat?.os || MISSING)}</td>
        <td class="muted">${MISSING}</td>
        <td class="muted">${field(seat?.hostname || seat?.email)}</td>
        <td class="muted">${esc(ago(r.ts, data.now))}</td>
      </tr>`
    }),
    ...data.proposals
      .filter((p) => p.status === 'pending' || p.status === 'draft')
      .map(
        (p) => `<tr data-status="${esc(p.status)}" data-nt-row class="nt-unread">
        <td>${esc(p.skill_id)} ${esc(p.status)}</td>
        <td class="muted">skill</td>
        <td class="muted">${MISSING}</td>
        <td class="muted">${MISSING}</td>
        <td class="muted">${MISSING}</td>
        <td class="muted">${field(p.created_by)}</td>
        <td class="muted">${esc(ago(p.created_at, data.now))}</td>
      </tr>`
      )
  ].join('')
  void FORBIDDEN_NAV
  void NAV_IDS
  void EXTRA_PAGES
  void renderLicenses
  void shoeyKpi
  void sparklineArea
  void sparklineLine

  const live30 = ops.live30
  const live30Series = ops.live30Series
  const world = shoeyWorld(data.map.countries, data.map.dots)
  const liveProfiles = data.profiles.filter((p) => p.live30)
  const liveWindow = data.now - 30 * 60 * 1000
  const recentEvents = data.events.filter((e) => e.ts >= liveWindow)

  const geoAgg = new Map<
    string,
    { iso: string; city: string; label: string; events: number; sessions: number; devices: Set<string> }
  >()
  const bumpGeo = (iso: string, city: string | null, device: string | null, asEvent: boolean): void => {
    const cc = iso && !looksLikeSecret(iso) ? iso.trim().toUpperCase() : ''
    const cityOk = city && !looksLikeSecret(city) ? city : ''
    if (!cc && !cityOk) return
    const key = `${cc}|${cityOk || '(Not set)'}`
    const countryLabel = cc ? countryName(cc) || cc : ''
    const label = countryLabel
      ? `${cityOk || '(Not set)'}, ${countryLabel}`
      : cityOk || '(Not set)'
    let row = geoAgg.get(key)
    if (!row) {
      row = { iso: cc, city: cityOk || '(Not set)', label, events: 0, sessions: 0, devices: new Set() }
      geoAgg.set(key, row)
    }
    if (asEvent) row.events += 1
    if (device) row.devices.add(device)
  }
  for (const p of liveProfiles) {
    bumpGeo(p.country || '', p.city, p.device, false)
  }
  for (const e of recentEvents) {
    bumpGeo(e.country || '', e.city, e.device, true)
  }
  const geoRows = [...geoAgg.values()]
    .map((r) => ({
      iso: r.iso,
      city: r.city,
      label: r.label,
      events: r.events || r.devices.size,
      sessions: r.devices.size || (r.events ? 1 : 0)
    }))
    .sort((a, b) => b.events - a.events || b.sessions - a.sessions)
  const geoFlags = [...new Set(geoRows.map((r) => r.iso).filter(Boolean))].slice(0, 8)
  const geoMax = Math.max(1, ...geoRows.map((r) => r.events))
  const geoBreakdown = `<article class="geo-card" data-geo-breakdown>
      <div class="geo-head">
        <h3 class="geo-title">Geo</h3>
        <div class="geo-flags" aria-hidden="true">${geoFlags.map((iso) => flagMark(iso)).join('')}</div>
      </div>
      <div class="geo-cols" aria-hidden="true"><span>Country / City</span><span>Events</span><span>Sessions</span></div>
      <div class="geo-list" id="geo-list">
        ${
          geoRows.length
            ? geoRows
                .map((r) => {
                  const w = Math.max(4, Math.round((r.events / geoMax) * 100))
                  const flag = r.iso ? `<span class="flag-mark">${flagMark(r.iso)}</span>` : ''
                  const q = `${r.iso} ${r.city} ${r.label}`.toLowerCase()
                  return `<div class="geo-row" data-iso="${esc(r.iso)}" data-q="${esc(q)}">
                    <span class="geo-bar" style="width:${w}%"></span>
                    <span class="geo-place">${flag}<span>${esc(r.label)}</span></span>
                    <span class="geo-n">${r.events}</span>
                    <span class="geo-n">${r.sessions}</span>
                  </div>`
                })
                .join('')
            : `<div class="empty geo-empty">No live geo yet. When a Métis app heartbeats, Cloudflare request.cf fills city and country here.</div>`
        }
      </div>
    </article>`


  const osAgg = new Map<string, { label: string; events: number; sessions: number }>()
  for (const p of liveProfiles) {
    const label = (p.os || 'unknown').trim() || 'unknown'
    const row = osAgg.get(label) || { label, events: 0, sessions: 0 }
    row.sessions += 1
    osAgg.set(label, row)
  }
  for (const e of recentEvents) {
    const label = (e.os || 'unknown').trim() || 'unknown'
    const row = osAgg.get(label) || { label, events: 0, sessions: 0 }
    row.events += 1
    osAgg.set(label, row)
  }
  const osRows = [...osAgg.values()].sort((a, b) => b.events - a.events || b.sessions - a.sessions)
  const osMax = Math.max(1, ...osRows.map((r) => r.events || r.sessions))
  const osBreakdown = `<article class="rt-board-card" data-os-breakdown>
      <div class="rt-board-head"><h3 class="rt-board-title">OS</h3></div>
      <div class="rt-board-cols" aria-hidden="true"><span>OS</span><span>Events</span><span>Seats</span></div>
      <div class="rt-board-list">
        ${
          osRows.length
            ? osRows
                .map((r) => {
                  const w = Math.max(4, Math.round(((r.events || r.sessions) / osMax) * 100))
                  return `<div class="rt-board-row">
                    <span class="rt-board-bar" style="width:${w}%"></span>
                    <span class="rt-board-place">${esc(r.label)}</span>
                    <span class="rt-board-n">${r.events}</span>
                    <span class="rt-board-n">${r.sessions}</span>
                  </div>`
                })
                .join('')
            : `<div class="empty">No OS mix yet. Heartbeats fill macOS / Windows here.</div>`
        }
      </div>
    </article>`

  const kindAgg = new Map<string, { label: string; events: number; sessions: Set<string> }>()
  for (const e of recentEvents) {
    const label = (e.name || 'event').trim() || 'event'
    const row = kindAgg.get(label) || { label, events: 0, sessions: new Set<string>() }
    row.events += 1
    if (e.device) row.sessions.add(e.device)
    kindAgg.set(label, row)
  }
  const kindRows = [...kindAgg.values()]
    .map((r) => ({ label: r.label, events: r.events, sessions: r.sessions.size || (r.events ? 1 : 0) }))
    .sort((a, b) => b.events - a.events || b.sessions - a.sessions)
  const kindMax = Math.max(1, ...kindRows.map((r) => r.events))
  const kindBreakdown = `<article class="rt-board-card" data-kind-breakdown>
      <div class="rt-board-head"><h3 class="rt-board-title">Event kinds</h3></div>
      <div class="rt-board-cols" aria-hidden="true"><span>Kind</span><span>Events</span><span>Seats</span></div>
      <div class="rt-board-list">
        ${
          kindRows.length
            ? kindRows
                .map((r) => {
                  const w = Math.max(4, Math.round((r.events / kindMax) * 100))
                  return `<div class="rt-board-row">
                    <span class="rt-board-bar" style="width:${w}%"></span>
                    <span class="rt-board-place">${esc(r.label)}</span>
                    <span class="rt-board-n">${r.events}</span>
                    <span class="rt-board-n">${r.sessions}</span>
                  </div>`
                })
                .join('')
            : `<div class="empty">No event kinds yet. Asks and heartbeats land here.</div>`
        }
      </div>
    </article>`

  // OpenPanel Realtime parity (WebsiteCloner): Sources / Surfaces / Cities — Métis nouns, never Referrals/Paths.
  const sourceAgg = new Map<string, { label: string; events: number; sessions: Set<string> }>()
  for (const p of liveProfiles) {
    const label =
      (p.hostname && !looksLikeSecret(p.hostname) && p.hostname.trim()) ||
      (p.email && !looksLikeSecret(p.email) && p.email.trim()) ||
      'unknown'
    const row = sourceAgg.get(label) || { label, events: 0, sessions: new Set<string>() }
    row.sessions.add(p.device)
    sourceAgg.set(label, row)
  }
  for (const e of recentEvents) {
    const label =
      (e.hostname && !looksLikeSecret(e.hostname) && e.hostname.trim()) ||
      (e.email && !looksLikeSecret(e.email) && e.email.trim()) ||
      'unknown'
    const row = sourceAgg.get(label) || { label, events: 0, sessions: new Set<string>() }
    row.events += 1
    if (e.device) row.sessions.add(e.device)
    sourceAgg.set(label, row)
  }
  const sourceRows = [...sourceAgg.values()]
    .map((r) => ({ label: r.label, events: r.events, sessions: r.sessions.size || (r.events ? 1 : 0) }))
    .sort((a, b) => b.events - a.events || b.sessions - a.sessions)
    .slice(0, 12)
  const sourceMax = Math.max(1, ...sourceRows.map((r) => r.events || r.sessions))
  const sourceBreakdown = `<article class="rt-board-card" data-source-breakdown>
      <div class="rt-board-head"><h3 class="rt-board-title">Sources</h3></div>
      <div class="rt-board-cols" aria-hidden="true"><span>Source</span><span>Events</span><span>Seats</span></div>
      <div class="rt-board-list">
        ${
          sourceRows.length
            ? sourceRows
                .map((r) => {
                  const w = Math.max(4, Math.round(((r.events || r.sessions) / sourceMax) * 100))
                  return `<div class="rt-board-row">
                    <span class="rt-board-bar" style="width:${w}%"></span>
                    <span class="rt-board-place">${esc(r.label)}</span>
                    <span class="rt-board-n">${r.events}</span>
                    <span class="rt-board-n">${r.sessions}</span>
                  </div>`
                })
                .join('')
            : `<div class="empty">No sources yet. Live seat hostnames land here.</div>`
        }
      </div>
    </article>`

  const surfaceAgg = new Map<string, { label: string; events: number; sessions: Set<string> }>()
  for (const e of recentEvents) {
    const pathChip = e.chips.find((c) => c.key === 'path')?.value
    const label =
      (pathChip && pathChip !== '/' && !looksLikeSecret(pathChip) && pathChip.trim()) ||
      (e.name && !looksLikeSecret(e.name) && e.name.trim()) ||
      'event'
    const row = surfaceAgg.get(label) || { label, events: 0, sessions: new Set<string>() }
    row.events += 1
    if (e.device) row.sessions.add(e.device)
    surfaceAgg.set(label, row)
  }
  const surfaceRows = [...surfaceAgg.values()]
    .map((r) => ({ label: r.label, events: r.events, sessions: r.sessions.size || (r.events ? 1 : 0) }))
    .sort((a, b) => b.events - a.events || b.sessions - a.sessions)
    .slice(0, 12)
  const surfaceMax = Math.max(1, ...surfaceRows.map((r) => r.events))
  const surfaceBreakdown = `<article class="rt-board-card" data-surface-breakdown>
      <div class="rt-board-head"><h3 class="rt-board-title">Surfaces</h3></div>
      <div class="rt-board-cols" aria-hidden="true"><span>Surface</span><span>Events</span><span>Seats</span></div>
      <div class="rt-board-list">
        ${
          surfaceRows.length
            ? surfaceRows
                .map((r) => {
                  const w = Math.max(4, Math.round((r.events / surfaceMax) * 100))
                  return `<div class="rt-board-row">
                    <span class="rt-board-bar" style="width:${w}%"></span>
                    <span class="rt-board-place">${esc(r.label)}</span>
                    <span class="rt-board-n">${r.events}</span>
                    <span class="rt-board-n">${r.sessions}</span>
                  </div>`
                })
                .join('')
            : `<div class="empty">No surfaces yet. Asks and heartbeats fill entry points here.</div>`
        }
      </div>
    </article>`

  const cityAgg = new Map<string, { label: string; iso: string; events: number; sessions: Set<string> }>()
  for (const p of liveProfiles) {
    const city = p.city && !looksLikeSecret(p.city) ? p.city.trim() : ''
    if (!city) continue
    const iso = p.country && !looksLikeSecret(p.country) ? p.country.trim().toUpperCase() : ''
    const label = iso ? `${city}, ${countryName(iso) || iso}` : city
    const row = cityAgg.get(label) || { label, iso, events: 0, sessions: new Set<string>() }
    row.sessions.add(p.device)
    cityAgg.set(label, row)
  }
  for (const e of recentEvents) {
    const city = e.city && !looksLikeSecret(e.city) ? e.city.trim() : ''
    if (!city) continue
    const iso = e.country && !looksLikeSecret(e.country) ? e.country.trim().toUpperCase() : ''
    const label = iso ? `${city}, ${countryName(iso) || iso}` : city
    const row = cityAgg.get(label) || { label, iso, events: 0, sessions: new Set<string>() }
    row.events += 1
    if (e.device) row.sessions.add(e.device)
    cityAgg.set(label, row)
  }
  const cityRows = [...cityAgg.values()]
    .map((r) => ({ label: r.label, iso: r.iso, events: r.events, sessions: r.sessions.size || (r.events ? 1 : 0) }))
    .sort((a, b) => b.events - a.events || b.sessions - a.sessions)
    .slice(0, 12)
  const cityMax = Math.max(1, ...cityRows.map((r) => r.events || r.sessions))
  const cityBreakdown = `<article class="rt-board-card" data-city-breakdown>
      <div class="rt-board-head"><h3 class="rt-board-title">Cities</h3></div>
      <div class="rt-board-cols" aria-hidden="true"><span>City</span><span>Events</span><span>Seats</span></div>
      <div class="rt-board-list">
        ${
          cityRows.length
            ? cityRows
                .map((r) => {
                  const w = Math.max(4, Math.round(((r.events || r.sessions) / cityMax) * 100))
                  const flag = r.iso ? `<span class="flag-mark">${flagMark(r.iso)}</span>` : ''
                  return `<div class="rt-board-row">
                    <span class="rt-board-bar" style="width:${w}%"></span>
                    <span class="rt-board-place">${flag}<span>${esc(r.label)}</span></span>
                    <span class="rt-board-n">${r.events}</span>
                    <span class="rt-board-n">${r.sessions}</span>
                  </div>`
                })
                .join('')
            : `<div class="empty">No cities yet. Cloudflare request.cf fills city when a seat heartbeats.</div>`
        }
      </div>
    </article>`


  const appAgg = new Map<string, { label: string; events: number; sessions: Set<string> }>()
  for (const p of liveProfiles) {
    const label = productLabel(p.product)
    const row = appAgg.get(label) || { label, events: 0, sessions: new Set<string>() }
    row.sessions.add(p.device)
    appAgg.set(label, row)
  }
  for (const e of recentEvents) {
    const profile = liveProfiles.find((p) => p.device === e.device)
    const label = productLabel(profile?.product ?? null)
    const row = appAgg.get(label) || { label, events: 0, sessions: new Set<string>() }
    row.events += 1
    if (e.device) row.sessions.add(e.device)
    appAgg.set(label, row)
  }
  const appRows = [...appAgg.values()]
    .map((r) => ({ label: r.label, events: r.events, sessions: r.sessions.size || (r.events ? 1 : 0) }))
    .sort((a, b) => b.events - a.events || b.sessions - a.sessions)
  const appMax = Math.max(1, ...appRows.map((r) => r.events || r.sessions))
  const appsBreakdown = `<article class="rt-board-card" data-apps-breakdown>
      <div class="rt-board-head"><h3 class="rt-board-title">Apps</h3></div>
      <div class="rt-board-cols" aria-hidden="true"><span>App</span><span>Events</span><span>Seats</span></div>
      <div class="rt-board-list">
        ${
          appRows.length
            ? appRows
                .map((r) => {
                  const w = Math.max(4, Math.round(((r.events || r.sessions) / appMax) * 100))
                  return `<div class="rt-board-row">
                    <span class="rt-board-bar" style="width:${w}%"></span>
                    <span class="rt-board-place">${esc(r.label)}</span>
                    <span class="rt-board-n">${r.events}</span>
                    <span class="rt-board-n">${r.sessions}</span>
                  </div>`
                })
                .join('')
            : `<div class="empty">No Métis apps detected yet. Desktop, Overlay, iOS, Mac, and Windows heartbeats land here.</div>`
        }
      </div>
    </article>`

  const activeSeats = liveProfiles.length

  const activity = recentEvents.length
    ? recentEvents
        .slice()
        .sort((a, b) => b.ts - a.ts)
        .slice(0, 40)
        .map((e, i) => {
          const who =
            e.email && !looksLikeSecret(e.email)
              ? e.email
              : e.hostname && !looksLikeSecret(e.hostname)
                ? e.hostname
                : e.device || MISSING
          const place = [e.city, e.country ? countryName(e.country) || e.country : '']
            .filter((v) => v && !looksLikeSecret(v))
            .join(', ')
          return `<div class="rt-activity-row" style="--i:${i}">
            <span class="rt-activity-dot" aria-hidden="true"></span>
            <div class="rt-activity-body">
              <div class="rt-activity-name">${esc(e.name || 'event')}</div>
              <div class="rt-activity-meta">${esc(who)}${place ? ` · ${esc(place)}` : ''}</div>
            </div>
            <span class="rt-activity-ago">${esc(ago(e.ts, data.now))}</span>
          </div>`
        })
        .join('')
    : `<div class="empty">No live activity in the last 30 minutes. Heartbeats and asks appear here.</div>`

  const roster = liveProfiles.length
    ? liveProfiles
        .map((p, i) => {
          const computer = p.hostname && !looksLikeSecret(p.hostname) ? p.hostname : MISSING
          const identity =
            p.email && !looksLikeSecret(p.email) ? p.email : computer !== MISSING ? computer : p.device
          const place = [p.city, p.country ? countryName(p.country) || p.country : '']
            .filter((v) => v && !looksLikeSecret(v))
            .join(' · ') || MISSING
          const ago = data.now - p.lastSeen < 90_000 ? 'just now' : when(p.lastSeen)
          const version = p.appVersion && !looksLikeSecret(p.appVersion) ? p.appVersion : MISSING
          const app = productLabel(p.product)
          const q = [identity, computer, place, p.os, app, p.device].join(' ').toLowerCase()
          const iso = p.country && !looksLikeSecret(p.country) ? p.country.trim().toUpperCase() : ''
          return `<div class="rt-seat" style="--i:${i}" data-device="${esc(p.device)}" data-iso="${esc(iso)}" data-product="${esc(p.product || '')}" data-q="${esc(q)}" tabindex="0" role="button">
            <div class="rt-seat-top">
              ${seatAvatar(identity === MISSING ? p.device : identity)}
              ${osBadge(p.os)}
              <div class="rt-seat-who">
                <div class="rt-seat-sig">${identity === MISSING ? MISSING : esc(identity)}</div>
                ${
                  computer !== MISSING && computer !== identity
                    ? `<div class="rt-seat-host">${esc(computer)}</div>`
                    : ''
                }
              </div>
              <span class="rt-seat-ago">${esc(ago)}</span>
            </div>
            <div class="rt-seat-meta">
              <span>${esc(place)}</span>
              <span class="rt-seat-app">${esc(app)}</span>
              <span>v${esc(version)}</span>
            </div>
          </div>`
        })
        .join('')
    : '<div class="rt-roster-empty empty">No live Métis seats in the last 30 minutes. Open the app so a heartbeat can land — email, hostname, and device show here.</div>'

  return `<!doctype html>
<html lang="en" data-theme="dark"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Métis Operator</title>
<link rel="stylesheet" href="${SPA_CSS_PATH}">
<script src="${SPA_JS_PATH}" defer></script>
</head>
<body>
<svg id="spark-defs"><defs>
  <linearGradient id="spark-fill" x1="0" x2="0" y1="0" y2="1">
    <stop offset="0" stop-color="#2563EB" stop-opacity="0.28"/>
    <stop offset="1" stop-color="#2563EB" stop-opacity="0"/>
  </linearGradient>
  <linearGradient id="shoey-fill" x1="0" x2="0" y1="0" y2="1">
    <stop offset="0" stop-color="#2563EB" stop-opacity="0.22"/>
    <stop offset="1" stop-color="#2563EB" stop-opacity="0"/>
  </linearGradient>
</defs></svg>
<div class="shell">
  <aside class="rail">
    <div class="rail-brand" title="Métis">
      <span class="rail-logo" aria-label="Métis">M</span>
      <span class="rail-name">Métis</span>
    </div>
    ${renderNav()}
    <div class="rail-foot">
      <div class="rail-utils">
        <a href="#notifications">Give feedback</a>
        <a href="#settings">Docs</a>
        <form method="post" action="/logout"><button type="submit">Back to workspace</button></form>
      </div>
      <div class="who">${esc(data.email)}</div>
      <button class="theme-btn" id="theme-btn" type="button" aria-pressed="true" aria-label="Night mode on. Switch to light mode." title="Switch to light mode">Night</button>
    </div>
  </aside>
  <div class="main">
    <header class="top">
      <div class="top-left">
        <button class="tool" type="button">Last 7 days</button>
        <button class="tool" type="button">Day</button>
        <button class="tool" type="button">Filters</button>
      </div>
      <input class="top-search" type="search" placeholder='Try: "last 7 days, seats only"' autocomplete="off">
      <div class="top-right">
        <span class="live-dot"><i></i>${live30}</span>
        <button class="tool" type="button">Private</button>
      </div>
      <h2 id="page-title" hidden>Realtime</h2>
    </header>

    <section class="page wrap" data-page="overview" hidden>
      ${renderOverviewMini10(data)}
      <article class="card ov-cf-secondary" style="padding-bottom:10px" data-cf-overview>
        <p class="eyebrow">Cloudflare</p>
        ${renderCloudflare(data.cloudflare)}
      </article>
    </section>

    <section class="page wrap" data-page="realtime">
      <div class="page-hero" data-live-map>
        <h3 class="page-title">Live map</h3>
        <p class="page-sub">Active seats on the globe with signatures. Pins use Cloudflare request.cf only. Heartbeats stream on Events.</p>
      </div>
      <div class="rt-shoey" data-rt-layout="shoey">
        <div class="rt-shoey-left">
          <div class="rt-kpi-bar">
            <div class="rt-kpi">
              <span class="rt-hud-lbl">Unique seats last 30 min</span>
              <div class="n rt-n">${formatCompact(live30)}</div>
            </div>
            <div class="rt-kpi rt-kpi-active">
              <span class="rt-hud-lbl">Active seats</span>
              <div class="n rt-n">${formatCompact(activeSeats)}</div>
            </div>
            <div class="rt-kpi-spark" aria-hidden="true">${blueBars(live30Series, 280, 48)}</div>
          </div>
          <aside class="rt-roster" id="rt-roster" aria-label="Live seat signatures">
            <div class="rt-roster-head">
              <h3 class="rt-h">Live seats</h3>
              <span class="rt-roster-count">${formatCompact(live30)}</span>
            </div>
            <div class="rt-roster-list">${roster}</div>
          </aside>
          <article class="rt-activity" id="rt-activity" aria-label="Live activity">
            <div class="rt-roster-head">
              <h3 class="rt-h">Activity</h3>
              <span class="rt-roster-count">${formatCompact(recentEvents.length)}</span>
            </div>
            <div class="rt-activity-list">${activity}</div>
          </article>
        </div>
        <article class="rt-map-full">
          <div id="map-root" data-land="inline" style="position:relative">${world}</div>
        </article>
      </div>
      <div class="rt-boards" data-rt-boards="full">
        ${geoBreakdown}
        ${cityBreakdown}
        ${appsBreakdown}
        ${sourceBreakdown}
        ${surfaceBreakdown}
        ${osBreakdown}
        ${kindBreakdown}
      </div>
    </section>


    <section class="page wrap" data-page="events" hidden>
      <div class="page-hero">
        <h3 class="page-title">Events</h3>
        <p class="page-sub">Heartbeats, asks, and conversions as they land. Live seat geography stays on Realtime.</p>
      </div>
      <div class="page-tabs" role="tablist">
        <button class="page-tab on" type="button" data-ev-tab="events">Events</button>
        <button class="page-tab" type="button" data-ev-tab="conversions">Conversions</button>
        <button class="page-tab" type="button" data-ev-tab="stats">Stats</button>
      </div>
      <div class="page-toolbar">
        <span class="listen-pill" data-live-events="${data.events.length}"><i></i>Listening</span>
        <button class="tool" type="button">Date range</button>
        <button class="tool" type="button" id="events-filters">${iconFilter()} Filters</button>
        <label class="search-wrap">
          ${iconSearch()}
          <input class="table-search toolbar-search" id="events-search" type="search" placeholder="Search ..." autocomplete="off">
        </label>
        <button class="tool page-view" type="button">${iconView()} View</button>
      </div>
      <article class="card ev-table-card table-frame" data-ev-pane="events" style="padding-bottom:10px">
        <div id="events-list">${renderEvents(data.events, data.now)}</div>
        <div class="empty" id="events-empty" hidden>${emptyData('No events match that search.')}</div>
      </article>
      <article class="card table-frame" data-ev-pane="conversions" hidden>
        ${
          data.events.some((e) => /^ask$/i.test(e.name))
            ? renderEvents(
                data.events.filter((e) => /^ask$/i.test(e.name)),
                data.now
              )
            : emptyData('No Asks yet. Heartbeats stay on Events.')
        }
      </article>
      <article class="card table-frame" data-ev-pane="stats" hidden>
        ${eventStats(data.events)}
      </article>
    </section>

    <section class="page wrap" data-page="sessions" hidden>
      <div class="page-hero">
        <h3 class="page-title">Sessions</h3>
        <p class="page-sub">Access all your sessions here. Live Métis seats only — no sample rows.</p>
      </div>
      <div class="page-toolbar">
        <label class="search-wrap">
          ${iconSearch()}
          <input class="table-search toolbar-search" id="sessions-search" type="search" placeholder="Search ..." autocomplete="off">
        </label>
        <button class="tool" type="button" id="sessions-filters">${iconFilter()} Filters</button>
        <button class="tool page-view" type="button">${iconView()} View</button>
      </div>
      ${renderSeatTable(data.profiles, data.events, data.now)}
      <div class="empty" id="sessions-empty" hidden>No sessions match that search.</div>
    </section>

    <section class="page wrap" data-page="notifications" hidden>
      <div class="page-hero nt-head">
        <h3 class="page-title">Notifications</h3>
        <p class="page-sub nt-sub">See notifications and manage your rules when to get notifications</p>
      </div>
      <div class="page-tabs underline" role="tablist">
        <button class="page-tab on" type="button" data-nt-tab="notifications">Notifications</button>
        <button class="page-tab" type="button" data-nt-tab="rules">Rules</button>
      </div>
      <div class="page-toolbar">
        <label class="search-wrap">
          ${iconSearch()}
          <input class="table-search toolbar-search" id="nt-search" type="search" placeholder="Search ..." autocomplete="off">
        </label>
        <button class="tool" type="button">Created at</button>
        <button class="tool page-view" type="button">${iconView()} View</button>
      </div>
      <div data-nt-pane="notifications">
        <div class="tabs" id="crm-filters">
          <button class="tab on" data-crm-filter="all">All ${data.crm.rows.length}</button>
          ${funnelTabs}
        </div>
        <article class="card table-frame" style="padding-bottom:10px">
          <table id="nt-table">
            <thead><tr><th>Title</th><th>Integration</th><th>Country</th><th>OS</th><th>Browser</th><th>Profile</th><th>Created at</th></tr></thead>
            <tbody>
              ${notifyRows || ''}
              <tr data-nt-empty ${notifyRows ? 'hidden' : ''}><td colspan="7"><div class="nt-empty-wrap">${emptyData()}</div></td></tr>
            </tbody>
          </table>
          ${
            crmRows
              ? `<table id="crm-table" hidden><thead><tr><th>Status</th><th>Title</th><th>Connector</th><th>Remote</th><th>Try</th><th>Meeting</th><th>When</th><th></th></tr></thead><tbody>${crmRows}</tbody></table>`
              : ''
          }
        </article>
      </div>
      <div data-nt-pane="rules" hidden>
        <article class="card table-frame"><div class="nt-empty-wrap">${emptyData('No rules yet.')}</div></article>
      </div>
    </section>

    <section class="page wrap" data-page="map" hidden data-alias="realtime"></section>

    <section class="page wrap" data-page="keys" hidden>
      <article class="card" style="padding-bottom:10px">
        <p class="eyebrow">Keys</p>
        <div class="sub muted" style="padding-bottom:8px">Tony adds LLM APIs and Cloudflare here. last4 only. Never a secret, cipher, token, or grant. CLI tokens stay on the seat.</div>
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
        <p class="eyebrow">Cloudflare connection</p>
        <div class="sub muted" style="padding-bottom:8px">Login redirect. Not Account ID + token paste. Seats never hold a Cloudflare token.</div>
        <p><a class="btn primary" id="cf-connect" href="/cloudflare/connect">Connect Cloudflare</a></p>
        <p class="eyebrow" style="margin-top:14px">Vault</p>
        <table id="vault-table">
          <thead><tr><th>Provider</th><th>Label</th><th>Last4</th><th>Status</th><th>Rotate</th><th>Revoke</th></tr></thead>
          <tbody>
            ${
              vaultRows ||
              `<tr data-vault-empty><td colspan="6" class="empty">No provider keys on Operator yet. Add an API. Rotate and Revoke land on each row. Seats never hold the raw key.</td></tr>`
            }
          </tbody>
        </table>
        <div id="key-msg" class="key-msg" role="status"></div>
      </article>
    </section>

    <section class="page wrap" data-page="settings" hidden>
      <article class="card" style="padding-bottom:10px">
        <p class="eyebrow">Settings</p>
        <div class="sub muted" style="padding-bottom:8px">Keys fund seats. Add an API once. last4 only. Heartbeats list fundedProviders. Seats never hold the raw key.</div>
        <p class="eyebrow" style="margin-top:14px">Add an API</p>
        <form class="key-form" id="key-add-settings" autocomplete="off">
          <div class="row">
            <select name="provider" required>
              <option value="anthropic">Anthropic</option>
              <option value="openai">OpenAI</option>
              <option value="gemini">Gemini</option>
              <option value="nvidia">NVIDIA NIM</option>
              <option value="deepseek">DeepSeek</option>
              <option value="minimax">MiniMax</option>
            </select>
            <input name="label" type="text" placeholder="Label" maxlength="80">
            <input name="secret" type="password" placeholder="API key" required autocomplete="off">
            <button class="primary" type="submit">Add</button>
          </div>
        </form>
        <div id="key-msg-settings" class="key-msg" role="status"></div>
        <p><a href="#keys">Open Keys</a> for rotate / revoke and Cloudflare.</p>
      </article>
      <article class="card" style="padding-bottom:10px" data-cf-page>
        <p class="eyebrow">Cloudflare</p>
        ${renderCloudflare(data.cloudflare)}
      </article>
    </section>
  </div>
</div>
</body></html>`
}

