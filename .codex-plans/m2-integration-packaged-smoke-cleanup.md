# m2 integration packaged smoke cleanup fix

- [x] Inspect `scripts/qa/hk-m.mjs`, `scripts/qa/hk-m.test.ts`, packaged smoke workflow, and recent merge touchpoints.
- [x] Confirm HK-M cleanup race fix and requested tests are already present in `980cfe102`.
- [x] Fix the active packaged-smoke failure path: managed Node downloads now retry transient failures and are included in the packaged-smoke runtime cache after checksum verification.
- [x] Run allowed `tsc` checks only; do not run repo tests or app per D-28.

## Review

Verification:
- `npx tsc --noEmit -p tsconfig.node.json` passed.
- `npx tsc --noEmit -p tsconfig.web.json` passed.
- `npx tsc --noEmit -p tsconfig.tests.json` passed after type-only test-helper repairs.
- `git diff --check` passed.
- Local tests/app execution skipped per D-28.
