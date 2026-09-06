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
/* -- toolbar / card head -- */
.connectors-card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
.connectors-history-toggle { font-size: 12px; }
.connectors-inline-error { color: var(--danger); font-size: 12px; font-weight: 600; padding: 10px 0 4px; }
.connectors-skeleton { display: flex; flex-direction: column; gap: 4px; padding: 4px 0; }

/* -- catalog: category sections + tile grid (plan 6.10 block 2, tile minmax(168px,1fr)) -- */
.connectors-catalog { display: flex; flex-direction: column; gap: 20px; }
.connectors-category:last-child { margin-bottom: 0; }
.catalog-tile-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(168px, 1fr)); gap: 10px; }

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

.connector-scope-chips { display: flex; flex-wrap: wrap; gap: 4px; max-width: 220px; }

.connector-status-cell { display: flex; align-items: center; gap: 6px; }
.connector-last-test { color: var(--ink-3); font-size: 11.5px; cursor: help; }

.connector-tools-cell { display: flex; flex-direction: column; gap: 4px; align-items: flex-start; }
.connector-tools-toggle { font-size: 12px; }
.connector-tools-list, .connector-test-tools { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.connector-tools-list li, .connector-test-tools li {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  font-size: 12px; font-family: var(--font-mono); padding: 2px 0;
}
.connector-tool-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.connector-used-cell { display: flex; flex-direction: column; gap: 2px; }
.connector-used-last { color: var(--ink-3); font-size: 11px; }

.connector-row-actions { gap: 6px; }

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
`
