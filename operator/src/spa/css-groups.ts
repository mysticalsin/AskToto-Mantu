/**
 * Groups page CSS (plan 6.6, P1.10 brief). Tokens only (plan 3.2 names via the aliases already on
 * `:root` in operator/src/spa/css.ts, e.g. `--ink-3`/`--ink3`) -- no hex literal, no inline
 * `style=`. Concatenated in operator/src/spa/manifest.ts, in NAV_IDS order, after SHELL_CSS and
 * PAGES_SHARED_CSS; every class below is unique to this page (`.group-*`, `.member-*`) or a small
 * generic utility (`.mono`) this page introduces because no shared file defines it yet.
 */
export const GROUPS_CSS = `
/* -- generic mono utility: last4, device ids, session ids -- introduced here, no shared file
   carries it yet (design-lead's primitives print ids in the surrounding element's own font). -- */
.mono { font-family: var(--font-mono); font-size: 12px; }

/* -- list table cells -- */
.group-name-cell { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.group-notes {
  color: var(--ink-3); font-size: 11.5px; max-width: 260px; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap;
}
.group-count-muted { color: var(--ink-3); }
.group-count-active { color: var(--ok); font-weight: 600; }
.group-count-sep { color: var(--ink-3); margin: 0 3px; }

/* -- loading skeleton, shaped like the final table (plan 3.7b law 8). -- */
.group-skeleton { display: flex; flex-direction: column; gap: 4px; padding: 4px 0; }

.group-inline-error { color: var(--danger); font-size: 12px; font-weight: 600; padding: 10px 0 4px; }

/* -- shared form layout for the Add-group drawer, the Members/Licenses tab forms and the inline
   edit form: a single column of labeled fields, consistent with the reference .key-form class. -- */
.group-form { display: grid; gap: 10px; margin: 0 0 12px; }
.group-form label { display: flex; flex-direction: column; gap: 4px; font: 600 12px var(--font-body); color: var(--ink-2); }
.group-form input, .group-form select, .group-form textarea {
  border: 1px solid var(--border); background: var(--bg); color: var(--ink);
  border-radius: var(--radius-control); padding: 7px 9px; font: 400 13px var(--font-body);
}
.group-form textarea { min-height: 64px; resize: vertical; }
.group-form-error { color: var(--danger); font-size: 12px; font-weight: 600; padding: 0 0 8px; }

/* -- Members / Licenses inline (non-stacked) forms: fields sit in a row on wide drawers. -- */
.group-member-form, .group-license-form {
  display: flex; flex-wrap: wrap; align-items: flex-end; gap: 8px; margin: 0 0 10px;
}
.group-member-form select, .group-member-form input,
.group-license-form select, .group-license-form input {
  border: 1px solid var(--border); background: var(--bg); color: var(--ink);
  border-radius: var(--radius-control); padding: 7px 9px; font: 400 13px var(--font-body);
}
.group-license-form label { display: flex; flex-direction: column; gap: 4px; font: 600 11px var(--font-body); color: var(--ink-2); }

/* -- drawer header: title + tier badge inline, Edit/Close sit to the right (seat-overlay-head
   already lays those out as a row). -- */
.group-drawer-heading { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1; }
.group-drawer-heading h4 { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.group-drawer-notes { color: var(--ink-2); font-size: 13px; margin: 0 0 4px; }
.group-drawer-meta { font-size: 11.5px; margin: 0 0 12px; }
.group-tab-panel { padding-top: 12px; }
.group-edit-actions { justify-content: flex-end; margin-top: 4px; }

/* -- member chips: springs in on add (motion.ts pop()), fades + collapses height on remove
   (client/pages/groups.ts's collapseAndRemove() toggles .member-chip-removing and waits 200ms
   before removing the node, plan 3.5b: "remove: fades and collapses height 200ms"). -- */
.group-member-list { display: flex; flex-wrap: wrap; gap: 6px; }
.member-chip {
  display: inline-flex; align-items: center; gap: 6px; max-width: 100%;
  overflow: hidden; transform-origin: left center;
  transition: opacity 200ms var(--ease-color), max-width 200ms var(--ease-spring),
    margin 200ms var(--ease-spring), padding 200ms var(--ease-spring);
}
.member-chip-removing { opacity: 0; max-width: 0; margin: 0; padding: 0; overflow: hidden; }
.member-chip-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 220px; }
.member-chip-kind { color: var(--ink-3); font-size: 9px; }
.member-remove {
  display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px;
  padding: 0; border: none; background: transparent; color: inherit; cursor: pointer; border-radius: 999px;
}
.member-remove:hover { background: color-mix(in srgb, var(--ink) 10%, transparent); }
.member-remove svg { width: 10px; height: 10px; }

/* -- connectors tab cell. -- */
.group-connector-cell { display: flex; align-items: center; gap: 8px; }
.group-connector-cell img { flex: none; }

/* -- reduced motion: collapseAndRemove() (operator/client/pages/groups.ts) checks
   client/motion.ts's reduceMotion() itself and skips straight to removing the node -- the
   .member-chip-removing transition above never even gets a chance to run -- and design-lead's
   global "*, *::before, *::after { transition-duration: 0.01ms !important }" block (css.ts) is a
   second, independent guard if that class is ever added while the media query is active. -- */
`
