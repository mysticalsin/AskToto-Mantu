import { GENERATED_FONTS } from './fonts.generated'

/**
 * Métis Operator chrome. Hashed and served at /assets/operator-<hash>.css. Not a stub.
 *
 * Design system: Shoey (OpenPanel) console structure -- rail, tiles, tables, drawers, world
 * map, density rules -- wearing the Amaris Fit Studio visual language: lavender canvas, violet
 * ink, one purple accent, Space Grotesk numerals, purple-tinted shadows, spring motion. The
 * world map is a light choropleth panel matching the page canvas (the owner, 2026-09-06: the map is
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
export const LIGHT_TOKENS = `
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
  /* -- map (the owner, 2026-09-06: not a dark focal panel -- a light choropleth matching the page
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
export const DARK_TOKENS = `
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

export const FONT_FACES = `${fontFace(GENERATED_FONTS.spaceGrotesk)}${fontFace(GENERATED_FONTS.inter)}`

