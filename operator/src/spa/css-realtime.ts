/**
 * realtime page CSS: map pills, city labels, grid, zoom, ocean.
 */
export const REALTIME_CSS = `
.rt-map-tooltip {
  position: fixed;
  z-index: 80;
  pointer-events: none;
  max-width: 280px;
  padding: 6px 10px;
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.35;
  color: #fafafa;
  background: rgba(24, 24, 27, 0.92);
  border: 1px solid rgba(255,255,255,0.12);
  box-shadow: 0 8px 24px rgba(0,0,0,0.35);
}
.rt-map-tooltip[hidden] { display: none !important; }
.rt-map { position: relative; }
.rt-map-svg { display: block; width: 100%; height: auto; background: var(--map-ocean); border-radius: var(--radius-map); }
.rt-map .world-ocean { fill: var(--map-ocean); }
.rt-map-grid-layer { pointer-events: none; }
.rt-country-pill-g { pointer-events: none; }
.rt-country-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px 4px 8px;
  border-radius: 999px;
  font-family: var(--mono);
  font-size: 11px;
  font-weight: 500;
  line-height: 1.2;
  white-space: nowrap;
  color: var(--ink);
  background: var(--map-pill);
  border: 1px solid color-mix(in srgb, var(--hair) 80%, transparent);
  box-shadow: 0 6px 18px rgba(0,0,0,0.28);
}
.rt-country-pill img {
  width: 16px;
  height: 12px;
  border-radius: 2px;
  display: block;
  flex: 0 0 auto;
}
.rt-country-pill .rt-pill-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--ink3) 80%, transparent);
  flex: 0 0 auto;
}
.rt-pin-label {
  font-family: var(--mono);
  font-size: 11px;
  font-weight: 500;
  fill: var(--map-dot);
  paint-order: stroke;
  stroke: color-mix(in srgb, var(--map-ocean) 75%, transparent);
  stroke-width: 3px;
  stroke-linejoin: round;
}
.rt-map-controls {
  position: absolute;
  right: 12px;
  bottom: 12px;
  z-index: 4;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.rt-map-zoom {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  border: 1px solid var(--hair);
  background: color-mix(in srgb, var(--panel) 88%, transparent);
  color: var(--ink);
  font: 600 16px/1 var(--font-body);
  cursor: pointer;
  box-shadow: 0 4px 12px rgba(0,0,0,0.25);
}
.rt-map-zoom:hover { background: var(--panel); }
.rt-map-fade {
  position: absolute;
  left: 0; right: 0; bottom: 0;
  height: 10%;
  pointer-events: none;
  border-radius: 0 0 var(--radius-map) var(--radius-map);
  background: linear-gradient(to top, var(--map-ocean), transparent);
}
.rt-world #map-root {
  min-height: 480px;
  background: var(--map-ocean);
  border-radius: var(--radius-map);
  overflow: hidden;
}
.activity-feed .eyebrow { display: flex; align-items: center; gap: 6px; }
`
