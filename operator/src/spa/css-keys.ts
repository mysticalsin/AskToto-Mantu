/**
 * Keys page CSS (plan 6.9, P1.7 brief). Tokens only (plan 3.2 names), no hex literal, no inline
 * `style=`. Concatenated in operator/src/spa/manifest.ts, in NAV_IDS order, after SHELL_CSS and
 * PAGES_SHARED_CSS; every class below is unique to this page (`.keys-*`) except `.mono`, which
 * operator/src/spa/css-groups.ts already introduced as a small shared utility (last4, device ids)
 * this page reuses rather than re-declaring.
 */
export const KEYS_CSS = `
.keys-explainer { margin: 0 0 20px; color: var(--ink-2); font-size: 13px; max-width: 720px; }

/* -- page layout: a 6 column grid (plan 3.4), full width for the Vault and Cloudflare cards,
   half width for Add key / Funded providers side by side; one column below 768px. -- */
.keys-grid { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 16px; }
.keys-col-6 { grid-column: span 6; }
.keys-col-3 { grid-column: span 3; }
@media (max-width: 768px) {
  .keys-grid { grid-template-columns: 1fr; }
  .keys-col-6, .keys-col-3 { grid-column: span 1; }
}

.keys-card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
.keys-history-toggle { font-size: 12px; }

/* -- card section labels (plan 3.3: "labels ... 12px, weight 600, no uppercase, no wide
   tracking") -- deliberately not css.ts's shared .eyebrow class (10px, uppercase, 0.12em
   tracking: the "eyebrow label" pattern the design gate bans outright). Local to this page
   rather than a change to that shared class, which other pages still use as-is; flagged to the
   orchestrator as a candidate for a repo-wide follow-up. -- */
.card-label { font: 600 12px var(--font-body); color: var(--ink-2); margin: 0 0 8px; text-transform: none; letter-spacing: normal; }
.card-label-flush { margin: 0; }

/* -- vault table cells -- */
.keys-provider-cell { display: flex; align-items: center; gap: 8px; }
.keys-provider-glyph { display: inline-flex; flex-shrink: 0; }
.keys-row-actions { gap: 6px; }

/* -- usage columns: value + a proportional bar that grows on load (data-grow, plan 3.5b "usage
   bars grow on load"). The bar is an <svg width="N%"> (no inline style=, gates.mjs gate 2), same
   technique operator/src/render/pages/_shared.ts's percentBar() uses for the Realtime geo table. -- */
.keys-usage-cell { display: flex; flex-direction: column; gap: 4px; min-width: 72px; }
.keys-usage-value { font: 600 12px var(--font-body); color: var(--ink); font-feature-settings: "tnum"; }
.keys-usage-bar { display: block; height: 4px; border-radius: var(--radius-pill); background: var(--data-1); opacity: 0.85; }

/* -- Add key card -- */
.keys-add-form { margin-bottom: 4px; }
.keys-provider-help { margin: -2px 0 2px; font-size: 12px; color: var(--ink-2); }
.keys-provider-help a { color: var(--accent); }
.keys-secret-wrap { display: flex; gap: 6px; }
.keys-secret-wrap .keys-secret-input { flex: 1; }
.keys-secret-input { transition: opacity 90ms var(--ease-color); }
.keys-secret-input.is-crossfading { opacity: 0; }

/* -- funded providers -- */
.keys-funded-chips { display: flex; flex-wrap: wrap; gap: 6px; }

/* -- Cloudflare AI Gateway card: 3 tiles, 1 column below 640px -- */
.keys-cf-tiles { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
@media (max-width: 640px) { .keys-cf-tiles { grid-template-columns: 1fr; } }
.keys-cf-tile { margin: 0; }

/* -- the connect control is a real <a> when enabled and an inert <button disabled> when
   OAuth secrets are missing (plan 6.9: "connect button disabled with the reason"); css.ts (a
   file this page does not own) has no [disabled] treatment for .btn (only .tool), so this page
   supplies its own -- inert must also look inert, never a live-looking dead end (lock 12). -- */
#cf-connect[disabled] { opacity: 0.5; cursor: not-allowed; }

@media (prefers-reduced-motion: reduce) {
  .keys-secret-input { transition: none; }
}
`
