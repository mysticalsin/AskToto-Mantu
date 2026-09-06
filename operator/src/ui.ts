import { choropleth, choroplethMini, shoeyWorld, sparklineLine } from './charts'
import { statusBadge, STATUS_BADGE_CSS } from './components/ui/status-badge'
import { CRM_FILTER_ORDER } from './crm'
import { CF_TOKEN_MISSING, type CloudflareOverview } from './cloudflare'
import type { ConsoleEvent, DashboardPayload, ProfileRow } from './dashboard'
import { FORBIDDEN_NAV, NAV_IDS, NAV_SECTIONS } from './nav'
import { looksLikeSecret } from './redact'
import { formatAvgDuration, geoCountryRollup } from './realtime-geo'

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
  --accent: #2563EB;
  --live: #10B981;
  --ok: #16A34A;
  --danger: #DC2626;
  --land: #3f3f46;
  --chart-1: #1a1a1d;
  --chart-2: #2a2a2e;
  --chart-3: #52525b;
  --chart-4: #a1a1aa;
  --chart-5: #2563EB;
  --nav: #0d0d0f;
  --nav-on: rgba(255,255,255,0.08);
  --dot: rgba(255,255,255,0.045);
  --mono: 'Geist Mono', ui-monospace, SFMono-Regular, monospace;
  --sans: 'Geist', Geist, Inter, system-ui, sans-serif;
}
[data-theme="light"] {
  --bg: #FFFFFF;
  --panel: #FFFFFF;
  --hair: #EDEDED;
  --ink: #18181B;
  --ink2: #71717A;
  --ink3: #A1A1AA;
  --land: #E5E7EB;
  --chart-1: #e4e4e7;
  --chart-2: #d4d4d8;
  --chart-3: #a1a1aa;
  --chart-4: #52525b;
  --chart-5: #2563EB;
  --nav: #FFFFFF;
  --nav-on: #F4F4F5;
  --dot: rgba(24,24,27,0.06);
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
.rail-brand { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.rail-brand h1 { margin: 0; font-size: 15px; font-weight: 650; letter-spacing: -0.04em; }
.rail-sub { margin: -4px 0 2px; font: 10px/1.2 var(--mono); letter-spacing: 0.14em; text-transform: uppercase; color: var(--ink3); }
.access-chip {
  font: 10px/1 var(--mono); letter-spacing: 0.08em; text-transform: uppercase;
  padding: 3px 7px; border-radius: 999px; border: 1px solid var(--hair); color: var(--live);
}
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
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 7px 8px; border-radius: 8px; color: var(--ink);
  font-size: 13px; font-weight: 550;
}
.nav-item:hover { background: var(--nav-on); }
.nav-item.on { background: var(--nav-on); font-weight: 650; }
.nav-count {
  min-width: 18px; text-align: center; font: 10px/16px var(--mono);
  border-radius: 999px; background: var(--accent); color: #fff; padding: 0 5px;
}
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
.wrap { padding: 12px 16px 36px; display: grid; gap: 12px; isolation: isolate; overflow-x: hidden; }
.page { min-width: 0; position: relative; z-index: 1; }
.kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.kpis.glance { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.kpis.glance .kpi .n { font-size: 32px; margin-top: 12px; }
@media (max-width: 1100px) { .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); } .kpis.glance { grid-template-columns: 1fr; } }
.ov-split { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(280px, 0.85fr); gap: 12px; align-items: start; }
.people-row {
  display: grid; grid-template-columns: 56px minmax(0, 1.1fr) minmax(0, 1.1fr) 110px 88px 72px;
  gap: 8px; align-items: center; padding: 8px 4px; border-bottom: 1px solid var(--hair);
}
.people-row .who { font-weight: 650; color: var(--ink); font-size: 12px; word-break: break-word; }
.activity-feed .event { padding: 8px 2px; grid-template-columns: 72px minmax(0, 1fr) minmax(0, 1.4fr) 72px; }
@media (max-width: 980px) { .ov-split, .people-row { grid-template-columns: 1fr; } }
.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; min-width: 0; }
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
.tab.on { background: var(--accent); color: #fff; }
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
.crm-kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.world-wrap { overflow: hidden; max-height: 280px; }
.geo-corner { display: grid; grid-template-columns: minmax(0, 1fr) 168px; gap: 10px; align-items: start; }
.geo-corner-map { width: 168px; }
.geo-corner-map svg { display: block; width: 100%; height: auto; max-height: 120px; }
.geo-live { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; align-items: start; }
.rt-world { padding-bottom: 10px; }
.rt-world .world { display: block; width: 100%; height: auto; min-height: 280px; max-height: 480px; }
.rt-split { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; align-items: start; }
.ov-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.vol { position: relative; }
.vol-row {
  display: grid; grid-template-columns: 1fr auto auto; gap: 8px; align-items: center;
  padding: 6px 8px; position: relative; font-size: 12px;
}
.vol-bar {
  position: absolute; inset: 2px auto 2px 0; background: color-mix(in srgb, var(--accent) 22%, transparent);
  border-radius: 4px; z-index: 0;
}
.vol-row > * { position: relative; z-index: 1; }
.rt-row {
  display: grid; grid-template-columns: 88px minmax(0, 1fr) minmax(0, 1.4fr) 72px;
  gap: 8px; align-items: center; padding: 6px 2px; border-bottom: 1px solid var(--hair); font-size: 12px;
}
.rt-row .ago { font-family: var(--mono); font-size: 10px; color: var(--ink3); text-align: right; }
@media (max-width: 980px) { .ov-pair, .rt-row { grid-template-columns: 1fr; } }
.geo-bar { display: block; height: 3px; margin-top: 4px; background: var(--accent); max-width: 100%; }
@media (max-width: 980px) { .geo-corner, .geo-live, .rt-split { grid-template-columns: 1fr; } }
.key-form { display: grid; gap: 8px; margin: 0 0 14px; }
.license-once {
  display: grid; gap: 8px; margin: 0 0 14px; padding: 10px 12px;
  border: 1px solid var(--hair); border-radius: 8px; background: var(--bg);
}
.license-once input {
  width: 100%; border: 1px solid var(--hair); background: var(--panel); color: var(--ink);
  border-radius: 8px; padding: 8px 10px; font: 12px var(--mono);
}
.key-form .row input, .key-form .row select {
  border: 1px solid var(--hair); background: var(--bg); color: var(--ink);
  border-radius: 8px; padding: 6px 8px; font: 12px var(--sans); min-width: 120px;
}
.map-empty { position: absolute; left: 12px; top: 42px; z-index: 1; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; }
th, td { text-align: left; padding: 7px 6px; border-bottom: 1px solid var(--hair); font-size: 12px; vertical-align: top; overflow: hidden; text-overflow: ellipsis; }
.search-bar {
  width: 100%; border: 1px solid var(--hair); background: var(--bg); color: var(--ink);
  border-radius: 8px; padding: 7px 10px; font: 12px var(--sans); margin: 0 0 10px;
}
.event[hidden], tr[hidden] { display: none !important; }
.rule { padding: 10px 0; border-bottom: 1px solid var(--hair); }
.rule h3 { margin: 0 0 4px; font-size: 13px; }
.rule p { margin: 0; color: var(--ink2); font-size: 12px; }
th { color: var(--ink3); font-weight: 500; font-family: var(--mono); font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; }
button, .btn {
  background: transparent; color: var(--ink); border: 1px solid var(--hair);
  padding: 4px 9px; font-size: 11px; cursor: pointer; border-radius: 999px;
}
button.primary, a.btn.primary { background: var(--accent); color: #fff; border-color: transparent; font-weight: 600; }
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
.live { display: inline-block; padding: 1px 7px; border-radius: 999px; background: var(--live); color: #052e1b; font: 10px var(--mono); letter-spacing: 0.08em; }
[data-theme="light"] .live { background: #10B981; color: #052e1b; }
.approval {
  display: inline-block; padding: 1px 7px; border-radius: 999px;
  font: 10px/1.4 var(--mono); letter-spacing: 0.04em; border: 1px solid var(--hair);
}
.approval.pending { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, var(--hair)); }
.approval.approved { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 40%, var(--hair)); }
.approval.revoked { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 40%, var(--hair)); }
.works { padding-bottom: 12px; }
.works-path {
  list-style: none; margin: 0 0 12px; padding: 0;
  display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px;
}
.works-path li {
  position: relative; padding: 10px 10px 10px 12px;
  border: 1px solid var(--hair); border-radius: 10px; background: var(--bg);
}
.works-path li.done { border-color: color-mix(in srgb, var(--ok) 45%, var(--hair)); }
.works-path li.need { border-color: color-mix(in srgb, var(--accent) 45%, var(--hair)); }
.works-path b {
  display: block; font: 10px/1 var(--mono); letter-spacing: 0.12em;
  text-transform: uppercase; color: var(--ink3); margin-bottom: 6px;
}
.works-path span { display: block; font-weight: 650; letter-spacing: -0.02em; }
.works-path small { display: block; margin-top: 4px; color: var(--ink2); font-size: 11px; }
@media (max-width: 980px) { .works-path { grid-template-columns: 1fr; } }
@media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; } }
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

