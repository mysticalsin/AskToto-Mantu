# M2-0572 Owner Camera Fix Plan

- [x] Read AGENTS, scoped owner-camera files, failing contracts, and architecture checker.
- [x] Diagnose CI failures: owner-camera helper BrowserWindow and sync fs calls regressed contracts/architecture; workflow lacked self-registration trigger.
- [x] Patch camera capture to use the existing overlay webContents through CommandControl instead of constructing a helper BrowserWindow.
- [x] Patch owner selftest fs calls to async APIs and keep report content-free.
- [x] Patch owner-camera workflow to self-register on PR while skipping jobs unless workflow_dispatch.
- [x] Run allowed tsc checks only and inspect diff/scope.

## Review

- `npx tsc --noEmit -p tsconfig.node.json`: PASS.
- `npx tsc --noEmit -p tsconfig.web.json`: PASS.
- `npx tsc --noEmit -p tsconfig.tests.json`: 5 errors, all outside M2-0572 (`dust.*auth-retry.test.ts`, `transcripts.test.ts`), within the requested bar.
- Static checks: no `BrowserWindow` construction or sync fs calls remain in `src/main/desktop-adapters.ts` / `src/main/owner-camera-selftest.ts`; `git diff --check` PASS; `src/main/index.ts` line count is 9960 vs 9965 at HEAD.
- D-28 honored: no Vitest, npm scripts, node repository scripts, Electron app, commits, pushes, tags, or deploys were run.
