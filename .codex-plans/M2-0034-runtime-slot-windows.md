# M2-0034 Runtime Slot Windows

## Plan

- [x] Read scoped code/tests and identify CI regression roots.
- [x] Patch M2-0034 implementation with minimal blast radius.
- [x] Fix test/mock and architecture-baseline regressions without weakening tests.
- [x] Run allowed `tsc` checks and inspect diff.
- [x] Record results and final verdict.

## Review

- Fixed the local-runtime mock regression by making `src/main/llm/local.ts` own its exported character/token estimate instead of reading the runtime export at module import time.
- Kept `src/main/brain/ingest.ts` at the failed CI baseline count of 3,077 lines while preserving runtime-slot-derived extraction sizing and classified ingest failures.
- Raised only the affected freeze harness contract-test timeouts to 60s, above their own 45s `spawnSync` timeout, so Windows can observe the scripted failure evidence instead of Vitest timing out first.
- Verification run locally under the owner rules:
  - `npx tsc --noEmit -p tsconfig.node.json`: exit 0.
  - `npx tsc --noEmit -p tsconfig.web.json`: exit 0.
  - `npx tsc --noEmit -p tsconfig.tests.json`: exit 2 with 7 pre-existing type errors, within the stated ceiling of no more than 7.
- Not run locally by rule: Vitest, app/dev/build, architecture script, or Electron.
