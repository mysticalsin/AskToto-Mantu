/**
 * Audit page CSS (plan 6.11b, P1.11 brief). Everything the shared classes in operator/src/spa/css.ts
 * and css-pages-shared.ts do not already cover: this page's own action-group tints (8 groups, no
 * ingest-taxonomy `kind-*` colour fits them), the Range/Filters/View/Export dropdown menus (one
 * small pattern, the same shape css-events.ts already established for its own Range/Filters/View so
 * there is one open/close/scale-in rule per page rather than a shared one two pages would have to
 * agree to touch together), the actor/route/request-id cell layouts, the request id copy-to-check
 * crossfade (plan 3.5b: "Request id copy: check mark crossfade"), the summary strip's "in range"
 * hover source (reuses metricTiles() chrome, no new rule needed there), and the drawer's link rows.
 *
 * Tokens only, no hex (plan lock). Concatenated in operator/src/spa/manifest.ts after SHELL_CSS,
 * PAGES_SHARED_CSS and every other page's own CSS, in NAV_IDS order.
 */
export const AUDIT_CSS = `
/* .card sets overflow: hidden; the dropdown menus below need to spill past that edge. */
.au-toolbar-card { overflow: visible; padding-bottom: 10px; }

/* -- Action group tints (8 groups, none of which is the ingest-event taxonomy kindBadge() tints):
   reuses the shared .kind-badge / .kind-icon shape, adds this page's own colour classes, the same
   technique css-notifications.ts uses for its own two non-ingest kinds. Chosen from the existing
   status/data tokens, no new hex. -- */
.kind-audit-licenses { color: var(--data-1); }
.kind-audit-seats { color: var(--ink-3); }
.kind-audit-keys { color: var(--info); }
.kind-audit-connectors { color: var(--ok); }
.kind-audit-skills { color: var(--accent-text); }
.kind-audit-reveals { color: var(--warn); }
.kind-audit-exports { color: var(--ink-2); }
.kind-audit-platform { color: var(--danger); }

.au-mono { font-family: var(--mono); }

/* -- One dropdown pattern for Range, Filters, View and the header's Export action (plan 3.5b:
   "filters menu scale + opacity"; "Export menu opens with scale"). [hidden] stays in the layout so
   opacity/transform can transition; operator/client/pages/audit.ts keeps aria-hidden/aria-expanded
   in sync so a closed panel is out of the tab order too, not only visually faded. -- */
.au-menu-wrap, .au-view-wrap { position: relative; display: inline-flex; }
.au-menu-panel {
  position: absolute; left: 0; top: calc(100% + 6px); z-index: 20;
  min-width: 220px; padding: 10px; display: flex; flex-direction: column; gap: 8px;
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-control);
  box-shadow: var(--shadow);
  opacity: 1; transform-origin: top left; transform: scale(1);
  transition: opacity 150ms var(--ease-color), transform 150ms var(--ease-spring);
}
.au-menu-panel[hidden] { display: flex; opacity: 0; transform: scale(0.98); pointer-events: none; }
.au-view-wrap .au-menu-panel, .au-export-wrap .au-menu-panel { right: 0; left: auto; transform-origin: top right; }
.au-menu-title {
  margin: 0; font: 600 10px var(--font-body); letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-3);
}
.au-menu-item {
  background: transparent; border: 0; text-align: left; padding: 6px 8px; border-radius: 6px;
  font: 400 12px var(--font-body); color: var(--ink); cursor: pointer; text-decoration: none; display: block;
}
.au-menu-item:hover, .au-view-item:hover { background: var(--bg-2); }
.au-menu-item[aria-checked="true"] { color: var(--accent-text); background: var(--accent-soft); }
.au-export-link { font-weight: 600; }
.au-filter-field { display: grid; gap: 3px; font: 400 12px var(--font-body); color: var(--ink-2); }
.au-filter-field input, .au-filter-field select { width: 100%; }
.au-menu-actions { display: flex; justify-content: flex-end; }
.au-view-item { display: flex; align-items: center; gap: 6px; font: 400 12px var(--font-body); color: var(--ink); padding: 4px; border-radius: 6px; cursor: pointer; }
.au-custom-range { display: grid; gap: 8px; padding-top: 4px; border-top: 1px solid var(--border); margin-top: 2px; }
.au-custom-range[hidden] { display: none; }

/* -- Column order is fixed (When, Actor, Action, Target, Route, Request id, Detail): position
   selectors, the same convention css-events.ts / css-notifications.ts use, since dataTable() does
   not emit a per-cell data attribute to hang a class on. -- */
.au-table-shell[data-hide-cols~='target'] table th:nth-child(4), .au-table-shell[data-hide-cols~='target'] table td:nth-child(4) { display: none; }
.au-table-shell[data-hide-cols~='route'] table th:nth-child(5), .au-table-shell[data-hide-cols~='route'] table td:nth-child(5) { display: none; }
.au-table-shell[data-hide-cols~='requestId'] table th:nth-child(6), .au-table-shell[data-hide-cols~='requestId'] table td:nth-child(6) { display: none; }
.au-table-shell[data-hide-cols~='detail'] table th:nth-child(7), .au-table-shell[data-hide-cols~='detail'] table td:nth-child(7) { display: none; }

/* -- Actor cell: avatar + text, or a plain system glyph for cron rows (plan: "avatar or 'system'
   for cron and seats"). -- */
.au-actor-cell { display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
.au-actor-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.au-actor-system { display: inline-flex; align-items: center; gap: 6px; color: var(--ink-3); font-size: 12px; }

/* -- Route: small mono, muted (a chrome detail, not the row's headline). -- */
.au-route { font-size: 11px; color: var(--ink-2); }

/* -- Request id: mono, copy on click (plan). Text and the confirmation both occupy the same box
   (absolute check over relative text) so the crossfade never reflows the row; plan 3.5b: "check
   mark crossfade". -- */
.au-reqid {
  position: relative; display: inline-flex; align-items: center; min-height: 20px;
  background: transparent; border: 1px dashed var(--border-2); border-radius: 6px;
  padding: 2px 8px; font-size: 12px; color: var(--ink); cursor: pointer;
}
.au-reqid-text, .au-reqid-check {
  transition: opacity 200ms var(--ease-color);
}
.au-reqid-check {
  position: absolute; inset: 0; display: inline-flex; align-items: center; gap: 4px;
  padding: 2px 8px; border-radius: 6px; background: var(--surface); color: var(--ok);
  opacity: 0; pointer-events: none; font: 600 12px var(--font-body);
}
.au-reqid-check svg { width: 12px; height: 12px; }
.au-reqid.is-copied .au-reqid-text { opacity: 0; }
.au-reqid.is-copied .au-reqid-check { opacity: 1; }
@media (prefers-reduced-motion: reduce) { .au-reqid-text, .au-reqid-check { transition: none; } }

#audit-table tbody tr { cursor: pointer; }
#audit-table tbody tr td { transition: background 120ms var(--ease-color); }
@media (prefers-reduced-motion: reduce) { #audit-table tbody tr td { transition: none; } }

.au-skeleton { padding-top: 4px; }
.au-load-older { margin-top: 10px; }
.au-retention-note { margin: 4px 0 0; }

/* -- Drawer links footer (seat / license / connector, plan: "links to the seat, the license, the
   connector"). Same shape css-events.ts's .ev-drawer-link-row establishes. -- */
.au-drawer-links { display: grid; gap: 8px; width: 100%; }
.au-drawer-link-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.au-drawer-link-row .lbl { font: 600 10px var(--font-body); letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-3); min-width: 56px; }

/* -- Drawer backdrop (plan 3.5b Shell row: "Drawers: ... backdrop fade" -- Audit's own drawer is
   "as shell"). detailDrawer()'s .seat-overlay ships no backdrop of its own; this page adds one,
   the same rule css-events.ts's .ev-drawer-backdrop carries. -- */
.au-drawer-backdrop {
  position: fixed; inset: 0; z-index: 2; background: color-mix(in srgb, black 32%, transparent);
  opacity: 0; pointer-events: none; transition: opacity 200ms var(--ease-color);
}
.au-drawer-backdrop[hidden] { display: block; opacity: 0; pointer-events: none; }
.au-drawer-backdrop.show { opacity: 1; pointer-events: auto; }
@media (prefers-reduced-motion: reduce) { .au-drawer-backdrop { transition: none; } }
`
