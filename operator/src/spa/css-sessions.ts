/**
 * Sessions page CSS (plan 6.5, 3.5b "Sessions" motion row). Tokens only, no hex literal (plan
 * D6 / gates.mjs gate 3). Concatenated in operator/src/spa/manifest.ts, in NAV_IDS order, after
 * SHELL_CSS and PAGES_SHARED_CSS -- rules here only ever add to or make more specific what the
 * shared sheet already carries (`.card`, `.chip`, `.btn`, `.status-dot`, `.seat-overlay`,
 * `.table-wrap`, `tbody tr:hover`...), never redefine a shared component's own look.
 *
 * The `[data-hide-col~="N"]` block (plan "View: column visibility") is generated, not hand
 * written, so the column count only has to be right once (operator/src/render/pages/sessions.ts's
 * SESSIONS_COLUMNS) and the client only ever sets a bare `data-hide-col="3 7"` attribute (an XML
 * attribute value, never `style=`) to hide any subset of the 13 columns.
 */

const MAX_SESSIONS_COLUMNS = 16

const HIDE_COLUMN_RULES = Array.from({ length: MAX_SESSIONS_COLUMNS }, (_, i) => i + 1)
  .map((n) => `#sessions-table[data-hide-col~="${n}"] tr > *:nth-child(${n}) { display: none; }`)
  .join('\n')

