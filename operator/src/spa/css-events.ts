/**
 * Events page CSS (plan 6.4, P1.4 brief). Everything the shared classes in operator/src/spa/css.ts
 * and css-pages-shared.ts do not already cover: the Listening/Paused toggle, the Range/Filters/View
 * dropdown menus (one small pattern, reused by all three so there is one open/close/scale-in rule
 * rather than three near-identical ones), the kind/status chip row Events and CRM both use, column
 * hiding for the View menu, the profile cell layout, and the ask-trace stagger-reveal + drawer
 * backdrop the motion minimums (plan 3.5b, Events row) ask for.
 *
 * Tokens only, no hex (plan lock). Concatenated in operator/src/spa/manifest.ts after SHELL_CSS,
 * PAGES_SHARED_CSS, OVERVIEW_CSS and REALTIME_CSS, in NAV_IDS order.
 */
export const EVENTS_CSS = `
/* Defensive counterpart to the fix css-licenses.ts and css-sessions.ts carry for the shared
   '.wrap' grid (spa/css.ts, not owned by this page): '.wrap' is "display: grid" with an implicit
   single auto-sized column, and each of this page's top-level '<div data-ev-pane="...">' panes is
   a grid item in it. A grid item with no explicit min-width defaults to min-width: auto, which
   could let a wide descendant (this page's own table, or a future one) grow the pane's box past
   the column instead of clamping to it and letting the descendant's own local overflow-x:auto do
   the scrolling. Currently a no-op here -- this page's actual 390px overflow (below) is a
   different element entirely -- but kept as the same standing guard those two pages already
   apply, so a future change to this pane's contents does not reopen the class of bug they hit. */
[data-ev-pane] { min-width: 0; }

/* .card sets overflow: hidden; every dropdown below needs to spill past that edge. */
.ev-toolbar-card { overflow: visible; padding-bottom: 10px; }

/* -- Listening / Paused toggle (plan 6.4: "green dot when listening"). The dot itself carries
   data-beacon (operator/client/motion-bind.ts): the 2.4s halo pulse, the one allowed infinite
   loop, only while listening -- the client removes data-beacon when paused, per the shared
   beacon() contract ("stays a plain, static dot" once motion stops). -- */
.ev-listen { display: inline-flex; align-items: center; gap: 6px; }
.ev-listen-dot { width: 7px; height: 7px; border-radius: var(--radius-pill); background: var(--live); display: inline-block; }
.ev-listen.is-paused .ev-listen-dot { background: var(--ink-3); }

/* -- One dropdown pattern for Range, Filters and View (plan 3.5b: "Filters menu: opens with scale
   + opacity"). [hidden] is overridden to stay in the layout so opacity/transform can transition;
   the JS side keeps aria-hidden/inert in sync so a closed panel is still out of the tab order and
   the accessibility tree, not only visually faded (operator/client/pages/events.ts wireMenus()). -- */
.ev-menu-wrap, .ev-view-wrap { position: relative; display: inline-flex; }
.ev-menu-panel {
  position: absolute; left: 0; top: calc(100% + 6px); z-index: 20;
  min-width: 200px; padding: 10px; display: flex; flex-direction: column; gap: 8px;
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-control);
  box-shadow: var(--shadow);
  opacity: 1; transform-origin: top left; transform: scale(1);
  transition: opacity 150ms var(--ease-color), transform 150ms var(--ease-spring);
}
.ev-menu-panel[hidden] { display: flex; opacity: 0; transform: scale(0.98); pointer-events: none; }
.ev-view-wrap .ev-menu-panel { right: 0; left: auto; transform-origin: top right; }

/* -- QA finding (blocker, mobile 390px overflow): the actual cause. [hidden] above deliberately
   keeps a closed panel "display: flex" (not none) so the open/close opacity+scale transition can
   play, which means it occupies its full layout box -- left: 0 off its own trigger -- at rest,
   not only while open. Below the shell's own single-column breakpoint (css-shell.ts, max-width:
   1023px) the Filters panel's content (the OS segmented control, four items across one row) is
   wider than the room remaining to the right of its trigger, so the closed, invisible panel's box
   already extends past the viewport edge -- the page reads as horizontally scrollable at rest,
   with no click needed to reproduce it (confirmed empirically with Playwright at 390px:
   document.documentElement.scrollWidth was 499px against a 390px clientWidth; the offending box
   was this panel, not the events table, which already scrolls correctly inside its own
   .table-wrap). The sticky top bar's own title-clipping is a separate, pre-existing shell defect
   (css-shell.ts, not owned by this page) reproducible on every page regardless of this overflow --
   confirmed on Overview too, which has no horizontal scroll at all -- so it is not this rule's
   concern. Right-aligning to the trigger below that
   breakpoint -- the same anchor .ev-view-wrap's panel above already uses, since that toggle sits
   at the toolbar's far right and never had this problem -- keeps every panel's box within the
   viewport, because its own trigger button is always on-screen. Left-alignment is untouched above
   1023px, where the toolbar has room to spare. -- */
@media (max-width: 1023px) {
  .ev-menu-wrap .ev-menu-panel { left: auto; right: 0; transform-origin: top right; }
}
.ev-menu-title {
  margin: 0; font: 600 10px var(--font-body); letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-3);
}
.ev-menu-item {
  background: transparent; border: 0; text-align: left; padding: 6px 8px; border-radius: 6px;
  font: 400 12px var(--font-body); color: var(--ink); cursor: pointer;
}
.ev-menu-item:hover, .ev-view-item:hover { background: var(--bg-2); }
.ev-menu-item[aria-checked="true"] { color: var(--accent-text); background: var(--accent-soft); }
.ev-filter-field { display: grid; gap: 3px; font: 400 12px var(--font-body); color: var(--ink-2); }
.ev-filter-field input { width: 100%; }
.ev-menu-actions { display: flex; justify-content: flex-end; }
.ev-view-item { display: flex; align-items: center; gap: 6px; font: 400 12px var(--font-body); color: var(--ink); padding: 4px; border-radius: 6px; cursor: pointer; }

.ev-export-group { display: inline-flex; align-items: center; gap: 4px; }

/* -- Kind / status chip rows (Events tab kind chips, CRM tab status chips). "Selected chip
   springs" is a one-shot pop() call from the client on the row that changes, not a CSS rule. -- */
.ev-kind-heading { display: flex; align-items: center; gap: 4px; margin-bottom: 8px; }
.ev-kind-label { font: 600 11px var(--font-body); letter-spacing: 0.04em; text-transform: uppercase; color: var(--ink-3); }
.ev-kind-row { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
button.chip.ev-kind-chip { cursor: pointer; border: 1px solid var(--border); }
.ev-kind-chip .ev-kind-all { font: 600 12px var(--font-body); }
.ev-kind-chip .ev-kind-count {
  margin-left: 2px; padding: 0 5px; border-radius: var(--radius-pill);
  background: var(--bg-2); color: var(--ink-2); font: 600 10px var(--font-mono);
}
.ev-kind-chip.is-active { color: var(--accent-text); background: var(--accent-soft); border-color: transparent; }
.ev-kind-chip.is-active .ev-kind-count { background: var(--surface); color: var(--accent-text); }

/* -- Column order is fixed (Created at, Name, Profile, Country, OS, Client, Detail): position
   selectors, the same convention css-notifications.ts uses, since dataTable() does not emit a
   per-cell data attribute to hang a class on. -- */
.ev-table-shell[data-hide-cols~='country'] table th:nth-child(4), .ev-table-shell[data-hide-cols~='country'] table td:nth-child(4) { display: none; }
.ev-table-shell[data-hide-cols~='os'] table th:nth-child(5), .ev-table-shell[data-hide-cols~='os'] table td:nth-child(5) { display: none; }
.ev-table-shell[data-hide-cols~='client'] table th:nth-child(6), .ev-table-shell[data-hide-cols~='client'] table td:nth-child(6) { display: none; }
.ev-table-shell[data-hide-cols~='detail'] table th:nth-child(7), .ev-table-shell[data-hide-cols~='detail'] table td:nth-child(7) { display: none; }

/* -- Profile cell: avatar + hostname/email stack. -- */
.ev-profile-cell { display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
.ev-profile-text { display: grid; gap: 1px; min-width: 0; }
.ev-profile-name { font-weight: 550; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ev-profile-email { font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* -- Row hover 120ms, row press scale(.995) (plan 3.5b). The press itself is a WAAPI call from
   operator/client/pages/events.ts (motion/mini, matching operator/client/motion.ts's press() at a
   more subtle scale for a full-width row); this only owns the hover transition and the cursor. -- */
#ev-table tbody tr { cursor: pointer; }
#ev-table tbody tr td { transition: background 120ms var(--ease-color); }
@media (prefers-reduced-motion: reduce) { #ev-table tbody tr td { transition: none; } }

.ev-skeleton { padding-top: 4px; }
.ev-load-older { margin-top: 10px; }

/* -- Drawer links footer (seat / license, plan 6.4: "seat link; license link"). -- */
.ev-drawer-links { display: grid; gap: 8px; width: 100%; }
.ev-drawer-link-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ev-drawer-link-row .lbl { font: 600 10px var(--font-body); letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-3); min-width: 46px; }
.ev-device-id { font-family: var(--mono); font-size: 12px; color: var(--ink); }

/* -- Ask trace stagger reveal (plan 3.5b: "the ask trace inside reveals field by field, stagger
   30ms"), driven by operator/client/motion.ts's sequence() adding .show one field at a time. -- */
.ev-trace-title { margin: 4px 0 6px; font: 600 11px var(--font-body); letter-spacing: 0.04em; text-transform: uppercase; color: var(--ink-3); grid-column: 1 / -1; }
.ev-trace-field { opacity: 0; transform: translateY(4px); transition: opacity 200ms var(--ease-color), transform 200ms var(--ease-spring); }
.ev-trace-field.show { opacity: 1; transform: translateY(0); }
@media (prefers-reduced-motion: reduce) { .ev-trace-field { transition: none; } }

/* -- Drawer backdrop (plan 3.5b Shell row: "Drawers: ... backdrop fade" -- Events' own drawer is
   "as shell"). detailDrawer()'s .seat-overlay ships no backdrop of its own; this page adds one. -- */
.ev-drawer-backdrop {
  position: fixed; inset: 0; z-index: 2; background: color-mix(in srgb, black 32%, transparent);
  opacity: 0; pointer-events: none; transition: opacity 200ms var(--ease-color);
}
.ev-drawer-backdrop[hidden] { display: block; opacity: 0; pointer-events: none; }
.ev-drawer-backdrop.show { opacity: 1; pointer-events: auto; }
@media (prefers-reduced-motion: reduce) { .ev-drawer-backdrop { transition: none; } }

.ev-crm-error { font-size: 11px; }
.ev-crm-action-cell { display: inline-flex; align-items: center; }
`
