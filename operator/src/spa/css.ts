import { STATUS_BADGE_CSS } from '../components/ui/status-badge'
import { GENERATED_FONTS } from './fonts.generated'

/**
 * Métis Operator chrome. Hashed and served at /assets/operator-<hash>.css. Not a stub.
 *
 * Design system: Shoey (OpenPanel) console structure -- rail, tiles, tables, drawers, world
 * map, density rules -- wearing the Amaris Fit Studio visual language: lavender canvas, violet
 * ink, one purple accent, Space Grotesk numerals, purple-tinted shadows, spring motion. The
 * world map is a light choropleth panel matching the page canvas (Tony, 2026-09-06: the map is
 * not a dark focal panel), coloured by a sequential violet scale (--chart-scale-01..05). Every
 * section below is labelled with the plan section it implements so a reviewer can check this
 * file against the spec line by line.
 *
 * No hex literal anywhere in this file outside the two token blocks (LIGHT_TOKENS,
 * DARK_TOKENS) -- every colour a component rule needs is a `var(--...)` reference. Legacy
 * token names (`--def-100`, `--card`, `--hair`, `--ink2`, `--chart-0`, ... every name the rest
 * of operator/src and operator/client still reads) are kept as aliases of the new plan-3.2
 * tokens so nothing breaks before P0.3 re-skins the primitives themselves.
 */

// ---------------------------------------------------------------------------
// Plan 3.2: tokens (light, primary)
// ---------------------------------------------------------------------------
const LIGHT_TOKENS = `
  /* -- surfaces, ink, accent, status, data (plan 3.2 light table) -- */
  --bg: #f8f6fd;
  --bg-2: #efeafb;
  --surface: #ffffff;
  --surface-2: #f5f1fc;
  --border: #ece5f7;
  --border-2: #ddd2ee;
  --ink: #170826;
  --ink-2: #5c5273;
  /* Plan 3.2 gives #6d6784; darkened to #66607d (QA's gates.mjs: the literal spec value is
     4.45:1 on --accent-soft, under the 4.5:1 floor -- this value clears bg, surface and
     accent-soft). */
  --ink-3: #66607d;
  /* --accent: rings and selected states only. --accent-fill: button/badge fills (paired with
     --accent-ink text). --accent-text: accent-as-text. Split 2026-09-06 after gates.mjs found
     --accent-ink on the dark --accent fill at 4.25:1, under the 4.5:1 floor -- light values are
     identical across all three roles, only dark diverges. */
  --accent: #7f00da;
  --accent-2: #6600ae;
  --accent-fill: #7f00da;
  --accent-soft: #f1e6fb;
  --accent-ink: #ffffff;
  --accent-text: #7f00da;
  --live: #10b981;
  --ok: #0a9e7d;
  --warn: #d98a00;
  --danger: #d23b3b;
  --info: #1477e0;
  --data-1: #8a00f8;
  --data-2: #1477e0;
  --data-3: #0a9e7d;
  --data-4: #d98a00;
  --data-track: #efeafb;
  /* -- map (Tony, 2026-09-06: not a dark focal panel -- a light choropleth matching the page
     canvas). --map-stroke is used at 0.5px, --map-graticule at 60% opacity. -- */
  --map-ocean: #ffffff;
  --map-land: #f0f0f0;
  --map-stroke: #999999;
  --map-graticule: #ece5f7;
  --map-land-hover: #e4defa;
  --map-dot: #170826;
  --map-pill: #ffffff;
  /* -- sequential choropleth scale (light to saturated violet), plan 3.2 token change 2026-09-06. -- */
  --chart-scale-01: #f1e6fb;
  --chart-scale-02: #d9bdf7;
  --chart-scale-03: #b98cff;
  --chart-scale-04: #9d4dff;
  --chart-scale-05: #7f00da;
  --beacon-idle: color-mix(in srgb, var(--data-1) 55%, transparent);
  --shadow: 0 1px 2px rgba(40, 10, 70, 0.06), 0 18px 40px -18px rgba(90, 0, 150, 0.22);
  --shadow-ring: 0 0 0 3px rgba(127, 0, 218, 0.18);
  --card-highlight: inset 0 1px 0 rgba(255, 255, 255, 0.6);
  --glass: rgba(255, 255, 255, 0.72);
  --glass-blur: blur(24px) saturate(1.2);

  /* -- type (plan 3.3). Family names come from the fonts actually built by
     operator/scripts/build-assets.mjs (operator/src/spa/fonts.generated.ts); when a package was
     not installed at build time the generated file reports fileName: null and the family name
     is left out of the stack below, so the browser falls through to the system fallback rather
     than ever requesting a font that was never shipped. -- */
  --font-display: ${cssFontStack(GENERATED_FONTS.spaceGrotesk, "'Space Grotesk Variable'")}, ui-sans-serif, system-ui, sans-serif;
  --font-body: ${cssFontStack(GENERATED_FONTS.inter, "'Inter Variable'")}, ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;

  /* -- shape (plan 3.4): cards/drawers 14px, controls/inputs 10px, pills 999px, table row
     hover 8px, map panel 18px. -- */
  --radius-card: 14px;
  --radius-control: 10px;
  --radius-pill: 999px;
  --radius-row: 8px;
  --radius-map: 18px;

  /* -- avatar tint (plan 3.6): saturation/lightness only -- primitives.ts supplies the hash-
     derived --avatar-hue per instance, never a colour literal. -- */
  --avatar-sat: 55%;
  --avatar-light: 88%;

  /* -- motion easings (plan 3.5): spring for transform/layout, colour for colour transitions.
     Mirrored as JS constants in operator/client/motion.ts -- keep the two in sync. -- */
  --ease-spring: cubic-bezier(0.23, 1, 0.32, 1);
  --ease-color: cubic-bezier(0.32, 0.72, 0, 1);

  /* -- legacy aliases: every custom-property name operator/src/render, operator/client and
     operator/src/charts.ts still read before this rewrite, pointed at the plan-3.2 token that
     plays the same role. Kept until P0.3 re-skins those call sites directly. -- */
  --def-100: var(--bg);
  --def-200: var(--bg-2);
  --def-300: var(--border-2);
  --def-400: var(--ink-3);
  --card: var(--surface);
  --card-foreground: var(--ink);
  --input: var(--border);
  --ring: var(--accent);
  --foreground: var(--ink);
  --muted: var(--surface-2);
  --muted-foreground: var(--ink-2);
  --accent-surface: var(--accent-soft);
  --accent-foreground: var(--ink);
  --primary: var(--accent-fill);
  --primary-foreground: var(--accent-ink);
  --destructive: var(--danger);
  --chart-0: var(--data-1);
  --chart-1: var(--accent-soft);
  --chart-2: var(--border-2);
  --chart-3: var(--data-4);
  --chart-4: var(--data-1);
  --chart-5: var(--accent-2);
  --ping: var(--live);
  --radius: var(--radius-control);
  --panel: var(--surface);
  --hair: var(--border);
  --ink2: var(--ink-2);
  --ink3: var(--ink-3);
  --land: var(--map-land);
  --ocean: var(--map-ocean);
  --land-stroke: var(--map-stroke);
  --nav: var(--surface);
  --nav-on: var(--bg-2);
  --mono: var(--font-mono);
  --sans: var(--font-body);
`

