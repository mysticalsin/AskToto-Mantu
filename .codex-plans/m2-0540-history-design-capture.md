# M2-0540 History Design Capture

## Plan

- [x] Read scoped capture script, test, History design helpers, and CI invocation.
- [x] Identify the locally visible driver race hypothesis without removing captures or weakening checks.
- [x] Add a regression that fails if the slow search cue wait starts before the search request reaches main.
- [x] Update `driveState` to anchor the slow search degraded wait to the search request.
- [x] Run allowed TypeScript checks.

## Review

CI root cause is not fully extractable from this sandbox. `gh run list` returns `error connecting to api.github.com`, no `history-design-report.json` or matching 2026-10-02 artifact is present under this worktree, and the only readable `queue.log` found locally is a 2026-09-29 log unrelated to the History design failure. LEAD_ACTION: extract `history-design/history-design-report.json`, `history-design/SUMMARY.md`, and the failing job log for the 2026-10-02 `history-design-mac` runs, then record the failing `slow` or `slow-with-rows` / `light-1x-reduced-motion` row's `drive.error`, `requestedAt - clickedAt`, and `bannerAfterMs`. Acceptance criterion 1 remains open until that CI evidence is attached.

ASSUMED hypothesis from local code review: the `slow-with-rows` state could spend part of the slow-search cue budget before History's search IPC request reached main. The renderer arms its degraded timer from the request, not from the harness's typed character. `driveState` waits for that second request and records `drive.requestedAt` from it before waiting for the slow banner. The list-level `slow` / `light-1x-reduced-motion` capture is unchanged by this work, and this note does not claim that the CI timeout is fixed.

Changed:
- `scripts/qa/history-design-capture.mjs` exports `driveState` for the behavior regression.
- `driveState` now accepts injected driver dependencies for tests while keeping production defaults.
- `slow-with-rows` now waits for the search request after filling the search input, then waits for the status banner from that request using the default `STATE_TIMEOUT_MS` visual-cue budget.
- No captures, thresholds, contrast checks, clipping checks, or CI invocation were removed or loosened.

Verification:
- `npx tsc --noEmit -p tsconfig.node.json` passed.
- `npx tsc --noEmit -p tsconfig.web.json` passed.
- `npx tsc --noEmit -p tsconfig.tests.json` reported 5 errors, all outside this ticket's scoped paths, within the owner limit of no more than 5:
  - `src/main/llm/dust.reuse-auth-retry.test.ts`: three `StreamHandlers` / `Mock` type mismatches.
  - `src/main/llm/dust.stream-auth-retry.test.ts`: one `StreamHandlers` / `Mock` type mismatch.
  - `src/main/transcripts.test.ts`: one `PathLike` / `string` rename mock type mismatch.
- GitHub CI evidence runs were not executed here because this sandbox cannot reach `api.github.com`; LEAD_ACTION: run three PR History design evidence jobs and attach the three `history-design/SUMMARY.md` reports showing 72/72 captures. Acceptance criterion 2 remains open until those three runs pass without removed, skipped or loosened captures.
- Startup navigation evidence: `_relay/HANDOFF.md`, `graphify-out/wiki/index.md`, and `graphify-out/graph.json` were absent in this worktree, so scoped files were read directly after those checks failed.
