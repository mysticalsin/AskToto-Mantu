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
    return `<div class="nav-sec"><p>${esc(sec.label)}</p>${items}</div>`
  }).join('')
  return `<nav id="rail-nav">${sections}</nav>`
}

function seriesDelta(values: number[]): { text: string; cls: string } {
  if (values.length < 4) return { text: '0%', cls: 'flat' }
  const mid = Math.floor(values.length / 2)
  const a = values.slice(0, mid).reduce((n, v) => n + v, 0) / mid
  const b = values.slice(mid).reduce((n, v) => n + v, 0) / (values.length - mid)
  if (a === 0) return { text: '0%', cls: 'flat' }
  const pct = ((b - a) / a) * 100
  if (!Number.isFinite(pct)) return { text: '0%', cls: 'flat' }
  const rounded = Math.abs(pct) < 0.05 ? 0 : Math.round(pct * 10) / 10
  if (rounded === 0) return { text: '0%', cls: 'flat' }
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

function formatDuration(ms: number | null): string {
  if (ms == null) return '0'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  return `${Math.round(ms / 60_000)}m`
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
      <span class="delta ${d.cls}">${esc(d.text)}</span>
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

function osIcon(os: string): string {
  const k = os.toLowerCase()
  if (k.includes('darwin') || k.includes('mac')) return '<i class="ic-mac" title="macOS"></i>'
  if (k.includes('win')) return '<i class="ic-win" title="Windows"></i>'
  if (!os) return ''
  return '<i class="ic-desk" title="device"></i>'
}

function osKind(os: string): 'mac' | 'windows' | 'linux' | 'desk' {
  const k = os.toLowerCase()
  if (k.includes('darwin') || k.includes('mac')) return 'mac'
  if (k.includes('win')) return 'windows'
  if (k.includes('linux')) return 'linux'
  return 'desk'
}

function osBadge(os: string): string {
  const kind = osKind(os)
  const label = kind === 'desk' ? 'os' : kind
  return `<span class="os-badge ${kind}" title="${esc(os || 'os')}">${label === 'windows' ? 'win' : label}</span>`
}

function seatStatus(lastSeen: number, now: number): { id: 'active' | 'paused' | 'inactive'; label: string } {
  const age = now - lastSeen
  if (age <= ONLINE_MS) return { id: 'active', label: 'Active' }
  if (age <= 30 * 60 * 1000) return { id: 'paused', label: 'Paused' }
  return { id: 'inactive', label: 'Inactive' }
}

function freshnessPct(lastSeen: number, now: number): number {
  const age = Math.max(0, now - lastSeen)
  const window = 30 * 60 * 1000
  return Math.max(6, Math.round((1 - Math.min(age, window) / window) * 100))
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

function renderEvents(events: ConsoleEvent[], now: number): string {
  const head = `<div class="event event-head" aria-hidden="true">
      <div>Created at</div><div>Name</div><div>Profile</div><div>Country</div><div>OS</div><div>Browser</div>
    </div>`
  if (!events.length) return `${head}<div class="empty">No events yet.</div>`
  const rows = events
    .map((e) => {
      const name = looksLikeSecret(e.name) ? 'event' : e.name
      const profile = e.hostname || e.email || null
      const place = [e.city, e.country].filter((v) => v && !looksLikeSecret(v)).join(' · ')
      const browser = e.browser && !looksLikeSecret(e.browser) ? e.browser : null
      const q = `${name} ${profile || ''} ${place} ${e.os || ''} ${browser || ''}`.toLowerCase()
      return `<div class="event" data-event="${esc(e.id)}" data-q="${esc(q)}">
        <div class="event-time">${esc(ago(e.ts, now))}</div>
        <div class="event-name">${esc(name)}</div>
        <div class="event-profile">${field(profile)}</div>
        <div class="event-country">${place ? esc(place) : MISSING}</div>
        <div class="event-os">${e.os ? `${osIcon(e.os)} ${esc(e.os)}` : MISSING}</div>
        <div class="event-os">${browser ? esc(browser) : MISSING}</div>
      </div>`
    })
    .join('')
  return `${head}${rows}`
}

function renderSeatTable(rows: ProfileRow[], events: ConsoleEvent[], now: number): string {
  const head = `<div class="seat-head" aria-hidden="true">
      <div>No</div><div>Seat / computer</div><div>Location</div><div>Identity</div><div>Last seen</div><div>Live</div><div>Status</div>
    </div>`
  if (!rows.length) {
    return `<div class="seat-card" data-seat-table>${head}<div class="empty" style="padding:28px 16px">No seats on the fleet yet. Heartbeats will fill this. Empty is an empty card, not sample servers.</div>
    <div class="seat-overlay" id="seat-overlay" hidden>
      <div class="row" style="justify-content:space-between">
        <h4 data-seat-title>Seat</h4>
        <button type="button" id="seat-overlay-close">Close</button>
      </div>
      <div data-seat-body></div>
    </div>
  </div>`
  }
  const body = rows
    .map((r, i) => {
      const status = seatStatus(r.lastSeen, now)
      const name = r.hostname || r.email || `seat ${r.device}`
      const identity = r.email || r.hostname || MISSING
      const loc = [r.city, r.country].filter((v) => v && !looksLikeSecret(v)).join(' · ')
      const meter = freshnessPct(r.lastSeen, now)
      const recent = events
        .filter((e) => (r.hostname && e.hostname === r.hostname) || (r.email && e.email === r.email))
        .slice(0, 6)
        .map((e) => `${ago(e.ts, now)} · ${looksLikeSecret(e.name) ? 'event' : e.name}`)
        .join(' | ')
      const detail = [
        `OS ${r.os || MISSING} · ${r.appVersion || MISSING}`,
        `License ${r.license && !looksLikeSecret(r.license) ? r.license : MISSING} · IP ${MISSING}`,
        `Last seen ${when(r.lastSeen)}`,
        recent ? `Recent: ${recent}` : 'No recent heartbeats for this seat.'
      ].join(' · ')
      const no = String(i + 1).padStart(2, '0')
      return `<div class="seat-row" data-seat-row data-country="${esc(r.country || '')}" data-os="${esc(r.os)}" data-seat-name="${esc(name)}" data-seat-detail="${esc(detail)}">
        <div class="seat-no">${no}</div>
        <div class="seat-name">${osBadge(r.os)} ${field(r.hostname)}</div>
        <div class="seat-loc">${r.country ? `<span class="seat-flag">${esc(r.country)}</span>` : ''}${loc ? esc(loc) : MISSING}</div>
        <div>${identity === MISSING ? MISSING : esc(identity)}</div>
        <div class="muted">${esc(ago(r.lastSeen, now))}</div>
        <div class="seat-meter" title="Heartbeat freshness"><i style="width:${meter}%"></i></div>
        <div><span class="seat-status ${status.id}">${status.label}</span></div>
      </div>`
    })
    .join('')
  return `<div class="seat-card" data-seat-table>
    ${head}${body}
    <div class="seat-overlay" id="seat-overlay" hidden>
      <div class="row" style="justify-content:space-between">
        <h4 data-seat-title>Seat</h4>
        <button type="button" id="seat-overlay-close">Close</button>
      </div>
      <div data-seat-body></div>
    </div>
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
      return `<tr data-status="${esc(r.status)}">
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
        (p) => `<tr>
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
  const live30Series = ops.liveSeries
  const world = shoeyWorld(data.map.countries, data.map.dots)
  const geoRows = data.profiles
    .filter((p) => p.country || p.city)
    .map((p) => ({
      name: [p.city, p.country].filter(Boolean).join(' · ') || '(Not set)',
      views: 1,
      sess: p.live ? 1 : 0
    }))
  const crmMix = mixRows(data.crm.funnel.map((f) => ({ label: f.connector, value: f.attempted })))
  const listenRows = mixRows(
    data.events
      .filter((e) => /listen|recap/i.test(e.name))
      .map((e) => ({ label: e.name, value: 1 }))
  )
  const modeRows = mixRows(data.asks.map((a) => ({ label: a.mode || 'ask', value: 1 })).reduce((acc, row) => {
    const hit = acc.find((x) => x.label === row.label)
    if (hit) hit.value += 1
    else acc.push(row)
    return acc
  }, [] as { label: string; value: number }[]))
  const skillRows = mixRows(data.proposals.map((p) => ({ label: p.skill_id, value: 1 })))
  const stream = data.events.slice(0, 24)

  return `<!doctype html>
<html lang="en"><head>
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
    <div class="rail-brand">
      <span class="rail-logo">M</span>
      <h1>Métis</h1>
      <span class="chev">▾</span>
    </div>
    ${renderNav()}
    <div class="rail-foot">
      <div class="rail-utils">
        <a href="#notifications">Give feedback</a>
        <a href="#settings">Docs</a>
        <form method="post" action="/logout"><button type="submit">Back to workspace</button></form>
      </div>
      <div class="who">${esc(data.email)}</div>
      <button class="theme-btn" id="theme-btn" type="button">Theme</button>
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
      <h2 id="page-title" hidden>Overview</h2>
    </header>

    <section class="page wrap" data-page="overview">
      ${renderOverviewMini10(data)}
      <article class="card" style="padding-bottom:10px" data-cf-overview>
        <p class="eyebrow">Cloudflare</p>
        ${renderCloudflare(data.cloudflare)}
      </article>
    </section>

    <section class="page wrap" data-page="realtime" hidden>
      <div class="rt-grid">
        <div>
          <article class="card kpi rt-unique" style="padding-bottom:10px">
            <h3 class="rt-h">Unique seats last 30 min</h3>
            <div class="n rt-n">${formatCompact(live30)}</div>
            ${blueBars(live30Series, 280, 56)}
          </article>
          <article class="card" style="padding:8px 10px 10px;margin-top:10px">
            <div class="rt-stream" id="rt-stream">
              ${
                stream.length
                  ? stream
                      .map((e) => {
                        const name = looksLikeSecret(e.name) ? 'event' : e.name
                        const ago = data.now - e.ts < 90_000 ? 'just now' : when(e.ts)
                        const os = e.chips.find((c) => c.key === 'os')?.value || ''
                        return `<div class="rt-row">
                          <span>${esc(name)}<span class="rt-ics">${osIcon(os)}</span></span>
                          <span class="ago">${esc(ago)}</span>
                        </div>`
                      })
                      .join('')
                  : '<div class="empty">No live events yet.</div>'
              }
            </div>
          </article>
        </div>
        <article class="card rt-map" style="padding:0;overflow:hidden">
          <div id="map-root" style="position:relative">${world}</div>
        </article>
      </div>
      <div class="grid-3">
        ${volumeTable(
          'geo',
          [{ id: 'geo', label: 'Geo' }],
          { geo: geoRows.length ? geoRows : [] },
          'Search geo',
          { value: 'Events', sess: 'Sessions' },
          'blue'
        )}
        ${volumeTable(
          'rt-refs',
          [{ id: 'refs', label: 'Referrals' }],
          { refs: crmMix.length ? crmMix : listenRows },
          'Search referrals',
          { value: 'Events', sess: 'Sessions' },
          'blue'
        )}
        ${volumeTable(
          'rt-paths',
          [{ id: 'path', label: 'Paths' }],
          { path: modeRows },
          'Search paths',
          { value: 'Events', sess: 'Sessions' },
          'blue'
        )}
      </div>
    </section>

    <section class="page wrap" data-page="events" hidden>
      <div class="ev-head">
        <div>
          <h3 class="rt-h">Events</h3>
          <p class="muted ev-sub">Seat heartbeats and Asks. Token-free.</p>
        </div>
        <span class="live-events" data-live-events="${data.events.length}"><i></i>${data.events.length} events</span>
      </div>
      <div class="tabs ev-tabs"><button class="tab on" type="button">Events</button></div>
      <article class="card ev-table-card" style="padding-bottom:10px">
        <input class="table-search" id="events-search" type="search" placeholder="Search events" autocomplete="off">
        <div id="events-list">${renderEvents(data.events, data.now)}</div>
      </article>
    </section>

    <section class="page wrap" data-page="sessions" hidden>
      <div class="ev-head">
        <div>
          <h3 class="rt-h">Sessions</h3>
          <p class="muted ev-sub">Seats that checked in. Computer and SSO email from the seat. Missing fields are ${MISSING}, never invented.</p>
        </div>
        <span class="live-events"><i></i>${data.profiles.length} seats</span>
      </div>
      ${renderSeatTable(data.profiles, data.events, data.now)}
    </section>

    <section class="page wrap" data-page="notifications" hidden>
      <div class="nt-head">
        <div>
          <h3 class="rt-h">Notifications</h3>
          <p class="muted nt-sub">Failed CRM sends and pending skill diffs. Honest empty. Never fake alerts.</p>
        </div>
      </div>
      <article class="card" style="padding-bottom:10px">
        <div class="crm-kpis">
          ${kpiCard({ title: 'Landed today', value: String(landing.landedToday), sub: 'success with a CRM id when the connector returned one', spark: '' })}
          ${kpiCard({ title: 'Fail rate', value: failRate, sub: 'failed + expired over attempted', spark: '' })}
          ${kpiCard({ title: 'Retries', value: String(landing.retries), sub: 'Tony Retry or attempt over 1', spark: '' })}
          ${kpiCard({ title: 'Dead letters', value: String(landing.deadLetters), sub: 'max attempts, Expired', spark: '' })}
        </div>
        ${funnelRows ? `<p class="eyebrow">Funnel by connector</p><div class="crm-funnel">${funnelRows}</div>` : ''}
        <div class="funnel tabs" id="crm-filters">
          <button class="tab on" data-crm-filter="all">All ${data.crm.rows.length}</button>
          ${funnelTabs}
        </div>
        <table id="nt-table">
          <thead><tr><th>Title</th><th>Integration</th><th>Country</th><th>OS</th><th>Browser</th><th>Profile</th><th>Created at</th></tr></thead>
          <tbody>
            ${
              notifyRows ||
              `<tr data-nt-empty><td colspan="7" class="empty">No data. We could not find any notifications here yet.</td></tr>`
            }
          </tbody>
        </table>
        ${
          crmRows
            ? `<table id="crm-table" hidden><thead><tr><th>Status</th><th>Title</th><th>Connector</th><th>Remote</th><th>Try</th><th>Meeting</th><th>When</th><th></th></tr></thead><tbody>${crmRows}</tbody></table>`
            : ''
        }
      </article>
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
        <div id="key-msg" class="muted" style="padding:8px 0"></div>
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