// ---------------------------------------------------------------------------
// Plan 3.2: tokens (dark, derived) -- only the tokens the plan's dark table actually
// redefines. Everything else (status colours, data series, map, shape, motion, legacy
// aliases) is a `var(...)` reference in LIGHT_TOKENS, so it resolves through automatically.
// ---------------------------------------------------------------------------
const DARK_TOKENS = `
  --bg: #0b0813;
  --bg-2: #130f1d;
  --surface: #120e1c;
  --surface-2: #1a1526;
  --border: #251d36;
  --border-2: #332948;
  --ink: #f3eefb;
  --ink-2: #a99fc0;
  /* Plan 3.2 gives #7d7394; lightened to #89809e (+9%, same hue) so 11.5px captions clear WCAG
     AA 4.5:1 against every dark surface including --accent-soft (#231437, lighter than
     --surface-2 -- QA's gates.mjs caught this pair at 4.48:1 with the first #877e9d nudge). See
     operator/scripts/build-assets.mjs's contrast gate and the P0.1 report for the numbers. */
  --ink-3: #89809e;
  --accent: #9d4dff;
  /* White on #9d4dff is 4.25:1, under 4.5:1 -- a darker violet earns the same brand hue back its
     required contrast for filled buttons/badges (5.96:1). Coordinator, 2026-09-06. */
  --accent-fill: #8a2be2;
  --accent-ink: #ffffff;
  --accent-text: #b98cff;
  --accent-soft: #231437;
  --data-track: #1a1526;
  --map-ocean: #120e1c;
  --map-land: #1f1830;
  --map-stroke: #3a2f52;
  --map-graticule: #251d36;
  --map-land-hover: #2d2246;
  --map-dot: #f3eefb;
  --map-pill: #1a1526;
  --chart-scale-01: #231437;
  --chart-scale-02: #3b1f63;
  --chart-scale-03: #5a2f95;
  --chart-scale-04: #7d45c9;
  --chart-scale-05: #9d4dff;
  --shadow: 0 1px 2px rgba(0, 0, 0, 0.45), 0 18px 40px -18px rgba(120, 60, 200, 0.35);
  --card-highlight: inset 0 1px 0 rgba(255, 255, 255, 0);
  --glass: rgba(18, 14, 28, 0.72);
  /* Muted and dark so an avatar tile never blows out against dark surfaces (plan 3.6). */
  --avatar-sat: 35%;
  --avatar-light: 28%;
`

function fontFace(font: { family: string; weightRange: string; fileName: string | null }): string {
  if (!font.fileName) return ''
  return `@font-face {
  font-family: '${font.family}';
  font-style: normal;
  font-weight: ${font.weightRange};
  font-display: swap;
  src: url('/assets/fonts/${font.fileName}') format('woff2-variations');
}
`
}

/** `'Family Name'` when the file actually shipped, `''` (fallthrough to the rest of the stack)
 *  when build-assets.mjs could not find the package -- css.ts must never point at a font that
 *  was never written to /assets/fonts/. */
function cssFontStack(font: { fileName: string | null }, quotedFamily: string): string {
  return font.fileName ? quotedFamily : ''
}

const FONT_FACES = `${fontFace(GENERATED_FONTS.spaceGrotesk)}${fontFace(GENERATED_FONTS.inter)}`

