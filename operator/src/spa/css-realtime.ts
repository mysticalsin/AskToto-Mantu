/**
 * Realtime page CSS. First block: the world map module (operator/src/world/map.ts), shared by
 * the realtime map and the overview choropleth. Tokens only (--map-*, --ink*, --border, --live,
 * --accent, --chart-0): no hex, so light/dark follow the console theme without JS repaint.
 * Motion is compositor-only (transform/opacity) and off under prefers-reduced-motion.
 * Second block (marked WP-C layout): the realtime page layout around the map.
 */
export const REALTIME_CSS = `
/* ---- World map (WP-A) ------------------------------------------------------------------ */
.rt-map { position: relative; }
.rt-map-svg {
  display: block; width: 100%; height: auto; background: var(--map-ocean);
  border-radius: var(--radius-map); touch-action: none; user-select: none;
}
.rt-map-svg .world-land-layer { pointer-events: none; }
.rt-pin { cursor: pointer; outline: none; }
.rt-pin-dot { fill: var(--map-dot, var(--ink)); fill-opacity: 0.9; }
.rt-pin:focus-visible .rt-pin-dot { stroke: var(--accent); stroke-width: 2px; }
.rt-pin-halo { transform-box: fill-box; transform-origin: center; animation: metis-rt-halo 2.4s ease-out infinite; }
.rt-pin-halo circle { fill: var(--map-halo, var(--live)); }
@keyframes metis-rt-halo {
  0% { transform: scale(1); opacity: 0.55; }
  100% { transform: scale(3.4); opacity: 0; }
}
.rt-cluster foreignObject { overflow: visible; }
.rt-pill-wrap {
  display: flex; align-items: flex-end; justify-content: center;
  width: 100%; height: 100%; pointer-events: none;
}
.rt-pill {
  pointer-events: auto; display: inline-flex; align-items: center; gap: 6px;
  height: 24px; max-width: 216px; padding: 0 9px 0 8px; border-radius: 8px;
  border: 1px solid var(--map-pill-border, var(--border));
  background: var(--map-pill-bg, var(--map-pill));
  color: var(--ink); font: 500 11px/1 var(--font-body); white-space: nowrap; cursor: pointer;
  box-shadow: 0 4px 16px color-mix(in srgb, var(--ink) 12%, transparent);
  transition: transform 160ms var(--ease-spring);
}
.rt-pill:hover { transform: translateY(-1px); }
.rt-pill:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.rt-pill[aria-expanded="true"] { border-color: var(--ink-3); }
.rt-pill-dot { position: relative; width: 7px; height: 7px; border-radius: 999px; background: var(--live); flex: none; }
.rt-pill-dot::after {
  content: ''; position: absolute; inset: 0; border-radius: inherit; background: var(--live);
  animation: metis-rt-ping 1.6s cubic-bezier(0, 0, 0.2, 1) infinite;
}
@keyframes metis-rt-ping {
  0% { transform: scale(1); opacity: 0.7; }
  75%, 100% { transform: scale(2.4); opacity: 0; }
}
.rt-pill-count { font-variant-numeric: tabular-nums; font-weight: 600; }
.rt-pill-sep { width: 1px; height: 12px; background: var(--border); flex: none; }
.rt-pill-label { overflow: hidden; text-overflow: ellipsis; color: var(--ink-2); }
@media (prefers-reduced-motion: reduce) {
  .rt-pin-halo, .rt-pill-dot::after { animation: none; }
  .rt-pin-halo { opacity: 0; }
  .rt-pill { transition: none; }
}

.rt-map-controls {
  position: absolute; right: 12px; bottom: 12px; z-index: 4;
  display: flex; flex-direction: column; gap: 4px;
}
.rt-map-zoom {
  width: 28px; height: 28px; border-radius: 8px; border: 1px solid var(--border);
  background: var(--surface); color: var(--ink); font: 600 16px/1 var(--font-body); cursor: pointer;
  box-shadow: 0 2px 8px color-mix(in srgb, var(--ink) 10%, transparent);
}
.rt-map-zoom:hover { background: var(--surface-2); }
.rt-map-zoom:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

.rt-map-tooltip {
  position: fixed; z-index: 80; pointer-events: none; max-width: 280px;
  padding: 5px 9px; border-radius: 6px; font-size: 12px; line-height: 1.35;
  color: var(--surface); background: var(--ink);
  box-shadow: 0 6px 18px color-mix(in srgb, var(--ink) 25%, transparent);
}
.rt-map-tooltip[hidden] { display: none !important; }

/* Cluster popover body (clusterPopoverHtml). The positioned container is WP-C's. */
.rt-pop { display: flex; flex-direction: column; gap: 12px; font-size: 12px; color: var(--ink); }
.rt-pop-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.rt-pop-eyebrow { margin: 0; font-size: 10px; font-weight: 600; letter-spacing: 0.06em; color: var(--ink-3); }
.rt-pop-title { margin: 2px 0 0; font-size: 15px; font-weight: 600; }
.rt-pop-sub { margin: 2px 0 0; color: var(--ink-3); font-variant-numeric: tabular-nums; }
.rt-pop-close {
  width: 26px; height: 26px; border-radius: 6px; border: 1px solid var(--border);
  background: var(--surface); color: var(--ink-2); font-size: 16px; line-height: 1; cursor: pointer; flex: none;
}
.rt-pop-close:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.rt-pop-tiles { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.rt-pop-tile { border: 1px solid var(--border); border-radius: 6px; padding: 8px; display: flex; flex-direction: column; gap: 2px; }
.rt-pop-tile span { color: var(--ink-3); font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; }
.rt-pop-tile b { font: 600 16px/1.1 var(--font-mono); font-variant-numeric: tabular-nums; }
.rt-pop-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.rt-pop h4 { margin: 0 0 6px; font-size: 11px; font-weight: 600; color: var(--ink-2); }
.rt-pop-rank, .rt-pop-sessions { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.rt-pop-rank li, .rt-pop-sessions li { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.rt-pop-name, .rt-pop-who { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rt-pop-n { font: 600 12px/1 var(--font-mono); font-variant-numeric: tabular-nums; }
.rt-pop-where, .rt-pop-when { color: var(--ink-3); white-space: nowrap; }
.rt-pop-empty { margin: 0; color: var(--ink-3); }

/* ---- WP-C layout (realtime page around the map) ---------------------------------------- */
/* Reference: full-bleed map with a glass overlay column (KPI + live feed), three cards below.
   Motion stays compositor-only; the overlay blur is static (--glass-blur, 12px cap). */
.rt-stage {
  position: relative; margin: 0 0 16px; overflow: hidden;
  border: 1px solid var(--border); border-radius: var(--radius-map); background: var(--map-ocean);
}
.rt-map-root { position: relative; }
.rt-stage .rt-map { min-height: 0; }
.rt-stage .rt-map-svg { border-radius: 0; }
.rt-stage .map-empty {
  position: absolute; left: 50%; bottom: 16px; z-index: 2; transform: translateX(-50%);
  max-width: min(520px, calc(100% - 32px)); margin: 0; padding: 8px 12px; text-align: center;
  font-size: 12px; color: var(--ink-2); background: var(--surface);
  border: 1px solid var(--border); border-radius: var(--radius-control); box-shadow: var(--shadow-pop);
}
.rt-stage .map-empty[hidden] { display: none; }
.rt-overlay {
  position: absolute; top: 16px; left: 16px; z-index: 3; width: 288px; max-height: calc(100% - 32px);
  display: flex; flex-direction: column; gap: 12px; pointer-events: none;
}
.rt-glass {
  pointer-events: auto; padding: 12px 14px; border: 1px solid var(--border); border-radius: var(--radius-card);
  background: color-mix(in srgb, var(--surface) 90%, transparent);
  -webkit-backdrop-filter: var(--glass-blur); backdrop-filter: var(--glass-blur); box-shadow: var(--shadow-pop);
}
.rt-kpi-label { margin: 0; font-size: 13px; color: var(--ink-3); }
.rt-kpi-value {
  margin: 2px 0 4px; font: 700 44px/1 var(--font-mono); letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums; color: var(--ink);
}
.rt-kpi-sub { margin: 0 0 8px; display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; color: var(--ink-2); }
.rt-live-dot { position: relative; width: 7px; height: 7px; border-radius: 999px; background: var(--live); flex: none; }
.rt-live-dot::after {
  content: ''; position: absolute; inset: 0; border-radius: inherit; background: var(--live);
  animation: metis-rt-ping 1.6s cubic-bezier(0, 0, 0.2, 1) infinite;
}
.rt-kpi-spark .spark { display: block; width: 100%; height: 36px; }
.rt-card-title { margin: 0; font-size: 14px; font-weight: 600; color: var(--ink-2); }
.rt-feed { min-height: 0; display: flex; flex-direction: column; gap: 6px; }
.rt-feed-list { list-style: none; margin: 0; padding: 0; overflow: auto; max-height: 300px; }
.rt-feed-row {
  display: grid; grid-template-columns: auto minmax(0, 1fr) auto; column-gap: 8px; row-gap: 1px;
  align-items: center; padding: 7px 0; border-top: 1px solid var(--border); font-size: 12px;
}
.rt-feed-row:first-child { border-top: 0; }
.rt-feed-row .kind-badge { grid-row: 1 / span 2; }
.rt-feed-who { grid-column: 2; font-weight: 500; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rt-feed-where { grid-column: 2; font-size: 11px; color: var(--ink-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rt-feed-ago { grid-column: 3; grid-row: 1 / span 2; font-size: 11px; color: var(--ink-3); font-variant-numeric: tabular-nums; }
.rt-feed-empty { padding: 6px 0; font-size: 12px; color: var(--ink-3); }

.rt-popover-host { position: absolute; inset: 0; z-index: 6; pointer-events: none; }
.rt-popover {
  position: absolute; width: 380px; max-width: calc(100% - 16px); max-height: min(440px, calc(100% - 16px));
  overflow: auto; padding: 14px; pointer-events: auto;
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-card); box-shadow: var(--shadow-pop);
}
.rt-popover[hidden] { display: none; }

.rt-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; }
.rt-card { padding: 14px 16px; min-width: 0; }
.rt-card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 0 0 10px; }
.rt-card-head .tabs { margin: 0; }
.rt-card-empty { padding: 18px 0; font-size: 12px; color: var(--ink-3); }
.rt-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.rt-table th {
  padding: 0 8px 6px; text-align: left; font-size: 12px; font-weight: 500;
  color: var(--ink-3); border-bottom: 1px solid var(--border);
}
.rt-loc { display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
.rt-loc .country-flag { width: 16px; height: 12px; border-radius: 2px; flex: none; }
.rt-loc-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rt-table td { padding: 6px 8px; border-bottom: 1px solid var(--border); }
.rt-table tr:last-child td { border-bottom: 0; }
.rt-table td:first-child { position: relative; }
.rt-table td:first-child > :not(.geo-bar) { position: relative; z-index: 1; }
.rt-table .num { text-align: right; font: 600 12px/1 var(--font-mono); font-variant-numeric: tabular-nums; }
.rt-table th.num { font-family: var(--font-body); }
.rt-mode-name { font-weight: 500; }
.rt-seats { list-style: none; margin: 0; padding: 0; max-height: 320px; overflow: auto; }
.rt-seat {
  display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; gap: 8px; align-items: center;
  padding: 7px 0; border-top: 1px solid var(--border); font-size: 12px;
}
.rt-seat:first-child { border-top: 0; }
.rt-seat-dot { width: 7px; height: 7px; border-radius: 999px; background: var(--ink-3); }
.rt-seat-dot[data-live="1"] { background: var(--live); }
.rt-seat-who { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rt-seat-where, .rt-seat-state { color: var(--ink-3); white-space: nowrap; }

@media (prefers-reduced-motion: reduce) {
  .rt-live-dot::after { animation: none; }
}
/* Narrow screens: the overlay stops covering a map that is only ~220px tall and stacks below it. */
@media (max-width: 760px) {
  .rt-overlay { position: static; width: auto; max-height: none; padding: 12px; }
  .rt-glass { -webkit-backdrop-filter: none; backdrop-filter: none; background: var(--surface); }
  .rt-feed-list { max-height: 240px; }
}
`
