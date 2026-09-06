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
import type { DashboardPayload } from './dashboard'

const CSS = `
@import url('https://cdn.jsdelivr.net/npm/geist@1.3.1/dist/fonts/geist-sans/style.min.css');
@import url('https://cdn.jsdelivr.net/npm/geist@1.3.1/dist/fonts/geist-mono/style.min.css');
:root {
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
  --mono: 'Geist Mono', ui-monospace, SFMono-Regular, monospace;
  --sans: 'Geist', Geist, Inter, system-ui, sans-serif;
}
* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; color: var(--ink); font: 12px/1.4 var(--sans); }
body {
  background-color: var(--bg);
  background-image: radial-gradient(rgba(255,255,255,0.055) 1px, transparent 1px);
  background-size: 14px 14px;
}
a { color: var(--accent); }
header {
  display: flex; align-items: baseline; justify-content: space-between; gap: 16px;
  padding: 10px 14px; border-bottom: 1px solid var(--hair);
  background: rgba(10,10,11,0.86); position: sticky; top: 0; z-index: 4;
}
header h1 { margin: 0; font-size: 15px; font-weight: 650; letter-spacing: -0.03em; }
header .who { font-family: var(--mono); font-size: 11px; color: var(--ink2); }
.eyebrow {
  font-family: var(--mono); font-size: 10px; letter-spacing: 0.14em;
  text-transform: uppercase; color: var(--ink3); margin: 0 0 8px;
}
.wrap { padding: 12px 14px 28px; display: grid; gap: 12px; }
.kpis { display: grid; grid-template-columns: repeat(3, 1px 1fr); gap: 0; }
.kpis .card { grid-column: span 1; }
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
  border-color: rgba(255,255,255,0.28); border-style: solid;
}
.card::before { top: -1px; left: -1px; border-width: 1px 0 0 1px; }
.card::after { bottom: -1px; right: -1px; border-width: 0 1px 1px 0; }
.card h3 { margin: 0; font-size: 13px; font-weight: 600; }
.kpi-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; }
.kpi .n { font-size: 28px; font-weight: 650; letter-spacing: -0.04em; line-height: 1; margin-top: 10px; }
.kpi .sub { font-family: var(--mono); font-size: 10px; color: var(--ink3); margin: 4px 0 8px; }
.spark { display: block; width: calc(100% + 24px); margin: 0 -12px; height: 56px; }
.chart { display: block; width: 100%; height: 140px; }
.world { display: block; width: 100%; height: auto; max-height: 360px; }
.heat { display: block; width: 100%; max-width: 280px; height: auto; }
.grat { stroke: rgba(255,255,255,0.12); stroke-width: 0.6; }
.dot { fill: var(--accent); stroke: #0a0a0b; stroke-width: 0.8; }
.tick { fill: var(--ink3); font-size: 9px; font-family: var(--mono); }
.tabs { display: flex; flex-wrap: wrap; gap: 4px; margin: 0 0 8px; }
.tab {
  border: 1px solid transparent; background: transparent; color: var(--ink2);
  font: 11px/1 var(--mono); letter-spacing: 0.04em; text-transform: uppercase;
  padding: 4px 9px; border-radius: 999px; cursor: pointer;
}
.tab.on { background: #f4f4f5; color: #0a0a0b; }
.pill {
  display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 10px;
  font-family: var(--mono); border: 1px solid var(--hair); color: var(--ink2);
}
.pill.up { color: var(--ok); background: rgba(131,192,146,0.12); border-color: rgba(131,192,146,0.28); }
.pill.down { color: var(--danger); background: rgba(240,113,122,0.12); border-color: rgba(240,113,122,0.28); }
.pill.hit { color: var(--ok); }
.empty { color: var(--ink2); font-size: 12px; padding: 10px 0 12px; }
.map-empty { position: absolute; left: 12px; top: 42px; z-index: 1; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 5px 6px; border-bottom: 1px solid rgba(255,255,255,0.06); font-size: 12px; }
th { color: var(--ink3); font-weight: 500; font-family: var(--mono); font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; }
button, .btn {
  background: transparent; color: var(--ink); border: 1px solid var(--hair);
  padding: 4px 9px; font-size: 11px; cursor: pointer; border-radius: 999px;
}
button.primary { background: #f4f4f5; color: #0a0a0b; border-color: transparent; font-weight: 600; }
button.danger { color: var(--danger); }
pre, textarea {
  width: 100%; background: rgba(0,0,0,0.35); color: var(--ink);
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
.crm-funnel-track { height: 6px; background: rgba(255,255,255,0.06); border: 1px solid var(--hair); position: relative; overflow: hidden; }
.crm-funnel-ok { position: absolute; inset: 0 auto 0 0; background: var(--ok); opacity: 0.7; }
.crm-funnel-fail { position: absolute; inset: 0 0 0 auto; background: var(--danger); opacity: 0.7; }
.crm-kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin: 0 0 10px; }
.crm-kpis .n { font-size: 22px; margin-top: 4px; }
.remote a { color: var(--accent); }
.heat-wrap { display: flex; gap: 16px; align-items: flex-start; }
.heat-meta { font-family: var(--mono); font-size: 10px; color: var(--ink3); }
@media (max-width: 980px) {
  .kpis, .grid-2, .grid-3, .crm-kpis { grid-template-columns: 1fr; }
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

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Métis Operator</title>
<style>${CSS}${STATUS_BADGE_CSS}
.kpis { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
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
<header>
  <h1>Métis Operator</h1>
  <div class="who">${esc(data.email)}</div>
</header>
<div class="wrap">
  <section>
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
  </section>

  <section class="grid-2">
    <article class="card">
      <p class="eyebrow">ROI</p>
      <div class="kpis" style="grid-template-columns:repeat(3,minmax(0,1fr));gap:8px">
        ${kpiCard({ title: 'Asks 7d', value: String(data.roi.asks7d), sub: 'real ingest only', spark: '' })}
        ${kpiCard({ title: 'Live seats', value: String(data.roi.liveSeats), sub: 'last-seen under 2 minutes', spark: '' })}
        ${kpiCard({
          title: 'Cost 7d',
          value: data.roi.cost7d ?? 'not reported',
          sub: data.roi.note,
          spark: ''
        })}
      </div>
    </article>
    <article class="card">
      <p class="eyebrow">Licenses</p>
      ${
        data.licenses.empty
          ? '<div class="empty">No heartbeats yet. Licenses stay empty until a seat checks in.</div>'
          : `<table><thead><tr><th>Device</th><th>OS</th><th>Version</th><th>Where</th><th>Last seen</th><th></th></tr></thead><tbody>${data.licenses.seats
              .map(
                (s) => `<tr>
        <td>${esc(s.device)}</td>
        <td class="muted">${esc(s.os)}</td>
        <td class="muted">${esc(s.version)}</td>
        <td class="muted">${esc(s.country || '')}</td>
        <td class="muted">${esc(when(s.lastSeen))}</td>
        <td>${s.live ? '<span class="pill up">live</span>' : '<span class="pill">idle</span>'}</td>
      </tr>`
              )
              .join('')}</tbody></table>
             <div class="sub muted" style="padding-bottom:8px">Real D1 seats. Activate stays on Fly. No keys on this page.</div>`
      }
    </article>
  </section>

  <section class="grid-2">
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
  </section>

  <section class="grid-2">
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
  </section>

  <section class="card" style="padding-bottom:10px">
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
    <div class="sub muted" style="padding-bottom:8px">Unique devices by country from Cloudflare request.cf. No GPS from the app. No IP.</div>
  </section>

  <section class="grid-2">
    <article class="card">
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
    <article class="card">
      <p class="eyebrow">Asks</p>
      ${
        askRows
          ? `<table><thead><tr><th>Mode</th><th>Preview</th><th>Cache</th><th>Provider</th><th></th></tr></thead><tbody>${askRows}</tbody></table>`
          : '<div class="empty">No Asks on the fleet yet.</div>'
      }
      <div id="reveal" class="muted" style="padding:8px 0"></div>
    </article>
  </section>

  <section class="card" style="padding-bottom:10px">
    <p class="eyebrow">CRM landing</p>
    <div class="crm-kpis">
      ${kpiCard({ title: 'Landed today', value: String(landing.landedToday), sub: 'success with a CRM id when the connector returned one', spark: '' })}
      ${kpiCard({ title: 'Fail rate', value: failRate, sub: 'failed + expired over attempted', spark: '' })}
      ${kpiCard({ title: 'Retries', value: String(landing.retries), sub: 'Tony Retry or attempt over 1', spark: '' })}
      ${kpiCard({ title: 'Dead letters', value: String(landing.deadLetters), sub: 'max attempts, Expired', spark: '' })}
    </div>
    ${
      funnelRows
        ? `<p class="eyebrow">Funnel by connector</p><div class="crm-funnel">${funnelRows}</div>`
        : ''
    }
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
  </section>

  <section class="card" style="padding-bottom:10px">
    <div class="row" style="margin-bottom:8px">
      <p class="eyebrow" style="margin:0">Skills</p>
      <button data-draft="interview">Draft interview</button>
      <button data-draft="recruiting">Draft recruiting</button>
      <button data-draft="support">Draft support</button>
    </div>
    ${props || '<div class="empty">No skill upgrades waiting. Use Ask in a mode, then Draft.</div>'}
  </section>
</div>
<script>
async function api(path, body) {
  const r = await fetch(path, { method: body ? 'POST' : 'GET', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
  return r.json()
}
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
