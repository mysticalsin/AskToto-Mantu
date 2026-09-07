/**
 * Settings page CSS (plan 6.11, task P1.10). Tokens only (plan 3.2 names), no hex literal, no
 * inline `style=`. Concatenated in operator/src/spa/manifest.ts, in NAV_IDS order, after
 * SHELL_CSS and PAGES_SHARED_CSS; every class below is unique to this page (`.settings-*`)
 * except the reused shared utilities (`.card`, `.chip`, `.muted`, `.row`, `.grid-2`, `.tool`,
 * `.btn`, `.theme-seg`/`.theme-btn`, the `segmented()`/`dataTable()`/`topListCard()` primitive
 * classes) and `.mono` (already introduced by operator/src/spa/css-groups.ts).
 */
export const SETTINGS_CSS = `
.settings-content { max-width: 800px; }

/* -- design-gate fix: the shared .eyebrow primitive (operator/src/spa/css.ts, a file this page
   does not own) sets uppercase text-transform plus 0.12em letter-spacing, which contradicts plan
   3.3 ("Labels and buttons 12 px, weight 600, no uppercase, no wide tracking") and is the
   "eyebrow label" pattern the design gate bans -- every section label on this page (Value, Push
   history, Providers, Models, Needs attention, By mode, Platform, Theme, Density, Reduced
   motion, Question types) uses that class. Scoped here rather than edited in css.ts itself: the
   ideal fix removes those two properties from the shared rule directly (every other page using
   .eyebrow inherits the same violation), filed as a patch for that file's owner. -- */
.settings-content .eyebrow { text-transform: none; letter-spacing: normal; font-size: 12px; }

/* -- tabs: sliding underline (plan 3.5b "Tabs: sliding underline (spring)"). The underline's
   position/width are set by operator/client/pages/settings.ts from real layout measurements
   (a tab's rendered pixel offset cannot be known at render time), never an inline style= on the
   tab buttons themselves. -- */
.settings-tabs-wrap { position: relative; margin: 4px 0 20px; }
.settings-tabs { display: flex; gap: 20px; flex-wrap: wrap; border-bottom: 1px solid var(--border); }
.settings-tab {
  background: none; border: none; padding: 8px 2px 12px; cursor: pointer;
  font: 600 13px var(--font-body); color: var(--ink-2); transition: color 150ms var(--ease-color);
}
.settings-tab.on { color: var(--ink); }
.settings-tab:hover { color: var(--ink); }
.settings-tab-underline {
  position: absolute; bottom: -1px; left: 0; height: 2px; width: 0;
  background: var(--accent); border-radius: var(--radius-pill);
  transform: translateX(0); transition: transform 250ms var(--ease-spring), width 250ms var(--ease-spring);
}

/* display:grid only when NOT [hidden]: an author rule that just said "display: grid" would
   override the user-agent's [hidden]{display:none} outright (author origin always beats
   user-agent origin for the same property, regardless of selector specificity), which would
   render every tab's panel at once instead of only the active one. */
.settings-panel[hidden] { display: none; }
.settings-panel:not([hidden]) { display: grid; gap: 16px; }
.settings-tab-intro { margin: 0 0 16px; color: var(--ink-2); font-size: 13px; max-width: 640px; }
.settings-tab-toolbar { display: flex; align-items: center; gap: 10px; margin-bottom: 4px; }

.settings-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 10px; flex-wrap: wrap; }
.settings-card-head h3 { margin: 0; }

/* -- Tiers -- */
.settings-tiers-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
@media (max-width: 720px) { .settings-tiers-grid { grid-template-columns: 1fr; } }
.settings-tier-seats { font-size: 12px; }

/* -- checkboxes (plan 3.5b "toggles and checkboxes spring"): the spring is the box's own
   scale+opacity transition on the check mark, native input kept for a11y/keyboard but visually
   hidden (never display:none, which would drop it from the tab order). -- */
.settings-checkbox-list { display: flex; flex-direction: column; gap: 2px; }
.settings-checkbox { display: flex; align-items: flex-start; gap: 10px; padding: 7px 0; cursor: pointer; }
.settings-checkbox input {
  position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden;
  clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
}
.settings-checkbox-box {
  flex-shrink: 0; width: 18px; height: 18px; margin-top: 1px; border-radius: 5px;
  border: 1px solid var(--border-2); background: var(--surface);
  display: flex; align-items: center; justify-content: center;
  transition: background 150ms var(--ease-color), border-color 150ms var(--ease-color);
}
.settings-checkbox-box svg {
  width: 12px; height: 12px; color: var(--accent-ink); opacity: 0; transform: scale(0.5);
  transition: transform 180ms var(--ease-spring), opacity 150ms var(--ease-color);
}
.settings-checkbox input:checked + .settings-checkbox-box { background: var(--accent-fill); border-color: var(--accent-fill); }
.settings-checkbox input:checked + .settings-checkbox-box svg { opacity: 1; transform: scale(1); }
.settings-checkbox input:focus-visible + .settings-checkbox-box { box-shadow: var(--shadow-ring); }
.settings-checkbox-text strong { display: block; font-size: 13px; font-weight: 600; color: var(--ink); }
.settings-checkbox-text .muted { font-size: 12px; }

/* -- save buttons (plan 3.5b "Save button: press spring, then a check mark crossfade for
   1.2 s"): press() (operator/client/motion.ts) supplies the press; this supplies the crossfade,
   toggled by adding/removing .is-saved on the button. -- */
.settings-save { position: relative; display: inline-flex; align-items: center; gap: 6px; margin-top: 4px; }
.settings-save-label, .settings-save-check { transition: opacity 150ms var(--ease-color); }
.settings-save-check { display: none; align-items: center; width: 14px; height: 14px; opacity: 0; }
.settings-save-check svg { width: 14px; height: 14px; }
.settings-save.is-saved .settings-save-label { opacity: 0; }
.settings-save.is-saved .settings-save-check { display: inline-flex; opacity: 1; }
.settings-inline-msg { min-height: 16px; font-size: 12px; }
.settings-inline-msg.fail-loud { font-size: 12px; padding: 0; }

/* -- Value -- */
.settings-value-form { display: grid; gap: 12px; max-width: 420px; }
.settings-value-preview, .settings-value-preview-empty { margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--border); }
.settings-value-preview .n {
  font-family: var(--font-display); font-size: 28px; font-weight: 600; letter-spacing: -0.02em;
  font-feature-settings: "tnum"; margin-top: 4px; color: var(--ink);
}

/* -- Skills: proposals board -- */
.settings-skills-board { display: grid; gap: 16px; }
.settings-proposal-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 6px; }
.settings-evidence-chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; min-height: 22px; }
.settings-proposal-actions { margin-top: 10px; }

/* -- diff view: added/removed line tints, no raw textarea by default (Edit toggles it). -- */
.settings-diff-view {
  margin: 6px 0; font-family: var(--font-mono); font-size: 12px; line-height: 1.5;
  border: 1px solid var(--border); border-radius: var(--radius-control); overflow: auto; max-height: 320px;
}
.diff-line { padding: 1px 10px; white-space: pre-wrap; word-break: break-word; }
.diff-add { background: color-mix(in srgb, var(--ok) 14%, transparent); }
.diff-del { background: color-mix(in srgb, var(--danger) 14%, transparent); }
.diff-ctx { color: var(--ink-2); }
.settings-diff-edit { display: block; width: 100%; margin: 6px 0; min-height: 160px; }

.settings-history-skeleton { display: flex; flex-direction: column; gap: 8px; }

/* -- Questions: stats, donuts, needs-attention -- */
.settings-stats-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
@media (max-width: 640px) { .settings-stats-grid { grid-template-columns: 1fr; } }
.settings-stat { display: flex; flex-direction: column; gap: 4px; }
.settings-stat-label { font-size: 12px; }
.settings-stat-value {
  font-family: var(--font-display); font-size: 20px; font-weight: 600; letter-spacing: -0.01em;
  font-feature-settings: "tnum"; color: var(--ink);
}

.settings-donuts-row { display: flex; gap: 28px; flex-wrap: wrap; margin-bottom: 16px; padding-bottom: 16px; border-bottom: 1px solid var(--border); }
.settings-donut-card { display: flex; flex-direction: column; align-items: center; gap: 8px; min-width: 110px; }
.settings-donut-wrap { position: relative; display: inline-flex; align-items: center; justify-content: center; }
.settings-donut-track { stroke: var(--data-track); }
.settings-donut-arc { stroke: var(--accent); }
.settings-donut-value {
  position: absolute; font-family: var(--font-display); font-size: 14px; font-weight: 600;
  font-feature-settings: "tnum"; color: var(--ink);
}
.settings-donut-empty { width: 64px; height: 64px; display: flex; align-items: center; justify-content: center; font-size: 11px; text-align: center; }

.settings-reveal-line { margin-top: 10px; padding: 0; font-size: 12px; color: var(--ink-2); border-radius: var(--radius-control); }
.settings-reveal-line:not(:empty) { padding: 8px 10px; background: var(--surface-2); border: 1px solid var(--border); color: var(--ink); }

/* -- Platform health -- */
.settings-bindings-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 20px; }
@media (max-width: 480px) { .settings-bindings-grid { grid-template-columns: 1fr; } }
.settings-ping { display: inline-flex; }

/* -- Access -- */
.settings-access-email { font-size: 14px; color: var(--ink); }

/* -- Data: never-stored list, export links -- */
.settings-never-list { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: var(--ink-2); }
.settings-export-grid { display: flex; flex-direction: column; gap: 4px; }
.settings-export-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 7px 0; border-bottom: 1px solid var(--border); }
.settings-export-row:last-child { border-bottom: none; }

/* -- Tiers: the consequence line restated before saving (plan: "restating the consequence before
   saving"), tinted like an inline warning without pulling in a whole banner primitive. -- */
.settings-inline-msg[data-tier-consequence]:not(:empty) { color: var(--warn); font-weight: 600; }

/* -- Density (plan 6.11 Appearance: "applied immediately to the live document"). [data-density] on
   <html> is portal-wide, real infrastructure (operator/client/pages/settings.ts sets it, the same
   way theme.ts already owns [data-theme]); a portal-wide compact mode for every other page's rows
   needs a matching rule in operator/src/spa/css.ts and operator/src/render/data-table.ts, neither
   owned by this page (filed in the report) -- this page's own cards react to it right now, so the
   control has a real, visible, immediate effect the moment it is toggled. -- */
:root[data-density="compact"] .settings-content .card { padding-top: 14px; padding-bottom: 14px; }
:root[data-density="compact"] .settings-checkbox { padding: 4px 0; }
:root[data-density="compact"] .settings-stats-grid { gap: 10px; }
:root[data-density="compact"] .settings-content { display: grid; gap: 10px; }

@media (prefers-reduced-motion: reduce) {
  .settings-tab-underline { transition: none; }
  .settings-checkbox-box, .settings-checkbox-box svg { transition: none; }
  .settings-save-label, .settings-save-check { transition: none; }
}
`
