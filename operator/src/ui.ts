import {
  bars,
  choropleth,
  dualLine,
  heatmapGrid,
  sparklineArea,
  sparklineLine,
  stackedTokens
} from './charts'
import { statusBadge, STATUS_BADGE_CSS } from './components/ui/status-badge'
import { CRM_FILTER_ORDER } from './crm'
import type { ConsoleEvent, DashboardPayload, ProfileRow } from './dashboard'
import { FORBIDDEN_NAV, NAV_IDS, NAV_SECTIONS } from './nav'
import { looksLikeSecret } from './redact'

const MISSING = '—'

const CSS = `
@import url('https://cdn.jsdelivr.net/npm/geist@1.3.1/dist/fonts/geist-sans/style.min.css');
@import url('https://cdn.jsdelivr.net/npm/geist@1.3.1/dist/fonts/geist-mono/style.min.css');
:root, [data-theme="dark"] {
  --bg: #0a0a0b;
  --panel: #111113;
  --hair: rgba(255,255,255,0.10);
  --ink: rgba(255,255,255,0.94);
  --ink2: rgba(255,255,255,0.55);
  --ink3: rgba(255,255,255,0.38);
  --accent: #7C8CF8;
  --ok: #83C092;
  --danger: #F0717A;
  --land: #2a2a2e;
  --chart-1: #1a1a1d;
  --chart-2: #2a2a2e;
  --chart-3: #52525b;
  --chart-4: #a1a1aa;
  --chart-5: #e4e4e7;
  --nav: #0d0d0f;
  --nav-on: rgba(255,255,255,0.08);
  --dot: rgba(255,255,255,0.055);
  --mono: 'Geist Mono', ui-monospace, SFMono-Regular, monospace;
  --sans: 'Geist', Geist, Inter, system-ui, sans-serif;
}
[data-theme="light"] {
  --bg: #f4f4f5;
  --panel: #ffffff;
  --hair: rgba(15,15,17,0.10);
  --ink: #18181b;
  --ink2: rgba(24,24,27,0.62);
  --ink3: rgba(24,24,27,0.42);
  --land: #d4d4d8;
  --chart-1: #e4e4e7;
  --chart-2: #d4d4d8;
  --chart-3: #a1a1aa;
  --chart-4: #52525b;
  --chart-5: #18181b;
  --nav: #fafafa;
  --nav-on: rgba(15,15,17,0.06);
  --dot: rgba(15,15,17,0.08);
}
@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]) {
    --bg: #f4f4f5;
    --panel: #ffffff;
    --hair: rgba(15,15,17,0.10);
    --ink: #18181b;
    --ink2: rgba(24,24,27,0.62);
    --ink3: rgba(24,24,27,0.42);
    --land: #d4d4d8;
    --chart-1: #e4e4e7;
    --chart-2: #d4d4d8;
    --chart-3: #a1a1aa;
    --chart-4: #52525b;
    --chart-5: #18181b;
    --nav: #fafafa;
    --nav-on: rgba(15,15,17,0.06);
    --dot: rgba(15,15,17,0.08);
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; color: var(--ink); font: 12px/1.45 var(--sans); }
body {
  background-color: var(--bg);
  background-image: radial-gradient(var(--dot) 1px, transparent 1px);
  background-size: 14px 14px;
}
a { color: var(--accent); text-decoration: none; }
.shell { display: grid; grid-template-columns: 228px 1fr; min-height: 100%; }
.rail {
  display: flex; flex-direction: column; gap: 10px;
  background: var(--nav); border-right: 1px solid var(--hair);
  padding: 14px 12px 16px; min-height: 100vh; position: sticky; top: 0;
}
.rail-brand { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.rail-brand h1 { margin: 0; font-size: 14px; font-weight: 650; letter-spacing: -0.03em; }
.rail-search {
  width: 100%; border: 1px solid var(--hair); background: var(--panel); color: var(--ink);
  border-radius: 8px; padding: 7px 10px; font: 12px var(--sans);
}
.rail-search::placeholder { color: var(--ink3); }
.rail nav { display: flex; flex-direction: column; gap: 14px; flex: 1; }
.nav-sec { display: flex; flex-direction: column; gap: 2px; }
.nav-sec p {
  font-family: var(--mono); font-size: 10px; letter-spacing: 0.14em;
  text-transform: uppercase; color: var(--ink3); margin: 0 6px 4px;
}
.nav-item {
  display: block; padding: 7px 8px; border-radius: 8px; color: var(--ink);
  font-size: 13px; font-weight: 550;
}
.nav-item:hover { background: var(--nav-on); }
.nav-item.on { background: var(--nav-on); font-weight: 650; }
.rail-foot { margin-top: auto; display: flex; flex-direction: column; gap: 8px; padding-top: 12px; }
.who { font-family: var(--mono); font-size: 10px; color: var(--ink2); word-break: break-all; }
.theme-btn {
  border: 1px solid var(--hair); background: transparent; color: var(--ink2);
  font: 11px/1 var(--mono); letter-spacing: 0.06em; text-transform: uppercase;
  padding: 6px 8px; border-radius: 8px; cursor: pointer;
}
.main { min-width: 0; }
.top {
  display: flex; align-items: baseline; justify-content: space-between; gap: 16px;
  padding: 12px 16px; border-bottom: 1px solid var(--hair);
  background: color-mix(in srgb, var(--bg) 86%, transparent); position: sticky; top: 0; z-index: 4;
}
.top h2 { margin: 0; font-size: 16px; font-weight: 650; letter-spacing: -0.03em; }
.eyebrow {
  font-family: var(--mono); font-size: 10px; letter-spacing: 0.14em;
  text-transform: uppercase; color: var(--ink3); margin: 0 0 8px;
}
.wrap { padding: 12px 16px 36px; display: grid; gap: 12px; }
.kpis { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; }
.card {
  position: relative;
  background: var(--panel);
  border: 1px solid var(--hair);
  padding: 10px 12px 0;
  overflow: hidden;
}
.card::before, .card::after {
  content: ''; position: absolute; width: 8px; height: 8px; pointer-events: none;
  border-color: color-mix(in srgb, var(--ink) 28%, transparent); border-style: solid;
}
.card::before { top: -1px; left: -1px; border-width: 1px 0 0 1px; }
.card::after { bottom: -1px; right: -1px; border-width: 0 1px 1px 0; }
.card h3 { margin: 0; font-size: 13px; font-weight: 600; }
.kpi-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; }
.kpi .n { font-size: 28px; font-weight: 650; letter-spacing: -0.04em; line-height: 1; margin-top: 10px; }
.kpi .sub { font-family: var(--mono); font-size: 10px; color: var(--ink3); margin: 4px 0 8px; }
.spark { display: block; width: calc(100% + 24px); margin: 0 -12px; height: 56px; }
.chart { display: block; width: 100%; height: 140px; }
.world { display: block; width: 100%; height: auto; max-height: 420px; }
.heat { display: block; width: 100%; max-width: 280px; height: auto; }
.grat { stroke: color-mix(in srgb, var(--ink) 18%, transparent); stroke-width: 0.6; }
.dot { fill: var(--accent); stroke: var(--bg); stroke-width: 0.8; }
.tick { fill: var(--ink3); font-size: 9px; font-family: var(--mono); }
.tabs { display: flex; flex-wrap: wrap; gap: 4px; margin: 0 0 8px; }
.tab {
  border: 1px solid transparent; background: transparent; color: var(--ink2);
  font: 11px/1 var(--mono); letter-spacing: 0.04em; text-transform: uppercase;
  padding: 4px 9px; border-radius: 999px; cursor: pointer;
}
.tab.on { background: var(--chart-5); color: var(--bg); }
[data-theme="light"] .tab.on, :root:not([data-theme="dark"]) .tab.on { color: #0a0a0b; background: #18181b; }
.pill {
  display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 10px;
  font-family: var(--mono); border: 1px solid var(--hair); color: var(--ink2);
}
.pill.up, .pill.hit { color: var(--ok); }
.pill.down { color: var(--danger); }
.chip {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 2px 8px; border-radius: 999px; border: 1px solid var(--hair);
  font-family: var(--mono); font-size: 10px; color: var(--ink2); background: var(--nav-on);
}
.empty { color: var(--ink2); font-size: 12px; padding: 10px 0 12px; }
.map-empty { position: absolute; left: 12px; top: 42px; z-index: 1; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 7px 6px; border-bottom: 1px solid var(--hair); font-size: 12px; vertical-align: top; }
th { color: var(--ink3); font-weight: 500; font-family: var(--mono); font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; }
button, .btn {
  background: transparent; color: var(--ink); border: 1px solid var(--hair);
  padding: 4px 9px; font-size: 11px; cursor: pointer; border-radius: 999px;
}
button.primary { background: var(--chart-5); color: var(--bg); border-color: transparent; font-weight: 600; }
button.danger { color: var(--danger); }
pre, textarea {
  width: 100%; background: color-mix(in srgb, var(--bg) 70%, #000); color: var(--ink);
  border: 1px solid var(--hair); padding: 8px; font: 11px var(--mono);
}
textarea { min-height: 120px; }
.row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.muted { color: var(--ink2); }
.legend { display: flex; gap: 12px; font-family: var(--mono); font-size: 10px; color: var(--ink3); padding: 6px 0 10px; }
.legend i { display: inline-block; width: 10px; height: 2px; background: var(--chart-5); vertical-align: middle; margin-right: 4px; }
.legend i.ask { background: var(--accent); }
.funnel { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 8px; }
.crm-funnel { display: grid; gap: 6px; margin: 0 0 10px; }
.crm-funnel-row { display: grid; grid-template-columns: 88px 1fr auto; gap: 8px; align-items: center; }
.crm-funnel-track { height: 6px; background: var(--nav-on); border: 1px solid var(--hair); position: relative; overflow: hidden; }
.crm-funnel-ok { position: absolute; inset: 0 auto 0 0; background: var(--ok); opacity: 0.7; }
.crm-funnel-fail { position: absolute; inset: 0 0 0 auto; background: var(--danger); opacity: 0.7; }
.crm-kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin: 0 0 10px; }
.crm-kpis .n { font-size: 22px; margin-top: 4px; }
.remote a { color: var(--accent); }
.heat-wrap { display: flex; gap: 16px; align-items: flex-start; }
.heat-meta { font-family: var(--mono); font-size: 10px; color: var(--ink3); }
.event {
  display: grid; grid-template-columns: 140px 160px 1fr 88px; gap: 10px; align-items: start;
  padding: 10px 4px; border-bottom: 1px solid var(--hair);
}
.event-name { font-weight: 650; }
.event-profile { color: var(--ink2); }
.event-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.event-time { font-family: var(--mono); font-size: 10px; color: var(--ink3); text-align: right; }
.live { display: inline-block; padding: 1px 7px; border-radius: 999px; background: #111; color: #fff; font: 10px var(--mono); letter-spacing: 0.08em; }
[data-theme="light"] .live { background: #18181b; }
.page[hidden] { display: none !important; }
@media (max-width: 980px) {
  .shell { grid-template-columns: 1fr; }
  .rail { position: relative; min-height: auto; }
  .kpis, .grid-2, .grid-3, .crm-kpis, .event { grid-template-columns: 1fr; }
}
`

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;')
}

