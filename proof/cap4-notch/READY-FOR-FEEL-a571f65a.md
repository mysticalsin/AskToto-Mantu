# READY FOR FEEL — a571f65a

Branch `claude/dock-three-fixes`. Version 1.9.5. Pack on HOLD.
Full QA write-up: `proof/cap4-notch/QA-NOTES-dock-three-fixes.md`.

## Go and feel these three

1. **Right sliding DockPanel chat bar (#188).** Pick the right edge, pick the
   command sidecar. The ask surface should be the tall 380-wide sidecar —
   header, one big answer body, composer pinned at the bottom — and never the
   horizontal bar squeezed into a vertical hole. The Codex backend underneath
   is untouched.
2. **Right-edge card art.** On the right-edge step, all four cards draw their
   own thing: two orbs, then a vertical rest-rail sidecar for the command
   sidecar and a ghosted one for its hidden twin. No card should show
   horizontal bar art.
3. **Top | Right, and Circle ↔ Jarvis.** Click between them, fast, and on a
   small screen. The stage should crossfade. No blank frame, no dim over the
   card grid, no "Saving…".

Cap2 Hey Métis ear is in and wired end to end. Cap4 Appearance DNA is kept.

## What this tip is standing on

- Typecheck green across all five projects; test-types at its 26 baseline.
- `npm run build` exit 0. `npm run check:release` OK.
- Full root suite, run outside the command sandbox: **6431 passed, 4 failed,
  17 pending** of 6452. Proxy suite 28 passed.
- The toolbar-overlap ship blocker (`bar-toolbar.layout.test.ts`) is green.
  It only means anything unsandboxed — sandboxed it cannot launch Chromium at
  all — so that is where it was run.

## The four reds, and why they are not this lane's

`operator-default-url.contract`, `operator-entitlements-state`,
`operator-ingest-funded`, `operator-integrations`. All four fail identically
at the merge base `12c61de2`, verified by running them in a detached worktree
at that commit. Someone on the operator lane should own them; they are not a
reason to hold this one.

## Two things to know before the feel

- The branch tip as it stood at `c393353a` did not compile — a duplicated
  `) : null}` in the Cap4 crossfade. If anything was pulled from origin before
  `65eaa6a2`, pull again.
- The zero-flash guards are source-text assertions, not render measurements.
  They will catch a revert of the DNA. They will not catch a flash that comes
  back by some other route, so the eye test is still the real gate — which is
  what this file is asking for.

One more behaviour change worth knowing: a failed placement save no longer
rolls the selection back. The rollback was the flash. On failure the UI keeps
the new selection and shows the error line.
