/**
 * Connectors page CSS (plan 6.10, D9, motion minimums plan 3.5b "Connectors" row). Tokens only
 * (plan 3.2 names), no hex literal, no inline `style=`. Concatenated in operator/src/spa/
 * manifest.ts, in NAV_IDS order, after SHELL_CSS and PAGES_SHARED_CSS; every class below is
 * unique to this page (`.connector-*`, `.connectors-*`) except `.mono`, which
 * operator/src/spa/css-groups.ts already introduced as a small shared utility this page reuses
 * rather than re-declaring, and `.is-crossfading`, whose marker name operator/src/spa/css-keys.ts
 * already established for "reveal toggle crossfades the dots to text" -- the transition it drives
 * here is this page's own (`.connector-credential-wrap input`), since css-keys.ts's rule is scoped
 * to its own `.keys-secret-input` class.
 */
export const CONNECTORS_CSS = `
/* The page section itself is a CSS Grid single-track column (operator/src/spa/css.ts's shared
   .wrap rule: "display: grid; gap: 12px", no explicit grid-template-columns, hence one implicit
   auto column). A grid item's default min-width is 'auto', which resolves to its content's
   min-content size, not 0 -- for most pages' cards that never matters since nothing inside is
   wider than a phone screen, but the Connected table's 10 columns of real data (a name plus
   last4, two scope chips, a status line, a tools note, two action buttons) genuinely need more
   than 390px unwrapped, and dataTable()'s own .table-wrap { overflow-x: auto } (operator/src/spa/
   css.ts) can only ever kick in and scroll THAT ONE ELEMENT if its containing chain is actually
   allowed to shrink below that min-content width first. Without this, the grid item -- and with
   it the whole page section, and the document -- stays exactly as wide as the table needs,
   producing real horizontal page scroll at 390px (plan 3.7b law 10 / the artifact-equivalent rule
   "the page body must never scroll horizontally": only a data table's own container may). Scoped
   to this page's own direct children only, never the shared .wrap rule every other page also uses. */
[data-page="connectors"] > * { min-width: 0; }

/* -- toolbar / card head -- */
.connectors-card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }

/* Connected table: a page-scoped tightening of the shared .dt-card row rhythm (never touching
   css.ts's own table.dt-card rule, which Groups/Licenses/Audit also use) -- law 10 ("under two
   viewport heights at 1440"): five rows of real, multi-line data (a name plus last4, two scope
   chips, a status line, a tools note, a used line) is naturally taller than a single-line table,
   so this keeps every row's own padding and inter-row spacing as tight as still-readable. */
.connectors-connected-card table.dt-card { border-spacing: 0 6px; }
.connectors-connected-card table.dt-card td { padding: 8px 12px; }
.connectors-history-toggle { font-size: 12px; }
.connectors-inline-error { color: var(--danger); font-size: 12px; font-weight: 600; padding: 10px 0 4px; }
.connectors-skeleton { display: flex; flex-direction: column; gap: 4px; padding: 4px 0; }

/* -- catalog: ONE flat tile grid, no per-category section wrapper (plan 6.10c: the literal fix for
   the screenshot bug -- category is a data attribute + filter state now, never a DOM section). -- */
.catalog-tile-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
/* plan 6.10c: "verify at exactly 1440 that this is 7/row x 4 rows; if card padding ... drift this
   below 7/row, that's a QA finding, not a silent acceptance." The shared .card rule's own 12px
   horizontal padding (operator/src/spa/css.ts, used by every card sitewide) left this card's grid
   4px short of the 7*150 + 6*8 = 1098px seven columns need at 1440 with the 288px rail -- trimmed
   here, scoped to just this card, rather than touching the shared rule every other card also uses. */
[data-connectors-catalog-card] { padding-left: 6px; padding-right: 6px; }
.connectors-catalog-sticky-row { position: sticky; top: 0; z-index: 2; background: var(--surface); padding: 4px 0 10px; margin-bottom: 2px; }
.connectors-catalog-filters .segmented { flex-wrap: wrap; }
@media (max-width: 640px) {
  .connectors-catalog-filters .segmented { flex-wrap: nowrap; overflow-x: auto; max-width: 100%; -webkit-overflow-scrolling: touch; }
}

/* plan 3.5b: "hover lifts ... and the logo scales 1.04" -- catalogTile()'s own hover lift/shadow
   already lives in operator/src/spa/css.ts; only the logo scale is this page's own addition. */
.catalog-tile .logo-glyph { transition: transform 150ms var(--ease-spring); }
.catalog-tile:hover .logo-glyph { transform: scale(1.04); }
@media (prefers-reduced-motion: reduce) { .catalog-tile:hover .logo-glyph { transform: none; } }

/* -- Connected table cells -- */
.connector-name-cell { display: flex; align-items: center; gap: 8px; min-width: 0; }
.connector-name-cell > div { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.connector-name-cell strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.connector-last4 { color: var(--ink-3); font-size: 11px; }

.connector-scope-chips { display: flex; flex-wrap: wrap; gap: 4px; max-width: 300px; }
/* A chip wraps to the next line as a whole rather than breaking its own text mid-word (the base
   .chip rule sets no white-space, so a long group id's hyphens are otherwise valid soft-wrap
   points -- see this page's Scope column, plan 6.10c). */
.connector-scope-chips .chip { white-space: nowrap; flex-shrink: 0; }

.connector-status-cell { display: flex; align-items: center; gap: 6px; }
.connector-last-test { color: var(--ink-3); font-size: 11.5px; cursor: help; }

.connector-tools-cell { display: flex; flex-direction: column; gap: 4px; align-items: flex-start; }
.connector-tools-toggle { font-size: 12px; }
.connector-tools-list, .connector-test-tools { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
/* .connector-tools-list sets its own display above, which otherwise beats the UA [hidden]
   default (same pattern as .search-results[hidden] in css-shell.ts / .page[hidden] in css.ts).
   Without this, toggleTools()'s hidden toggle collapsed nothing: every connector's tool list
   rendered permanently expanded regardless of the toggle button's own aria-expanded state --
   invisible while every REST row still read "Not applicable" (finding 7), but a real law-10 page-
   height problem the moment a REST row's real tool set (HubSpot, ClickUp, ...) started rendering
   here too. */
.connector-tools-list[hidden] { display: none !important; }
.connector-tools-list li, .connector-test-tools li {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  font-size: 12px; font-family: var(--font-mono); padding: 2px 0;
}
.connector-tool-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* Row layout, never column: "3 calls · 5d" reads as one fact on one line (plan 6.10c's densest
   table cell). This used to be flex-direction: column with no white-space rule at all, which -
   the moment the table's auto layout gave this, the last real column, anything less than its
   full content width - let "3 calls" itself word-wrap ("3" / "calls") on top of the already-
   stacked count/last-used lines, four lines total per row. white-space: nowrap is what actually
   fixes it: it tells the table's own auto-layout algorithm this cell's min-content width is its
   full unwrapped width, so the column (and, via .table-wrap { overflow-x: auto }, the table)
   widens instead of wrapping - the same overflow-x mechanism this page's own min-width: 0 rule
   above already exists to allow. */
.connector-used-cell { display: inline-flex; align-items: baseline; gap: 4px; white-space: nowrap; vertical-align: middle; }
.connector-used-sep { color: var(--ink-3); }
.connector-used-last { color: var(--ink-3); font-size: 11px; }

/* Same nowrap fix, same root cause, for the Kind column: "Custom MCP server" is the only kind
   label long enough to wrap while every other row's kind name fits on one line, so it alone grew
   taller than its neighbours and broke the table's hairline-row rhythm. */
.connector-kind-cell { white-space: nowrap; }

.connector-row-actions { gap: 6px; flex-wrap: nowrap; }

/* plan 3.5b: "Failing connectors: a soft red pulse on the status dot only." Same halo mechanic as
   operator/client/motion.ts's beacon() and operator/src/spa/css-licenses.ts's amber
   metis-licenses-expiring-pulse, keyed to --danger instead: "failing" and "online now" are
   different signals, so the shared green helper (hard-coded to --live) is never reused for this.
   Keyed off the row's own data-connector-health attribute (never a class collision with
   dataTable()'s single rowClass, which this page already spends on ".connector-row") so a
   client-side refresh that flips health back to healthy stops the pulse the instant the row is
   redrawn. Collapses under operator/src/spa/css.ts's global prefers-reduced-motion override. */
[data-connector-health="failing"] .status-dot-failed i { animation: metis-connectors-failing-pulse 2.4s var(--ease-color) infinite; }
@keyframes metis-connectors-failing-pulse {
  0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--danger) 55%, transparent); }
  100% { box-shadow: 0 0 0 10px color-mix(in srgb, var(--danger) 0%, transparent); }
}

/* -- connection drawer: label / credential / config fields -- */
.connector-credential-wrap { display: flex; gap: 6px; }
.connector-credential-wrap input { flex: 1; transition: opacity 90ms var(--ease-color); }
.connector-credential-wrap input.is-crossfading { opacity: 0; }
.connector-field-help { margin: 4px 0 0; font-size: 11.5px; }
/* plan 6.10b/6.10c: the credential field's real, clickable "Open <vendor> docs" link (not just
   the static help breadcrumb text above it). */
.connector-field-link { display: inline-block; margin: 4px 0 0; font-size: 11.5px; font-weight: 600; color: var(--accent-text); text-decoration: none; }
.connector-field-link:hover { text-decoration: underline; }

/* -- scope: tier checkboxes + group multiselect -- */
.connector-scope-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.connector-scope-label { display: block; font: 600 11px var(--font-body); color: var(--ink-2); margin-bottom: 4px; }
.connector-scope-list { display: flex; flex-direction: column; gap: 4px; max-height: 140px; overflow-y: auto; }
.connector-scope-check { display: flex; align-items: center; gap: 6px; font-size: 12.5px; font-weight: 400; }
.connector-scope-check input { padding: 0; }
.connector-scope-empty { margin: 0; }
.connector-scope-hint { grid-column: 1 / -1; margin: 0; font-size: 11.5px; }

/* -- mode: brokered (default) / direct, with the direct-mode warning sentence -- */
.connector-mode-grid { display: flex; flex-direction: column; gap: 8px; }
.connector-mode-option {
  display: flex; flex-direction: column; gap: 2px; padding: 8px 10px;
  border: 1px solid var(--border); border-radius: var(--radius-control); font-weight: 600; font-size: 13px;
}
.connector-mode-option .row { align-items: center; gap: 6px; }
.connector-mode-option input { padding: 0; }
.connector-mode-desc { font-weight: 400; font-size: 11.5px; margin-left: 20px; }

/* -- Test connection / Save footer -- */
.connector-drawer-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.connector-test-result { margin-top: 10px; }
.connector-result-card {
  background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-control); padding: 10px 12px;
}
.connector-result-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.connector-result-latency { color: var(--ink-3); font-size: 11px; }
.connector-result-summary { margin: 0 0 6px; font-size: 12.5px; }
.connector-test-error { margin: 0 0 6px; color: var(--danger); font-size: 12.5px; font-weight: 600; }

@media (max-width: 640px) {
  .connector-scope-grid { grid-template-columns: 1fr; }
}

/* -- Danger banner (plan 6.10c block 2): one line, ~32px at 1440; the shared alertBadge()
   label is nowrap by design (operator/src/spa/css.ts, right for a short status pill elsewhere),
   but this page's real sentence ("N connectors are failing...") is too long for that at a phone
   width, so it wraps here rather than forcing the banner off the edge of the screen. -- */
.connectors-danger-banner { margin-bottom: 4px; }
.connectors-danger-banner .alert-badge { width: 100%; box-sizing: border-box; }
@media (max-width: 480px) {
  .connectors-danger-banner .alert-badge { flex-wrap: wrap; row-gap: 2px; }
  .connectors-danger-banner .alert-badge-label { white-space: normal; }
}

/* -- Status strip (plan 6.10c block 3): a row of filter-chip stat cells. -- */
.connectors-status-strip { display: flex; flex-wrap: wrap; gap: 4px; padding: 8px; }
.connectors-status-cell {
  flex: 1 1 140px; min-width: 0; display: flex; flex-direction: column; gap: 4px; align-items: flex-start;
  background: transparent; border: 1px solid transparent; border-radius: var(--radius-control);
  padding: 8px 12px; cursor: pointer; text-align: left; transition: background 150ms var(--ease-color);
}
.connectors-status-cell:hover { background: var(--bg-2); }
.connectors-status-cell.on { background: var(--accent-soft); border-color: var(--border-2); }
.connectors-status-cell-danger .connectors-status-value { color: var(--danger); }
.connectors-status-label { display: flex; align-items: center; font: 600 11px var(--font-body); color: var(--ink-2); }
.connectors-status-value { font: 600 18px var(--font-display); color: var(--ink); }
/* A prose value ("Slowest": a connector name and a latency, not a bare KPI numeral) never uses the
   KPI-numeral type the tiles around it use for real numbers -- that type is sized for a digit or
   two, and a sentence at that size wraps to a second line, making this one tile taller than its
   siblings and breaking the strip's shared baseline (plan 3.3 is a type-scale rule, not a
   formatting choice). max-width: 100% + min-width: 0 on the cell above is what lets the ellipsis
   actually engage instead of the tile just growing past its flex-basis to fit the whole sentence;
   the element's title attribute (set by statusCellHtml() when text: true) carries what the ellipsis hides. */
.connectors-status-value-text {
  font: 600 13px var(--font-body); letter-spacing: 0; white-space: nowrap; overflow: hidden;
  text-overflow: ellipsis; max-width: 100%;
}

/* -- Toolbar filter chip slot (plan 6.10c block 4: "the active status-strip filter chip when set,
   removable"). Populated by operator/client/pages/connectors.ts, empty on first paint. -- */
.connectors-filter-chip-slot:empty { display: none; }
.connectors-filter-chip-slot .chip { display: inline-flex; align-items: center; gap: 4px; cursor: default; }
.connectors-filter-chip-slot .chip button {
  background: transparent; border: 0; color: inherit; cursor: pointer; padding: 0; line-height: 1; font-size: 13px;
}

/* -- Bulk select (plan 6.10c block 4): a checkbox column revealed only in Select mode, and a
   footer bar naming every affected connection before a bulk action runs. -- */
.connectors-connected-card table.dt-card th:first-child,
.connectors-connected-card table.dt-card td:first-child { width: 0; padding: 0; overflow: hidden; }
.connectors-connected-card[data-select-mode] table.dt-card th:first-child,
.connectors-connected-card[data-select-mode] table.dt-card td:first-child { width: auto; padding: 10px 4px 10px 12px; overflow: visible; }
.connector-select-check { margin: 0; }
.connectors-bulk-bar {
  display: flex; flex-direction: column; gap: 8px; background: var(--surface-2); border: 1px solid var(--border-2);
  border-radius: var(--radius-card); padding: 10px 14px; margin: -4px 0 8px;
}
.connectors-bulk-bar[hidden] { display: none !important; }
.connectors-bulk-text { margin: 0; font: 600 13px var(--font-body); }
.connectors-bulk-actions { gap: 8px; }
.connectors-bulk-rescope-panel { border-top: 1px solid var(--border); padding-top: 10px; }
.connectors-bulk-rescope-actions { justify-content: flex-end; }
.connectors-overflow-toggle { margin-top: 8px; }

/* -- Zero state (plan 6.10c block 8): three suggested tiles, never an empty box. -- */
.connectors-zero-lede { margin: 0 0 12px; font-size: 13px; color: var(--ink-2); }
.connectors-zero-suggestions { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; }
.connectors-zero-suggestion { display: flex; flex-direction: column; gap: 6px; }
.connectors-zero-suggestion .catalog-tile { cursor: pointer; }
.connectors-zero-reason { margin: 0; font-size: 11.5px; }

/* -- Drawer tabs for an existing connection (plan 6.10c). -- */
.connector-tab-panel { padding-top: 4px; }
.connector-overview-grid { display: flex; flex-direction: column; gap: 8px; margin-bottom: 10px; }
.connector-overview-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.connector-overview-direct-warn { margin-bottom: 10px; }
.connector-overview-direct-warn .alert-badge { width: 100%; box-sizing: border-box; }
.connector-capability-sentence { margin: 8px 0 0; font-size: 12.5px; color: var(--ink-2); }

.connector-tools-panel-list { list-style: none; margin: 0 0 12px; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.connector-tools-panel-list li {
  display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 8px 0; border-bottom: 1px solid var(--border);
}
.connector-tool-desc { font-size: 11.5px; flex-basis: 100%; }
.connector-tool-switch { display: inline-flex; align-items: center; gap: 4px; margin-left: auto; font-size: 11px; color: var(--ink-3); cursor: help; }
.connector-tools-panel-note { margin: 0 0 10px; font-size: 11.5px; }
.connector-allow-writes { border-top: 1px solid var(--border); padding-top: 10px; margin-top: 4px; }
.connector-allow-writes-toggle { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 13px; }
.connector-allow-writes p.muted { margin: 6px 0 0; font-size: 11.5px; }

.connector-scope-preview { margin: 0 0 10px; font-size: 12.5px; font-weight: 600; color: var(--ink); }

.connector-danger-grid { display: flex; flex-direction: column; gap: 12px; }
.connector-danger-row {
  display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;
  padding: 10px 0; border-bottom: 1px solid var(--border);
}
.connector-danger-row:last-child { border-bottom: 0; }
.connector-danger-row p { margin: 0; font-size: 12.5px; color: var(--ink-2); flex: 1 1 260px; }

.connector-oauth-commands {
  background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-control);
  padding: 10px 12px; margin: 8px 0 0; font-size: 12px; line-height: 1.6; white-space: pre; overflow-x: auto;
}

.connector-activity-spark-wrap { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.connector-activity-spark { width: 168px; height: 28px; flex-shrink: 0; }
.connector-activity-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.connector-activity-list li { display: flex; align-items: center; gap: 8px; font-size: 12px; padding: 4px 0; border-bottom: 1px solid var(--border); }
.connector-activity-seat { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.connector-activity-ms, .connector-activity-age { color: var(--ink-3); font-size: 11px; }
`
