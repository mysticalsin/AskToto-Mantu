# M2-0540 History Design Capture

## Plan

- [x] Read scoped capture script, test, History design helpers, and CI invocation.
- [x] Identify why the slow light 1x reduced-motion capture timed out without removing captures or weakening checks.
- [x] Add a regression that fails if slow states are restored to role-gated cue waits.
- [x] Update `driveState` to use the pinned cue selection.
- [x] Run allowed TypeScript checks.

## Review

Root cause from the CI-provided History design evidence: the failing capture was the slow `light-1x-reduced-motion` variant. `driveState` had already observed the History list request, then waited up to `STATE_TIMEOUT_MS` for the slow degraded banner through a role-gated `status` cue. That cue did not arrive through the role-gated wait before the 10,000 ms state timeout, so the capture row timed out at 71/72 even though the slow visual copy is the transition needed before capture. The `unavailable` state still legitimately waits on `role="status"` because that row's status banner is its state signal; the slow states now synchronize on the visual text cue and still keep the post-capture role checks unchanged.

Changed:
- `scripts/qa/history-design-capture.mjs` exports `HISTORY_DESIGN_CUE_BY_STATE` / `historyDesignCueForState`.
- `driveState` now uses that selection for `slow`, `slow-with-rows`, `failed`, and `unavailable`.
- `slow` and `slow-with-rows` are pinned to `{ text: 'OneDrive is slow to answer', role: null }`.
- No captures, thresholds, contrast checks, clipping checks, or CI invocation were removed or loosened.

Verification:
- `npx tsc --noEmit -p tsconfig.node.json` passed.
- `npx tsc --noEmit -p tsconfig.web.json` passed.
- `npx tsc --noEmit -p tsconfig.tests.json` reported 5 errors in files outside this ticket's touched paths, within the owner limit of no more than 5.
- GitHub CI evidence runs were not executed here because this sandbox cannot reach `api.github.com`; the lead action remains three PR History design runs with 72/72 captures.
