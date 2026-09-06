/**
 * Shell component CSS (plan metis-portal-wow, dev-shell / P0.2): rail, live indicator, the rail
 * search field and its inline results dropdown, toasts, mobile bar, theme segmented control.
 * Concatenated after CONSOLE_CSS (operator/src/spa/css.ts, design-lead) in
 * operator/src/spa/manifest.ts, so any selector defined in both files resolves to the definition
 * here. Every color, shadow and easing below is a token named in plan section 3.2 / 3.5
 * (metis-portal-wow.md): no hex literals, no token invented here.
 *
 * `.shell` keeps the exact `grid-template-columns: 288px 1fr` string operator/src/assets.test.ts
 * greps for (rail is 288px, not the pre-wow 185px).
 *
 * Tony 2026-09-06: no command palette, no shortcut sheet (removed).
 */
export const SHELL_CSS = `
.shell { display: grid; grid-template-columns: 288px 1fr; min-height: 100%; }
.main { min-width: 0; background: var(--bg); }

/* ---- Rail ---------------------------------------------------------------------------- */
.rail {
  display: flex; flex-direction: column; gap: 10px;
  background: var(--surface); border-right: 1px solid var(--border);
  padding: 14px 12px 16px; height: 100vh; position: sticky; top: 0;
  width: 288px;
}
.rail-brand { display: flex; align-items: center; gap: 10px; }
.rail-logo {
  width: 32px; height: 32px; border-radius: 10px; background: var(--accent); color: var(--accent-ink);
  display: grid; place-items: center; font-weight: 600; font-size: 15px; letter-spacing: -0.02em;
  flex: none;
}
.rail-pill {
  display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0;
  font-size: 12px; font-weight: 600; color: var(--ink); cursor: default;
}
.rail-pill span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rail-pill .tool-ic { color: var(--ink-3); width: 14px; height: 14px; }

.live-indicator {
  display: flex; align-items: center; gap: 7px; padding: 7px 10px; border-radius: 10px;
  background: var(--surface-2); font-size: 11.5px; font-weight: 600; color: var(--ink-2);
}
.live-indicator .live-dot {
  width: 7px; height: 7px; border-radius: 999px; background: var(--live); flex: none;
  box-shadow: 0 0 0 0 var(--live); animation: metis-live-pulse 2.4s var(--ease-spring) infinite;
}
.live-indicator[data-state="reconnecting"] .live-dot { background: var(--warn); animation: none; }
.live-indicator[data-state="paused"] .live-dot { background: var(--ink-3); animation: none; }
.live-indicator[data-state="reconnecting"] { color: var(--warn); }
.live-indicator[data-state="paused"] { color: var(--ink-3); }

.rail-action.tool {
  display: flex; align-items: center; justify-content: center; gap: 6px; width: 100%;
  border: 1px solid transparent; background: var(--accent); color: var(--accent-ink);
  border-radius: 10px; padding: 9px 12px; font: 600 12px/1 inherit; cursor: pointer;
  transition: transform 150ms var(--ease-spring), background 150ms var(--ease-color);
}
.rail-action.tool:hover { background: var(--accent-2); }
.rail-action.tool:active { transform: scale(.97); }
/* The class above sets its own display, which otherwise beats the UA [hidden] default (same
   specificity, author stylesheet wins). Only one of the three .rail-action variants (Generate
   license, Add connector, search) is ever visible; operator/client/router.ts flips which. */
.rail-action[hidden] { display: none !important; }
.rail-search-shell { position: relative; }
.rail-search-wrap.search-wrap {
  display: flex; align-items: center; gap: 6px; border: 1px solid var(--border-2);
  background: var(--surface-2); border-radius: 10px; padding: 8px 10px; cursor: text;
}
.rail-search-wrap:focus-within { border-color: var(--accent); box-shadow: var(--shadow-ring); }
.rail-search-wrap .tool-ic { color: var(--ink-3); width: 15px; height: 15px; flex: none; }
.rail-search { flex: 1; min-width: 0; border: 0; background: transparent; color: var(--ink); font: 12px inherit; }
.rail-search::placeholder { color: var(--ink-3); }
.kbd-hint {
  font: 10px/1 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  color: var(--ink-3); border: 1px solid var(--border-2); border-radius: 4px; padding: 2px 5px;
  background: var(--surface);
}

.rail nav { display: flex; flex-direction: column; gap: 16px; flex: 1; min-height: 0; margin-top: 4px; overflow-y: auto; }
.nav-sec { display: flex; flex-direction: column; gap: 1px; }
.nav-sec p {
  font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--ink-3);
  margin: 6px 8px 4px; font-weight: 600;
}
.nav-item {
  display: flex; align-items: center; gap: 10px; padding: 7px 8px; border-radius: 10px;
  color: var(--ink-2); font-size: 13px; font-weight: 500; position: relative;
  transition: background 150ms var(--ease-color), color 150ms var(--ease-color);
}
.nav-item .tool-ic { width: 16px; height: 16px; color: var(--ink-3); flex: none; }
.nav-item:hover { background: var(--bg-2); color: var(--ink); }
.nav-item.on { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.nav-item.on .tool-ic { color: var(--accent); }
.nav-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nav-count {
  display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 18px;
  padding: 0 5px; border-radius: 999px; background: var(--accent); color: var(--accent-ink);
  font-size: 10.5px; font-weight: 700; line-height: 1;
}
.nav-item.on .nav-count { background: var(--accent); color: var(--accent-ink); }

.rail-foot { margin-top: auto; display: flex; flex-direction: column; gap: 8px; padding-top: 14px; border-top: 1px solid var(--border); }
.access-chip {
  align-self: flex-start; font-size: 10.5px; font-weight: 600; letter-spacing: 0.02em;
  color: var(--ok); background: var(--surface-2); border-radius: 999px; padding: 3px 9px;
}
.who {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 10.5px; color: var(--ink-2); word-break: break-all;
}
.theme-seg {
  display: flex; border: 1px solid var(--border-2); border-radius: 999px; padding: 2px; gap: 2px;
  background: var(--surface-2);
}
.theme-btn {
  flex: 1; border: 0; background: transparent; color: var(--ink-2);
  font-size: 11px; font-weight: 600; padding: 5px 0; border-radius: 999px; cursor: pointer;
  transition: background 150ms var(--ease-color), color 150ms var(--ease-color);
}
.theme-btn[aria-pressed="true"] { background: var(--surface); color: var(--ink); box-shadow: var(--shadow); }
.rail-foot form { display: contents; }
.rail-foot form .theme-btn { background: transparent; }
.rail-foot form .theme-btn:hover { background: var(--bg-2); color: var(--danger); }

/* ---- Mobile top bar (<1024px) -------------------------------------------------------- */
.mobile-bar {
  display: none; align-items: center; gap: 10px; padding: 10px 14px;
  background: var(--glass); backdrop-filter: blur(24px) saturate(1.2);
  border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 4;
}
.mobile-bar h2 { margin: 0; flex: 1; font-size: 15px; font-weight: 650; letter-spacing: -0.02em; color: var(--ink); }
.live-dot-mini {
  width: 8px; height: 8px; border-radius: 999px; background: var(--live); flex: none;
  animation: metis-live-pulse 2.4s var(--ease-spring) infinite;
}
.live-dot-mini[data-state="reconnecting"] { background: var(--warn); animation: none; }
.live-dot-mini[data-state="paused"] { background: var(--ink-3); animation: none; }

.rail-toggle {
  display: none; align-items: center; justify-content: center; width: 32px; height: 32px;
  border: 1px solid var(--border); background: var(--surface); color: var(--ink);
  border-radius: 10px; cursor: pointer; flex: none;
}
.rail-backdrop {
  display: none; position: fixed; inset: 0; z-index: 40; background: rgba(23, 8, 38, 0.32);
  backdrop-filter: blur(2px); border: 0; padding: 0; cursor: pointer;
}

@media (max-width: 1023px) {
  .shell { grid-template-columns: 1fr; }
  .mobile-bar { display: flex; }
  .rail {
    position: fixed; top: 0; left: 0; z-index: 46; min-height: 100vh;
    transform: translateX(-100%); transition: transform 220ms var(--ease-spring);
  }
  .rail.open { transform: translateX(0); }
  .rail-toggle { display: inline-flex; }
  .rail-backdrop[data-open="1"] { display: block; }
}

/* ---- Rail search results dropdown ------------------------------------------------------ */
.search-results {
  position: absolute; top: calc(100% + 6px); left: 0; right: 0; z-index: 30;
  max-height: 60vh; overflow-y: auto; padding: 6px; display: flex; flex-direction: column; gap: 10px;
  background: var(--glass); backdrop-filter: blur(24px) saturate(1.2);
  border: 1px solid var(--border); border-radius: 14px; box-shadow: var(--shadow);
}
/* .search-results sets its own display below, which otherwise beats the UA [hidden] default
   (same specificity, author stylesheet wins), same pattern as .page[hidden] in
   operator/src/spa/css.ts. Without this the dropdown shows even while hidden is set. */
.search-results[hidden] { display: none !important; }
.search-group { display: flex; flex-direction: column; gap: 2px; }
.search-group-label {
  font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
  color: var(--ink-3); margin: 4px 6px 2px;
}
.search-row {
  display: flex; align-items: center; gap: 8px; width: 100%; text-align: left;
  border: 0; background: transparent; color: var(--ink); padding: 7px 8px; border-radius: 10px;
  font-size: 12.5px; cursor: pointer;
}
.search-row.on { background: var(--accent-soft); box-shadow: var(--shadow-ring); }
.search-row-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.search-row-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.search-row-sub { color: var(--ink-3); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.search-row-meta { color: var(--ink-3); font-size: 11px; flex: none; }
.search-row-mono {
  font: 11px/1 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  color: var(--ink-2); flex: none;
}
.search-more { padding: 4px 8px; color: var(--ink-3); font-size: 11px; }
.search-empty { padding: 12px 8px; text-align: center; color: var(--ink-3); font-size: 12px; }

/* ---- Toasts ------------------------------------------------------------------------------ */
.toast-region {
  position: fixed; right: 16px; bottom: 16px; z-index: 70; display: flex; flex-direction: column;
  gap: 8px; max-width: min(360px, calc(100vw - 32px));
}
.toast {
  display: flex; align-items: center; gap: 10px; background: var(--surface); color: var(--ink);
  border: 1px solid var(--border); border-radius: 14px; box-shadow: var(--shadow);
  padding: 11px 12px; font-size: 12.5px;
}
.toast-ok { border-left: 3px solid var(--ok); }
.toast-info { border-left: 3px solid var(--info); }
.toast-error { border-left: 3px solid var(--danger); }
.toast-text { flex: 1; }
.toast-request-id {
  font: 11px/1 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  color: var(--ink-3); background: var(--surface-2); border-radius: 6px; padding: 2px 6px;
}
.toast-undo, .toast-close {
  border: 0; background: transparent; color: var(--accent); font-weight: 600; cursor: pointer;
  font-size: 12px; padding: 2px 4px;
}
.toast-close { color: var(--ink-3); font-size: 14px; }

/* ---- Motion --------------------------------------------------------------------------- */
@keyframes metis-live-pulse {
  0% { box-shadow: 0 0 0 0 var(--live); }
  70% { box-shadow: 0 0 0 6px transparent; }
  100% { box-shadow: 0 0 0 0 transparent; }
}
@media (prefers-reduced-motion: reduce) {
  .rail, .rail-action.tool, .nav-item, .theme-btn, .live-indicator .live-dot, .live-dot-mini {
    transition: none !important; animation: none !important;
  }
}
`