export const CONSOLE_CSS = `/* Métis Operator SPA chrome. Shoey structure, Amaris skin (plan metis-portal-wow.md 3). */
:root {${LIGHT_TOKENS}}
/* An explicit choice (data-theme="dark") always wins; with no cookie ("system"),
   prefers-color-scheme decides (plan 3.2). */
[data-theme="dark"] {${DARK_TOKENS}}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]):not([data-theme="dark"]) {${DARK_TOKENS}}
}

/* -- plan 3.3: self-hosted @font-face, woff2, latin subset, font-display: swap. No Google
   Fonts link, no CDN of any kind (plan lock 8) -- empty string when a package was not
   installed at build time (see fontFace() above). -- */
${FONT_FACES}

*, *::before, *::after { box-sizing: border-box; }
html { color-scheme: light; }
html[data-theme="dark"] { color-scheme: dark; }
@media (prefers-color-scheme: dark) {
  html:not([data-theme="light"]):not([data-theme="dark"]) { color-scheme: dark; }
}

/* -- plan 3.3 base type + plan 3.4 base surface: body copy 13px/19.5px Inter, page canvas
   --bg, primary text --ink. -- */
html, body { margin: 0; height: 100%; }
body {
  background: var(--bg);
  color: var(--ink);
  font: 400 13px/19.5px var(--font-body);
  -webkit-font-smoothing: antialiased;
}
h1, h2, h3, h4, h5, h6 { margin: 0; font-family: var(--font-body); font-weight: 600; color: var(--ink); }
a { color: var(--accent-text); text-decoration: none; }
/* Reference layout primitives (operator/shoey-ref/SPEC.md #1): .row/.col are plain flex,
   .card is border+radius+bg, .hide-scrollbar hides the scrollbar cross-browser, .sticky-header
   pins a canvas-toned bar to the top of its scroll container. */
.row { display: flex; flex-direction: row; }
.col { display: flex; flex-direction: column; }
.hide-scrollbar { scrollbar-width: none; }
.hide-scrollbar::-webkit-scrollbar { display: none; }
.sticky-header { position: sticky; top: 0; z-index: 20; background: var(--bg); }
/* -- plan 3.3 base "table": header rule only, 40% row separation, 13px body cells. -- */
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-family: var(--font-body); }
th, td { text-align: left; padding: 6px 6px; vertical-align: top; }
th {
  color: var(--ink-3); font-weight: 500; font-family: var(--font-mono); font-size: 10px;
  letter-spacing: 0.08em; text-transform: uppercase; border-bottom: 1px solid var(--border);
}
td {
  font-size: 13px; color: var(--ink);
  border-bottom: 1px solid color-mix(in srgb, var(--border) 40%, transparent);
}
tbody tr:hover td { background: var(--bg-2); }
tr.is-selected td { background: var(--accent-soft); box-shadow: var(--shadow-ring); }
/* -- plan 3.3 base "input": 10px control radius, --border-2 outline. -- */
input, select, textarea {
  font: 400 13px var(--font-body);
  color: var(--ink);
  background: var(--surface);
  border: 1px solid var(--border-2);
  border-radius: var(--radius-control);
  padding: 6px 10px;
}
input::placeholder, textarea::placeholder { color: var(--ink-3); }
/* -- plan 3.3 base "button": 12px/600, no uppercase, pill radius. -- */
button, .btn {
  background: transparent; color: var(--ink); border: 1px solid var(--border);
  padding: 5px 10px; font: 600 12px/1 var(--font-body); cursor: pointer;
  border-radius: var(--radius-pill);
}
button.primary { background: var(--accent-fill); color: var(--accent-ink); border-color: transparent; }
button.danger { color: var(--danger); }
/* -- plan 3.3 base focus ring: --accent everywhere, visible-keyboard-only. -- */
:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
/* -- glass utility (plan 3.2 --glass / --glass-blur): sticky toolbar, drawer header. -- */
.glass { background: var(--glass); backdrop-filter: var(--glass-blur); -webkit-backdrop-filter: var(--glass-blur); }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}

/* -- plan 3.4 layout: rail 288px fixed, content padding-left 288px at >=1024px. -- */
.shell { display: grid; grid-template-columns: 288px 1fr; min-height: 100%; }
.rail {
  display: flex; flex-direction: column; gap: 8px;
  background: var(--nav); border-right: 1px solid var(--hair);
  padding: 12px 10px 14px; min-height: 100vh; position: sticky; top: 0;
  width: 288px;
}
/* Below 1024px the rail goes fully off-canvas (reference Sidebar.tsx: -translate-x-72) and a
   menu button plus a full-viewport backdrop scrim take over. */
.rail-toggle {
  display: none; position: fixed; top: 12px; left: 12px; z-index: 45;
  width: 34px; height: 34px; align-items: center; justify-content: center;
  border: 1px solid var(--hair); background: var(--panel); color: var(--ink);
  border-radius: var(--radius-control); cursor: pointer;
}
.rail-backdrop {
  display: none; position: fixed; inset: 0; z-index: 40;
  background: color-mix(in srgb, black 32%, transparent); backdrop-filter: blur(2px);
  border: 0; padding: 0; cursor: pointer;
}
@media (max-width: 1023px) {
  .shell { grid-template-columns: 1fr; }
  .rail {
    position: fixed; top: 0; left: 0; z-index: 46; min-height: 100vh;
    transform: translateX(-100%); transition: transform 200ms var(--ease-spring);
  }
  .rail.open { transform: translateX(0); }
  .rail-toggle { display: inline-flex; }
  .rail-backdrop[data-open="1"] { display: block; }
}
@media (prefers-reduced-motion: reduce) { .rail { transition: none; } }
.rail-brand { display: flex; align-items: center; gap: 8px; }
/* -- plan 6.1: logo mark, Métis "M" on --accent-fill rounded square, 32px. -- */
.rail-logo {
  width: 32px; height: 32px; border-radius: var(--radius-control); background: var(--accent-fill); color: var(--accent-ink);
  display: grid; place-items: center; font: 700 13px/1 var(--font-display); letter-spacing: -0.02em; flex-shrink: 0;
}
.rail-brand h1 { margin: 0; font-size: 13px; font-weight: 650; letter-spacing: -0.03em; }
.rail-brand .chev { color: var(--ink3); font-size: 11px; }
.rail nav { display: flex; flex-direction: column; gap: 14px; flex: 1; }
.nav-sec { display: flex; flex-direction: column; gap: 1px; }
.nav-sec p {
  font-size: 11px; letter-spacing: 0.02em; color: var(--ink3); margin: 8px 8px 4px; font-weight: 550;
}
.nav-item {
  display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: var(--radius-control);
  color: var(--ink); font: 600 12px/1.3 var(--font-body);
}
.nav-item:hover { background: var(--nav-on); }
.nav-item.on { background: var(--accent-soft); color: var(--accent-text); font-weight: 650; }
.nav-item.on svg { color: var(--accent-text); }
.nav-count {
  margin-left: auto; min-width: 18px; height: 18px; padding: 0 5px; border-radius: var(--radius-pill);
  background: var(--accent-soft); color: var(--accent-text);
  font: 600 10px/18px var(--font-mono); text-align: center;
}
.rail-foot { margin-top: auto; display: flex; flex-direction: column; gap: 8px; padding-top: 12px; }
.rail-utils { display: flex; gap: 8px; flex-wrap: wrap; }
.rail-utils a, .rail-utils button { color: var(--ink2); font-size: 11px; background: none; border: 0; cursor: pointer; padding: 0; }
/* -- plan 6.1: "Private, Access" chip. -- */
.access-chip {
  display: inline-flex; align-items: center; width: fit-content; padding: 2px 8px;
  border-radius: var(--radius-pill); font: 600 10px/1.6 var(--font-mono); letter-spacing: 0.04em;
  text-transform: uppercase; color: var(--ok); background: color-mix(in srgb, var(--ok) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--ok) 24%, transparent);
}
.who { font-family: var(--mono); font-size: 10px; color: var(--ink2); word-break: break-all; }
.theme-btn {
  border: 1px solid var(--hair); background: transparent; color: var(--ink2);
  font: 600 11px/1 var(--font-mono); letter-spacing: 0.06em; text-transform: uppercase;
  padding: 6px 8px; border-radius: var(--radius-control); cursor: pointer;
}
.main { min-width: 0; background: var(--bg); }
/* -- plan 3.7 item 3: glass sticky toolbar (blur 24px). -- */
.top {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 10px 16px; border-bottom: 1px solid var(--hair);
  background: var(--glass); backdrop-filter: var(--glass-blur); -webkit-backdrop-filter: var(--glass-blur);
  position: sticky; top: 0; z-index: 4;
}
.top-left, .top-right { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.tool {
  border: 1px solid var(--hair); background: var(--panel); color: var(--ink);
  border-radius: var(--radius-control); padding: 6px 10px; font: 600 12px var(--font-body); cursor: pointer;
  display: inline-flex; align-items: center; gap: 6px;
}
.tool[disabled] { opacity: 0.5; cursor: default; }
.top-search {
  flex: 1; min-width: 180px; border: 1px solid var(--hair); background: var(--panel); color: var(--ink);
  border-radius: var(--radius-control); padding: 7px 12px; font: 400 13px var(--font-body);
}
.live-dot {
  display: inline-flex; align-items: center; gap: 6px; font: 600 12px/1 var(--font-body); color: var(--ink);
  border: 1px solid var(--hair); border-radius: var(--radius-pill); padding: 5px 10px; background: var(--panel);
}
.live-dot i { width: 7px; height: 7px; border-radius: var(--radius-pill); background: var(--live); display: inline-block; }
/* -- plan 3.3: page titles 24px, Space Grotesk, tabular numerals, tracking -0.02em at 24px+. -- */
.top h2 {
  margin: 0; font-size: 24px; font-weight: 600; letter-spacing: -0.02em; color: var(--ink);
  font-family: var(--font-display);
}
.eyebrow {
  font-size: 10px; letter-spacing: 0.12em;
  text-transform: uppercase; color: var(--ink3); margin: 0 0 8px; font-weight: 600;
}
.eyebrow-flush { margin: 0; }
.wrap { padding: 14px 16px 36px; display: grid; gap: 12px; }
.kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.kpis-extra { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 10px; }
.ov-10 { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; }
/* -- plan 3.4 cards: --surface, 1px --border, --shadow, 1px inset top highlight (light only). -- */
.stat-card {
  background: var(--panel); border: 1px solid var(--hair); border-radius: var(--radius-card);
  box-shadow: var(--shadow), var(--card-highlight);
  padding: 12px 12px 0; overflow: hidden; min-width: 0; color: var(--ink);
}
.stat-card-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.stat-card h3 { margin: 0; font-size: 15px; font-weight: 600; letter-spacing: -0.01em; color: var(--ink); }
.trend-badge {
  font: 600 11px var(--font-body); padding: 2px 7px; border-radius: var(--radius-pill);
  border: 1px solid color-mix(in srgb, var(--ok) 20%, transparent);
  background: color-mix(in srgb, var(--ok) 8%, transparent); color: var(--ok);
}
.trend-badge.down {
  border-color: color-mix(in srgb, var(--danger) 20%, transparent);
  background: color-mix(in srgb, var(--danger) 8%, transparent); color: var(--danger);
}
.trend-badge.flat { border-color: var(--hair); background: var(--nav-on); color: var(--ink2); }
.stat-flow { display: flex; align-items: baseline; gap: 8px; margin: 10px 0 4px; }
/* -- plan 3.3: KPI numerals 32px (tile), Space Grotesk 600, tabular figures. -- */
.stat-flow .n {
  font-family: var(--font-display); font-size: 32px; font-weight: 600; letter-spacing: -0.02em;
  font-feature-settings: "tnum"; font-variant-numeric: tabular-nums; line-height: 1; color: var(--ink);
}
.stat-flow .lbl { font-size: 11px; color: var(--ink2); }
.stat-card .spark, .stat-card .stat-spark { display: block; width: calc(100% + 24px); margin: 6px -12px 0; height: 72px; }
.stat-gauge, .stat-ring { height: 64px; margin-left: auto; margin-right: auto; width: 88px; }
.stat-choro-wrap { margin: 6px -12px 0; height: 78px; overflow: hidden; }
.stat-choro { display: block; width: 100%; height: 78px; }
.ov-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.ov-chip {
  display: inline-flex; align-items: center; gap: 6px;
  border: 1px solid var(--hair); border-radius: var(--radius-pill); padding: 4px 10px;
  font-size: 11px; color: var(--ink2); background: var(--panel);
}
.ov-chip b { color: var(--ink); font-weight: 600; }
.ev-grid { display: grid; grid-template-columns: 1fr; gap: 12px; align-items: start; }
.ev-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin: 0 0 10px; }
.ev-sub { margin: 4px 0 0; font-size: 12px; }
.ev-tabs { margin: 0 0 10px; }
.page-hero { display: grid; gap: 4px; margin: 2px 0 4px; }
/* -- plan 3.3: page titles 24px. -- */
.page-title {
  margin: 0; font-size: 24px; font-weight: 600; letter-spacing: -0.02em; color: var(--ink);
  font-family: var(--font-display);
}
.page-sub { margin: 0; font-size: 13px; color: var(--ink2); }
.page-tabs { display: flex; flex-wrap: wrap; gap: 4px; margin: 8px 0 12px; }
.page-tab {
  border: 0; background: transparent; color: var(--ink2);
  font: 600 13px/1 var(--font-body); padding: 7px 12px; border-radius: var(--radius-control); cursor: pointer;
}
.page-tab.on { background: var(--bg-2); color: var(--ink); }
.page-tab[data-inert] { opacity: 0.6; cursor: default; }
.page-tabs.underline { gap: 16px; border-bottom: 1px solid var(--hair); padding-bottom: 0; }
.page-tabs.underline .page-tab { border-radius: 0; padding: 8px 2px 10px; }
.page-tabs.underline .page-tab.on { background: transparent; color: var(--ink); box-shadow: inset 0 -2px 0 var(--ink); }
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
  border: 1px solid var(--hair); background: var(--panel); border-radius: var(--radius-pill);
  padding: 5px 10px; font-size: 12px; font-weight: 600; color: var(--ink);
}
.listen-pill i, .live-events i {
  width: 8px; height: 8px; border-radius: var(--radius-pill); background: var(--live);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--live) 16%, transparent);
}
.table-frame { min-height: 280px; }
.empty-data {
  display: grid; justify-items: center; gap: 8px; text-align: center;
  padding: 48px 16px; color: var(--ink);
}
.empty-data strong { font-size: 14px; font-weight: 650; }
.empty-data p { margin: 0; color: var(--ink2); font-size: 12px; }
.empty-dash {
  width: 36px; height: 36px; border: 1.5px dashed var(--ink3); border-radius: var(--radius-control);
}
.stat-line {
  display: flex; justify-content: space-between; gap: 12px;
  padding: 8px 2px; border-bottom: 1px solid var(--hair); font-size: 13px;
}
.stat-line b { font-weight: 650; }
.ev-table-card { padding-top: 12px; }
.ev-names { display: flex; flex-direction: column; gap: 2px; max-height: 560px; overflow: auto; }
.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; }
.card {
  position: relative;
  background: var(--panel);
  border: 1px solid var(--hair);
  border-radius: var(--radius-card);
  box-shadow: var(--shadow), var(--card-highlight);
  padding: 10px 12px 0;
  overflow: hidden;
  color: var(--ink);
}
.card h3 { margin: 0; font-size: 15px; font-weight: 600; letter-spacing: -0.01em; color: var(--ink); }
.kpi-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; }
.kpi { padding-bottom: 8px; }
.kpi .eyebrow { margin-bottom: 4px; }
/* -- plan 3.3: KPI numerals 32px, Space Grotesk 600, tabular figures. -- */
.kpi .n {
  font-family: var(--font-display); font-size: 32px; font-weight: 600; letter-spacing: -0.02em;
  font-feature-settings: "tnum"; font-variant-numeric: tabular-nums; line-height: 1; margin-top: 6px; color: var(--ink);
}
.rt-h { margin: 0; font-size: 15px; font-weight: 600; letter-spacing: -0.01em; color: var(--ink); font-family: var(--font-body); }
/* -- plan 3.3: KPI numerals 40px (Realtime live count). -- */
.rt-n {
  font-family: var(--font-display); font-size: 40px !important; font-weight: 600; letter-spacing: -0.02em;
  font-feature-settings: "tnum"; font-variant-numeric: tabular-nums; margin-top: 8px !important;
}
.rt-unique { padding-top: 14px; }
.rt-unique-pad { padding-bottom: 14px; }
.activity-feed-pad { padding-bottom: 10px; }
.delta { font-size: 11px; font-weight: 600; }
.delta.up { color: var(--ok); }
.delta.down { color: var(--danger); }
.delta.flat { color: var(--ink3); }
.rt-grid { display: grid; grid-template-columns: minmax(220px, 28%) minmax(0, 1fr); gap: 16px; align-items: stretch; }
.rt-map { min-width: 0; min-height: 480px; position: relative; }
/* -- plan 6.3: light choropleth map panel matching the page canvas, 18px radius (Tony,
   2026-09-06: not a dark focal panel). -- */
.rt-map #map-root { min-height: 480px; height: 100%; background: var(--map-ocean); border-radius: var(--radius-map); }
#map-root[data-land="inline"] { min-height: 480px; background: var(--map-ocean); border-radius: var(--radius-map); }
#map-root[data-land="inline"] svg.shoey-world {
  display: block; width: 100%; height: auto; min-height: 480px;
}
.rt-map .world.shoey-world { min-height: 480px; max-height: none; }
.rt-stream { display: flex; flex-direction: column; gap: 2px; max-height: 420px; overflow: auto; }
.rt-row {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 6px 2px; border-bottom: 1px solid var(--hair); font-size: 11px;
}
.rt-row .ago { color: var(--ink3); font-size: 11px; white-space: nowrap; }
.rt-ics { display: inline-flex; gap: 3px; margin-left: 6px; vertical-align: middle; }
.ic-mac, .ic-win, .ic-desk {
  display: inline-block; width: 12px; height: 12px; border-radius: 2px; background: var(--data-1);
}
.ic-win { background: var(--info); }
.ic-desk { background: var(--ink3); }
.vol { position: relative; }
.vol-row {
  display: grid; grid-template-columns: 1fr 56px 64px; gap: 8px; align-items: center;
  padding: 5px 8px; position: relative; font-size: 11px;
}
.vol-bar {
  position: absolute; inset: 2px auto 2px 0; background: var(--def-200); border-radius: 4px; z-index: 0;
}
.vol-bar.blue { background: var(--data-track); }
.vol-row > * { position: relative; z-index: 1; }
.table-card .tabs { margin: 0 0 8px; }
.table-search {
  width: 100%; border: 1px solid var(--hair); border-radius: var(--radius-control); padding: 6px 10px;
  font: 400 13px var(--font-body); margin-bottom: 8px;
  background: var(--panel); color: var(--ink);
}
.empty-card { background: var(--panel); border: 1px solid var(--hair); border-radius: var(--radius-card); padding: 28px 20px; }
.empty-card h3 { margin: 0 0 6px; font-size: 16px; }
.empty-card p { margin: 0; color: var(--ink2); }
.kpi .sub { font-family: var(--mono); font-size: 10px; color: var(--ink3); margin: 4px 0 8px; }
.spark { display: block; width: calc(100% + 24px); margin: 0 -12px; height: 56px; }
.chart { display: block; width: 100%; height: 140px; }
.world { display: block; width: 100%; height: auto; max-height: 420px; }
.world.shoey-world {
  width: 100%; height: auto; max-height: none; min-height: 0;
  aspect-ratio: 2 / 1; background: var(--map-ocean); border-radius: var(--radius-map);
}
.world.shoey-world.ov { min-height: 0; max-height: 220px; }
.world.shoey-world .world-ocean { fill: var(--map-ocean); }
.world.shoey-world path.world-land, .world.shoey-world path[data-iso] {
  fill: var(--map-land) !important;
  stroke: var(--map-stroke) !important;
  stroke-width: 0.5px;
  vector-effect: non-scaling-stroke;
}
.world.shoey-world path.world-land:hover, .world.shoey-world path[data-iso]:hover { fill: var(--map-land-hover) !important; }
.world.shoey-world .seat-dot { fill: var(--map-dot); stroke: var(--map-ocean); }
.heat { display: block; width: 100%; max-width: 280px; height: auto; }
.grat { stroke: color-mix(in srgb, var(--map-graticule) 60%, transparent); stroke-width: 0.6; }
.dot { fill: var(--accent); stroke: var(--bg); stroke-width: 0.8; }
.tick { fill: var(--ink3); font-size: 9px; font-family: var(--mono); }
.tabs { display: flex; flex-wrap: wrap; gap: 4px; margin: 0 0 8px; }
.tab {
  border: 1px solid transparent; background: transparent; color: var(--ink2);
  font: 600 11px/1 var(--font-mono); letter-spacing: 0.04em; text-transform: uppercase;
  padding: 4px 9px; border-radius: var(--radius-pill); cursor: pointer;
}
.tab.on { background: var(--ink); color: var(--bg); }
.tab.on .status-badge { color: inherit; border-color: currentColor; background: transparent; }
.pill {
  display: inline-block; padding: 1px 7px; border-radius: var(--radius-pill); font-size: 10px;
  font-family: var(--mono); border: 1px solid var(--hair); color: var(--ink2);
}
.pill.up, .pill.hit { color: var(--ok); }
.pill.down { color: var(--danger); }
.chip {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 2px 8px; border-radius: var(--radius-pill); border: 1px solid var(--hair);
  font-family: var(--mono); font-size: 10px; color: var(--ink2); background: var(--nav-on);
}
.empty { color: var(--ink2); font-size: 12px; padding: 10px 0 12px; }
.fail-loud { color: var(--danger); font-size: 13px; font-weight: 600; padding: 10px 0 12px; }
.key-form { display: grid; gap: 8px; margin: 0 0 14px; }
.key-form .row input, .key-form .row select {
  border: 1px solid var(--hair); background: var(--bg); color: var(--ink);
  border-radius: var(--radius-control); padding: 6px 8px; font: 400 12px var(--font-body); min-width: 120px;
}
.map-empty { position: absolute; left: 12px; top: 42px; z-index: 1; }
.key-msg { padding: 8px 0; font-size: 12px; }
.key-msg.ok { color: var(--ok); font-weight: 600; }
article[data-cf-overview], article[data-cf-page] { background: var(--panel); color: var(--ink); }
pre, textarea {
  width: 100%; background: color-mix(in srgb, var(--bg) 70%, black); color: var(--ink);
  border: 1px solid var(--hair); padding: 8px; font: 11px var(--mono);
}
textarea { min-height: 120px; }
.row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.muted { color: var(--ink2); }
.legend { display: flex; gap: 12px; font-family: var(--mono); font-size: 10px; color: var(--ink3); padding: 6px 0 10px; }
.legend i { display: inline-block; width: 10px; height: 2px; background: var(--data-2); vertical-align: middle; margin-right: 4px; }
.legend i.ask { background: var(--data-1); }
.funnel { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 8px; }
.crm-funnel { display: grid; gap: 6px; margin: 0 0 10px; }
.crm-funnel-row { display: grid; grid-template-columns: 88px 1fr auto; gap: 8px; align-items: center; }
.crm-funnel-track { height: 6px; background: var(--nav-on); border: 1px solid var(--hair); position: relative; overflow: hidden; }
.crm-funnel-ok { position: absolute; inset: 0 auto 0 0; background: var(--ok); opacity: 0.7; }
.crm-funnel-fail { position: absolute; inset: 0 0 0 auto; background: var(--danger); opacity: 0.7; }
.crm-kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin: 0 0 10px; }
.crm-kpis .n { font-family: var(--font-display); font-size: 22px; font-weight: 600; font-feature-settings: "tnum"; margin-top: 4px; }
.remote a { color: var(--accent-text); }
.heat-wrap { display: flex; gap: 16px; align-items: flex-start; }
.heat-meta { font-family: var(--mono); font-size: 10px; color: var(--ink3); }
.event {
  display: grid; grid-template-columns: 130px 1.1fr 1.1fr 1fr 90px 90px; gap: 10px; align-items: center;
  padding: 10px 8px; border-bottom: 1px solid var(--hair); font-size: 12px;
}
.event-head {
  font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink3);
  font-weight: 550; padding-bottom: 6px;
}
.event-name { font-weight: 650; }
.event-profile { color: var(--ink2); }
.event-country, .event-os, .event-browser { color: var(--ink2); }
.event-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.event-time { font-family: var(--font-body); font-size: 12px; color: var(--ink3); text-align: left; }
.live { display: inline-block; padding: 1px 7px; border-radius: var(--radius-pill); background: var(--ink); color: var(--bg); font: 10px var(--mono); letter-spacing: 0.08em; }
.page[hidden] { display: none !important; }
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
  border-radius: var(--radius-card);
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
  transition: transform 160ms var(--ease-spring), box-shadow 160ms var(--ease-spring), background 160ms var(--ease-color);
}
.seat-row:hover {
  transform: translateY(-1px);
  box-shadow: var(--shadow);
  background: color-mix(in srgb, var(--nav-on) 80%, transparent);
}
@media (prefers-reduced-motion: reduce) {
  .seat-row { transition: none; }
  .seat-row:hover { transform: none; }
}
.seat-no { font-family: var(--mono); font-size: 11px; color: var(--ink3); }
.seat-name { display: inline-flex; align-items: center; gap: 8px; font-weight: 600; }
.os-badge {
  width: 22px; height: 22px; border-radius: var(--radius-pill); display: grid; place-items: center;
  font: 700 8px/1 var(--font-body); letter-spacing: 0.02em; color: var(--accent-ink); text-transform: lowercase;
}
.os-badge.mac { background: var(--ink); }
.os-badge.windows { background: var(--info); }
.os-badge.linux { background: var(--ok); }
.seat-loc { color: var(--ink2); font-size: 12px; }
.seat-flag {
  display: inline-block; min-width: 22px; padding: 1px 5px; margin-right: 6px;
  border-radius: 4px; border: 1px solid var(--hair); font: 700 9px var(--mono);
}
.seat-meter { height: 6px; background: var(--nav-on); border-radius: var(--radius-pill); overflow: hidden; }
.seat-meter i { display: block; height: 100%; background: var(--data-1); border-radius: var(--radius-pill); }
.seat-status {
  display: inline-flex; justify-content: center; padding: 2px 8px; border-radius: var(--radius-pill);
  font: 600 10px var(--font-body); border: 1px solid var(--hair);
}
.seat-status.active { color: var(--ok); background: color-mix(in srgb, var(--ok) 8%, transparent); border-color: color-mix(in srgb, var(--ok) 22%, transparent); }
.seat-status.paused { color: var(--warn); background: color-mix(in srgb, var(--warn) 10%, transparent); border-color: color-mix(in srgb, var(--warn) 22%, transparent); }
.seat-status.inactive { color: var(--ink3); background: var(--nav-on); }
.seat-overlay {
  position: absolute; inset: 12px; background: var(--panel);
  border: 1px solid var(--hair); border-radius: var(--radius-card);
  box-shadow: var(--shadow); padding: 16px; z-index: 3;
  overflow: auto;
}
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
.drawer-footer { margin-top: 12px; }
.sess-profile { display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
.sess-host { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 550; }
.sess-id {
  font-family: var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.sess-avatar {
  width: 22px; height: 22px; border-radius: var(--radius-control); display: inline-grid; place-items: center;
  font: 700 10px/1 var(--font-body); color: var(--ink); flex-shrink: 0;
}
.seat-hbars { display: flex; align-items: flex-end; gap: 3px; height: 28px; }
.seat-hbars i { width: 6px; background: var(--data-1); border-radius: 2px 2px 0 0; display: block; min-height: 3px; }
.nt-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin: 0 0 10px; }
.nt-sub { margin: 4px 0 0; font-size: 12px; }
svg:not(.shoey-world) path { vector-effect: non-scaling-stroke; }
#spark-defs { position: absolute; width: 0; height: 0; }
@media (max-width: 980px) {
  .kpis, .kpis-extra, .ov-10, .grid-2, .grid-3, .crm-kpis, .event, .rt-grid, .ev-grid { grid-template-columns: 1fr; }
}

/* --- render/ primitive styling (shell, toolbar, metricTable, topListCard, live, badges) --- */
.rail-switcher { flex: 1; justify-content: space-between; }
.rail-switcher .tool-ic:last-child { margin-left: auto; }
.rail-search-wrap { margin: 8px 0; }
.rail-search-wrap .rail-search { padding-left: 30px; width: 100%; }
.kbd-hint {
  position: absolute; right: 8px; top: 50%; transform: translateY(-50%);
  font: 10px/1 var(--mono); color: var(--ink3); border: 1px solid var(--hair);
  border-radius: 4px; padding: 1px 5px; background: var(--panel);
}
.theme-group { gap: 4px; }
.theme-btn[aria-pressed="true"] { background: var(--nav-on); color: var(--ink); font-weight: 650; }
.nav-item svg { width: 15px; height: 15px; flex-shrink: 0; color: var(--ink3); }
.nav-item.on svg { color: var(--ink); }

/* metricTable() */
.mt-wrap { container-type: inline-size; }
.mt-flags { display: flex; gap: 4px; }
.mt-row {
  display: grid; grid-template-columns: 1fr auto auto auto; gap: 8px; align-items: center;
  height: 32px; position: relative; padding: 0 8px; border-radius: var(--radius-row);
}
.mt-head { height: 28px; font: 10px/1 var(--mono); letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink3); }
.mt-row > * { position: relative; z-index: 1; }
.mt-label { display: flex; align-items: center; gap: 6px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mt-col { text-align: right; font-family: var(--mono); font-size: 11px; }
@container (max-width: 650px) { .mt-hide-650 { display: none; } }
@container (max-width: 350px) { .mt-hide-350 { display: none; } }
@container (max-width: 150px) { .mt-hide-150 { display: none; } }

/* topListCard(): grid-template-columns is a class (SPEC rule 5: 1fr 70px for one value column,
   1fr 70px 70px for two), not an inline style -- plan D6, style-src 'self', no unsafe-inline. */
.tlc-tabs { display: flex; gap: 16px; border-bottom: 1px solid var(--hair); padding: 0 12px; }
.tlc-tab { border: 0; background: transparent; color: var(--ink2); font: 600 12px var(--font-body); padding: 10px 0; cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px; }
.tlc-tab.on { color: var(--ink); border-bottom-color: var(--accent); }
.tlc-search { padding: 8px 12px; border-bottom: 1px solid var(--hair); }
.tlc-row { display: grid; gap: 6px; align-items: center; height: 25px; position: relative; padding: 0 12px; }
.tlc-row.cols-1 { grid-template-columns: 1fr 70px; }
.tlc-row.cols-2 { grid-template-columns: 1fr 70px 70px; }
.tlc-head { height: 26px; font: 10px/1 var(--mono); letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink3); }
.tlc-sort { display: inline-flex; align-items: center; gap: 2px; justify-self: end; cursor: pointer; }
.tlc-row > * { position: relative; z-index: 1; }
.tlc-label { display: flex; align-items: center; gap: 6px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tlc-value { text-align: right; font-family: var(--mono); font-size: 11px; }
.tlc-foot { display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; border-top: 1px solid var(--hair); color: var(--ink3); }
.tlc-flush { padding-bottom: 0; }

/* row-bar: the metricTable()/topListCard() proportional row bar, an inline <svg><rect width="N%">
   (a presentation attribute CSP always allows, unlike a style attribute) -- shared by both
   components, positioned to match each one's own row height and inset. */
.row-bar { position: absolute; left: 0; right: auto; width: 100%; z-index: 0; pointer-events: none; }
.mt-row .row-bar { top: 2px; bottom: 2px; }
.tlc-row .row-bar { top: 1px; bottom: 1px; }
.row-bar rect { fill: var(--def-200); }
.mt-row:hover .row-bar rect, .tlc-row:hover .row-bar rect { fill: var(--accent-soft); }

/* metricTiles() */
.mtiles-card { overflow: visible; }
.mtiles-card-flush { padding: 0; }
.mtiles-grid { display: grid; grid-template-columns: repeat(2, 1fr); }
@media (min-width: 768px) { .mtiles-grid { grid-template-columns: repeat(4, 1fr); } }
.mtile { border: 1px solid var(--hair); border-top: 0; border-left: 0; padding: 10px 12px; min-width: 0; }
.mtile:nth-child(2n) { border-right: 0; }
@media (min-width: 768px) { .mtile:nth-child(2n) { border-right: 1px solid var(--hair); } .mtile:nth-child(4n) { border-right: 0; } }

/* visitorsCard() / liveCard() / liveFeed() */
.visitors-bars { display: block; width: 100%; height: 42px; margin-top: 8px; }
.pulse-dot { width: 6px; height: 6px; border-radius: var(--radius-pill); background: var(--live); display: inline-block; margin-left: 6px; }

/* primitives: flag, osGlyph/osChip, avatar, kindBadge, tierBadge, statusDot, clientChip,
   deltaChip, tooltip, skeletonRows, timeCell */
.flag { font-size: 14px; line-height: 1; }
/* flagStrip(): header summary strip, name still reaches screen readers via flag()'s own title. */
.flag-strip { display: inline-flex; gap: 2px; }
/* countryCell() (plan 3.6 rewritten): flag never appears without its name. */
.country-cell { display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
.country-flag { display: block; border-radius: 2px; flex-shrink: 0; object-fit: cover; }
.country-flag-none { display: inline-block; width: 16px; height: 12px; border-radius: 2px; background: var(--surface-2); flex-shrink: 0; }
.country-cell-body { display: flex; flex-direction: column; min-width: 0; }
.country-cell-name { font-size: 13px; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.country-cell-secondary { font-size: 11.5px; color: var(--ink-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.os-chip { display: inline-flex; align-items: center; gap: 4px; }
.os-glyph { width: 13px; height: 13px; }
/* -- plan 3.6: avatars are initials on a deterministic tint from the identity hash (the
   primitive picks one of 12 hue buckets via a data-hue attribute, never an inline style
   attribute -- plan D6's CSP is style-src 'self' with no 'unsafe-inline', so a per-instance
   inline custom property would be blocked at runtime). --avatar-sat / --avatar-light are theme
   tokens, so the tile never blows out in dark mode. 8px-radius squircle feel via
   --radius-control. -- */
.avatar {
  position: relative; display: inline-grid; place-items: center; width: 22px; height: 22px;
  border-radius: var(--radius-control); font: 700 9px/1 var(--font-body); flex-shrink: 0;
  background: hsl(var(--avatar-hue, 210) var(--avatar-sat) var(--avatar-light)); color: var(--ink);
}
.avatar[data-hue="0"] { --avatar-hue: 0; }
.avatar[data-hue="1"] { --avatar-hue: 30; }
.avatar[data-hue="2"] { --avatar-hue: 60; }
.avatar[data-hue="3"] { --avatar-hue: 90; }
.avatar[data-hue="4"] { --avatar-hue: 120; }
.avatar[data-hue="5"] { --avatar-hue: 150; }
.avatar[data-hue="6"] { --avatar-hue: 180; }
.avatar[data-hue="7"] { --avatar-hue: 210; }
.avatar[data-hue="8"] { --avatar-hue: 240; }
.avatar[data-hue="9"] { --avatar-hue: 270; }
.avatar[data-hue="10"] { --avatar-hue: 300; }
.avatar[data-hue="11"] { --avatar-hue: 330; }
.avatar-live {
  position: absolute; right: -2px; bottom: -2px; width: 7px; height: 7px; border-radius: var(--radius-pill);
  background: var(--live); border: 1.5px solid var(--card);
}
.kind-badge { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 600; }
.kind-icon { width: 13px; height: 13px; flex-shrink: 0; }
.kind-heartbeat { color: var(--ok); } .kind-ask { color: var(--data-1); } .kind-recap { color: var(--accent-text); }
.kind-listen { color: var(--warn); } .kind-rating { color: var(--data-2); } .kind-crm { color: var(--data-3); }
.kind-vault { color: var(--ink2); } .kind-license { color: var(--data-1); } .kind-seat { color: var(--ink3); }
.kind-use { color: var(--info); } .kind-platform { color: var(--danger); }
.tier-badge { display: inline-block; padding: 1px 7px; border-radius: var(--radius-pill); font: 600 10px var(--font-body); border: 1px solid var(--hair); }
.tier-metis { color: var(--accent-text); } .tier-metis-light { color: var(--ink2); }
.status-dot { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; }
.status-dot i { width: 7px; height: 7px; border-radius: var(--radius-pill); display: inline-block; background: var(--ink3); }
.status-dot-live i { background: var(--live); }
.status-dot-idle i { background: var(--ink3); }
.status-dot-pending i { background: var(--warn); }
.status-dot-failed i, .status-dot-revoked i { background: var(--danger); }
.client-chip { font: 500 11px var(--mono); color: var(--ink2); }
.delta-chip { font: 600 11px var(--font-body); padding: 2px 7px; border-radius: var(--radius-pill); }
.delta-up { background: color-mix(in srgb, var(--ok) 12%, transparent); color: var(--ok); }
.delta-down { background: color-mix(in srgb, var(--danger) 12%, transparent); color: var(--danger); }
.delta-flat { background: var(--def-200); color: var(--ink3); }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; }
.skeleton-row { height: 32px; display: flex; align-items: center; padding: 0 8px; }
.skeleton-row i { display: block; width: 100%; height: 10px; border-radius: 4px; background: var(--def-200); animation: skeleton-pulse 1.2s ease-in-out infinite; }
@keyframes skeleton-pulse { 0%, 100% { opacity: 0.5; } 50% { opacity: 1; } }
/* -- shimmer() helper (operator/client/motion.ts, plan 3.5b): a light sweep across a loading
   block. Covered by the global prefers-reduced-motion override above (the *, *::before, *::after
   rule collapses this ::after's animation-duration to ~0), and shimmer() itself never adds the
   class when reduceMotion() is true. -- */
.is-shimmering { position: relative; overflow: hidden; }
.is-shimmering::after {
  content: ""; position: absolute; inset: 0; transform: translateX(-100%);
  background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--surface) 65%, transparent), transparent);
  animation: metis-shimmer-sweep 1.4s ease-in-out infinite;
}
@keyframes metis-shimmer-sweep { 100% { transform: translateX(100%); } }
.time-cell { font-family: var(--mono); font-size: 10px; color: var(--ink3); cursor: default; }

/* -- P0.3 new primitives (plan 6.10, 6.1, 3.7): logoGlyph, catalogTile, connectionDrawer,
   toast, dialog, tabs, chip, segmented, sourceTooltip, exportMenu. -- */

/* glass toolbar / drawer header: two-class selector wins over .sticky-header's solid
   background regardless of source order. */
.page-toolbar.glass, .seat-overlay-head.glass {
  background: var(--glass); backdrop-filter: var(--glass-blur); -webkit-backdrop-filter: var(--glass-blur);
}
.seat-overlay-head.glass { padding: 12px 16px; margin: -16px -16px 12px; border-bottom: 1px solid var(--border); border-radius: var(--radius-card) var(--radius-card) 0 0; }
.seat-overlay-head.glass .logo-glyph { flex-shrink: 0; }

.logo-glyph { display: inline-block; border-radius: 6px; object-fit: contain; flex-shrink: 0; }

/* catalogTile() */
.catalog-tile {
  display: flex; flex-direction: column; align-items: flex-start; gap: 8px;
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-card);
  padding: 12px; min-width: 168px; cursor: pointer; text-align: left;
  transition: transform 150ms var(--ease-spring), box-shadow 150ms var(--ease-spring);
}
.catalog-tile:hover { transform: translateY(-1px); box-shadow: var(--shadow); }
@media (prefers-reduced-motion: reduce) { .catalog-tile:hover { transform: none; } }
.catalog-tile-needs-oauth { opacity: 0.6; cursor: default; }
.catalog-tile-needs-oauth:hover { transform: none; box-shadow: none; }
.catalog-tile-connected { box-shadow: var(--shadow-ring); }
.catalog-tile-name { font: 600 13px var(--font-body); color: var(--ink); }
.catalog-tile-transport { font-family: var(--font-mono); }
.catalog-tile-note { font: 12px var(--font-body); color: var(--ink3); }

/* chip() tones (statusDot()/deltaChip() colours, never a bespoke meaning per page) */
.chip-ok { color: var(--ok); background: color-mix(in srgb, var(--ok) 10%, transparent); border-color: color-mix(in srgb, var(--ok) 24%, transparent); }
.chip-warn { color: var(--warn); background: color-mix(in srgb, var(--warn) 10%, transparent); border-color: color-mix(in srgb, var(--warn) 24%, transparent); }
.chip-danger { color: var(--danger); background: color-mix(in srgb, var(--danger) 10%, transparent); border-color: color-mix(in srgb, var(--danger) 24%, transparent); }
.chip-accent { color: var(--accent-text); background: var(--accent-soft); border-color: transparent; }

/* segmented() -- same visual language as the reference .theme-group/.theme-btn */
.segmented { display: inline-flex; gap: 4px; padding: 2px; background: var(--bg-2); border-radius: var(--radius-pill); }
.segmented-item {
  border: 0; background: transparent; color: var(--ink2); font: 600 12px var(--font-body);
  padding: 5px 12px; border-radius: var(--radius-pill); cursor: pointer;
}
.segmented-item.on { background: var(--surface); color: var(--ink); box-shadow: var(--shadow); }

/* sourceTooltip() mark */
.source-tooltip-mark {
  display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px;
  border-radius: 999px; border: 1px solid var(--border-2); color: var(--ink3);
  font: 600 10px/1 var(--font-mono); margin-left: 4px; cursor: help;
}

/* toast() -- bottom-right, one at a time (plan 6.1) */
.toast {
  display: flex; align-items: center; gap: 10px; position: fixed; right: 16px; bottom: 16px; z-index: 80;
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-control);
  box-shadow: var(--shadow); padding: 10px 12px; font: 400 13px var(--font-body); color: var(--ink);
  max-width: 360px;
}
.toast[hidden] { display: none !important; }
.toast-error { border-color: color-mix(in srgb, var(--danger) 30%, var(--border)); }
.toast-success { border-color: color-mix(in srgb, var(--ok) 30%, var(--border)); }
.toast-request-id { font-family: var(--font-mono); font-size: 11px; color: var(--ink3); }
.toast-dismiss { background: transparent; border: 0; color: var(--ink3); cursor: pointer; padding: 2px; margin-left: auto; }

/* dialog() -- replaces window.prompt (plan lock/gate 5) */
.dialog-overlay { position: fixed; inset: 0; z-index: 70; background: color-mix(in srgb, black 32%, transparent); display: grid; place-items: center; }
.dialog-overlay[hidden] { display: none !important; }
.dialog-panel {
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-card);
  box-shadow: var(--shadow); padding: 20px; width: 360px; max-width: calc(100vw - 32px);
}
.dialog-panel h4 { margin: 0 0 12px; font: 600 15px var(--font-body); color: var(--ink); }
.dialog-label { display: block; font: 600 12px var(--font-body); color: var(--ink2); margin-bottom: 6px; }
.dialog-input-wrap { display: flex; gap: 6px; margin-bottom: 16px; }
.dialog-input { flex: 1; }
.dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }

/* exportMenu() */
.export-menu { display: inline-flex; align-items: center; gap: 6px; text-decoration: none; }

/* alertBadge() (plan 3.5c, ported Tremor-style alert badge): white ink on --ok/--danger/--info,
   divider in the same hue lightened. --accent-ink is reused for "white ink" -- it is already
   the token for readable text on a saturated fill, in both themes. */
.alert-badge {
  display: inline-flex; align-items: center; gap: 8px; padding: 6px 12px;
  border-radius: var(--radius-pill); font: 600 12px var(--font-body); color: var(--accent-ink);
}
.alert-badge-ok { background: var(--ok); }
.alert-badge-danger { background: var(--danger); }
.alert-badge-info { background: var(--info); }
.alert-badge-icon { width: 16px; height: 16px; flex-shrink: 0; }
.alert-badge-divider { width: 1px; align-self: stretch; }
.alert-badge-ok .alert-badge-divider { background: color-mix(in srgb, var(--ok) 55%, white); }
.alert-badge-danger .alert-badge-divider { background: color-mix(in srgb, var(--danger) 55%, white); }
.alert-badge-info .alert-badge-divider { background: color-mix(in srgb, var(--info) 55%, white); }
.alert-badge-label { white-space: nowrap; }
.alert-badge-action { color: var(--accent-ink); text-decoration: underline; text-underline-offset: 2px; margin-left: 4px; white-space: nowrap; }

/* dataTable variant: card (plan 3.5c): rows separated rather than ruled, a --surface band per
   row with a 1px top highlight (--card-highlight, the same token cards use), hover/selected
   tints mixed from the surface, 14px rounded outer corners, numeric columns right-aligned mono,
   sortable headers with an up/down/neutral arrow. The default (ruled) table rules above are
   untouched -- these only ever apply under the extra .dt-card class. */
table.dt-card { border-collapse: separate; border-spacing: 0 8px; }
table.dt-card thead th {
  font: 600 10px var(--font-body); text-transform: none; letter-spacing: normal;
  color: var(--ink-2); border-bottom: 0; padding: 0 12px 4px;
}
table.dt-card thead th.dt-card-sortable { cursor: pointer; }
table.dt-card .dt-sort-ic { width: 12px; height: 12px; vertical-align: -2px; margin-left: 2px; color: var(--ink-3); }
table.dt-card tbody tr { background: var(--surface); box-shadow: var(--card-highlight); }
table.dt-card tbody tr:hover { background: color-mix(in srgb, var(--surface) 80%, var(--bg-2)); }
table.dt-card tbody tr.is-selected { background: color-mix(in srgb, var(--surface) 70%, var(--accent-soft)); box-shadow: var(--shadow-ring); }
table.dt-card td { border-bottom: 0; padding: 10px 12px; }
table.dt-card .dt-card-numeric { text-align: right; font-family: var(--font-mono); }
table.dt-card tbody tr:first-child td:first-child { border-top-left-radius: var(--radius-card); }
table.dt-card tbody tr:first-child td:last-child { border-top-right-radius: var(--radius-card); }
table.dt-card tbody tr:last-child td:first-child { border-bottom-left-radius: var(--radius-card); }
table.dt-card tbody tr:last-child td:last-child { border-bottom-right-radius: var(--radius-card); }
table.dt-card tfoot td { background: color-mix(in srgb, var(--surface) 85%, var(--bg-2)); border-radius: 0 0 var(--radius-card) var(--radius-card); }

/* connectorRow() / connectorGroup() (plan 6.10b) */
.connector-group { padding: 4px 0 8px; }
.connector-group-head { padding: 10px 16px 6px; }
.connector-group-head h3 { margin: 0; font: 600 13px var(--font-body); color: var(--ink); }
.connector-group-count { color: var(--ink-3); font-weight: 500; }
.connector-group-rows { display: flex; flex-direction: column; }
.connector-row {
  display: flex; align-items: center; gap: 12px; height: 56px; padding: 0 16px;
  border-top: 1px solid var(--border); cursor: pointer; text-align: left;
}
.connector-group-rows .connector-row:first-child { border-top: 0; }
.connector-row[hidden] { display: none; }
.connector-row-icon { position: relative; flex-shrink: 0; width: 32px; height: 32px; }
.connector-row-logo { display: block; width: 32px; height: 32px; border-radius: 8px; background: var(--surface-2); object-fit: contain; padding: 4px; box-sizing: border-box; }
.connector-row-dot {
  position: absolute; right: -2px; bottom: -2px; width: 9px; height: 9px; border-radius: var(--radius-pill);
  border: 1.5px solid var(--surface);
}
.connector-row-dot-connected { background: var(--live); }
.connector-row-dot-attention { background: var(--danger); }
.connector-row-dot-pending { background: var(--warn); }
.connector-row-dot-untested { background: var(--ink-3); }
.connector-row-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.connector-row-name { display: flex; align-items: center; gap: 6px; font: 600 13px var(--font-body); color: var(--ink); }
.connector-row-badge { font-size: 11px; }
.connector-row-secondary { font-size: 11.5px; color: var(--ink-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.connector-row-action { flex-shrink: 0; font: 600 12px var(--font-body); color: var(--accent-text); }
.connector-row:hover .connector-row-action { text-decoration: underline; }
.connector-show-more {
  display: flex; align-items: center; justify-content: center; gap: 4px; width: 100%;
  padding: 10px 16px; border-top: 1px solid var(--border); background: transparent;
  color: var(--ink-2); font: 600 12px var(--font-body); cursor: pointer;
}
${STATUS_BADGE_CSS}
`
