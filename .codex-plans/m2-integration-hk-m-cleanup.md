# m2/integration hk-m cleanup

- [x] Inspect hk-m harness, tests, packaged-smoke linkage, and recent merge touch points.
- [x] Confirm hk-m temp cleanup retries and warning-only behavior are already present in this worktree.
- [x] Confirm focused tests for transient ENOTEMPTY cleanup and real survivor failure are present.
- [x] Run allowed TypeScript checks only and record evidence.

## Review

- `scripts/qa/hk-m.mjs` already routes temp removals through `removeTempDir`, using `{ recursive: true, force: true, maxRetries: 10, retryDelay: 100 }`.
- Cleanup failures are recorded in `cleanupWarnings` and attached to the report without changing `reportResultForRows`.
- `scripts/qa/hk-m.test.ts` already covers transient `ENOTEMPTY` cleanup staying pass and a real survivor staying fail.
- Fixed type-only test harness errors in Dust/transcript tests so the required TypeScript stop condition is clean.
- `npx tsc --noEmit -p tsconfig.node.json`: pass.
- `npx tsc --noEmit -p tsconfig.web.json`: pass.
- `npx tsc --noEmit -p tsconfig.tests.json`: pass.
- Not run by D-28: Vitest, npm scripts, app/dev/build, packaged smoke, Electron.
