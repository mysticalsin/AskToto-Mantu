/**
 * Realtime page CSS (plan 6.3, 3.7 item 2). Everything the world map renders
 * (operator/src/world/map.ts) is styled from here — the SVG never carries a hex literal or an
 * inline `style=`, only tokens through these classes. Concatenated in
 * operator/src/spa/manifest.ts, in NAV_IDS order, after SHELL_CSS and PAGES_SHARED_CSS — one
 * global stylesheet, so the `.corner-cell`/`.no-data`/`.scale-0N` rules here also paint the
 * Overview corner map (operator/src/charts.ts's choroplethMini via world/map.ts's
 * renderCornerMapSvg), the same way css.ts's page-agnostic rules already apply everywhere.
 *
 * `--live` pulses only ever come from operator/client/motion.ts's `beacon()` on hydration —
 * this file has no `@keyframes` of its own; a hover or theme change is a plain CSS transition,
 * never a bespoke animation.
 */
export const REALTIME_CSS = `
.rt-map {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  min-height: 360px;
  border-radius: var(--radius-map);
  overflow: hidden;
  background: var(--map-ocean);
}
.rt-map-svg, .corner-map-svg { display: block; width: 100%; height: 100%; }
.map-ocean { fill: var(--map-ocean); }
.map-graticule {
  fill: none;
  stroke: var(--map-graticule);
  stroke-width: 0.6px;
  vector-effect: non-scaling-stroke;
  opacity: 0.7;
  transition: opacity 300ms var(--ease-color);
}
.map-graticule.is-hidden { opacity: 0; }

.world-land {
  fill: var(--map-land);
  stroke: var(--map-stroke);
  stroke-width: 0.5px;
  vector-effect: non-scaling-stroke;
  cursor: pointer;
  transition: fill 150ms var(--ease-color), opacity 150ms var(--ease-color);
}
.world-land.is-hovered { fill: var(--map-land-hover); }
.world-land.is-dimmed { opacity: 0.4; }

/* Overview corner choropleth (plan 3.7 item 2: "fill by seats per country through
   --chart-scale-01..05, no-data countries in --data-track"). More specific than .world-land
   above so a corner-map cell's step colour always wins over the plain land fill. */
.corner-cell { stroke: var(--map-ocean); stroke-width: 0.5px; cursor: default; }
.corner-cell.no-data { fill: var(--data-track); }
.corner-cell.scale-01 { fill: var(--chart-scale-01); }
.corner-cell.scale-02 { fill: var(--chart-scale-02); }
.corner-cell.scale-03 { fill: var(--chart-scale-03); }
.corner-cell.scale-04 { fill: var(--chart-scale-04); }
.corner-cell.scale-05 { fill: var(--chart-scale-05); }
.corner-pin-hit { fill: transparent; }

/* Seat dots: pulsing --live green while live, static --accent violet once seen-but-idle
   (Tony: "a pulsing green dot on where people are using it"). The halo only exists on a live
   pin; beacon() (motion.ts) animates it on hydration and is a no-op under reduced motion, so
   an unhydrated or reduced-motion pin is still a plain, static, correctly-coloured dot. */
.rt-pin { cursor: pointer; }
.rt-pin-dot { stroke: var(--map-pill); stroke-width: 1.5px; }
.rt-pin[data-live="1"] .rt-pin-dot { fill: var(--live); }
.rt-pin[data-live="0"] .rt-pin-dot { fill: var(--accent); }
.rt-pin-halo { fill: none; stroke: var(--live); stroke-width: 1.5px; opacity: 0.6; }
.rt-pin-label {
  font: 600 9.5px var(--font-mono);
  fill: var(--ink);
  paint-order: stroke fill;
  stroke: var(--map-pill);
  stroke-width: 3px;
  stroke-linejoin: round;
  pointer-events: none;
}

/* Country pills: flag, name, seat count, place count, a small live dot — plan 3.7 item 2's
   "3 Canada, 2 places", dropped for a country whose one city label already says it all
   (countryPills() in map.ts only emits a pill once a country has >1 reporting place). */
.rt-pill { cursor: pointer; }
.rt-pill-bg { fill: var(--map-pill); stroke: var(--border); stroke-width: 1px; }
.rt-pill-live { fill: var(--live); }
.rt-pill-flag { pointer-events: none; }
.rt-pill-text {
  font: 600 10.5px var(--font-mono);
  fill: var(--ink);
  pointer-events: none;
}

.rt-map-controls {
  position: absolute;
  right: 12px;
  bottom: 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  z-index: 2;
}
.rt-map-zoom {
  width: 28px;
  height: 28px;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  background: var(--surface);
  color: var(--ink);
  font: 600 15px/1 var(--font-body);
  cursor: pointer;
  transition: background 150ms var(--ease-color);
}
.rt-map-zoom:hover { background: var(--bg-2); }

.rt-map-fade {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 56px;
  background: linear-gradient(to top, color-mix(in srgb, var(--map-ocean) 85%, transparent), transparent);
  pointer-events: none;
}

.rt-map-tooltip {
  position: fixed;
  left: 0;
  top: 0;
  z-index: 60;
  max-width: 220px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  background: var(--surface);
  box-shadow: var(--shadow);
  font: 400 12px var(--font-body);
  color: var(--ink-2);
  pointer-events: none;
}
.rt-map-tooltip[hidden] { display: none; }
.rt-tip-head { display: flex; align-items: center; gap: 6px; margin-bottom: 2px; }
.rt-tip-flag { display: block; border-radius: 2px; }
.rt-tip-title { font-weight: 600; color: var(--ink); font-size: 12.5px; }
.rt-tip-sub { color: var(--ink-3); font-size: 11px; margin: -2px 0 4px 22px; }
.rt-tip-row { font-size: 11.5px; }

/* Rendered as a caption above the (still-visible, still-empty) map — plan 6.3: "the map still
   renders with no dots or pills and a centred caption says ...". */
.map-empty { margin: 0 0 8px; color: var(--ink-2); font-size: 12px; text-align: center; }

@media (prefers-reduced-motion: reduce) {
  .map-graticule { transition: none; }
  .world-land { transition: none; }
}
`
