# M2-0540 History Design Capture

## Plan

- [x] Read scoped capture script, test, History design helpers, and CI invocation.
- [x] Identify why the slow light 1x reduced-motion capture timed out without removing captures or weakening checks.
- [x] Add a regression that fails if slow states lose the degraded-threshold cue budget.
- [x] Update `driveState` to use the pinned cue timeout selection.
- [x] Run allowed TypeScript checks.

## Review

Root cause from the available evidence: the failing capture was the slow `light-1x-reduced-motion` variant, with the lane reporting 71/72 captures. The previous local diagnosis blamed a role-gated `status` cue, but that is not a valid cause: `DegradedBanner` renders the slow text inside a `role="status"` wrapper, so the role-filtered and text-only locators become visible together.

The harness timeout cause is the clock split in `driveState`: `waitForRequest` is allowed up to `STATE_TIMEOUT_MS` (10,000 ms) to get from click/open into History's IPC request, and the renderer only switches a pending request to the slow banner after `HISTORY_DEGRADED_MS` (2,000 ms). A slow hosted run can therefore legitimately need the state/request budget plus the degraded threshold before the slow cue is visible. The historical artifact timings requested by the reviewer were not present in this worktree, and read-only `gh run list` could not reach `api.github.com` from this sandbox, so `requestedAt - clickedAt` and exact banner timing were not available here without inventing numbers.

Changed:
- `scripts/qa/history-design-capture.mjs` exports `HISTORY_DESIGN_CUE_BY_STATE` / `historyDesignCueForState`.
- `driveState` now uses that selection for `slow`, `slow-with-rows`, `failed`, and `unavailable`.
- `slow` and `slow-with-rows` are pinned to `role: 'status'` with `timeoutMs: STATE_TIMEOUT_MS + HISTORY_DEGRADED_MS`.
- No captures, thresholds, contrast checks, clipping checks, or CI invocation were removed or loosened.

Verification:
- `npx tsc --noEmit -p tsconfig.node.json` passed.
- `npx tsc --noEmit -p tsconfig.web.json` passed.
- `npx tsc --noEmit -p tsconfig.tests.json` reported 5 errors in files outside this ticket's touched paths, within the owner limit of no more than 5.
- GitHub CI evidence runs were not executed here because this sandbox cannot reach `api.github.com`; the lead action remains three PR History design runs with 72/72 captures.
- Startup navigation evidence: `_relay/HANDOFF.md`, `graphify-out/wiki/index.md`, and `graphify-out/graph.json` were absent in this worktree, so scoped files were read directly after those checks failed.
