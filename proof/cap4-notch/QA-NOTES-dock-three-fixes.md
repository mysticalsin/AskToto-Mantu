# QA notes — dock lane, three FE fixes on the Codex backend tip

Branch `claude/dock-three-fixes`, worktree `/Users/tony/dev/metis-fix3`.
Merge base for every baseline comparison below: `12c61de2`.

## What was already on the branch when this pass started

`c393353a` claimed all three FE fixes. Two of the three held up. The commit
itself did not compile:

```
src/renderer/src/components/OnboardingAppearance.tsx(158,15):
error TS1381: Unexpected token. Did you mean `{'}'}` or `&rbrace;`?
```

A duplicated `) : null}` after the `layout === 'bar'` conditional. That tip was
pushed to origin, so the branch was red for anyone who pulled it. Fixed in
`65eaa6a2` along with two smaller things the same commit left behind: the
placement-save failure string had been overwritten with the chrome one (a
failed *position* save told the user Métis could not save "this appearance"),
and `appearanceLocked` had been de-indented out of the component body.

## Fix-by-fix

### 1. DockPanel #188 chat sidecar — kept, Codex backend untouched

`src/renderer/src/App.tsx:701` routes `AskSurface` to `DockPanel` when chrome is
`dock` and the settings sheet is closed, and to `Bar` otherwise.
`OVERLAY_DOCK_PANEL = { width: 380, height: 560 }` in
`src/main/island/geometry.ts:187`. `DockPanel` takes `BarProps` verbatim, which is
what keeps the two surfaces at parity without new wiring.

Nothing in this pass touched the backend.

### 2. Onboarding command-sidebar right-edge image

`ChromeCardThumb` in `OnboardingAppearance.tsx` now has a `dock` / `dock-hidden`
branch that draws a vertical rest-rail plus an inward panel, before the
`bar-hides` branch it used to fall through to. The right-edge card set is
`['circle', 'jarvis', 'dock', 'dock-hidden']`
(`onboarding-appearance.ts:138`) — `circle` and `jarvis` already drew orbs, so
all four right-edge cards now draw their own art and none reuses the
horizontal bar.

### 3. Top | Right flash

Three changes together:

- phase reset fires on `layout` only, not on `chromeId` / `placement`, so a
  Circle ↔ Jarvis swap no longer blanks the stage;
- both circle stages and the bar slot render simultaneously and crossfade via
  `.is-on` / `.is-off` (opacity + delayed `visibility`), so no layer unmounts on
  select. All three are `position: absolute` with no `opacity` in their base
  rules, so the `.is-*` pair governs and nothing reflows;
- `pickChrome` / `pickPlacement` persist optimistically and never raise
  `busy: true`, which is what dimmed the whole card grid.

Reduced-motion is handled: the crossfade transitions are dropped under
`prefers-reduced-motion: reduce`.

## Regression this lane had introduced, now fixed

Seven `src/main` speaker cases failed on this branch and passed at `12c61de2`.
Root cause was the Cap2 ear commit (`cdfa698a`) reshaping the two live feed
handlers — they coerce the renderer PCM up front, gate on engine availability,
and tap the wake ingest — while the contract tests still described the older
shape. Fixed in `a571f65a`; details in that commit message.

This mattered beyond the red: the `coerceFloat32Pcm` ReferenceError meant those
tests were no longer exercising the PCM gate at all.

## Residual — disclosed, not fixed

- **The zero-flash guards are textual, not render-level.** The three cases added
  in `onboarding-placement-step.test.ts` read the component and stylesheet as
  strings and assert the DNA markers are present. They pin the intent and they
  will catch a revert, but they do not render the step or measure a repaint, so
  the "microsecond flash on a small screen" is verified by construction and by
  eye, not by an automated timing assertion.
- **Optimistic persist no longer rolls back.** `pickPlacement` used to restore
  the previous placement and chrome when the save failed. That rollback was
  removed to kill the flash. On a failed save the UI now keeps the new
  selection and shows the error line, so the selection can disagree with what
  was persisted until the next successful save. Deliberate, and the smaller of
  the two evils given the DNA, but it is a real behaviour change.
- **Four operator cases fail, and did so before this lane.** Listed below.

## Gate results at `a571f65a`

Run from the worktree, outside the command sandbox where noted.

| Gate | Result |
|---|---|
| `npm run typecheck` (5 projects) | green; test-types at its 26 baseline |
| `npm run build` | exit 0, `check-built-offline` included |
| `npm run check:release` | OK — github releases, mysticalsin/Metis-Releases |
| `npm run test:proxy` | 28 passed |
| Dock / onboarding / ear lane | 90 passed, 0 failed |
| `bar-toolbar.layout.test.ts` (toolbar overlap ship blocker) | 5 passed, 0 failed |
| speaker-id + speaker-session-wiring | 61 passed, 0 failed |
| Full root suite, unsandboxed | 6431 passed, 4 failed, 17 pending (6452) |

### Sandbox caveat, and why it matters for reading any earlier run

The macOS Seatbelt sandbox this session runs under blocks Chromium launch
(`bootstrap_check_in ... Permission denied`) and loopback binds. Under it the
full suite reported 42 failures; run outside it, all but the four below pass.
Every gate above that could be affected was re-run unsandboxed. In particular
the toolbar-overlap gate — a DESIGN.md ship blocker — only means anything
unsandboxed, and it is green there.

### The four pre-existing failures

Present at `12c61de2`, unchanged by this lane, verified by running the same
files in a detached worktree at that commit:

- `operator-default-url.contract.test.ts` — does not POST without ingest secret even when DEFAULT resolves
- `operator-entitlements-state.test.ts` — allows everything when there is no Operator URL/secret at all
- `operator-ingest-funded.test.ts` — stores heartbeat IDs in RAM only and never treats a secret as a provider id
- `operator-integrations.test.ts` — returns null when Operator is not configured, without making a network call

They are not a dock-lane call. Flagging them for whoever owns the operator lane.

## Version

`package.json` 1.9.5, `native-app/project.yml` MARKETING_VERSION 1.9.5. Pack is
on HOLD — 2.0.0 is Devon's cut after Ultron GO, not this branch's.
