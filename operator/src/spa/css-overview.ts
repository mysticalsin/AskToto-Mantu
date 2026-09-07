/**
 * Overview page CSS (plan 6.2, P1.2). Tokens only, no hex literals anywhere in this file (task
 * lock: "no hex literal outside css.ts") -- every colour is a `var(--token)` reference from the
 * plan 3.2 sheet in operator/src/spa/css.ts. Concatenated in operator/src/spa/manifest.ts, after
 * SHELL_CSS and PAGES_SHARED_CSS, in NAV_IDS order (design-lead's file, not touched here).
 *
 * Reuses the shared card, chip, segmented and tlc/mtiles rules from operator/src/spa/css.ts
 * wherever this page's markup already carries those classes; everything below is additive,
 * scoped with an `ov-` prefix so it can never collide with another page's own css-<page>.ts.
 */
export const OVERVIEW_CSS = `
/* operator/src/spa/css.ts's shared .tlc-row rule sets display: grid unconditionally, which (same
   equal-specificity trap as .ov-filter-menu below) beats the UA stylesheet's [hidden] rule the
   moment a row this page's Filters or search hides carries both the class and the attribute --
   the row would stay visually laid out even with .hidden = true. [hidden] on a selector is one
   attribute selector heavier than the bare class, so this override wins by specificity
   regardless of which stylesheet declares it first, fixing every .tlc-row on every page, not
   only this one's. Left here (not proposed as a css.ts edit) because this file is the one this
   task can change; the task report flags it for design-lead to fold into css.ts directly. */
.tlc-row[hidden] { display: none; }

/* -- toolbar: range + granularity + Filters, plus the Filters popover. -- */
.ov-toolbar-controls { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ov-filters-wrap { position: relative; }
.ov-filter-menu {
  position: absolute; top: calc(100% + 6px); left: 0; z-index: 30; width: 260px;
  background: var(--panel); border: 1px solid var(--hair); border-radius: var(--radius-card);
  box-shadow: var(--shadow); padding: 10px 12px 12px; display: grid; gap: 8px;
}
/* An author display declaration on a class beats the UA stylesheet's [hidden] display:none rule
   at equal specificity, so the popover's own display: grid above would otherwise defeat its
   hidden attribute the moment this class rule applies -- this is what actually hides it. */
.ov-filter-menu[hidden] { display: none; }
.ov-filter-group { border: 0; padding: 0; margin: 0; display: grid; gap: 4px; }
.ov-filter-group legend { font: 600 11px var(--font-body); color: var(--ink3); text-transform: uppercase; letter-spacing: 0.05em; padding: 0; margin-bottom: 2px; }
.ov-filter-option { display: flex; align-items: center; gap: 6px; font: 400 12px var(--font-body); color: var(--ink); padding: 2px 0; }
.ov-filter-clear { justify-self: start; margin-top: 2px; }

/* -- live count chip (toolbar right) and its beacon dot. .live-dot is already the rail's own
   bordered pill component, so this page's small pulsing dot gets its own class. -- */
.ov-live-chip { font-family: var(--font-body); font-size: 11px; gap: 6px; }
.ov-beacon-dot { display: inline-block; width: 7px; height: 7px; border-radius: var(--radius-pill); background: var(--live); }

/* -- metric tiles: the Value tile's empty-state link and the Live-30-min rolling bars. -- */
.mtile .ov-value-link {
  display: inline-block; font: 600 15px/1.3 var(--font-body); color: var(--accent);
  text-decoration: none; text-underline-offset: 2px;
}
.mtile .ov-value-link:hover { text-decoration: underline; }
.ov-live30-svg { display: block; width: 100%; height: 28px; margin-top: 6px; overflow: visible; }
.ov-bar-slot { transition: transform 260ms var(--ease-spring); }
.ov-bar-exit { opacity: 0; transition: opacity 260ms var(--ease-spring); }

/* -- fleet-is-quiet banner: shown only when no heartbeat has arrived recently. -- */
.ov-quiet-card {
  border-left: 3px solid var(--warn);
  display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px;
}
.ov-quiet-head { display: flex; align-items: center; gap: 8px; }
.ov-quiet-head h3 { margin: 0; font: 600 15px/1.3 var(--font-display); color: var(--ink); }
.ov-quiet-icon { width: 16px; height: 16px; color: var(--warn); flex: none; }
.ov-quiet-body { margin: 0; font: 400 13px/1.5 var(--font-body); color: var(--ink2); max-width: 78ch; }

/* -- tokens card: header row, stacked bar, legend, cost line. -- */
.ov-tokens-card .kpi-top { align-items: center; }
.ov-tokens-total { font-size: 22px; }
.ov-token-bar { display: block; width: 100%; height: 10px; border-radius: 3px; overflow: hidden; margin: 8px 0 6px; }
.ov-token-legend { display: flex; flex-wrap: wrap; gap: 12px 16px; font: 400 12px var(--font-body); color: var(--ink2); }
.ov-token-legend-item { display: inline-flex; align-items: center; gap: 6px; }
.ov-token-legend-item b { font-family: var(--font-display); font-feature-settings: "tnum"; font-variant-numeric: tabular-nums; color: var(--ink); font-weight: 600; }
.ov-token-swatch { display: inline-block; width: 8px; height: 8px; border-radius: 2px; }
.ov-token-swatch-1 { background: var(--data-1); }
.ov-token-swatch-2 { background: var(--data-2); }
.ov-token-swatch-3 { background: var(--data-3); }
.ov-token-swatch-4 { background: var(--data-4); }
.ov-tokens-cost { margin-top: 6px; }

/* -- unique seats area chart. QA page-height budget (plan 3.7b #10): 150px, kept equal to the
   height: 150 option passed to areaChartWithPrevious() in operator/src/render/pages/overview.ts
   -- the SVG's own preserveAspectRatio="none" stretches to whatever box this rule gives it, so
   the two must move together or the chart's ticks and stroke width distort. -- */
.ov-area-chart { display: block; width: 100%; height: 150px; margin-top: 8px; }
.ov-area-tick { font: 400 10px var(--font-mono); fill: var(--ink3); }
.ov-area-empty { margin-top: 8px; }
.ov-area-legend { display: flex; gap: 16px; font: 400 11px var(--font-body); color: var(--ink2); margin-top: 4px; }
.ov-area-legend-item { display: inline-flex; align-items: center; gap: 6px; }
.ov-area-swatch { display: inline-block; width: 14px; height: 2px; border-radius: 1px; }
.ov-area-swatch-cur { background: var(--data-1); }
.ov-area-swatch-prev { background: var(--ink-3); }
/* First-paint draw-in (plan 3.5b: "path draws in over 800ms, area fill fades in after, previous
   period dashed line fades last"). The stroke itself is animated client-side by
   operator/client/motion.ts's drawPath(); the area fill and the previous-period line only need a
   plain, delay-staggered opacity fade, which a global prefers-reduced-motion rule in css.ts
   already collapses to instant. */
.ov-area-fill { animation: ov-fade-in 400ms var(--ease-color) 700ms both; }
.ov-area-prev { animation: ov-fade-in 400ms var(--ease-color) 1100ms both; }
@keyframes ov-fade-in { from { opacity: 0; } to { opacity: 1; } }

/* -- the six cards: a plain two-column grid (every card is an equal half-width pair, plan 6.2's
   "col-span-3 pairs" out of a notional 6-column row -- with all six the same width a 2-column
   grid says the same thing without inventing an unused generic span-N utility system). -- */
.ov-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
@media (max-width: 768px) { .ov-grid { grid-template-columns: 1fr; } }

/* -- connectors card: stacks the "Needs attention" / "Connected" group cards (plan 6.10b via
   operator/src/render/connectors-list.ts's connectorRow()) in the one col-span-3 slot next to
   Countries. The group cards' own rules (.connector-group, .connector-row, .connector-show-more)
   are shared in operator/src/spa/css.ts; this page only owns the stack layout around them. -- */
.ov-connectors-card { display: flex; flex-direction: column; gap: 16px; }
.ov-connectors-error[hidden] { display: none; }
/* Shown once loadConnectorsCard() (overview.ts) clears the skeleton out of [data-ov-connectors-
   root] on a real fetch failure -- its own card is gone at that point, so this needs its own
   full card chrome (background/border/radius/shadow, matching .card in css.ts) rather than the
   bare, unstyled text that used to sit directly on the page background with nothing around it
   (task report finding 8). The left accent bar and dot echo .toast-error's own danger styling
   elsewhere in this file, so an error reads the same way wherever it appears. */
.ov-connectors-error {
  display: flex; align-items: center; gap: 8px; margin: 0;
  padding: 10px 12px; font-size: 12px; color: var(--ink);
  background: var(--panel); border: 1px solid var(--hair); border-left: 3px solid var(--danger);
  border-radius: var(--radius-card); box-shadow: var(--shadow), var(--card-highlight);
}
.ov-connectors-error::before {
  content: ''; flex: none; width: 6px; height: 6px; border-radius: var(--radius-pill); background: var(--danger);
}

/* -- map card: corner choropleth, recoloured via data-iso classes (operator/src/render/pages/
   overview-charts.ts's recolorChoroplethMini), plus the sequential-scale legend. -- */
.ov-map-frame { margin-top: 8px; }
.ov-map-frame svg { display: block; width: 100%; height: auto; }
.ov-map-svg path.ov-map-scale-0 { fill: var(--data-track); }
.ov-map-svg path.ov-map-scale-1 { fill: var(--chart-scale-01); }
.ov-map-svg path.ov-map-scale-2 { fill: var(--chart-scale-02); }
.ov-map-svg path.ov-map-scale-3 { fill: var(--chart-scale-03); }
.ov-map-svg path.ov-map-scale-4 { fill: var(--chart-scale-04); }
.ov-map-svg path.ov-map-scale-5 { fill: var(--chart-scale-05); }
.ov-map-empty { margin-top: 8px; }
.ov-map-legend { display: flex; align-items: center; gap: 4px; margin-top: 8px; font: 400 10px var(--font-mono); color: var(--ink3); }
.ov-map-legend-label { padding: 0 4px; }
.ov-map-swatch { display: inline-block; width: 12px; height: 8px; border-radius: 2px; }
.ov-map-swatch.ov-map-scale-0 { background: var(--data-track); }
.ov-map-swatch.ov-map-scale-1 { background: var(--chart-scale-01); }
.ov-map-swatch.ov-map-scale-2 { background: var(--chart-scale-02); }
.ov-map-swatch.ov-map-scale-3 { background: var(--chart-scale-03); }
.ov-map-swatch.ov-map-scale-4 { background: var(--chart-scale-04); }
.ov-map-swatch.ov-map-scale-5 { background: var(--chart-scale-05); }

/* -- generate license card. -- */
.ov-license-form { display: flex; align-items: flex-end; gap: 10px; flex-wrap: wrap; margin: 8px 0; }
.ov-license-field { display: grid; gap: 4px; font: 600 12px var(--font-body); color: var(--ink2); }
.ov-license-field select {
  border: 1px solid var(--hair); background: var(--bg); color: var(--ink);
  border-radius: var(--radius-control); padding: 6px 8px; font: 400 13px var(--font-body);
}
.ov-license-once { margin-top: 4px; padding-top: 10px; border-top: 1px solid var(--hair); }
.ov-license-once-row { display: flex; gap: 8px; margin-top: 6px; }
.ov-license-once-value {
  flex: 1; min-width: 0; border: 1px solid var(--hair); background: var(--bg); color: var(--ink);
  border-radius: var(--radius-control); padding: 7px 10px; font: 400 12px var(--font-mono);
}
`
