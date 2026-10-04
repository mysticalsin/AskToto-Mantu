# M2-0572 Owner Camera Fix Plan

- [x] Read AGENTS, scoped owner-camera files, failing contracts, and architecture checker.
- [x] Diagnose CI failures: owner-camera helper BrowserWindow and sync fs calls regressed contracts/architecture; workflow lacked self-registration trigger.
- [x] Patch camera capture to use the existing overlay webContents through CommandControl instead of constructing a helper BrowserWindow.
- [x] Patch owner selftest fs calls to async APIs and keep report content-free.
- [x] Patch owner-camera workflow to self-register on PR while skipping jobs unless workflow_dispatch.
- [x] Carry CI feedback first: restore `src/main/index.ts` FF-04 line count to the baseline without editing `scripts/architecture-baseline.json`.
- [x] Run allowed tsc checks only and inspect diff/scope.

## Review

- `wc -l src/main/index.ts`: 9960, matching the reported FF-04 baseline count.
- `npx tsc --noEmit -p tsconfig.node.json`: PASS.
- `npx tsc --noEmit -p tsconfig.web.json`: PASS.
- `npx tsc --noEmit -p tsconfig.tests.json`: 5 errors, all outside M2-0572 (`dust.*auth-retry.test.ts`, `transcripts.test.ts`), within the requested bar.
- Static checks: no `BrowserWindow` construction or sync fs calls remain in `src/main/desktop-adapters.ts` / `src/main/owner-camera-selftest.ts`; `src/main/index.ts` line count is back to 9960.
- D-28 honored: no Vitest, npm scripts, repository node scripts, Electron app, commits, pushes, tags, or deploys were run.
- `_relay/HANDOFF.md` was unavailable in this public worktree; no relay folder was created.
