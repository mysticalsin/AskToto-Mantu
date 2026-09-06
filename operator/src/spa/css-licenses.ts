/**
 * Licenses page CSS (plan 6.7, motion minimums plan 3.5b "Licenses" row). Concatenated in
 * operator/src/spa/manifest.ts, in NAV_IDS order, after SHELL_CSS and PAGES_SHARED_CSS. Tokens
 * only (plan 3.2), no hex literal, canonical (hyphenated) token names -- see operator/src/spa/
 * css.ts's own header for why some of its rules still read the legacy aliases (`--ink2` etc.);
 * new rules in this file use the plan-3.2 names directly.
 *
 * The accent wash on a freshly FLIP-inserted issued-license row (plan 3.5b) needs no rule here:
 * operator/client/motion.ts's flash() paints it with Web Animations directly, not a CSS class.
 *
 * QA finding (mobile 390px overflow): `.wrap` (shared, operator/src/spa/css.ts, not owned by this
 * page) is `display: grid` with an implicit single auto-sized column, and `renderLicenses()`'s
 * `<div class="licenses-page">` is that column's one grid item. A grid item with no explicit
 * `min-width` defaults to `min-width: auto`, which for a plain block box (`.licenses-page` itself
 * has `overflow: visible`, unlike `.card`, whose own `overflow: hidden` already exempts it the
 * same way on every other page) resolves to the item's min-content size -- here, the Seats and
 * Issued tables' full 9-column width -- so the grid column grows to fit the table instead of
 * clamping to the viewport, and `.table-wrap`'s `overflow-x: auto` (spa/css.ts) never gets a
 * chance to engage because it is never asked to shrink. `.licenses-page { min-width: 0 }` below
 * overrides that default (the standard fix for this well-known CSS grid behaviour) so the column
 * clamps to the viewport and the tables scroll horizontally inside their own `.table-wrap`
 * instead of the page. Confirmed empirically with Playwright at 390px: before this rule,
 * `document.documentElement.scrollWidth` was 807px against a 390px `clientWidth`; after it, the
 * two match and the Seats/Issued tables scroll internally, matching the Audit page's existing,
 * non-overflowing behaviour (whose own top-level children are `.card`s, not a wrapping div, so
 * they get the same exemption through `overflow: hidden` instead). The same defect reproduces on
 * the Events page, which wraps its content in a similar div; if Events also needs a fix, its own
 * owner adds the matching `min-width: 0` rule to that page's own wrapper class the same way.
 */