export const SESSIONS_CSS = `
/* -- design gate fix (blocker): at narrow widths the 13-column table's intrinsic width was
   leaking out through the grid track above it, blowing the whole document out to ~1000px instead
   of only the table scrolling inside its own card (plan 3.7b law 10). \`.page.wrap\` (operator/src/
   ui.ts, shared) is a CSS Grid; a grid item's automatic minimum size defaults to its content's
   min-content width unless the item sets \`min-width: 0\` itself. [data-sessions-root] (this page's
   direct grid item) and .card (data-sessions-table-wrap, nested one level in) never set it, so
   .table-wrap's own \`overflow-x: auto\` (css.ts, shared) never got a constrained width to clip
   against. Both selectors below are scoped to this page's own markup, not a shared-file edit --
   the equivalent shared-file patch (also fixes .card everywhere else that carries a wide table) is
   in this page's build report, since css.ts is design-lead's file, not owned here. Fixing the width
   also fixes .page-toolbar's flex-wrap: once .top-right's container is properly capped at the
   viewport width, the existing \`flex-wrap: wrap\` correctly drops View + both Export buttons to
   their own row instead of being pushed off-canvas. -- */
[data-sessions-root],
[data-sessions-root] .card { min-width: 0; }

/* -- design gate fix (blocker): eyebrow-label AI-tell. th, .eyebrow and .seat-field .lbl (all
   css.ts, shared) render as uppercase + wide-tracked micro-labels, which plan 3.3's type law bans
   ("Labels and buttons 12 px, weight 600, no uppercase, no wide tracking"). Scoped overrides here
   (higher specificity than the bare shared rules, so source order does not matter) drop the
   transform/tracking and land on the plan's own 12px/600 spec for every label this page renders;
   the source text was already sentence case ("Started", "Timeline", ...), only the CSS transform
   made it look shouted. The equivalent shared-file fix (also clears the same tell on every other
   page reusing these classes) is in this page's build report. -- */
#sessions-table th,
[data-session-drawer] .eyebrow,
[data-session-drawer] .seat-field .lbl {
  text-transform: none;
  letter-spacing: normal;
  font-size: 12px;
  font-weight: 600;
}

/* -- design gate fix (major): one accent, reserved for the primary action / active state / focus /
   selection (plan 3.2) -- not a decorative badge. .tier-metis (css.ts, shared) paints --accent-text
   on nearly every row's tier pill; scoped off that hue here onto --info, a neutral status tint
   already used for badges in both themes (.kind-use, .os-badge.windows). The drawer's real primary
   action (Approve, above in this page's markup) now carries the accent instead via .btn.primary.
   The equivalent shared-file fix is in this page's build report. -- */
[data-sessions-root] .tier-metis,
[data-session-drawer] .tier-metis { color: var(--info); }

/* -- toolbar controls: the range select reads like the other .tool pills. -- */
.tool-select-wrap { display: inline-flex; align-items: center; }
.tool-select {
  height: 32px; padding: 0 10px; border-radius: var(--radius-control); border: 1px solid var(--border);
  background: var(--surface); color: var(--ink); font: 500 12px var(--font-body); cursor: pointer;
}
.tool-select:hover { background: var(--bg-2); }

/* -- filters / view popovers: anchored under their toggle button, scale + opacity open (plan
   3.5b: "filters menu opens with scale + opacity"). The global prefers-reduced-motion override
   (operator/src/spa/css.ts) already collapses this transition to 0.01ms, so no separate reduced
   motion rule is needed here. -- */
.sessions-menu-wrap { position: relative; display: inline-flex; }
.sessions-panel {
  position: absolute; top: calc(100% + 6px); left: 0; z-index: 40; min-width: 220px;
  display: grid; gap: 10px; padding: 12px; border-radius: var(--radius-card);
  background: var(--surface); border: 1px solid var(--border); box-shadow: var(--shadow);
  opacity: 0; transform: scale(0.98); transform-origin: top left;
  transition: opacity 180ms var(--ease-spring), transform 180ms var(--ease-spring);
}
.sessions-panel.is-open { opacity: 1; transform: scale(1); }
.sessions-panel label { display: grid; gap: 4px; font-size: 12px; color: var(--ink-2); font-weight: 550; }
.sessions-panel select, .sessions-panel input {
  height: 30px; padding: 0 8px; border-radius: var(--radius-control); border: 1px solid var(--border);
  background: var(--surface); color: var(--ink); font: 500 12px var(--font-body);
}
.sessions-view { display: grid; grid-template-columns: 1fr; gap: 6px; max-height: 320px; overflow-y: auto; }
.sessions-view label { flex-direction: row; align-items: center; display: flex; gap: 8px; font-weight: 500; }

.sessions-export { display: inline-flex; gap: 8px; }

/* -- table: hover feedback shared with Events' motion (plan 3.5b: "same table motion as Events"),
   scoped to this table only. Press feedback is operator/client/motion.ts's press() (plan
   implementation rule: only through the shared helpers), not a second, competing CSS :active
   transform here. -- */
#sessions-table tbody tr { cursor: pointer; transition: background 120ms var(--ease-color); }

.sessions-skeleton { display: grid; gap: 6px; padding: 4px 0; }

.session-profile { display: inline-flex; align-items: center; gap: 8px; }
.session-profile-text { display: grid; gap: 2px; line-height: 1.25; }
.session-live { display: inline-flex; align-items: center; gap: 6px; font: 500 12px var(--font-body); color: var(--live); }

${HIDE_COLUMN_RULES}

/* -- drawer content (plan 6.5 "session drawer"): laid out inside the shared .seat-overlay shell
   (operator/src/spa/css.ts), never redefining that shell's own position, size or shadow. -- */
.session-drawer-identity { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.session-drawer-name { font: 600 14px var(--font-display); color: var(--ink); }
.session-drawer-fields { display: grid; gap: 10px 16px; grid-template-columns: 1fr 1fr; margin-bottom: 12px; }
.session-license-actions { display: flex; gap: 8px; margin-bottom: 12px; }
.session-license-actions .btn.is-confirming { background: var(--danger); color: var(--accent-ink); border-color: transparent; }
.session-drawer-links { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; }
.session-drawer-section { margin-bottom: 18px; padding-top: 14px; border-top: 1px solid var(--border); }
.session-drawer-section:first-of-type { border-top: none; padding-top: 0; }
.session-drawer-loading { display: grid; gap: 6px; }

.btn.tiny { height: 24px; padding: 0 8px; font-size: 11px; }

/* -- timeline: an SVG line drawn top-to-bottom (drawPath(), operator/client/motion.ts) behind a
   plain flow list of rows, each popping in staggered (plan 3.5b: "the vertical line draws down,
   then each event pops in along it, stagger 40ms"). The line's height/viewBox/path length are set
   from the list's real rendered height by operator/client/pages/sessions.ts (SVG presentation
   attributes, never a style= width -- plan's own inline-style exception). -- */
.session-timeline { position: relative; padding-left: 22px; }
.session-timeline-svg { position: absolute; left: 4px; top: 4px; overflow: visible; }
.session-timeline-svg path { stroke: var(--border-2); stroke-width: 2; fill: none; }
.session-timeline-list { display: grid; gap: 10px; list-style: none; margin: 0; padding: 0; }
.session-timeline-row { display: flex; align-items: center; gap: 8px; position: relative; }
.session-timeline-dot {
  position: absolute; left: -22px; width: 8px; height: 8px; border-radius: var(--radius-pill);
  background: var(--accent); border: 2px solid var(--surface);
}
.session-timeline-offset { color: var(--ink-3); font-size: 11px; margin-left: auto; }

.session-ask-list { display: grid; gap: 8px; list-style: none; margin: 0; padding: 0; }
.session-ask-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.session-ask-offset { color: var(--ink-3); font-size: 11px; min-width: 52px; }
.session-ask-chips { display: flex; gap: 6px; flex-wrap: wrap; }

.session-connectors { display: grid; gap: 8px; list-style: none; margin: 0; padding: 0; }
.session-connector-row { display: flex; align-items: center; gap: 8px; }
.session-connector-row .muted { margin-left: auto; }
`