function ago(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 5) return 'now'
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h`
  return `${Math.floor(h / 24)}d`
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

function renderNav(pendingApprovals = 0): string {
  const sections = NAV_SECTIONS.map((sec) => {
    const items = sec.items
      .map((item) => {
        const count =
          item.id === 'licenses' && pendingApprovals > 0
            ? `<span class="nav-count">${pendingApprovals}</span>`
            : ''
        return `<a class="nav-item" data-nav="${item.id}" href="#${item.id}">${esc(item.label)}${count}</a>`
      })
      .join('')
    return `<div class="nav-sec"><p>${esc(sec.label)}</p>${items}</div>`
  }).join('')
  return `<nav id="rail-nav">${sections}</nav>`
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
        `<tr data-geo-city="${esc(r.city)}"><td>${esc(r.city)}${geoBar(r.count, maxCity)}</td><td class="muted">${esc(r.country)}</td><td>${r.count}</td><td class="muted">${r.unique_sessions}</td><td class="muted">${formatAvgDuration(r.avg_duration)}</td></tr>`
    )
    .join('')
  const regionRows = regions
    .map(
      (r) =>
        `<tr><td>${esc(r.region)}${geoBar(r.count, maxRegion)}</td><td class="muted">${esc(r.country)}</td><td>${r.count}</td><td class="muted">${r.unique_sessions}</td><td class="muted">${formatAvgDuration(r.avg_duration)}</td></tr>`
    )
    .join('')
  const countryRows = countries
    .map(
      (r) =>
        `<tr><td>${esc(r.country)}${geoBar(r.count, maxCountry)}</td><td>${r.count}</td><td class="muted">${r.unique_sessions}</td><td class="muted">${formatAvgDuration(r.avg_duration)}</td></tr>`
    )
    .join('')
  return `<article class="card geo-corner" data-geo-corner>
    <div>
      <p class="eyebrow">Places</p>
      <div class="tabs" id="geo-tabs">
        <button class="tab on" data-geo-tab="cities" type="button">Cities</button>
        <button class="tab" data-geo-tab="regions" type="button">Regions</button>
        <button class="tab" data-geo-tab="countries" type="button">Countries</button>
      </div>
      <div data-geo-pane="cities">
        ${
          cityRows
            ? `<table data-geo-table="cities"><thead><tr><th>City</th><th>Country</th><th>Count</th><th>Sessions</th><th>Avg</th></tr></thead><tbody>${cityRows}</tbody></table>`
            : '<div class="empty">No city geo yet. Heartbeats write request.cf city.</div>'
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
    <div class="geo-corner-map" data-geo-widget>${choroplethMini(data.map.countries)}</div>
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
        `<tr data-geo-city="${esc(r.city)}"><td>${esc(r.city)}${geoBar(r.count, maxCity)}</td><td class="muted">${esc(r.country)}</td><td>${r.count}</td><td class="muted">${r.unique_sessions}</td><td class="muted">${formatAvgDuration(r.avg_duration)}</td></tr>`
    )
    .join('')
  const regionRows = regions
    .map(
      (r) =>
        `<tr><td>${esc(r.region)}${geoBar(r.count, maxRegion)}</td><td class="muted">${esc(r.country)}</td><td>${r.count}</td><td class="muted">${r.unique_sessions}</td><td class="muted">${formatAvgDuration(r.avg_duration)}</td></tr>`
    )
    .join('')
  const countryRows = countries
    .map(
      (r) =>
        `<tr><td>${esc(r.country)}${geoBar(r.count, maxCountry)}</td><td>${r.count}</td><td class="muted">${r.unique_sessions}</td><td class="muted">${formatAvgDuration(r.avg_duration)}</td></tr>`
    )
    .join('')
  return `<article class="card" data-realtime-geo>
    <p class="eyebrow">GeoTable</p>
    <div class="tabs" data-geo-tabs="realtime">
      <button class="tab on" data-geo-tab="cities" type="button">City</button>
      <button class="tab" data-geo-tab="regions" type="button">Regions</button>
      <button class="tab" data-geo-tab="countries" type="button">Country</button>
    </div>
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
    <div id="rt-map-root" data-geo-widget>${shoeyWorld(data.map.countries, data.map.dots)}</div>
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
  const maxDev = Math.max(1, ...devices.map((r) => byDevice.get(r.hostname || r.email || r.device) ?? 0))
  const deviceBody = devices
    .map((r) => {
      const who = r.hostname || r.email || r.device
      const n = byDevice.get(who) ?? 0
      const pct = Math.max(10, Math.round((n / maxDev) * 100))
      return `<div class="vol-row" data-toplist-device="${esc(r.device)}">
        <span class="vol-bar" style="width:${pct}%"></span>
        <span>${field(who)}</span>
        <span class="muted">${field(r.city)}</span>
        <span>${r.live ? '<span class="pill up">live</span>' : '<span class="muted">idle</span>'}</span>
      </div>`
    })
    .join('')
  const kindBody = kindRows
    .map(([name, n]) => {
      const pct = Math.max(10, Math.round((n / maxKind) * 100))
      return `<div class="vol-row" data-toplist-event="${esc(name)}">
        <span class="vol-bar" style="width:${pct}%"></span>
        <span>${esc(name)}</span>
        <span class="muted">${n}</span>
        <span></span>
      </div>`
    })
    .join('')
  return `<div class="ov-pair" data-overview-toplists>
    <article class="card" style="padding-bottom:10px">
      <p class="eyebrow">Top devices</p>
      ${deviceBody || '<div class="empty">No seats yet.</div>'}
    </article>
    <article class="card" style="padding-bottom:10px">
      <p class="eyebrow">Top events</p>
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
  return `<form class="key-form license-gen" data-license-generate autocomplete="off">
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
  const mapCaption =
    'Unique devices by country from Cloudflare request.cf. No GPS from the app. No IP. Click a country to filter the fleet table. Empty is an empty world, not sample dots.'

  void FORBIDDEN_NAV
  void NAV_IDS

  const pendingApprovals = data.licenses.rows.filter((r) => r.approval !== 'approved').length
  return `<!doctype html>
