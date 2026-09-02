import { STATUS_BADGE_CSS } from '../components/ui/status-badge'

/** Shoey chrome. Hashed and served at /assets/operator-<hash>.css. Not a stub. */
export const CONSOLE_CSS = `/* Métis Operator SPA — Shoey Overview / Realtime / Events */
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
.kpis-extra { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 10px; }
.ev-grid { display: grid; grid-template-columns: minmax(200px, 240px) 1fr; gap: 12px; align-items: start; }
.ev-names { display: flex; flex-direction: column; gap: 2px; max-height: 560px; overflow: auto; }
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
.world.shoey-world.ov { min-height: 180px; max-height: 220px; }
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
svg path { vector-effect: non-scaling-stroke; }
#spark-defs { position: absolute; width: 0; height: 0; }
@media (max-width: 980px) {
  .shell { grid-template-columns: 1fr; }
  .rail { position: relative; min-height: auto; }
  .kpis, .kpis-extra, .grid-2, .grid-3, .crm-kpis, .event, .rt-grid, .ev-grid { grid-template-columns: 1fr; }
}
${STATUS_BADGE_CSS}
`