function when(ts: number): string {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 16)
}

function field(value: string | null | undefined): string {
  if (!value || looksLikeSecret(value)) return MISSING
  return esc(value)
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

function renderEvents(events: ConsoleEvent[]): string {
  if (!events.length) return '<div class="empty">No events yet.</div>'
  return events
    .map((e) => {
      const name = looksLikeSecret(e.name) ? 'event' : e.name
      const chips = e.chips
        .filter((c) => !looksLikeSecret(c.key) && !looksLikeSecret(c.value))
        .map((c) => `<span class="chip">${esc(c.key)} ${esc(c.value)}</span>`)
        .join('')
      const profile = e.hostname || e.email || MISSING
      return `<div class="event" data-event="${esc(e.id)}">
        <div class="event-name">${esc(name)}</div>
        <div class="event-profile">${field(profile === MISSING ? null : profile)}</div>
        <div class="event-chips">${chips}</div>
        <div class="event-time">${esc(when(e.ts))}</div>
      </div>`
    })
    .join('')
}

function renderProfiles(rows: ProfileRow[], osFilter?: string): string {
  const filtered = osFilter
    ? rows.filter((r) => (osFilter === 'darwin' ? r.os === 'darwin' : r.os === 'win' || r.os === 'win32' || r.os === 'windows'))
    : rows
  if (!filtered.length) return '<div class="empty">No seats on the fleet yet.</div>'
  const body = filtered
    .map(
      (r) => `<tr data-country="${esc(r.country || '')}" data-os="${esc(r.os)}">
        <td>${field(r.hostname)}</td>
        <td>${field(r.email)}</td>
        <td class="muted">${esc(r.os)}</td>
        <td class="muted">${esc(r.appVersion)}</td>
        <td class="muted">${esc(r.country || MISSING)}${r.city ? ` · ${esc(r.city)}` : ''}</td>
        <td class="muted">${esc(when(r.lastSeen))}</td>
        <td>${r.live ? '<span class="pill up">live</span>' : '<span class="muted">idle</span>'}</td>
      </tr>`
    )
    .join('')
  return `<table><thead><tr><th>Computer</th><th>SSO email</th><th>OS</th><th>Version</th><th>Country</th><th>Seen</th><th></th></tr></thead><tbody>${body}</tbody></table>`
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
  const maps = {
    land: choropleth(data.map.countries, data.map.dots, 'land'),
    analytics: choropleth(data.map.countries, data.map.dots, 'analytics'),
    graticule: choropleth(data.map.countries, data.map.dots, 'graticule'),
    hatch: choropleth(data.map.countries, data.map.dots, 'hatch')
  }
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
  const askRows = data.asks
    .map(
      (a) => `<tr>
        <td>${esc(a.mode)}</td>
        <td>${esc(a.preview)}</td>
        <td><span class="pill ${esc(a.cache_status)}">${esc(a.cache_status)}</span></td>
        <td class="muted">${esc(a.provider)}</td>
        <td><button data-reveal="${esc(a.id)}">Reveal</button></td>
      </tr>`
    )
    .join('')
  const costRows = data.cost.table
    .map(
      (r) => `<tr>
        <td>${esc(r.provider)}</td>
        <td>${esc(r.mode)}</td>
        <td>${r.asks}</td>
        <td>${r.read == null ? 'not reported' : r.read}</td>
        <td>${r.write == null ? 'not reported' : r.write}</td>
        <td>${r.uncached == null ? 'not reported' : r.uncached}</td>
        <td>${r.estimate ?? 'not reported'}</td>
      </tr>`
    )
    .join('')
  const timeline = data.change.timeline
    .map(
      (t) => `<tr>
        <td class="muted">${esc(when(t.ts))}</td>
        <td>${esc(t.action)}</td>
        <td class="muted">${esc(t.actor)}</td>
        <td>${esc(t.detail)}</td>
      </tr>`
    )
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
  const indexHint =
    k.lastIndexAt != null ? `last index ${when(k.lastIndexAt)}` : 'last index not reported'
  const liveSeats = data.profiles.filter((p) => p.live)
  const vaultRows = data.keys.vault
    .map(
      (v) => `<tr>
        <td>${esc(v.provider)}</td>
        <td>${esc(v.label)}</td>
        <td class="muted">··${esc(v.last4)}</td>
        <td>${esc(v.status)}</td>
      </tr>`
    )
    .join('')
  const mapCaption =
    'Unique devices by country from Cloudflare request.cf. No GPS from the app. No IP. Click a country to filter the fleet table. Empty is an empty world, not sample dots.'

  void FORBIDDEN_NAV
  void NAV_IDS

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Métis Operator</title>
<style>${CSS}${STATUS_BADGE_CSS}
svg path { vector-effect: non-scaling-stroke; }
#spark-defs { position: absolute; width: 0; height: 0; }
</style>
</head>
<body>
<svg id="spark-defs"><defs>
  <linearGradient id="spark-fill" x1="0" x2="0" y1="0" y2="1">
    <stop offset="0" stop-color="#e4e4e7" stop-opacity="0.28"/>
    <stop offset="1" stop-color="#e4e4e7" stop-opacity="0"/>
  </linearGradient>
</defs></svg>
<div class="shell">
  <aside class="rail">
    <div class="rail-brand"><h1>Métis</h1></div>
    <input class="rail-search" id="nav-search" type="search" placeholder="Search" autocomplete="off">
    ${renderNav()}
    <div class="rail-foot">
      <div class="who">${esc(data.email)}</div>
      <button class="theme-btn" id="theme-btn" type="button">Theme</button>
      <form method="post" action="/logout"><button class="theme-btn" type="submit">Sign out</button></form>
    </div>
  </aside>
  <div class="main">
    <header class="top">
      <h2 id="page-title">Overview</h2>
      <span class="live">LIVE ${k.live}</span>
    </header>

    <section class="page wrap" data-page="overview">
      <p class="eyebrow">Fleet</p>
      <div class="kpis">
        ${kpiCard({ title: 'Live seats', value: String(k.live), sub: 'last-seen under 2 minutes', spark: sparklineLine(k.liveSeries) })}
        ${kpiCard({ title: 'DAU', value: String(k.dau), sub: `WAU ${k.wau}`, spark: sparklineArea(k.dauSeries) })}
        ${kpiCard({
          title: 'API cost',
          value: k.costToday ?? 'hidden',
          sub: k.cost7d ? `7d ${k.cost7d} · estimate, list price` : 'estimate, list price · not reported',
          spark: sparklineArea(k.costSeries)
        })}
        ${kpiCard({
          title: 'Prompt cache',
          value: k.cacheHit ?? 'not reported',
          sub: 'real provider fields only',
          spark: sparklineLine(k.hitSeries)
        })}
        ${kpiCard({
          title: 'Versions in field',
          value: String(k.versions),
          sub: indexHint,
          spark: bars(data.scale.versions.slice(0, 6), 220, 56)
        })}
        ${kpiCard({
          title: 'Pending diffs',
          value: String(k.pendingDiffs),
          sub: 'Approve then Push',
          spark: sparklineLine(data.change.heatmap.slice(-24))
        })}
      </div>

      <div class="grid-2">
        <article class="card">
          <p class="eyebrow">Scale</p>
          <div class="tabs">
            <button class="tab on" data-scale="24h">24h</button>
            <button class="tab" data-scale="7d">7d</button>
          </div>
          <div id="scale-24">${dualLine(data.scale.hours24)}</div>
          <div id="scale-7" hidden>${dualLine(data.scale.days7)}</div>
          <div class="legend"><span><i></i>heartbeats</span><span><i class="ask"></i>Asks</span></div>
        </article>
        <article class="card">
          <p class="eyebrow">Mix</p>
          <div class="grid-2" style="gap:8px">
            <div>
              <div class="sub muted">App version</div>
              ${bars(data.scale.versions, 240, 140)}
            </div>
            <div>
              <div class="sub muted">OS</div>
              ${bars(data.scale.os, 240, 140)}
            </div>
          </div>
        </article>
      </div>

      <div class="grid-2">
        <article class="card">
          <p class="eyebrow">Cost tokens</p>
          ${stackedTokens(data.cost.tokens)}
          <div class="legend"><span><i></i>cache read</span><span class="muted">write / uncached underneath</span></div>
        </article>
        <article class="card">
          <p class="eyebrow">Cost by provider</p>
          ${
            data.cost.table.length
              ? `<table><thead><tr><th>Provider</th><th>Mode</th><th>Asks</th><th>Read</th><th>Write</th><th>Uncached</th><th>Estimate</th></tr></thead><tbody>${costRows}</tbody></table>
                 <div class="sub muted" style="padding-bottom:8px">estimate, list price. Missing usage is not reported, never $0.</div>`
              : '<div class="empty">No Asks with usage on the fleet yet.</div>'
          }
        </article>
      </div>

      <article class="card" style="padding-bottom:10px">
        <p class="eyebrow">Change</p>
        <div class="heat-wrap">
          ${heatmapGrid(data.change.heatmap)}
          <div class="heat-meta">Skill draft / approve / push and rollouts over 17 weeks. Empty cells are quiet days, not sample activity.</div>
        </div>
        ${
          timeline
            ? `<table><thead><tr><th>When</th><th>Action</th><th>Who</th><th>Version</th></tr></thead><tbody>${timeline}</tbody></table>`
            : '<div class="empty">No skill changes yet.</div>'
        }
      </article>

      <article class="card" style="padding-bottom:10px">
        <p class="eyebrow">Asks</p>
        ${
          askRows
            ? `<table><thead><tr><th>Mode</th><th>Preview</th><th>Cache</th><th>Provider</th><th></th></tr></thead><tbody>${askRows}</tbody></table>`
            : '<div class="empty">No Asks on the fleet yet.</div>'
        }
        <div id="reveal" class="muted" style="padding:8px 0"></div>
      </article>

      <article class="card" style="padding-bottom:10px">
        <p class="eyebrow">CRM landing</p>
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
        ${
          crmRows
            ? `<table id="crm-table"><thead><tr><th>Status</th><th>Title</th><th>Connector</th><th>Remote</th><th>Try</th><th>Meeting</th><th>When</th><th></th></tr></thead><tbody>${crmRows}</tbody></table>
               <div class="sub muted" style="padding-bottom:8px">Seven status chips filter real ingest. Retry on Failed or Expired tells that seat to processDue that id. Never auto-send from Intelligence, import, or index.</div>`
            : '<div class="empty">No CRM sends on the fleet yet.</div>'
        }
      </article>
    </section>

    <section class="page wrap" data-page="realtime" hidden>
      <article class="card" style="padding-bottom:10px">
        <p class="eyebrow">Live seats</p>
        ${
          liveSeats.length
            ? renderProfiles(liveSeats)
            : '<div class="empty">No live seats in the last two minutes.</div>'
        }
      </article>
      <article class="card" style="padding-bottom:10px">
        <p class="eyebrow">Live stream</p>
        <div id="rt-stream">${renderEvents(data.events.slice(0, 30))}</div>
      </article>
    </section>

    <section class="page wrap" data-page="events" hidden>
      <article class="card" style="padding-bottom:10px">
        <p class="eyebrow">Events</p>
        <div id="events-list">${renderEvents(data.events)}</div>
      </article>
    </section>

    <section class="page wrap" data-page="profiles" hidden>
      <article class="card" style="padding-bottom:10px">
        <p class="eyebrow">People</p>
        <div class="sub muted" style="padding-bottom:8px">Computer and SSO email from the seat. Missing fields are ${MISSING}, never invented.</div>
        ${renderProfiles(data.profiles)}
      </article>
    </section>

    <section class="page wrap" data-page="map" hidden>
      <article class="card" style="padding-bottom:10px">
        <p class="eyebrow">Map</p>
        <div class="tabs" id="map-tabs">
          <button class="tab" data-map="land">Land</button>
          <button class="tab on" data-map="analytics">Analytics</button>
          <button class="tab" data-map="graticule">Graticule</button>
          <button class="tab" data-map="hatch">Hatch</button>
        </div>
        <div id="map-root" style="position:relative">
          <div data-map-pane="land" hidden>${maps.land}</div>
          <div data-map-pane="analytics">${maps.analytics}</div>
          <div data-map-pane="graticule" hidden>${maps.graticule}</div>
          <div data-map-pane="hatch" hidden>${maps.hatch}</div>
        </div>
        <div class="sub muted" style="padding-bottom:8px">${esc(mapCaption)}</div>
        <table id="map-fleet"><thead><tr><th>Computer</th><th>SSO email</th><th>OS</th><th>Version</th><th>Country</th><th>Seen</th><th></th></tr></thead>
        <tbody>${
          data.profiles
            .map(
              (r) => `<tr data-country="${esc(r.country || '')}">
                <td>${field(r.hostname)}</td>
                <td>${field(r.email)}</td>
                <td class="muted">${esc(r.os)}</td>
                <td class="muted">${esc(r.appVersion)}</td>
                <td class="muted">${esc(r.country || MISSING)}</td>
                <td class="muted">${esc(when(r.lastSeen))}</td>
                <td></td>
              </tr>`
            )
            .join('') || `<tr><td colspan="7" class="empty">No seats on the fleet yet.</td></tr>`
        }</tbody></table>
      </article>
    </section>

    <section class="page wrap" data-page="macos" hidden>
      <article class="card" style="padding-bottom:10px">
        <p class="eyebrow">macOS</p>
        ${renderProfiles(data.profiles, 'darwin')}
      </article>
    </section>

    <section class="page wrap" data-page="windows" hidden>
      <article class="card" style="padding-bottom:10px">
        <p class="eyebrow">Windows</p>
        ${renderProfiles(data.profiles, 'win')}
      </article>
    </section>

    <section class="page wrap" data-page="licenses" hidden>
      <article class="card" style="padding-bottom:10px">
        <p class="eyebrow">Licenses</p>
        ${renderLicenses(data.profiles)}
      </article>
    </section>

    <section class="page wrap" data-page="skills" hidden>
      <article class="card" style="padding-bottom:10px">
        <div class="row" style="margin-bottom:8px">
          <p class="eyebrow" style="margin:0">Skills</p>
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
        <div class="sub muted" style="padding-bottom:8px">Presence only. Never a secret value, HMAC, PEM, or bearer string.</div>
        <table>
          <thead><tr><th>Binding</th><th>Status</th></tr></thead>
          <tbody>
            <tr><td>Ingest HMAC</td><td>${data.keys.ingestBound ? 'bound' : 'missing'}</td></tr>
            <tr><td>Prompt key</td><td>${data.keys.promptBound ? 'bound' : 'missing'}</td></tr>
            <tr><td>Skill signing</td><td>${data.keys.skillBound ? 'bound' : 'missing'}</td></tr>
          </tbody>
        </table>
        ${
          vaultRows
            ? `<p class="eyebrow" style="margin-top:14px">Vault</p><table><thead><tr><th>Provider</th><th>Label</th><th>Last4</th><th>Status</th></tr></thead><tbody>${vaultRows}</tbody></table>`
            : '<div class="empty">No provider keys stored on Operator. Seats keep their own keys.</div>'
        }
      </article>
    </section>
  </div>
</div>
<script>
async function api(path, body) {
  const r = await fetch(path, { method: body ? 'POST' : 'GET', credentials: 'same-origin', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
  return r.json()
}
const titles = {
  overview: 'Overview', realtime: 'Realtime', events: 'Events', profiles: 'Profiles',
  map: 'Map', macos: 'macOS', windows: 'Windows', licenses: 'Licenses', skills: 'Skills', keys: 'Keys'
}
function route() {
  const raw = (location.hash || '#overview').replace('#', '')
  const id = titles[raw] ? raw : 'overview'
  document.querySelectorAll('[data-page]').forEach((p) => { p.hidden = p.getAttribute('data-page') !== id })
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('on', a.getAttribute('data-nav') === id))
  const t = document.getElementById('page-title')
  if (t) t.textContent = titles[id]
}
window.addEventListener('hashchange', route)
route()
const search = document.getElementById('nav-search')
if (search) search.addEventListener('input', () => {
  const q = search.value.trim().toLowerCase()
  document.querySelectorAll('[data-nav]').forEach((a) => {
    const hit = !q || (a.textContent || '').toLowerCase().includes(q)
    a.hidden = !hit
  })
})
const themeBtn = document.getElementById('theme-btn')
function applyTheme(v) {
  if (v) document.documentElement.setAttribute('data-theme', v)
  else document.documentElement.removeAttribute('data-theme')
}
try { applyTheme(localStorage.getItem('metis-operator-theme')) } catch (e) {}
if (themeBtn) themeBtn.addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-theme')
  const next = cur === 'dark' ? 'light' : cur === 'light' ? '' : 'dark'
  applyTheme(next)
  try { if (next) localStorage.setItem('metis-operator-theme', next); else localStorage.removeItem('metis-operator-theme') } catch (e) {}
})
document.querySelectorAll('[data-scale]').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('[data-scale]').forEach((x) => x.classList.toggle('on', x === b))
  document.getElementById('scale-24').hidden = b.getAttribute('data-scale') !== '24h'
  document.getElementById('scale-7').hidden = b.getAttribute('data-scale') !== '7d'
}))
document.querySelectorAll('[data-map]').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('[data-map]').forEach((x) => x.classList.toggle('on', x === b))
  const v = b.getAttribute('data-map')
  document.querySelectorAll('[data-map-pane]').forEach((p) => { p.hidden = p.getAttribute('data-map-pane') !== v })
}))
document.querySelectorAll('#map-root path[data-iso]').forEach((p) => p.addEventListener('click', () => {
  const iso = p.getAttribute('data-iso')
  document.querySelectorAll('#map-fleet tbody tr').forEach((tr) => {
    tr.hidden = Boolean(iso) && tr.getAttribute('data-country') !== iso
  })
}))
document.querySelectorAll('[data-crm-filter]').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('[data-crm-filter]').forEach((x) => x.classList.toggle('on', x === b))
  const f = b.getAttribute('data-crm-filter')
  document.querySelectorAll('#crm-table tbody tr').forEach((tr) => {
    tr.hidden = f !== 'all' && tr.getAttribute('data-status') !== f
  })
}))
document.querySelectorAll('[data-reveal]').forEach((b) => b.addEventListener('click', async () => {
  const id = b.getAttribute('data-reveal')
  const j = await api('/v1/admin/asks/' + id)
  document.getElementById('reveal').textContent = j.ok ? (j.question || '(empty)') : (j.error || 'reveal failed')
}))
document.querySelectorAll('[data-approve]').forEach((b) => b.addEventListener('click', async () => {
  const id = b.getAttribute('data-approve')
  const diff = document.querySelector('[data-diff="' + id + '"]').value
  await api('/v1/admin/skills/' + id + '/approve', { diff })
  location.reload()
}))
document.querySelectorAll('[data-reject]').forEach((b) => b.addEventListener('click', async () => {
  const id = b.getAttribute('data-reject')
  await api('/v1/admin/skills/' + id + '/reject', { reason: 'rejected in console' })
  location.reload()
}))
document.querySelectorAll('[data-push]').forEach((b) => b.addEventListener('click', async () => {
  const id = b.getAttribute('data-push')
  await api('/v1/admin/skills/' + id + '/push', {})
  location.reload()
}))
document.querySelectorAll('[data-draft]').forEach((b) => b.addEventListener('click', async () => {
  await api('/v1/admin/skills/draft', { skillId: b.getAttribute('data-draft') })
  location.reload()
}))
document.querySelectorAll('[data-retry]').forEach((b) => b.addEventListener('click', async () => {
  await api('/v1/admin/crm/' + b.getAttribute('data-retry') + '/retry', {})
  location.reload()
}))
</script>
</body></html>`
}

/** First paint for an unauthenticated browser GET of /. Never JSON. */
export function renderLogin(error?: string): string {
  const err = error
    ? `<p class="login-err" role="alert">${esc(error)}</p>`
    : ''
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Métis Operator</title>
<style>
@import url('https://cdn.jsdelivr.net/npm/geist@1.3.1/dist/fonts/geist-sans/style.min.css');
@import url('https://cdn.jsdelivr.net/npm/geist@1.3.1/dist/fonts/geist-mono/style.min.css');
:root, [data-theme="dark"] {
  --bg: #0a0a0b; --panel: #111113; --hair: rgba(255,255,255,0.10);
  --ink: rgba(255,255,255,0.94); --ink2: rgba(255,255,255,0.55); --ink3: rgba(255,255,255,0.38);
  --accent: #7C8CF8; --danger: #F0717A;
  --mono: 'Geist Mono', ui-monospace, SFMono-Regular, monospace;
  --sans: 'Geist', Geist, Inter, system-ui, sans-serif;
}
@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]) {
    --bg: #f4f4f5; --panel: #ffffff; --hair: rgba(15,15,17,0.10);
    --ink: #18181b; --ink2: rgba(24,24,27,0.62); --ink3: rgba(24,24,27,0.42);
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; color: var(--ink); font: 13px/1.45 var(--sans); background: var(--bg); }
.login {
  min-height: 100%; display: grid; place-items: center; padding: 24px;
}
.login-card {
  width: min(360px, 100%); background: var(--panel); border: 1px solid var(--hair);
  border-radius: 12px; padding: 22px 20px 20px;
}
.login-card p.eyebrow {
  font-family: var(--mono); font-size: 10px; letter-spacing: 0.14em;
  text-transform: uppercase; color: var(--ink3); margin: 0 0 6px;
}
.login-card h1 { margin: 0 0 16px; font-size: 18px; font-weight: 650; letter-spacing: -0.03em; }
.login-card label {
  display: block; font-size: 11px; color: var(--ink2); margin: 0 0 4px;
}
.login-card input {
  width: 100%; border: 1px solid var(--hair); background: var(--bg); color: var(--ink);
  border-radius: 8px; padding: 8px 10px; font: 13px var(--sans); margin: 0 0 12px;
}
.login-card button {
  width: 100%; border: 0; background: var(--accent); color: #fff;
  border-radius: 8px; padding: 9px 12px; font: 600 13px var(--sans); cursor: pointer;
}
.login-err { color: var(--danger); font-size: 12px; margin: 0 0 10px; }
.login-note { margin: 12px 0 0; font-size: 11px; color: var(--ink3); }
</style>
</head>
<body>
  <main class="login" data-login="1">
    <form class="login-card" method="post" action="/login" autocomplete="on">
      <p class="eyebrow">Operator</p>
      <h1>Sign in</h1>
      ${err}
      <label for="email">Email</label>
      <input id="email" name="email" type="email" required autocomplete="username">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" required autocomplete="current-password">
      <button type="submit">Sign in</button>
      <p class="login-note">Tony only. Two emails. The console stays closed until this form succeeds.</p>
    </form>
  </main>
</body></html>`
}
