/**
 * Notifications page CSS (plan 6.8). Everything the shared classes in operator/src/spa/css.ts and
 * css-pages-shared.ts do not already cover: the two notice-kind colours kindBadge()'s ingest-event
 * tint map does not have (Connector, Skill -- plan: this page builds its own small badge for the
 * six notice kinds instead of forcing two of them through the wrong taxonomy), the kind-chip
 * filter row, the View column-visibility popover and the columns it can hide, and the mark-seen /
 * inline-action-resolve motion (plan 3.5b Notifications row) that is not just a data-* attribute
 * bindMotion() already understands.
 *
 * Tokens only, no hex (plan lock). Concatenated in operator/src/spa/manifest.ts after SHELL_CSS
 * and PAGES_SHARED_CSS.
 */
export const NOTIFICATIONS_CSS = `
/* .card sets overflow: hidden; the View menu popover needs to spill past that edge. */
.notice-toolbar-card { overflow: visible; padding-bottom: 10px; }

/* kindBadge() (operator/src/render/primitives.ts) tints the ingest-event taxonomy only
   (heartbeat/ask/recap/...); Connector and Skill are not ingest events, so this page's own
   noticeKindBadge() needs two colours kindBadge()'s map does not define, reusing the shared
   .kind-badge/.kind-icon shape design-lead owns in css.ts. */
.kind-connector { color: var(--info); }
.kind-skill { color: var(--data-2); }

button.chip.notice-kind-chip { cursor: pointer; border: 1px solid var(--hair); }
.notice-kind-chip .notice-kind-count {
  margin-left: 2px;
  padding: 0 5px;
  border-radius: var(--radius-pill);
  background: var(--muted);
  color: var(--muted-foreground);
  font: 600 10px var(--font-mono);
}
.notice-kind-chip.is-active {
  color: var(--accent-text);
  background: var(--accent-soft);
  border-color: transparent;
}
.notice-kind-chip.is-active .notice-kind-count {
  background: var(--surface);
  color: var(--accent-text);
}

.notice-expiry { color: var(--warn); font-weight: 600; }

.view-menu-wrap { position: relative; display: inline-flex; }
.view-menu {
  position: absolute;
  right: 0;
  top: calc(100% + 6px);
  z-index: 20;
  min-width: 168px;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  background: var(--panel);
  border: 1px solid var(--hair);
  border-radius: var(--radius-control);
  box-shadow: var(--shadow);
}
/* .view-menu sets its own display above, which otherwise beats the UA [hidden] rule (same
   specificity, author stylesheet wins) -- same pattern as .page[hidden] in css.ts. */
.view-menu[hidden] { display: none !important; }
.view-menu-title {
  margin: 0 0 2px;
  font: 600 10px var(--font-body);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ink-3);
}
.view-menu-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font: 400 12px var(--font-body);
  color: var(--ink);
  padding: 4px;
  border-radius: 6px;
  cursor: pointer;
}
.view-menu-item:hover { background: var(--muted); }

/* Column order is fixed (Kind, Title, Detail, Profile, Country, OS, When, action): position
   selectors, not a per-cell data attribute the shared dataTable() primitive does not emit. */
.notice-table-shell[data-hide-cols~='detail'] table th:nth-child(3),
.notice-table-shell[data-hide-cols~='detail'] table td:nth-child(3) { display: none; }
.notice-table-shell[data-hide-cols~='profile'] table th:nth-child(4),
.notice-table-shell[data-hide-cols~='profile'] table td:nth-child(4) { display: none; }
.notice-table-shell[data-hide-cols~='country'] table th:nth-child(5),
.notice-table-shell[data-hide-cols~='country'] table td:nth-child(5) { display: none; }
.notice-table-shell[data-hide-cols~='os'] table th:nth-child(6),
.notice-table-shell[data-hide-cols~='os'] table td:nth-child(6) { display: none; }

/* Mobile scroll cue (design gate finding, 390px: the Profile/Country/OS/When/Action columns --
   including the page's single most important element, the inline Approve/Retry/Re-test/Revoke
   button -- sit entirely outside the viewport with no hint there is more to see; plan 3.7b law 1,
   "Approve a seat: inline in Notifications"). Classic four-layer scroll-shadow technique (Lea
   Verou, "Fading out on scroll, with just CSS"): a --panel "cover" gradient scrolls with the
   table content on each side (background-attachment: local) and exactly masks that side's shadow
   gradient at rest; the two shadow gradients stay pinned to the scroll container's own viewport
   (background-attachment: scroll). Net effect: a shadow shows on a side only while that side
   still has unscrolled content -- pure CSS, no JS, correct in both themes since every stop is a
   token (color-mix against --ink so the shadow tint flips with the theme automatically). */
.notice-table-shell .table-wrap {
  background:
    linear-gradient(to right, var(--panel) 30%, transparent),
    linear-gradient(to right, transparent, var(--panel) 70%) 100% 0,
    radial-gradient(farthest-side at 0 50%, color-mix(in srgb, var(--ink) 22%, transparent), transparent),
    radial-gradient(farthest-side at 100% 50%, color-mix(in srgb, var(--ink) 22%, transparent), transparent) 100% 0;
  background-repeat: no-repeat;
  background-color: var(--panel);
  background-size: 24px 100%, 24px 100%, 10px 100%, 10px 100%;
  background-attachment: local, local, scroll, scroll;
}

/* Mark-seen (plan 3.5b: "the row fades to 60%"). Opacity-only, so it stays correct under
   prefers-reduced-motion: reduce without a separate override (plan 3.5: reduced motion
   "collapses everything to opacity or nothing" -- an opacity change already is that). */
[data-notice-row] { cursor: pointer; transition: opacity 0.3s var(--ease-color); }
[data-notice-row].is-seen { opacity: 0.6; }

/* Inline action resolve sequence (plan 3.5b: "the row's action area crossfades to a check mark,
   then the row collapses 250ms"). */
.notice-action-cell { display: inline-flex; align-items: center; }
.notice-action-done {
  display: inline-flex;
  color: var(--ok);
  opacity: 0;
  animation: notice-check-in 0.2s var(--ease-color) forwards;
}
.notice-action-done svg { width: 16px; height: 16px; }
@keyframes notice-check-in { to { opacity: 1; } }
[data-notice-row].notice-row-collapse td {
  opacity: 0;
  padding-top: 0;
  padding-bottom: 0;
  line-height: 0;
  transition: opacity 0.18s var(--ease-color), padding 0.25s var(--ease-spring), line-height 0.25s var(--ease-spring);
}

@media (prefers-reduced-motion: reduce) {
  [data-notice-row] { transition: none; }
  .notice-action-done { animation: none; opacity: 1; }
  [data-notice-row].notice-row-collapse td { transition: none; }
}
`
