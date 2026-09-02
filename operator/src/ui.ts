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
import { statusBadge, STATUS_BADGE_CSS } from './components/ui/status-badge'
import { CRM_FILTER_ORDER } from './crm'
import type { CloudflareOverview } from './cloudflare'
import type { ConsoleEvent, DashboardPayload, ProfileRow } from './dashboard'
import { EXTRA_PAGES, FORBIDDEN_NAV, NAV_IDS, NAV_SECTIONS } from './nav'
import { looksLikeSecret } from './redact'

const MISSING = '—'

const CSS = `
@import url('https://cdn.jsdelivr.net/npm/geist@1.3.1/dist/fonts/geist-sans/style.min.css');
@import url('https://cdn.jsdelivr.net/npm/geist@1.3.1/dist/fonts/geist-mono/style.min.css');
:root {
  --bg: #FFFFFF;
  --panel: #FFFFFF;
  --hair: #EDEDED;
  --ink: #18181B;
  --ink2: #71717A;
  --ink3: #A1A1AA;
  --accent: #2563EB;
  --ok: #16A34A;
  --danger: #DC2626;
  --live: #10B981;
  --land: #F3F4F6;
  --chart-1: #EFF6FF;
  --chart-2: #BFDBFE;
  --chart-3: #60A5FA;
  --chart-4: #2563EB;
  --chart-5: #1D4ED8;
  --nav: #FFFFFF;
  --nav-on: #F4F4F5;
  --mono: ui-monospace, SFMono-Regular, 'Geist Mono', monospace;
  --sans: Inter, Geist, system-ui, sans-serif;
}
[data-theme="dark"] {
  --bg: #0a0a0b;
  --panel: #111113;
  --hair: rgba(255,255,255,0.10);
  --ink: rgba(255,255,255,0.94);
  --ink2: rgba(255,255,255,0.55);
  --ink3: rgba(255,255,255,0.38);
  --land: #2a2a2e;
  --nav: #0d0d0f;
  --nav-on: rgba(255,255,255,0.08);
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; color: var(--ink); font: 12px/1.4 var(--sans); }
body { background: var(--bg); }
a { color: var(--accent); text-decoration: none; }
.shell { display: grid; grid-template-columns: 185px 1fr; min-height: 100%; }
.rail {
  display: flex; flex-direction: column; gap: 8px;
  background: var(--nav); border-right: 1px solid var(--hair);
  padding: 12px 10px 14px; min-height: 100vh; position: sticky; top: 0;
  width: 185px;
}
.rail-brand { display: flex; align-items: center; gap: 8px; }
.rail-logo {
  width: 28px; height: 28px; border-radius: 999px; background: #2563EB; color: #fff;
  display: grid; place-items: center; font: 700 10px/1 var(--sans); letter-spacing: -0.04em;
}
.rail-brand h1 { margin: 0; font-size: 13px; font-weight: 650; letter-spacing: -0.03em; }
.rail-brand .chev { color: var(--ink3); font-size: 11px; }
.create-btn {
  display: flex; align-items: center; justify-content: space-between;
  width: 100%; border: 0; background: #18181B; color: #fff;
  border-radius: 8px; padding: 7px 8px; font: 600 12px var(--sans); cursor: pointer;
}
.create-menu {
  display: none; margin: 0; padding: 8px 10px; border: 1px solid var(--hair);
  border-radius: 8px; background: var(--panel); color: var(--ink2); font-size: 12px;
}
.create-menu.open { display: block; }
.rail-search {
  width: 100%; border: 1px solid var(--hair); background: var(--panel); color: var(--ink);
  border-radius: 8px; padding: 7px 10px; font: 12px var(--sans);
}
.rail-search::placeholder { color: var(--ink3); }
.kbd {
  float: right; font: 10px var(--mono); color: var(--ink3);
  border: 1px solid var(--hair); border-radius: 4px; padding: 1px 5px; margin-top: -22px; margin-right: 8px;
}
.rail nav { display: flex; flex-direction: column; gap: 14px; flex: 1; }
.nav-sec { display: flex; flex-direction: column; gap: 1px; }
.nav-sec p {
  font-size: 11px; letter-spacing: 0.02em; color: var(--ink3); margin: 8px 8px 4px; font-weight: 550;
}
.nav-item {
  display: block; padding: 6px 8px; border-radius: 6px; color: var(--ink);
  font-size: 12px; font-weight: 500;
}
.nav-item:hover { background: var(--nav-on); }
.nav-item.on { background: var(--nav-on); font-weight: 600; }
.rail-foot { margin-top: auto; display: flex; flex-direction: column; gap: 8px; padding-top: 12px; }
.rail-utils { display: flex; gap: 8px; flex-wrap: wrap; }
.rail-utils a, .rail-utils button { color: var(--ink2); font-size: 11px; background: none; border: 0; cursor: pointer; padding: 0; }
.who { font-family: var(--mono); font-size: 10px; color: var(--ink2); word-break: break-all; }
.theme-btn {
  border: 1px solid var(--hair); background: transparent; color: var(--ink2);
  font: 11px/1 var(--mono); letter-spacing: 0.06em; text-transform: uppercase;
  padding: 6px 8px; border-radius: 8px; cursor: pointer;
}
.main { min-width: 0; background: #FAFAFA; }
.top {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 10px 16px; border-bottom: 1px solid var(--hair); background: #fff;
  position: sticky; top: 0; z-index: 4;
}
.top-left, .top-right { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.tool {
  border: 1px solid var(--hair); background: #fff; color: var(--ink);
  border-radius: 8px; padding: 6px 10px; font: 12px var(--sans); cursor: pointer;
}
.top-search {
  flex: 1; min-width: 180px; border: 1px solid var(--hair); background: #fff; color: var(--ink);
  border-radius: 8px; padding: 7px 12px; font: 12px var(--sans);
}
.live-dot {
  display: inline-flex; align-items: center; gap: 6px; font: 12px/1 var(--sans); color: var(--ink);
  border: 1px solid var(--hair); border-radius: 999px; padding: 5px 10px; background: #fff;
}
.live-dot i { width: 7px; height: 7px; border-radius: 99px; background: var(--live); display: inline-block; }
.top h2 { margin: 0; font-size: 16px; font-weight: 650; letter-spacing: -0.03em; }
.eyebrow {
  font-size: 10px; letter-spacing: 0.12em;
  text-transform: uppercase; color: var(--ink3); margin: 0 0 8px; font-weight: 600;
}
.wrap { padding: 14px 16px 36px; display: grid; gap: 12px; }
.kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; }
.card {
  position: relative;
  background: var(--panel);
  border: 1px solid var(--hair);
  border-radius: 8px;
  padding: 10px 12px 0;
  overflow: hidden;
}
.card h3 { margin: 0; font-size: 13px; font-weight: 600; }
.kpi-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; }
.kpi { padding-bottom: 8px; }
.kpi .eyebrow { margin-bottom: 4px; }
.kpi .n { font-size: 28px; font-weight: 650; letter-spacing: -0.04em; line-height: 1; margin-top: 6px; }
.delta { font-size: 11px; font-weight: 600; }
.delta.up { color: var(--ok); }
.delta.down { color: var(--danger); }
.delta.flat { color: var(--ink3); }
.rt-grid { display: grid; grid-template-columns: minmax(220px, 2fr) minmax(0, 3fr); gap: 12px; align-items: stretch; }
.rt-map { min-width: 0; }
.rt-stream { display: flex; flex-direction: column; gap: 2px; max-height: 320px; overflow: auto; }
.rt-row {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 6px 2px; border-bottom: 1px solid var(--hair); font-size: 11px;
}
.rt-row .ago { color: var(--ink3); font-size: 11px; white-space: nowrap; }
.rt-ics { display: inline-flex; gap: 3px; margin-left: 6px; vertical-align: middle; }
.ic-mac, .ic-win, .ic-desk {
  display: inline-block; width: 12px; height: 12px; border-radius: 2px; background: #2563EB;
}
.ic-win { background: #0A84FF; }
.ic-desk { background: #71717A; }
.vol { position: relative; }
.vol-row {
  display: grid; grid-template-columns: 1fr 56px 64px; gap: 8px; align-items: center;
  padding: 5px 8px; position: relative; font-size: 11px;
}
.vol-bar {
  position: absolute; inset: 2px auto 2px 0; background: #F4F4F5; border-radius: 4px; z-index: 0;
}
.vol-bar.blue { background: #DBEAFE; }
.vol-row > * { position: relative; z-index: 1; }
.table-card .tabs { margin: 0 0 8px; }
.table-search {
  width: 100%; border: 1px solid var(--hair); border-radius: 8px; padding: 6px 10px;
  font: 12px var(--sans); margin-bottom: 8px;
}
.empty-card { background: #fff; border: 1px solid var(--hair); border-radius: 8px; padding: 28px 20px; }
.empty-card h3 { margin: 0 0 6px; font-size: 16px; }
.empty-card p { margin: 0; color: var(--ink2); }
.kpi .sub { font-family: var(--mono); font-size: 10px; color: var(--ink3); margin: 4px 0 8px; }
.spark { display: block; width: calc(100% + 24px); margin: 0 -12px; height: 56px; }
.chart { display: block; width: 100%; height: 140px; }
.world { display: block; width: 100%; height: auto; max-height: 420px; }
.world.shoey-world { max-height: none; min-height: 280px; }
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
.fail-loud { color: var(--danger); font-size: 13px; font-weight: 600; padding: 10px 0 12px; }
.key-form { display: grid; gap: 8px; margin: 0 0 14px; }
.key-form .row input, .key-form .row select {
  border: 1px solid var(--hair); background: var(--bg); color: var(--ink);
  border-radius: 8px; padding: 6px 8px; font: 12px var(--sans); min-width: 120px;
}
.map-empty { position: absolute; left: 12px; top: 42px; z-index: 1; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 6px 6px; border-bottom: 1px solid var(--hair); font-size: 11px; vertical-align: top; }
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
  display: grid; grid-template-columns: 140px 160px 1fr 88px; gap: 8px; align-items: start;
  padding: 8px 4px; border-bottom: 1px solid var(--hair); font-size: 11px;
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
  .kpis, .grid-2, .grid-3, .crm-kpis, .event, .rt-grid { grid-template-columns: 1fr; }
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

function renderCloudflare(cf: CloudflareOverview): string {
  if (cf.error) {
    return `<div class="fail-loud" data-cf-error>${esc(cf.error)}</div>
      <div class="sub muted" style="padding-bottom:8px">Worker ${esc(cf.worker)}. Connect Account ID and API token on Keys. No token on seats.</div>`
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
  if (values.length < 4) return { text: 'not reported', cls: 'flat' }
  const mid = Math.floor(values.length / 2)
  const a = values.slice(0, mid).reduce((n, v) => n + v, 0) / mid
  const b = values.slice(mid).reduce((n, v) => n + v, 0) / (values.length - mid)
  if (a === 0) return { text: 'not reported', cls: 'flat' }
  const pct = ((b - a) / a) * 100
  if (!Number.isFinite(pct)) return { text: 'not reported', cls: 'flat' }
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
      return `<div class="event" data-event="${esc(e.id)}" data-q="${esc(`${name} ${profile}`.toLowerCase())}">
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
      (v) => `<tr data-key="${esc(v.id)}">
        <td>${esc(v.provider)}</td>
        <td>${esc(v.label)}</td>
        <td class="muted">··${esc(v.last4)}</td>
        <td>${esc(v.status)}</td>
        <td>${
          v.status === 'revoked'
            ? ''
            : `<button data-rotate="${esc(v.id)}">Rotate</button><button class="danger" data-revoke="${esc(v.id)}">Revoke</button>`
        }</td>
      </tr>`
    )
    .join('')
  void FORBIDDEN_NAV
  void NAV_IDS
  void EXTRA_PAGES
  void indexHint
  void sparklineArea
  void sparklineLine

  const asks7 = data.scale.days7.reduce((n, p) => n + p.asks, 0)
  const asksSeries = data.scale.days7.map((p) => p.asks)
  const asksPerSeat = k.dau > 0 && asks7 > 0 ? (asks7 / k.dau).toFixed(1) : 'not reported'
  const hitPct = k.cacheHit && k.cacheHit.endsWith('%') ? Number(k.cacheHit.slice(0, -1)) : null
  const missVal = hitPct == null ? 'not reported' : `${Math.max(0, Math.round(100 - hitPct))}%`
  const missSeries = k.hitSeries.map((v) => (v > 0 ? Math.max(0, 100 - v) : 0))
  const live30 = data.profiles.filter((p) => data.now - p.lastSeen <= 30 * 60 * 1000).length
  const live30Series = k.liveSeries
  const costVal = k.cost7d ?? 'not reported'
  const areaVals = data.scale.days7.map((p) => p.heartbeats)
  const areaLabs = data.scale.days7.map((p, i) =>
    i === 0 || i === data.scale.days7.length - 1 || i % 2 === 0 ? dayLabel(p.t) : ''
  )
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
<style>${CSS}${STATUS_BADGE_CSS}
svg path { vector-effect: non-scaling-stroke; }
#spark-defs { position: absolute; width: 0; height: 0; }
</style>
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
    <button class="create-btn" id="create-report" type="button">+ Create report <span>▾</span></button>
    <div class="create-menu" id="create-menu">No reports yet. Overview and Realtime are the live Métis views.</div>
    <div>
      <input class="rail-search" id="nav-search" type="search" placeholder="Ask AI anything…" autocomplete="off">
      <span class="kbd">⌘ J</span>
    </div>
    ${renderNav()}
    <div class="rail-foot">
      <div class="rail-utils">
        <a href="#notifications">Give feedback</a>
        <a href="#references">Docs</a>
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
      <div class="kpis">
        ${shoeyKpi('Unique seats', formatCompact(k.dau), k.dauSeries)}
        ${shoeyKpi('Live seats', formatCompact(k.live), k.liveSeries)}
        ${shoeyKpi('Asks', formatCompact(asks7), asksSeries)}
        ${shoeyKpi('Asks per seat', asksPerSeat, asksSeries)}
        ${shoeyKpi('Cache miss', missVal, missSeries)}
        ${shoeyKpi('Latency', 'not reported', [])}
        ${shoeyKpi('Cost', costVal, k.costSeries)}
        ${shoeyKpi('Live · 30 min', formatCompact(live30), live30Series)}
      </div>

      <article class="card" style="padding-bottom:10px">
        <p class="eyebrow">Unique seats</p>
        ${blueArea(areaVals, areaLabs)}
      </article>

      <div class="grid-2">
        ${volumeTable(
          'refs',
          [
            { id: 'crm', label: 'CRM' },
            { id: 'listen', label: 'Listen' },
            { id: 'recap', label: 'Recap' },
            { id: 'connectors', label: 'Connectors' },
            { id: 'source', label: 'Source' },
            { id: 'medium', label: 'Medium' },
            { id: 'campaign', label: 'Campaign' },
            { id: 'term', label: 'Term' },
            { id: 'content', label: 'Content' }
          ],
          {
            crm: crmMix,
            listen: listenRows,
            recap: listenRows.filter((r) => /recap/i.test(r.name)),
            connectors: crmMix,
            source: [],
            medium: [],
            campaign: [],
            term: [],
            content: []
          },
          'Search refs'
        )}
        ${volumeTable(
          'paths',
          [
            { id: 'modes', label: 'Modes' },
            { id: 'skills', label: 'Skills' },
            { id: 'usecases', label: 'Use cases' }
          ],
          {
            modes: modeRows,
            skills: skillRows,
            usecases: mixRows(data.events.map((e) => ({ label: e.name, value: 1 })))
          },
          'Search pages'
        )}
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

      <article class="card" style="padding-bottom:10px" data-cf-overview>
        <p class="eyebrow">Cloudflare</p>
        ${renderCloudflare(data.cloudflare)}
      </article>
    </section>

    <section class="page wrap" data-page="realtime" hidden>
      <div class="rt-grid">
        <div>
          <article class="card kpi" style="padding-bottom:10px">
            <p class="eyebrow">Unique seats last 30 min</p>
            <div class="n">${formatCompact(live30)}</div>
            ${blueBars(live30Series, 240, 48)}
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

    ${emptyPage('dashboards', 'Dashboards', 'No saved Métis views yet. A dashboard will list seats, Asks, and Listen once a report exists.')}
    ${emptyPage('insights', 'Insights', 'No Ask cost, cache, or security issues reported yet.')}
    ${emptyPage('pages', 'Pages', 'No mode, skill, or use-case paths yet. Never sample commerce URLs.')}
    ${emptyPage('seo', 'SEO', 'No public Métis or wiki surfaces reported yet.')}
    <section class="page wrap" data-page="sessions" hidden>
      <article class="card" style="padding-bottom:10px">
        <p class="eyebrow">Sessions</p>
        ${
          liveSeats.length
            ? renderProfiles(liveSeats)
            : '<div class="empty">No seat sessions in this window. Heartbeats will fill this.</div>'
        }
      </article>
    </section>
    ${emptyPage('groups', 'Groups', 'No license, workspace, or OS groups reported yet.')}
    ${emptyPage('cohorts', 'Cohorts', 'No DAU / WAU seat cohorts yet. Heartbeats will fill this.')}
    ${emptyPage('references', 'References', 'No signed skill refs yet.')}
    ${emptyPage('notifications', 'Notifications', landing.deadLetters || k.pendingDiffs ? `${k.pendingDiffs} pending skill diffs. ${landing.deadLetters} dead CRM letters.` : 'No failed CRM sends or pending skill diffs to surface.')}

    <section class="page wrap" data-page="events" hidden>
      <article class="card" style="padding-bottom:10px">
        <div class="tabs"><button class="tab on" type="button">Events</button></div>
        <input class="table-search" id="events-search" type="search" placeholder="Search events" autocomplete="off">
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

    <section class="page wrap" data-page="map" hidden data-alias="realtime"></section>

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
    </section>

    <section class="page wrap" data-page="devices" hidden>
      <article class="card" style="padding-bottom:10px">
        <p class="eyebrow">Devices</p>
        ${renderProfiles(data.profiles)}
      </article>
    </section>

    <section class="page wrap" data-page="cloudflare" hidden>
      <article class="card" style="padding-bottom:10px" data-cf-page>
        <p class="eyebrow">Cloudflare</p>
        ${renderCloudflare(data.cloudflare)}
      </article>
    </section>

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
        <form class="key-form" id="cf-add" autocomplete="off">
          <div class="row">
            <input name="accountId" type="text" placeholder="Account ID" required maxlength="40">
            <input name="token" type="password" placeholder="API token" required autocomplete="off">
            <button class="primary" type="submit">Connect</button>
          </div>
        </form>
        ${
          vaultRows
            ? `<p class="eyebrow" style="margin-top:14px">Vault</p><table><thead><tr><th>Provider</th><th>Label</th><th>Last4</th><th>Status</th><th></th></tr></thead><tbody>${vaultRows}</tbody></table>`
            : '<div class="empty">No provider keys on Operator yet. Add an API or Cloudflare here so seats can be funded.</div>'
        }
        <div id="key-msg" class="muted" style="padding:8px 0"></div>
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
  overview: 'Overview', dashboards: 'Dashboards', insights: 'Insights', pages: 'Pages', seo: 'SEO',
  realtime: 'Realtime', events: 'Events', sessions: 'Sessions', profiles: 'Profiles', groups: 'Groups',
  cohorts: 'Cohorts', settings: 'Settings', references: 'References', notifications: 'Notifications',
  map: 'Realtime', macos: 'macOS', windows: 'Windows', licenses: 'Licenses', skills: 'Skills',
  keys: 'Keys', devices: 'Devices', cloudflare: 'Cloudflare'
}
function route() {
  const raw = (location.hash || '#overview').replace('#', '')
  const requested = titles[raw] ? raw : 'overview'
  const id = requested === 'settings' ? 'keys' : requested === 'map' ? 'realtime' : requested
  document.querySelectorAll('[data-page]').forEach((p) => { p.hidden = p.getAttribute('data-page') !== id })
  const navOn = requested === 'map' || requested === 'realtime' ? 'realtime' : (requested === 'keys' || requested === 'settings' || requested === 'cloudflare' || requested === 'licenses' ? 'settings' : requested === 'devices' ? 'profiles' : requested)
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('on', a.getAttribute('data-nav') === navOn))
  const t = document.getElementById('page-title')
  if (t) t.textContent = titles[id]
}
window.addEventListener('hashchange', route)
if (!location.hash) {
  const path = location.pathname.replace(/^\//, '')
  if (path && titles[path]) location.hash = '#' + path
}
route()
const createBtn = document.getElementById('create-report')
const createMenu = document.getElementById('create-menu')
if (createBtn && createMenu) createBtn.addEventListener('click', () => createMenu.classList.toggle('open'))
document.querySelectorAll('[data-vol-tab]').forEach((b) => b.addEventListener('click', () => {
  const key = b.getAttribute('data-vol-tab') || ''
  const group = key.split(':')[0]
  document.querySelectorAll('[data-vol-tab^="' + group + ':"]').forEach((x) => x.classList.toggle('on', x === b))
  document.querySelectorAll('[data-vol-pane^="' + group + ':"]').forEach((p) => { p.hidden = p.getAttribute('data-vol-pane') !== key })
}))
document.querySelectorAll('[data-vol-search]').forEach((input) => {
  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase()
    const id = input.getAttribute('data-vol-search')
    document.querySelectorAll('[data-vol-pane^="' + id + ':"] .vol-row[data-q]').forEach((row) => {
      row.hidden = Boolean(q) && !(row.getAttribute('data-q') || '').includes(q)
    })
  })
})
const evSearch = document.getElementById('events-search')
if (evSearch) evSearch.addEventListener('input', () => {
  const q = evSearch.value.trim().toLowerCase()
  document.querySelectorAll('#events-list .event').forEach((row) => {
    row.hidden = Boolean(q) && !(row.getAttribute('data-q') || '').includes(q)
  })
})
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
document.querySelectorAll('#map-root path[data-iso]').forEach((p) => p.addEventListener('click', () => {
  const iso = p.getAttribute('data-iso')
  document.querySelectorAll('[data-vol-pane="geo:geo"] .vol-row[data-q]').forEach((row) => {
    row.hidden = Boolean(iso) && !(row.getAttribute('data-q') || '').toUpperCase().includes(iso)
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
const keyMsg = document.getElementById('key-msg')
function showKey(j) {
  if (!keyMsg) return
  if (j && j.ok) keyMsg.textContent = j.last4 ? ('saved ··' + j.last4) : (j.status || 'ok')
  else keyMsg.textContent = (j && j.error) || 'failed'
}
function bindKeyAdd(form) {
  if (!form) return
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const fd = new FormData(form)
    const j = await api('/v1/admin/keys', { provider: fd.get('provider'), label: fd.get('label'), secret: fd.get('secret') })
    if (j && j.ok) location.reload()
    else showKey(j)
  })
}
bindKeyAdd(document.getElementById('key-add'))
bindKeyAdd(document.getElementById('key-add-settings'))
const cfForm = document.getElementById('cf-add')
if (cfForm) cfForm.addEventListener('submit', async (e) => {
  e.preventDefault()
  const fd = new FormData(cfForm)
  const j = await api('/v1/admin/keys', { provider: 'cloudflare-account', accountId: fd.get('accountId'), token: fd.get('token') })
  if (j && j.ok) location.reload()
  else showKey(j)
})
document.querySelectorAll('[data-rotate]').forEach((b) => b.addEventListener('click', async () => {
  const secret = window.prompt('New secret or token')
  if (!secret) return
  const j = await api('/v1/admin/keys/' + b.getAttribute('data-rotate') + '/rotate', { secret })
  if (j && j.ok) location.reload()
  else showKey(j)
}))
document.querySelectorAll('[data-revoke]').forEach((b) => b.addEventListener('click', async () => {
  const j = await api('/v1/admin/keys/' + b.getAttribute('data-revoke') + '/revoke', {})
  if (j && j.ok) location.reload()
  else showKey(j)
}))
</script>
</body></html>`
}
