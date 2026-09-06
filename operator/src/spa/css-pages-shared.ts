/**
 * Shared page-body utility classes (plan P0.4). Every page module under operator/src/render/
 * pages/ used to carry its spacing as inline `style="padding-bottom:10px"` etc.; gates.mjs gate
 * 2 requires zero inline `style=` in the rendered preview HTML, so those became classes here.
 * No page currently needs a style unique to only that page beyond these shared utilities, so
 * there is one shared file rather than eleven near-identical `css-<page>.ts` files; a page that
 * later needs something page-specific gets its own `css-<page>.ts` at that point.
 *
 * Also carries `display: block` for the percentage bars operator/src/render/pages/_shared.ts's
 * `percentBar()` renders as a sized `<svg>` (an XML `width`/`height` attribute, not `style=`) in
 * place of the old `<span style="width:...%">` -- the class itself (`.vol-bar`, `.geo-bar`,
 * `.crm-funnel-ok`, `.crm-funnel-fail`) keeps its existing background/position rules in
 * operator/src/spa/css.ts (design-lead's file) unchanged; this only adds the one property an
 * SVG needs that a span did not.
 */
export const PAGES_SHARED_CSS = `
.pad-b10 { padding-bottom: 10px; }
.pad-b8 { padding-bottom: 8px; }
.pad-b6 { padding-bottom: 6px; }
.mg-b8 { margin-bottom: 8px; }
.mg-0 { margin: 0; }
.mg-t14 { margin-top: 14px; }
.pad-8-0 { padding: 8px 0; }
svg.vol-bar, svg.geo-bar, svg.crm-funnel-ok, svg.crm-funnel-fail { display: block; }
`