<html lang="en" data-theme="dark"><head>
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
    <div class="rail-brand"><h1>Métis</h1><span class="access-chip" data-access-solid>Access</span></div>
    <p class="rail-sub">Operator</p>
    <input class="rail-search" id="nav-search" type="search" placeholder="Search" autocomplete="off">
    ${renderNav(pendingApprovals)}
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
      <div class="kpis glance" data-overview-kpis>
        ${kpiCard({ title: 'Live seats', value: String(data.roi.liveSeats), sub: 'heartbeat &lt; 2 min · real devices', spark: sparklineLine(k.liveSeries) })}
        ${kpiCard({ title: 'Time saved', value: data.roi.timeSaved, sub: data.roi.timeSavedSub, spark: '' })}
        ${kpiCard({ title: 'Value', value: data.roi.value, sub: data.roi.valueSub, spark: '' })}
      </div>
      ${renderTopLists(data)}
      <div class="ov-split">
        <article class="card activity-feed" style="padding-bottom:10px" data-overview-activity>
          <p class="eyebrow">Activity</p>
          ${
            data.events.length
              ? `<div class="sub muted" style="padding-bottom:6px">Seats, heartbeats, asks, recaps. City from request.cf. Not pageviews.</div>
                 <div data-activity-stream>${renderEvents(data.events.slice(0, 24), data.now)}</div>`
              : '<div class="empty">No activity yet. A heartbeat writes city and lands here.</div>'
          }
        </article>
        ${renderGeoCorner(data)}
      </div>
      <article class="card" style="padding-bottom:10px" data-overview-people>
        <p class="eyebrow">${liveSeats.length ? 'Live people' : 'People'}</p>
        ${renderPeopleStrip(liveSeats.length ? liveSeats : data.profiles, liveSeats.length)}
      </article>
      ${renderInstallWorks(data)}
    </section>

    <section class="page wrap" data-page="realtime" hidden>
      ${renderWorldMap(data)}
      <div class="rt-split">
        <article class="card activity-feed" style="padding-bottom:10px" data-live-feed>
          <p class="eyebrow">LiveFeed</p>
          ${
            data.events.length
              ? `<div id="rt-stream">${renderEvents(data.events.slice(0, 30), data.now)}</div>`
              : '<div class="empty">No live events yet. A heartbeat writes city and lands here.</div>'
          }
        </article>
        ${renderRealtimeGeo(data)}
      </div>
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

    <section class="page wrap" data-page="sessions" hidden>
      ${renderSessions(data)}
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
    </section>

    <section class="page wrap" data-page="rules" hidden>
      <article class="card" style="padding-bottom:10px">
        <p class="eyebrow">Rules</p>
        <div class="rule"><h3>Access only</h3><p>Console and admin APIs require Cloudflare Access email-code. Allowlist tony.walteur@gmail.com and twalteur@amaris.com. No homemade login. Access-solid.</p></div>
        <div class="rule"><h3>Install → works</h3><p>A seat checks in. Tony approves it or the seat activates an Operator license in Métis → Identity → License. Then Métis uses Operator platform keys. No provider-key paste by default. Unapproved seats fail loud.</p></div>
        <div class="rule"><h3>Generate license</h3><p>On Licenses, Tony clicks Generate license and picks how long it stays active. Paste that string into Métis Identity. Selling ATK / JWS activation stays closed.</p></div>
        <div class="rule"><h3>Seat approval</h3><p>A device stays pending until Tony approves it on Licenses or an Operator license is active on the seat. Revoke still wins. Unapproved seats get fundedProviders [] and 403 on /v1/use. Live pending: ${data.profiles.filter((p) => p.approval !== 'approved').length}.</p></div>
        <div class="rule"><h3>Cloudflare · AI Gateway</h3><p>Log in to Cloudflare on Keys. Operator provisions the AI Gateway key. Paste is not the happy path. No CF token on seats.</p></div>
        <div class="rule"><h3>Platform keys first</h3><p>Authorized seats use Operator vault keys (NIM, Anthropic, DeepSeek, Cloudflare AI Gateway, more). Manual Métis Settings keys stay as fallback. CLI still wins when connected.</p></div>
        <div class="rule"><h3>CRM never auto-send</h3><p>Pushes ingest status only. Tony Retry marks retry_requested. The seat processes that id. Intelligence / import / index never send.</p></div>
        <div class="rule"><h3>No secrets in HTML</h3><p>Keys last4 only. Events drop token-shaped strings. Heartbeat never carries a raw key or grant.</p></div>
        <div class="rule"><h3>Real ingest only</h3><p>Globe, Users, Licenses, ROI, and Events come from D1 heartbeats and Asks. usage-import rows stay off the fleet.</p></div>
      </article>
    </section>

    <section class="page wrap" data-page="pushes" hidden>
      <article class="card" style="padding-bottom:10px">
        <p class="eyebrow">Data-push telemetry</p>
        <div class="sub muted" style="padding-bottom:8px">Outbound Métis → CRM / DB. Architecture: seat HMAC ingest <code>event=crm</code> → Operator D1 <code>crm_sends</code> → named connector (ClickUp, BidStack, Plane, Outlook). Connectors may be stubbed; the log is live.</div>
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
            ? `<table id="crm-table"><thead><tr><th>Status</th><th>Title</th><th>Connector</th><th>Remote</th><th>Try</th><th>Meeting</th><th>When</th><th></th></tr></thead><tbody>${crmRows}</tbody></table>
               <div class="sub muted" style="padding-bottom:8px">Retry on Failed or Expired tells that seat to processDue that id. Never auto-send.</div>`
            : '<div class="empty">No outbound pushes ingested yet.</div>'
        }
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
        <p class="sub muted">Choose Cloudflare. Log in to the Cloudflare account. Operator adds the API key. No paste.</p>
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
  </div>
