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

/* -- Geo table row grid (plan 6.3, task report item 2): metric-table.ts's .mt-row is a plain
   flow of children -- the label span plus one span per 'columns' entry -- onto css.ts's shared
   .mt-row { grid-template-columns: 1fr auto auto auto; } (4 tracks). The Geo table's row has 4
   metric columns (Events, Live sessions, Seats 30m, Duration) *plus* the label, 5 items on a
   4-track grid, so the 5th (Duration) wrapped onto its own implicit row -- the "each city's name
   sits in its own tall band, detached from Country/Count/Sessions/Avg" bug. Scoped to this page's
   own Geo card rather than widening the shared 4-track template (events.ts's connector funnel
   table uses that same 4-column shape and is not this task's file to touch). */
[data-realtime-geo] .mt-row { grid-template-columns: minmax(0, 1fr) auto auto auto auto; }
/* countryCell() (primitives.ts) replaces the old flag()+string label: flag, country name and the
   city as a secondary line, both lines small enough to sit inside the shared 32px row without
   spilling into the row below or after it. */
[data-realtime-geo] .country-cell-name,
[data-realtime-geo] .country-cell-secondary { line-height: 1.15; }
[data-realtime-geo] .mt-label { min-width: 0; }
/* -- Page height (plan 3.7b law 10, task report item 1): with a full fixture's worth of
   countries and connected seats, both tables below the strip grew as tall as their row count,
   the single biggest source of the ~5.5-viewport page. Capped the same way as the Live events
   feed above -- an internal scroll, never a hard row limit that would hide a real country or
   seat. -- */
[data-realtime-geo] .mt-body { max-height: 176px; overflow-y: auto; }
[data-realtime-seats] .table-wrap { max-height: 176px; overflow-y: auto; }

/* -- Live events feed (plan 3.7 item 2/6.3, task report item 1/3): the feed has no built-in cap
   on its own height -- operator/src/render/live.ts's #rt-stream id never matched css.ts's
   .rt-stream class rule (a dead selector), so up to LIVE_FEED_ROW_CAP rows grew the card (and
   the page) without a scrollbar. Recreated here, scoped by id, without touching the shared file
   or the id/class mismatch itself. -- */
[data-live-feed] #rt-stream { display: flex; flex-direction: column; gap: 2px; max-height: 300px; overflow-y: auto; }
/* Each row stays one line (kind badge, name, flag + OS chip, ticking age): the chips wrapped
   onto a second line under the name at anything less than full width, since .event-chips is
   flex-wrap: wrap in css.ts. Truncate instead of wrapping: the name shrinks and ellipses first,
   the chip pair and the age stay put. */
[data-live-feed] .rt-row { flex-wrap: nowrap; }
[data-live-feed] .event-name {
  flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
[data-live-feed] .event-chips { flex: 0 0 auto; flex-wrap: nowrap; overflow: hidden; max-width: 45%; }
[data-live-feed] .ago { flex: 0 0 auto; }

/* -- Map SVG rules, from the map rebuild: these own everything inside the SVG and win
   over any page level rule above that targets the same element. -- */
.rt-map {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  border-radius: var(--radius-map);
  overflow: hidden;
  background: var(--map-ocean);
}
/* No \`min-height\` here (a previous version set 360px): \`min-height\` always wins over the
   height \`aspect-ratio\` would otherwise compute, so on a narrow phone-width card (~356px
   wide, where 16:9 wants ~200px) it forced a near-square box instead -- and Mercator projects
   the globe's high-Arctic latitudes (Russia's own north coast, well past 66N) toward Y
   coordinates far outside this map's 0..648 viewBox, ordinarily invisible because
   \`overflow: hidden\` above clips it right at the correctly-sized 16:9 edge. The taller,
   off-ratio box gave that always-there overflow room to actually render, in the gap the wrong
   aspect ratio opened up -- the "hard-edged circular disc" over Scandinavia/Russia/China/Japan
   from task report item 7 (most visible at narrow widths, where the ratio broke hardest;
   only its topmost arc showed at 1440px, where the box is far wider than 360px regardless). */
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
   above so a corner-map cell's step colour always wins over the plain land fill.
   stroke-width is 0.2px, not the realtime map's 0.5px hairline: a country's own land bridge
   can be genuinely narrower than half a pixel once the whole globe is Mercator-projected into
   this map's 520-unit width (India's Siliguri Corridor, linking West Bengal to the north-east
   states, is the real case -- task report item 6). A 0.5px stroke traces both sides of a gap
   that thin and paints over whatever fill survives between them, rendering one connected
   country as two disconnected lobes with a gap of ocean in between. 0.2px still reads as a
   clear separator between adjacent, differently-coloured cells; re-rendered and visually
   confirmed against India's corridor specifically, and against every other seeded country on
   this map, to make sure none of them show the same gap at this width. */
.corner-cell { stroke: var(--map-ocean); stroke-width: 0.2px; cursor: default; }
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
/* Leader line (map.ts's renderPin, LEADER_LINE_MIN_DY): only present at all once the collision
   nudge has pushed a label far enough from its own dot that the two no longer read as one unit
   on their own -- ties the label visually back to the marker it names. */
.rt-pin-leader { stroke: var(--map-stroke); stroke-width: 1px; vector-effect: non-scaling-stroke; pointer-events: none; }
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

/* Mobile: renderRealtimeMapSvg() (map.ts) has no notion of viewport width -- it renders one
   1152-unit-wide SVG, scaled purely by CSS to whatever the card's own width is. At a ~360px
   mobile card that is roughly a quarter of the desktop rendering, every pin label and country
   pill text shrinks right along with it -- text that reads fine at the desktop width becomes an
   illegible, overlapping smear at mobile size well before the underlying shapes do (task report:
   the Western-Europe and India clusters collapsing into smeared text blocks, six country pills
   sitting edge-to-edge). Both layers are already redundant with the per-point/per-country
   tooltip attachMapInteraction() shows on hover/tap, so the fix is to drop straight to dots +
   tooltip at this width rather than trying to out-shrink the same label set the desktop map
   shows -- still an honest, still a legible picture of where seats are; every dot keeps its own
   colour, size and pulse regardless. */
@media (max-width: 640px) {
  .rt-pin-label, .rt-pills { display: none; }
}

@media (prefers-reduced-motion: reduce) {
  .map-graticule { transition: none; }
  .world-land { transition: none; }
}
`