export const LICENSES_CSS = `
/* Keeps this page's own grid item (the direct child of the shared .wrap grid, spa/css.ts) from
   growing to the Seats/Issued tables' full content width on narrow viewports -- see the file
   header above. */
.licenses-page { min-width: 0; }

/* .card (spa/css.ts) carries no vertical margin of its own -- every other page that stacks
   several top-level cards handles that spacing itself. Scoped to this page only. */
.licenses-page > .card + .card { margin-top: 16px; }

/* "Needs your review" (block 0, plan 6.7). The nugget reuses the shared .chip.chip-accent look
   (spa/css.ts) so its colour never drifts from the rest of the accent-chip vocabulary. */
.lic-review-head { display: flex; align-items: center; gap: 10px; margin-bottom: 4px; }
.lic-review-head h3 { margin: 0; }
/* .chip (spa/css.ts) sets its own display, which as an author rule otherwise beats the browser's
   default [hidden] user-agent style at equal specificity -- every other page in this codebase
   that puts [hidden] on a classed element (.page, .seat-overlay, .toast...) adds this same kind
   of explicit override for exactly that reason. */
.lic-review-nugget[hidden] { display: none !important; }
.lic-review-hint { margin: 0 0 10px; font-size: 11.5px; }
.lic-review-card [data-review-segmented] { margin-bottom: 10px; }

/* Seat identity cell (avatar + name + secondary line), shared by both review queues. */
.review-seat { display: inline-flex; align-items: center; gap: 10px; }
.review-seat-body { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.review-seat-name { font-weight: 600; }
.review-seat-sub { font-size: 11.5px; color: var(--ink-3); }
.review-actions { display: inline-flex; gap: 8px; justify-content: flex-end; }

/* Row height (plan 6.7: "56px, built for speed rather than density") -- a taller pad than the
   default .dt-card row (spa/css.ts: 10px 12px) on this block's rows only. */
tr.lic-review-row td { padding-top: 14px; padding-bottom: 14px; }

/* Keyboard-triage cursor (plan 6.7: "the focused row shows the --shadow-ring"). Not native DOM
   focus -- j/k move a bespoke cursor across a list, the way Gmail's own j/k does, so a screen
   reader or a real Tab press is unaffected by it; the ring is purely the sighted-keyboard cue. */
tr.lic-review-row.is-focused { box-shadow: inset 0 0 0 2px var(--accent); }

/* Two-click inline confirm on Revoke (plan 6.7: "confirm inline in the row, never a modal"),
   used by block 0's own Revoke buttons and, since the same QA finding asked for it, by the
   Generate/Seats cards' Revoke buttons too (operator/client/licenses.ts's armConfirmButton()). */
[data-page="licenses"] .btn.is-confirming { background: var(--danger); color: var(--accent-ink); border-color: transparent; }

/* Row collapse on a resolved action (plan 3.5b: "the acted row collapses (250ms)"). Opacity plus
   padding/line-height, the same technique operator/src/spa/css-notifications.ts uses for its own
   resolved rows, so it already reads correctly under the global prefers-reduced-motion collapse
   (spa/css.ts) with no separate override needed here. */
tr.lic-review-row.lic-review-row-collapse td {
  opacity: 0;
  padding-top: 0;
  padding-bottom: 0;
  line-height: 0;
  transition: opacity 0.18s var(--ease-color), padding 0.25s var(--ease-spring), line-height 0.25s var(--ease-spring);
}

/* Generate card layout. */
.licenses-hint { margin: 0 0 12px; }
.licenses-generate-row { align-items: flex-end; flex-wrap: wrap; gap: 12px; }
.licenses-field { display: flex; flex-direction: column; gap: 4px; }
.licenses-field-label { font: 600 11px var(--font-body); color: var(--ink-2); }
.licenses-generate-row select[name="groupId"], .licenses-generate-row select[name="tier"] { min-width: 160px; }

/* Duration segmented control (plan 3.5b: "a sliding thumb (spring)"). The real, submitted control
   is the native <select name="days"> next to it (kept .sr-only -- see licenses.ts's
   durationControl() doc comment for why); these rules are the decorative mirror only. */
.duration-control { position: relative; display: inline-flex; }
.duration-seg {
  position: relative; display: inline-flex; padding: 2px; width: 280px;
  background: var(--bg-2); border-radius: var(--radius-pill);
}
.duration-thumb {
  position: absolute; top: 2px; bottom: 2px; left: 2px; width: calc(20% - 0.8px);
  background: var(--surface); border-radius: var(--radius-pill); box-shadow: var(--shadow);
  transition: transform 250ms var(--ease-spring);
}
.duration-thumb[data-thumb-index="0"] { transform: translateX(0%); }
.duration-thumb[data-thumb-index="1"] { transform: translateX(100%); }
.duration-thumb[data-thumb-index="2"] { transform: translateX(200%); }
.duration-thumb[data-thumb-index="3"] { transform: translateX(300%); }
.duration-thumb[data-thumb-index="4"] { transform: translateX(400%); }
.duration-seg-btn {
  position: relative; z-index: 1; flex: 1 1 0%; border: 0; background: transparent; color: var(--ink-2);
  font: 600 12px var(--font-body); padding: 5px 6px; border-radius: var(--radius-pill); cursor: pointer;
  text-align: center; white-space: nowrap;
}
.duration-seg-btn.on { color: var(--ink); }

/* Once-string strip (plan 3.5b: "reveals with a shimmer sweep, the Copy button pulses once"; plan
   3.7b law 7: "the once-string never disappears until Tony dismisses it"). */
.license-once { margin: 10px 0 16px; padding: 10px 12px; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-control); }
.license-once-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.license-once-row input { flex: 1; min-width: 220px; font-family: var(--font-mono); font-size: 12px; }

/* Small mono identifier chip: activated-seat device id, and the "Computer" column's fallback when
   a seat has no hostname on file. */
.mono-id { font-family: var(--font-mono); font-size: 11px; color: var(--ink-2); background: var(--bg-2); padding: 1px 6px; border-radius: var(--radius-control); }

/* Revoke motion (plan 3.5b: "the row's status dot turns red with a 200ms colour transition and
   the row dims"). Scoped to this page: operator/client/licenses.ts toggles the dot's class and
   this class right before the confirmed revoke call resolves, so the transition plays before the
   page's rerender() lands the reconciled server state a moment later. */
[data-page="licenses"] .status-dot i { transition: background-color 200ms var(--ease-color); }
[data-page="licenses"] tr.is-revoking { opacity: 0.55; transition: opacity 200ms var(--ease-color); }

/* Expiring-soon amber pulse on the status dot only (plan 3.5b). Same halo mechanic as
   operator/client/motion.ts's beacon(), but keyed to --warn instead of beacon()'s hard-coded
   --live: "about to expire" and "online now" are different signals, so the shared green helper
   is not reused here (see licenses.ts's statusCell() doc comment). Keyed off .status-dot-live so
   it stops the instant a client-side revoke swaps that class; collapses under spa/css.ts's global
   prefers-reduced-motion rule like every other animation on the page. */
.lic-expiring-dot .status-dot-live i { animation: metis-licenses-expiring-pulse 2.4s var(--ease-color) infinite; }
@keyframes metis-licenses-expiring-pulse {
  0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--warn) 55%, transparent); }
  100% { box-shadow: 0 0 0 10px color-mix(in srgb, var(--warn) 0%, transparent); }
}
`