</div>
<script>
async function api(path, body) {
  const r = await fetch(path, { method: body ? 'POST' : 'GET', credentials: 'same-origin', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
  return r.json()
}
const titles = {
  overview: 'Overview', realtime: 'Realtime', events: 'Events', sessions: 'Sessions',
  profiles: 'Sessions', map: 'Map', macos: 'macOS', windows: 'Windows', licenses: 'Licenses',
  skills: 'Skills', keys: 'Keys', notifications: 'Notifications', rules: 'Rules', pushes: 'Pushes',
  users: 'Sessions', settings: 'Settings'
}
function route() {
  const raw = (location.hash || '#overview').replace('#', '')
  const id = raw === 'users' || raw === 'profiles' ? 'sessions' : titles[raw] ? raw : 'overview'
  document.querySelectorAll('[data-page]').forEach((p) => { p.hidden = p.getAttribute('data-page') !== id })
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('on', a.getAttribute('data-nav') === id))
  const t = document.getElementById('page-title')
  if (t) t.textContent = titles[id]
}
window.addEventListener('hashchange', route)
route()
const evSearch = document.getElementById('events-search')
if (evSearch) evSearch.addEventListener('input', () => {
  const q = evSearch.value.trim().toLowerCase()
  document.querySelectorAll('#events-table [data-q]').forEach((row) => {
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
  const theme = v === 'light' ? 'light' : 'dark'
  document.documentElement.setAttribute('data-theme', theme)
}
try { applyTheme(localStorage.getItem('metis-operator-theme')) } catch (e) { applyTheme('dark') }
if (themeBtn) themeBtn.addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light'
  applyTheme(next)
  try { localStorage.setItem('metis-operator-theme', next) } catch (e) {}
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
document.querySelectorAll('[data-geo-tab]').forEach((b) => b.addEventListener('click', () => {
  const root = b.closest('[data-geo-corner], [data-realtime-geo]') || document
  root.querySelectorAll('[data-geo-tab]').forEach((x) => x.classList.toggle('on', x === b))
  const v = b.getAttribute('data-geo-tab')
  root.querySelectorAll('[data-geo-pane]').forEach((p) => { p.hidden = p.getAttribute('data-geo-pane') !== v })
}))
const sessSearch = document.getElementById('sessions-search')
if (sessSearch) sessSearch.addEventListener('input', () => {
  const q = sessSearch.value.trim().toLowerCase()
  document.querySelectorAll('[data-seat-row]').forEach((row) => {
    row.hidden = Boolean(q) && !(row.getAttribute('data-q') || '').includes(q)
  })
})
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
;(function cfResult() {
  const q = new URLSearchParams(location.search).get('cf')
  const el = document.getElementById('cf-connect-msg')
  if (!el || !q) return
  if (q === 'connected') el.textContent = 'AI Gateway key added. last4 only.'
  else if (q === 'failed') el.textContent = 'Cloudflare login worked, but Operator could not provision the key.'
  else if (q === 'denied') el.textContent = 'Cloudflare login was cancelled.'
  else if (q === 'need-oauth') el.textContent = 'Cloudflare OAuth client is missing on this Worker.'
})()
const keyMsg = document.getElementById('key-msg')
function showKey(j) {
  if (!keyMsg) return
  if (j && j.ok) keyMsg.textContent = j.last4 ? ('saved ··' + j.last4) : (j.status || 'ok')
  else keyMsg.textContent = (j && j.error) || 'failed'
}
const addForm = document.getElementById('key-add')
if (addForm) addForm.addEventListener('submit', async (e) => {
  e.preventDefault()
  const fd = new FormData(addForm)
  const j = await api('/v1/admin/keys', { provider: fd.get('provider'), label: fd.get('label'), secret: fd.get('secret') })
  if (j && j.ok) location.reload()
  else showKey(j)
})
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
document.querySelectorAll('[data-license-approve]').forEach((b) => b.addEventListener('click', async () => {
  await api('/v1/admin/licenses/' + encodeURIComponent(b.getAttribute('data-license-approve')) + '/approve', {})
  location.reload()
}))
document.querySelectorAll('[data-license-revoke]').forEach((b) => b.addEventListener('click', async () => {
  await api('/v1/admin/licenses/' + encodeURIComponent(b.getAttribute('data-license-revoke')) + '/revoke', {})
  location.reload()
}))
document.querySelectorAll('[data-license-generate]').forEach((form) => {
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const fd = new FormData(form)
    const j = await api('/v1/admin/licenses/generate', { days: Number(fd.get('days')) })
    const root = form.parentElement
    const box = root && root.querySelector('[data-license-once]')
    const input = root && root.querySelector('[data-license-once-value]')
    if (j && j.ok && j.license && box && input) {
      input.value = j.license
      box.hidden = false
    }
  })
})
document.querySelectorAll('[data-license-once-copy]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const root = btn.parentElement
    const input = root && root.querySelector('[data-license-once-value]')
    if (input && input.value && navigator.clipboard) await navigator.clipboard.writeText(input.value)
  })
})
</script>
</body></html>`
}

