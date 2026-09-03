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
  --land: #E5E7EB;
  --ocean: #FFFFFF;
  --land-stroke: #6B7280;
  --chart-1: #EFF6FF;
  --chart-2: #BFDBFE;
  --chart-3: #60A5FA;
  --chart-4: #2563EB;
  --chart-5: #1D4ED8;
  --nav: #FFFFFF;
  --nav-on: #F4F4F5;
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --mono: 'Geist Mono', ui-monospace, SFMono-Regular, monospace;
  --sans: 'Geist', 'Geist Sans', ui-sans-serif, system-ui, sans-serif;
}
[data-theme="dark"] {
  --bg: #0a0a0b;
  --panel: #111113;
  --hair: rgba(255,255,255,0.10);
  --ink: rgba(255,255,255,0.94);
  --ink2: rgba(255,255,255,0.55);
  --ink3: rgba(255,255,255,0.38);
  --land: #3f3f46;
  --ocean: #0a0a0b;
  --land-stroke: #111827;
  --nav: #0d0d0f;
  --nav-on: rgba(255,255,255,0.08);
}
* { box-sizing: border-box; }
html { color-scheme: light; }
html[data-theme="dark"] { color-scheme: dark; }
html, body { margin: 0; height: 100%; color: var(--ink); background: var(--bg); font: 12px/1.4 var(--sans); -webkit-font-smoothing: antialiased; }
body { background: var(--bg); color: var(--ink); }
a { color: var(--accent); text-decoration: none; }
.shell { display: grid; grid-template-columns: 185px 1fr; min-height: 100%; }
.rail {
  display: flex; flex-direction: column; gap: 8px;
  background: var(--nav); border-right: 1px solid var(--hair);
  padding: 12px 10px 14px; min-height: 100vh; position: sticky; top: 0;
  width: 185px;
}
.rail-brand { display: flex; align-items: center; gap: 8px; padding: 2px 4px 6px; }
.rail-logo {
  width: 22px; height: 22px; border-radius: 999px; flex-shrink: 0;
  background: #2563EB; color: #fff;
  display: grid; place-items: center;
  font: 700 10px/1 var(--sans); letter-spacing: -0.04em;
  border: 0;
}
[data-theme="dark"] .rail-logo {
  background: transparent;
  border: 1.5px solid rgba(255,255,255,0.42);
  color: transparent;
  font-size: 0;
}
.rail-brand h1 { margin: 0; font-size: 13px; font-weight: 650; letter-spacing: -0.03em; }
.rail-brand .chev { color: var(--ink3); font-size: 11px; }
.rail nav { display: flex; flex-direction: column; gap: 14px; flex: 1; }
.nav-sec { display: flex; flex-direction: column; gap: 2px; }
.nav-sec p {
  font-size: 11px; letter-spacing: 0.02em; color: var(--ink3); margin: 8px 8px 4px; font-weight: 550;
}
.nav-item {
  display: block; padding: 7px 10px; border-radius: 8px; color: var(--ink2);
  font-size: 12.5px; font-weight: 500; letter-spacing: -0.01em;
  transition: background 160ms var(--ease-out), color 160ms var(--ease-out);
}
.nav-item:hover { background: var(--nav-on); color: var(--ink); }
.nav-item.on { background: var(--nav-on); color: var(--ink); font-weight: 600; }
.rail-foot { margin-top: auto; display: flex; flex-direction: column; gap: 8px; padding-top: 12px; }
.rail-utils { display: flex; gap: 8px; flex-wrap: wrap; }
.rail-utils a, .rail-utils button { color: var(--ink2); font-size: 11px; background: none; border: 0; cursor: pointer; padding: 0; }
.who { font-family: var(--mono); font-size: 10px; color: var(--ink2); word-break: break-all; }
.theme-btn {
  border: 1px solid var(--hair); background: transparent; color: var(--ink2);
  font: 11px/1 var(--mono); letter-spacing: 0.06em; text-transform: uppercase;
  padding: 6px 8px; border-radius: 8px; cursor: pointer;
}
.main { min-width: 0; background: var(--bg); }
.top {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 10px 16px; border-bottom: 1px solid var(--hair);
  background: var(--panel); position: sticky; top: 0; z-index: 4;
}
.top-left, .top-right { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.tool {
  border: 1px solid var(--hair); background: var(--panel); color: var(--ink);
  border-radius: 8px; padding: 6px 10px; font: 12px var(--sans); cursor: pointer;
}
.top-search {
  flex: 1; min-width: 180px; border: 1px solid var(--hair); background: var(--panel); color: var(--ink);
  border-radius: 8px; padding: 7px 12px; font: 12px var(--sans);
}
.live-dot {
  display: inline-flex; align-items: center; gap: 6px; font: 12px/1 var(--sans); color: var(--ink);
  border: 1px solid var(--hair); border-radius: 999px; padding: 5px 10px; background: var(--panel);
}
.live-dot i { width: 7px; height: 7px; border-radius: 99px; background: var(--live); display: inline-block; }
.top h2 { margin: 0; font-size: 16px; font-weight: 650; letter-spacing: -0.03em; }
.eyebrow {
  font-size: 10px; letter-spacing: 0.12em;
  text-transform: uppercase; color: var(--ink3); margin: 0 0 8px; font-weight: 600;
}
.wrap { padding: 14px 16px 36px; display: grid; gap: 12px; }
.page { animation: pageFade 420ms var(--ease-out); }
.page.page-enter { animation: pageFade 420ms var(--ease-out); }
.page[hidden] { display: none !important; animation: none; }
@keyframes pageFade {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: none; }
}
.kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.kpis-extra { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 10px; }
.ov-10 { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; }
.stat-card {
  background: var(--panel); border: 1px solid var(--hair); border-radius: 12px;
  padding: 14px 14px 0; overflow: hidden; min-width: 0; color: var(--ink);
}
.stat-card-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.stat-card h3 { margin: 0; font-size: 12px; font-weight: 550; letter-spacing: -0.01em; color: var(--ink2); }
.trend-badge {
  font: 600 11px var(--sans); padding: 2px 7px; border-radius: 6px;
  border: 1px solid rgba(22,163,74,0.2); background: rgba(22,163,74,0.08); color: #16A34A;
}
.trend-badge.down { border-color: rgba(220,38,38,0.2); background: rgba(220,38,38,0.08); color: #DC2626; }
.trend-badge.flat { border-color: var(--hair); background: var(--nav-on); color: var(--ink2); }
.stat-flow { display: flex; align-items: baseline; gap: 8px; margin: 12px 0 6px; }
.stat-flow .n {
  font-size: 28px; font-weight: 650; letter-spacing: -0.045em; line-height: 1; color: var(--ink);
  animation: kpiSettle 560ms var(--ease-out) both;
}
.stat-flow .lbl { font-size: 11px; color: var(--ink3); }
@keyframes kpiSettle {
  from { opacity: 0.35; transform: translateY(5px); }
  to { opacity: 1; transform: none; }
}
.stat-card .spark, .stat-card .stat-spark { display: block; width: calc(100% + 28px); margin: 6px -14px 0; height: 72px; }
.stat-gauge, .stat-ring { height: 64px; margin-left: auto; margin-right: auto; width: 88px; }
.stat-choro-wrap { margin: 6px -14px 0; height: 78px; overflow: hidden; }
.stat-choro { display: block; width: 100%; height: 78px; }
.ov-chips { display: flex; flex-wrap: wrap; gap: 8px 14px; opacity: 0.9; }

.ov-hero {
  display: grid; gap: 10px; padding: 4px 2px 2px;
}
.ov-brand { display: inline-flex; align-items: center; gap: 10px; }
.ov-mark {
  width: 28px; height: 28px; border-radius: 999px; flex-shrink: 0;
  background: #2563EB; color: #fff;
  display: grid; place-items: center;
  font: 700 11px/1 var(--sans); letter-spacing: -0.04em;
  border: 0;
}
[data-theme="dark"] .ov-mark {
  background: transparent;
  border: 1.5px solid rgba(255,255,255,0.42);
  color: transparent;
  font-size: 0;
}
.ov-brand-name {
  font-size: 22px; font-weight: 650; letter-spacing: -0.045em; color: var(--ink); line-height: 1;
}
.ov-headline {
  margin: 0; font-size: 15px; font-weight: 550; letter-spacing: -0.02em; color: var(--ink2);
}
.ov-lede { margin: 0; font-size: 13px; color: var(--ink3); max-width: 42rem; line-height: 1.45; }

.ov-live {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px 20px;
  padding: 14px 16px; border: 1px solid var(--hair); border-radius: 12px;
  background: var(--panel);
}
.ov-live-landed {
  border-color: color-mix(in srgb, var(--accent) 35%, var(--hair));
  background: var(--panel);
  animation: ovLand 700ms ease-out;
}
.ov-live-idle { background: var(--panel); }
.ov-live-main { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
.ov-live-dot {
  width: 8px; height: 8px; border-radius: 99px; background: var(--live);
  box-shadow: 0 0 0 0 rgba(34,197,94,0.4);
  animation: ovPulse 1.8s ease-out infinite;
}
.ov-live-idle .ov-live-dot { background: var(--ink3); animation: none; box-shadow: none; }
.ov-live-label { font: 650 13px/1.2 var(--sans); color: var(--ink); letter-spacing: -0.02em; }
.ov-live-range { font: 500 12px/1.2 var(--mono); color: var(--ink2); }
.ov-live-meta { font: 12px var(--sans); color: var(--ink2); }
.ov-live-stats {
  display: grid; grid-auto-flow: column; grid-auto-columns: max-content;
  gap: 18px; align-items: baseline;
}
.ov-live-stat {
  display: inline-flex; align-items: baseline; gap: 6px;
  font: 12px var(--sans); color: var(--ink2);
}
.ov-live-stat b { font: 650 14px/1 var(--mono); color: var(--ink); letter-spacing: -0.03em; }
.stat-card-landed {
  border-color: color-mix(in srgb, var(--accent) 40%, var(--hair));
  animation: ovLand 700ms ease-out;
}
.ov-cf-secondary { margin-top: 4px; opacity: 0.92; }
@keyframes ovPulse {
  0% { box-shadow: 0 0 0 0 rgba(34,197,94,0.4); }
  70% { box-shadow: 0 0 0 7px rgba(34,197,94,0); }
  100% { box-shadow: 0 0 0 0 rgba(34,197,94,0); }
}
@keyframes ovLand {
  from { transform: translateY(4px); opacity: 0.55; }
  to { transform: none; opacity: 1; }
}

.ov-chip {
  display: inline-flex; align-items: baseline; gap: 6px;
  border: 0; border-radius: 0; padding: 0;
  font-size: 12px; color: var(--ink2); background: transparent;
}
.ov-chip b { color: var(--ink); font-weight: 600; font-size: 11px; letter-spacing: 0.02em; text-transform: uppercase; }
.ev-grid { display: grid; grid-template-columns: 1fr; gap: 12px; align-items: start; }
.ev-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin: 0 0 10px; }
.ev-sub { margin: 4px 0 0; font-size: 12px; }
.ev-tabs { margin: 0 0 10px; }
.page-hero { display: grid; gap: 6px; margin: 2px 0 6px; }
.page-title { margin: 0; font-size: 24px; font-weight: 650; letter-spacing: -0.045em; color: var(--ink); }
.page-sub { margin: 0; font-size: 13px; color: var(--ink2); max-width: 40rem; line-height: 1.45; }
.page-tabs { display: flex; flex-wrap: wrap; gap: 4px; margin: 8px 0 12px; }
.page-tab {
  border: 0; background: transparent; color: var(--ink2);
  font: 500 13px/1 var(--sans); padding: 7px 12px; border-radius: 8px; cursor: pointer;
}
.page-tab.on { background: #F4F4F5; color: #18181B; font-weight: 600; }
[data-theme="dark"] .page-tab.on { background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.94); }
.page-tabs.underline { gap: 16px; border-bottom: 1px solid var(--hair); padding-bottom: 0; }
.page-tabs.underline .page-tab { border-radius: 0; padding: 8px 2px 10px; }
.page-tabs.underline .page-tab.on {
  background: transparent; color: var(--ink);
  box-shadow: inset 0 -2px 0 #18181B;
}
[data-theme="dark"] .page-tabs.underline .page-tab.on { box-shadow: inset 0 -2px 0 #f4f4f5; }
.page-toolbar {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 0 0 10px;
}
.page-toolbar .toolbar-search { flex: 1; min-width: 160px; margin-bottom: 0; }
.page-toolbar .page-view { margin-left: auto; }
.page-toolbar .tool { display: inline-flex; align-items: center; gap: 6px; }
.tool-ic { width: 14px; height: 14px; display: block; flex-shrink: 0; }
.search-wrap {
  position: relative; flex: 1; min-width: 180px; display: flex; align-items: center;
}
.search-wrap .tool-ic {
  position: absolute; left: 10px; color: var(--ink3); pointer-events: none;
}
.search-wrap .toolbar-search { padding-left: 32px; width: 100%; }
.listen-pill, .live-events {
  display: inline-flex; align-items: center; gap: 6px;
  border: 1px solid var(--hair); background: var(--panel); border-radius: 999px;
  padding: 5px 10px; font-size: 12px; font-weight: 600; color: var(--ink);
}
.listen-pill i, .live-events i {
  width: 8px; height: 8px; border-radius: 999px; background: var(--live);
  box-shadow: 0 0 0 3px rgba(16,185,129,0.16);
}
.table-frame { min-height: 280px; }
.empty-data {
  display: grid; justify-items: center; gap: 8px; text-align: center;
  padding: 56px 16px; color: var(--ink);
}
.empty-data strong { font-size: 15px; font-weight: 650; letter-spacing: -0.02em; }
.empty-data p { margin: 0; color: var(--ink2); font-size: 13px; max-width: 26rem; line-height: 1.45; }
.empty-dash {
  width: 40px; height: 40px; border: 1.5px dashed var(--ink3); border-radius: 10px;
  margin-bottom: 4px;
}
.stat-line {
  display: flex; justify-content: space-between; gap: 12px;
  padding: 8px 2px; border-bottom: 1px solid var(--hair); font-size: 13px;
}
.stat-line b { font-weight: 650; }
.ev-table-card { border-radius: 14px; overflow: hidden; padding-top: 4px; }
.ev-names { display: flex; flex-direction: column; gap: 2px; max-height: 560px; overflow: auto; }
.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; }
.card {
  position: relative;
  background: var(--panel);
  border: 1px solid var(--hair);
  border-radius: 12px;
  padding: 12px 14px 0;
  overflow: hidden;
  color: var(--ink);
}
.card h3 { margin: 0; font-size: 13px; font-weight: 600; color: var(--ink); }
.kpi-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; }
.kpi { padding-bottom: 8px; }
.kpi .eyebrow { margin-bottom: 4px; }
.kpi .n { font-size: 28px; font-weight: 650; letter-spacing: -0.04em; line-height: 1; margin-top: 6px; color: var(--ink); }
.rt-h { margin: 0; font-size: 16px; font-weight: 650; letter-spacing: -0.03em; color: var(--ink); }
.rt-n { font-size: 44px !important; margin-top: 8px !important; letter-spacing: -0.05em; }
.rt-unique { padding-top: 14px; }
.delta { font-size: 11px; font-weight: 600; }
.delta.up { color: var(--ok); }
.delta.down { color: var(--danger); }
.delta.flat { color: var(--ink3); }
.rt-kpi-bar {
  display: flex; align-items: flex-end; justify-content: space-between; gap: 16px;
  padding: 14px 16px 12px; border: 1px solid var(--hair); border-radius: 14px;
  background: var(--panel); min-height: 0;
}
.rt-kpi { display: grid; gap: 6px; min-width: 0; }
.rt-kpi .n {
  margin: 0; font: 650 28px/1 var(--sans); letter-spacing: -0.04em; color: var(--ink);
  animation: kpiSettle 560ms var(--ease-out) both;
}
.rt-kpi-spark { flex: 1; max-width: 320px; min-width: 140px; opacity: 0.95; }
.rt-kpi-spark .chart, .rt-kpi-spark svg { display: block; width: 100%; height: 48px; }
.rt-stage {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(260px, 320px);
  gap: 14px;
  align-items: stretch;
  min-height: 560px;
}
.rt-map-full {
  position: relative;
  min-width: 0;
  min-height: 560px;
  background: #FFFFFF;
  border: 1px solid var(--hair);
  border-radius: 14px;
  overflow: hidden;
}
.rt-map-full #map-root { min-height: 560px; height: 100%; background: #FFFFFF; }
#map-root[data-land="inline"] { min-height: 560px; background: #FFFFFF; }
#map-root[data-land="inline"] svg.shoey-world {
  display: block; width: 100%; height: auto; min-height: 560px;
}
[data-theme="dark"] .rt-map-full,
[data-theme="dark"] .rt-map-full #map-root,
[data-theme="dark"] #map-root[data-land="inline"] { background: #0a0a0b; }
.rt-map-full .world.shoey-world { min-height: 560px; max-height: none; }
.rt-hud-lbl {
  display: block; font-size: 11px; font-weight: 650; letter-spacing: 0.06em;
  text-transform: uppercase; color: var(--ink3);
}
.rt-roster {
  display: flex; flex-direction: column; gap: 10px; min-height: 0;
  border: 1px solid var(--hair); border-radius: 14px; background: var(--panel);
  padding: 14px; overflow: hidden;
}
.rt-roster-head {
  display: flex; align-items: baseline; justify-content: space-between; gap: 8px;
  padding-bottom: 4px; border-bottom: 1px solid var(--hair);
}
.rt-roster-count { font: 650 18px/1 var(--sans); letter-spacing: -0.03em; color: var(--ink); }
.rt-roster-list {
  display: flex; flex-direction: column; gap: 4px;
  overflow: auto; min-height: 0; flex: 1;
}
.rt-roster-empty { padding: 22px 10px; line-height: 1.5; }
.rt-seat {
  display: grid; gap: 6px; padding: 10px 8px;
  border-radius: 10px; border: 1px solid transparent;
  animation: rt-seat-in 0.34s ease-out both; cursor: pointer;
  transition: background 160ms var(--ease-out), border-color 160ms var(--ease-out);
}
.rt-seat:hover { border-color: var(--hair); background: color-mix(in srgb, var(--nav-on) 70%, transparent); }
.rt-seat.on {
  border-color: color-mix(in srgb, var(--accent) 40%, var(--hair));
  background: color-mix(in srgb, var(--accent) 10%, transparent);
}
.rt-seat-top { display: flex; align-items: center; gap: 8px; min-width: 0; }
.rt-seat-who { min-width: 0; flex: 1; }
.rt-seat-sig {
  font-size: 12px; font-weight: 650; letter-spacing: -0.02em;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink);
}
.rt-seat-host {
  font-size: 11px; color: var(--ink3);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.rt-seat-ago { font-size: 11px; color: var(--ink3); white-space: nowrap; }
.rt-seat-meta {
  display: flex; justify-content: space-between; gap: 8px;
  font-size: 11px; color: var(--ink2); padding-left: 30px;
}
.rt-seat-meta span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@keyframes rt-seat-in {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: none; }
}
.world.shoey-world .seat-ring {
  transform-box: fill-box; transform-origin: center;
  animation: seat-breathe 2.8s ease-in-out infinite;
}
@keyframes seat-breathe {
  0%, 100% { opacity: 0.2; }
  50% { opacity: 0.55; }
}
.world.shoey-world .seat-sig-bg { fill: #fff; stroke: #E5E5E5; }
[data-theme="dark"] .world.shoey-world .seat-sig-bg { fill: #18181B; stroke: #3F3F46; }
[data-theme="dark"] .world.shoey-world .seat-sig-name { fill: #F8FAFC; }
[data-theme="dark"] .world.shoey-world .seat-sig-meta { fill: #A1A1AA; }
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
  position: absolute; inset: 2px auto 2px 0; background: var(--nav-on); border-radius: 4px; z-index: 0;
}
.vol-bar.blue { background: #DBEAFE; }
[data-theme="dark"] .vol-bar.blue { background: rgba(37,99,235,0.28); }
.vol-row > * { position: relative; z-index: 1; }
.table-card .tabs { margin: 0 0 8px; }
.table-search {
  width: 100%; border: 1px solid var(--hair); border-radius: 8px; padding: 6px 10px;
  font: 12px var(--sans); margin-bottom: 8px;
  background: var(--panel); color: var(--ink);
}
.empty-card { background: var(--panel); border: 1px solid var(--hair); border-radius: 8px; padding: 28px 20px; }
.empty-card h3 { margin: 0 0 6px; font-size: 16px; }
.empty-card p { margin: 0; color: var(--ink2); }
.kpi .sub { font-family: var(--mono); font-size: 10px; color: var(--ink3); margin: 4px 0 8px; }
.spark { display: block; width: calc(100% + 24px); margin: 0 -12px; height: 56px; }
.chart { display: block; width: 100%; height: 140px; }
.world { display: block; width: 100%; height: auto; max-height: 420px; }
.world.shoey-world {
  width: 100%; height: auto; max-height: none; min-height: 0;
  aspect-ratio: 2 / 1; background: #FFFFFF;
}
.world.shoey-world.ov { min-height: 0; max-height: 220px; }
.world.shoey-world .world-ocean { fill: #FFFFFF; }
.world.shoey-world path.world-land, .world.shoey-world path[data-iso] {
  fill: #E5E7EB !important;
  stroke: #6B7280 !important;
  stroke-width: 1.15;
  vector-effect: none;
}
[data-theme="dark"] .world.shoey-world { background: #0a0a0b; }
[data-theme="dark"] .world.shoey-world .world-ocean { fill: #0a0a0b; }
[data-theme="dark"] .world.shoey-world path.world-land,
[data-theme="dark"] .world.shoey-world path[data-iso] {
  fill: #3f3f46 !important;
  stroke: #111827 !important;
}
.world.shoey-world .seat-dot { fill: #111827; stroke: #fff; }
.world.shoey-world .seat-mark {
  pointer-events: auto; cursor: pointer;
}
.world.shoey-world .seat-mark .seat-hit { pointer-events: auto; }
.world.shoey-world path[data-iso] { cursor: pointer; }
.world.shoey-world path[data-iso].on {
  fill: #93C5FD !important;
}
[data-theme="dark"] .world.shoey-world path[data-iso].on {
  fill: #3B82F6 !important;
}
.world.shoey-world .seat-mark.on .seat-dot {
  fill: #2563EB; stroke: #fff; stroke-width: 1.6;
}
.world.shoey-world .seat-mark.on .seat-ring { opacity: 0.7; stroke: #2563EB; }
[data-theme="dark"] .world.shoey-world .seat-dot { fill: #F8FAFC; stroke: #0a0a0b; }
[data-theme="dark"] .world.shoey-world .seat-mark.on .seat-dot { fill: #93C5FD; stroke: #0a0a0b; }
.geo-card {
  padding: 16px 16px 12px; background: var(--panel); border: 1px solid var(--hair);
  border-radius: 14px; min-width: 0;
}
.geo-head {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  margin-bottom: 12px;
}
.geo-title {
  margin: 0; font-size: 14px; font-weight: 650; letter-spacing: -0.025em; color: var(--ink);
}
.geo-flags { display: flex; align-items: center; gap: 3px; flex-wrap: wrap; justify-content: flex-end; opacity: 0.85; }
.geo-flags .flag-mark { font-size: 13px; line-height: 1; }
.geo-cols {
  display: grid; grid-template-columns: minmax(0, 1fr) 64px 72px; gap: 8px;
  padding: 0 10px 8px; font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase;
  color: var(--ink3); font-weight: 600;
}
.geo-list { display: flex; flex-direction: column; gap: 1px; }
.geo-row {
  position: relative; display: grid; grid-template-columns: minmax(0, 1fr) 64px 72px; gap: 8px;
  align-items: center; padding: 9px 10px; border-radius: 8px; cursor: pointer;
  border-bottom: 1px solid color-mix(in srgb, var(--hair) 55%, transparent);
  transition: background 140ms var(--ease-out);
}
.geo-row:last-child { border-bottom: 0; }
.geo-row:hover, .geo-row.on {
  background: color-mix(in srgb, var(--accent) 9%, transparent);
}
.geo-bar {
  position: absolute; left: 0; top: 4px; bottom: 4px; z-index: 0;
  background: color-mix(in srgb, var(--ink) 7%, transparent); border-radius: 6px;
  max-width: calc(100% - 150px);
  transform-origin: left center;
  animation: geoBarGrow 640ms var(--ease-out) both;
}
[data-theme="dark"] .geo-bar { background: rgba(255,255,255,0.07); }
@keyframes geoBarGrow {
  from { transform: scaleX(0.08); opacity: 0.35; }
  to { transform: scaleX(1); opacity: 1; }
}
.geo-place, .geo-n { position: relative; z-index: 1; }
.geo-place {
  display: inline-flex; align-items: center; gap: 8px; min-width: 0;
  font-size: 12.5px; color: var(--ink); font-weight: 500;
}
.geo-place span:last-child {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.geo-n {
  font: 500 12px/1 var(--mono); color: var(--ink2); text-align: right;
}
.geo-empty { padding: 16px 10px 18px; line-height: 1.5; }
@media (max-width: 960px) {
  .rt-stage { grid-template-columns: 1fr; min-height: 0; }
  .rt-map-full, .rt-map-full #map-root, #map-root[data-land="inline"] svg.shoey-world { min-height: 360px; }
  .geo-cols, .geo-row { grid-template-columns: minmax(0, 1fr) 56px 64px; }
}
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
.tab.on { background: #18181b; color: #ffffff; }
[data-theme="dark"] .tab.on { background: #f4f4f5; color: #0a0a0b; }
.tab.on .status-badge { color: inherit; border-color: currentColor; background: transparent; }
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
.map-empty { position: absolute; left: 12px; top: 12px; z-index: 1; max-width: 280px; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 6px 6px; border-bottom: 1px solid var(--hair); font-size: 11px; vertical-align: top; }
th { color: var(--ink3); font-weight: 500; font-family: var(--mono); font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; }
button, .btn {
  background: transparent; color: var(--ink); border: 1px solid var(--hair);
  padding: 4px 9px; font-size: 11px; cursor: pointer; border-radius: 999px;
}
button.primary { background: var(--chart-5); color: #ffffff; border-color: transparent; font-weight: 600; }
.key-msg { padding: 8px 0; font-size: 12px; }
.key-msg.ok { color: var(--ok); font-weight: 600; }
article[data-cf-overview], article[data-cf-page] { background: var(--panel); color: var(--ink); }
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
  display: grid; grid-template-columns: 130px 1.1fr 1.1fr 1fr 90px 90px; gap: 10px; align-items: center;
  padding: 11px 12px; border-bottom: 1px solid var(--hair); font-size: 12.5px;
  transition: background 140ms var(--ease-out);
}
.event:hover { background: color-mix(in srgb, var(--nav-on) 65%, transparent); }
.event-head {
  font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink3);
  font-weight: 600; padding: 4px 12px 8px; border-bottom: 1px solid var(--hair);
}
.event-name { font-weight: 650; letter-spacing: -0.015em; color: var(--ink); }
.event-profile { color: var(--ink2); }
.event-country, .event-os, .event-browser { color: var(--ink2); }
.event-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.event-time {
  font-family: var(--mono); font-size: 11px; color: var(--ink3); text-align: left;
  letter-spacing: -0.01em; white-space: nowrap;
}
.live { display: inline-block; padding: 1px 7px; border-radius: 999px; background: #18181b; color: #fff; font: 10px var(--mono); letter-spacing: 0.08em; }
[data-theme="dark"] .live { background: #f4f4f5; color: #0a0a0b; }
.event[hidden],
.event.is-hidden,
.vol-row[hidden],
.seat-row[hidden],
.sess-row[hidden],
[data-nt-row][hidden] {
  display: none !important;
}
.seat-card {
  border: 1px solid color-mix(in srgb, var(--hair) 80%, transparent);
  background: var(--panel);
  border-radius: 12px;
  overflow: hidden;
  position: relative;
}
.seat-head, .seat-row {
  display: grid;
  grid-template-columns: 44px 1.3fr 1.2fr 1.3fr 110px 88px 92px;
  gap: 8px; align-items: center;
  padding: 10px 14px;
}
.sess-head, .sess-row {
  grid-template-columns: 130px 1fr 1.2fr 1fr 1fr 88px;
}
.seat-head {
  font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--ink3); font-weight: 550; border-bottom: 1px solid var(--hair);
}
.seat-row {
  border-bottom: 1px solid var(--hair); cursor: pointer;
  transition: background 160ms var(--ease-out);
}
.seat-row:hover {
  background: color-mix(in srgb, var(--nav-on) 80%, transparent);
}
@media (prefers-reduced-motion: reduce) {
  .world.shoey-world .seat-ring, .rt-seat, .page, .stat-flow .n, .rt-kpi .n, .geo-bar, .ov-live-dot { animation: none !important; }
  .seat-row, .event, .rt-seat, .geo-row, .nav-item { transition: none; }
}
.seat-no { font-family: var(--mono); font-size: 11px; color: var(--ink3); }
.seat-name { display: inline-flex; align-items: center; gap: 8px; font-weight: 600; }
.os-badge {
  width: 22px; height: 22px; border-radius: 999px; display: grid; place-items: center;
  font: 700 8px/1 var(--sans); letter-spacing: 0.02em; color: #fff; text-transform: lowercase;
}
.os-badge.mac { background: #18181B; }
.os-badge.windows { background: #0A84FF; }
.os-badge.linux { background: #16A34A; }
.seat-loc { color: var(--ink2); font-size: 12px; }
.seat-flag {
  display: inline-block; min-width: 22px; padding: 1px 5px; margin-right: 6px;
  border-radius: 4px; border: 1px solid var(--hair); font: 700 9px var(--mono);
}
.seat-meter { height: 6px; background: var(--nav-on); border-radius: 99px; overflow: hidden; }
.seat-meter i { display: block; height: 100%; background: #2563EB; border-radius: 99px; }
.seat-status {
  display: inline-flex; justify-content: center; padding: 2px 8px; border-radius: 999px;
  font: 600 10px var(--sans); border: 1px solid var(--hair);
}
.seat-status.active { color: #16A34A; background: rgba(22,163,74,0.08); border-color: rgba(22,163,74,0.22); }
.seat-status.paused { color: #CA8A04; background: rgba(202,138,4,0.10); border-color: rgba(202,138,4,0.22); }
.seat-status.inactive { color: var(--ink3); background: var(--nav-on); }
.seat-overlay {
  position: absolute; inset: 12px; background: var(--panel);
  border: 1px solid var(--hair); border-radius: 10px;
  box-shadow: 0 16px 40px rgba(15,23,42,0.16); padding: 16px; z-index: 3;
  overflow: auto;
}
[data-theme="dark"] .seat-overlay { box-shadow: 0 16px 40px rgba(0,0,0,0.45); }
.seat-overlay[hidden] { display: none !important; }
.seat-overlay h4 { margin: 0 0 4px; font-size: 15px; }
.seat-overlay-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 12px; }
.seat-overlay-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 18px; }
.seat-field { display: grid; gap: 3px; }
.seat-field .lbl {
  font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink3); font-weight: 600;
}
.seat-field .val { font-size: 13px; color: var(--ink); }
.seat-overlay-wide { grid-column: 1 / -1; }
.sess-profile { display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
.sess-host { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 550; }
.sess-id {
  font-family: var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.sess-avatar {
  width: 22px; height: 22px; border-radius: 6px; display: inline-grid; place-items: center;
  font: 700 10px/1 var(--sans); color: #3F3F46; flex-shrink: 0;
}
.seat-hbars { display: flex; align-items: flex-end; gap: 3px; height: 28px; }
.seat-hbars i { width: 6px; background: #2563EB; border-radius: 2px 2px 0 0; display: block; min-height: 3px; }
.nt-head { display: grid; gap: 6px; margin: 0 0 4px; }
.nt-sub { margin: 0; font-size: 13px; color: var(--ink2); max-width: 36rem; line-height: 1.45; }
#nt-table { border-collapse: separate; border-spacing: 0; }
#nt-table thead th {
  padding: 10px 12px; font-size: 10px; letter-spacing: 0.07em;
  border-bottom: 1px solid var(--hair); background: color-mix(in srgb, var(--panel) 92%, var(--bg));
}
#nt-table tbody td { padding: 12px; vertical-align: middle; border-bottom: 1px solid var(--hair); }
#nt-table tbody tr[data-nt-row] { transition: background 140ms var(--ease-out); }
#nt-table tbody tr[data-nt-row]:hover { background: color-mix(in srgb, var(--nav-on) 70%, transparent); }
#nt-table tbody tr.nt-unread td:first-child {
  position: relative; font-weight: 650; color: var(--ink);
}
#nt-table tbody tr.nt-unread td:first-child::before {
  content: ''; position: absolute; left: 4px; top: 50%; transform: translateY(-50%);
  width: 5px; height: 5px; border-radius: 99px; background: var(--accent);
}
.nt-empty-wrap { padding: 28px 12px; }
svg:not(.shoey-world) path { vector-effect: non-scaling-stroke; }
#spark-defs { position: absolute; width: 0; height: 0; }
@media (max-width: 980px) {
  .shell { grid-template-columns: 1fr; }
  .rail { position: relative; min-height: auto; }
  .kpis, .kpis-extra, .ov-10, .grid-2, .grid-3, .crm-kpis, .event, .rt-stage, .ev-grid { grid-template-columns: 1fr; }
}
${STATUS_BADGE_CSS}

.brand-mark {
  display: inline-flex; align-items: center; justify-content: center;
  width: 16px; height: 16px; border-radius: 4px; flex: 0 0 auto;
  color: #18181B; vertical-align: middle;
}
.brand-mark.os-mark.mac, .brand-mark.os-mark.mac svg { color: #18181B; }
.brand-mark.os-mark.win, .brand-mark.os-mark.win svg { color: #0A84FF; }
.brand-mark.os-mark.linux, .brand-mark.os-mark.linux svg { color: #16A34A; }
.brand-mark.browser-mark.electron, .brand-mark.browser-mark.electron svg { color: #47848F; }
.flag-mark { font-size: 14px; line-height: 1; }
.country-cell, .browser-cell, .os-cell, .profile-cell {
  display: inline-flex; align-items: center; gap: 6px; min-width: 0;
}
.country-cell span, .browser-cell span, .os-cell span, .profile-cell span {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.os-badge {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 2px 8px 2px 4px; border-radius: 999px;
  border: 1px solid var(--hair); background: var(--nav-on);
  font: 600 10px/1 var(--sans); color: var(--ink2);
}
.os-badge .brand-mark { width: 14px; height: 14px; }
.page-hero[data-live-map] { margin-bottom: 10px; }
.ic-mac, .ic-win, .ic-desk {
  display: inline-block; width: 12px; height: 12px; border-radius: 2px; background: #2563EB;
}
.ic-win { background: #0A84FF; }
.ic-desk { background: #71717A; }

`