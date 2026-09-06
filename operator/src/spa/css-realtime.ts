/**
 * Realtime page CSS (plan 6.3, 3.7 item 2, 3.5b Realtime row). Tokens only, no hex literals
 * anywhere in this file (task lock: "no hex literal outside css.ts") -- every colour is a
 * `var(--token)` reference from the plan 3.2 sheet in operator/src/spa/css.ts. Concatenated in
 * operator/src/spa/manifest.ts, after SHELL_CSS and PAGES_SHARED_CSS, in NAV_IDS order
 * (design-lead's file, not touched here).
 *
 * operator/src/world/map.ts's own embedded `<style>` block owns everything inside the map SVG
 * itself (land/pill/pin colours and hover states, the zoom viewport transition); this file only
 * owns the page-level layout around it -- the card, the strip, the toolbar chip and the
 * following tooltip -- scoped with an `rt-` prefix so it can never collide with another page's
 * own css-<page>.ts.
 */
export const REALTIME_CSS = `
/* -- map card: full-bleed, 16:9 (plan 6.3), 18px radius, the LIVE pill anchored top-right. -- */
.rt-map-card { position: relative; padding: 0; overflow: hidden; border-radius: var(--radius-map); }
.rt-map { aspect-ratio: 16 / 9; }
.rt-map-live {
  position: absolute; top: 12px; right: 12px; z-index: 2;
  background: var(--map-pill); color: var(--ink); border: 1px solid var(--border);
  padding: 3px 10px; border-radius: var(--radius-pill); font: 600 11px var(--font-mono);
  box-shadow: var(--shadow);
}
.rt-map-controls { position: absolute; right: 12px; bottom: 12px; z-index: 2; display: grid; gap: 6px; }
.rt-map-zoom {
  width: 28px; height: 28px; display: grid; place-items: center; border-radius: var(--radius-control);
  background: var(--surface); color: var(--ink); border: 1px solid var(--border); box-shadow: var(--shadow);
  font: 600 15px/1 var(--font-body); cursor: pointer; transition: transform 150ms var(--ease-spring), box-shadow 150ms var(--ease-spring);
}
.rt-map-zoom:hover { box-shadow: var(--shadow-ring); }
.rt-map-zoom:active { transform: scale(0.94); }
.rt-map-fade {
  position: absolute; left: 0; right: 0; bottom: 0; height: 64px; pointer-events: none; z-index: 1;
  background: linear-gradient(to bottom, transparent, color-mix(in srgb, var(--map-ocean) 65%, transparent));
}
.map-empty {
  position: absolute; inset: 0; z-index: 2; display: grid; place-items: center; text-align: center;
  padding: 0 24px; color: var(--ink-2); font-size: 12.5px; pointer-events: none;
}

/* -- following tooltip (plan 3.7 item 2): fixed so client/motion.ts's follow() can translate it
   straight to the pointer; never intercepts the pointer itself. -- */
.rt-tooltip {
  position: fixed; left: 0; top: 0; z-index: 60; pointer-events: none;
  min-width: 160px; max-width: 240px; background: var(--surface); color: var(--ink);
  border: 1px solid var(--border); border-radius: var(--radius-control); box-shadow: var(--shadow);
  padding: 8px 10px; font-size: 12px;
}
.rt-tooltip-head { display: flex; align-items: center; gap: 6px; font-weight: 650; margin-bottom: 2px; }
.rt-tooltip-rows { color: var(--ink-2); font-size: 11.5px; }

/* -- strip: Seats 30m, Live, Live events (plan 6.3). -- */
.rt-strip { display: grid; grid-template-columns: minmax(200px, 260px) minmax(180px, 220px) minmax(0, 1fr); gap: 16px; margin: 16px 0; }
@media (max-width: 860px) { .rt-strip { grid-template-columns: 1fr; } }

/* -- toolbar country filter chip (plan 3.7 item 2: "sets a chip in the toolbar"). -- */
.rt-country-chip { display: inline-flex; align-items: center; gap: 6px; background: var(--accent-soft); color: var(--accent-text); border-color: transparent; }
.rt-country-chip[hidden] { display: none !important; }
.chip-clear {
  display: grid; place-items: center; width: 16px; height: 16px; padding: 0; margin: 0;
  border: 0; border-radius: var(--radius-pill); background: transparent; color: inherit; cursor: pointer;
}
.chip-clear:hover { background: color-mix(in srgb, currentColor 14%, transparent); }
.chip-clear .tool-ic { width: 10px; height: 10px; }

/* -- geo table search input, and the connected-seats first cell (avatar + name + email). -- */
[data-realtime-geo] .table-search { margin-top: 8px; }
[data-realtime-seats] table td:first-child { display: flex; align-items: center; gap: 8px; }
`
