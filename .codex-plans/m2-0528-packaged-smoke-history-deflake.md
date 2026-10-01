# M2-0528 Plan

- [x] Inspect conflict state and scoped packaged-smoke files.
- [x] Resolve `scripts/qa/packaged-smoke.test.ts` conflict keeping both sides' intent.
- [x] Confirm behavior tests cover readiness diagnostics and guard breakage risk.
- [x] Run allowed TypeScript checks only: node, web, tests.
- [x] Update relay baton with evidence.

## Review

- Conflict resolved by retaining both the M2-0528 `navigationViewReadiness` import and the `origin/m2/integration` overlay-stability imports.
- `rg -n "<<<<<<<|=======|>>>>>>>" scripts/qa/packaged-smoke.test.ts scripts/qa/packaged-smoke.mjs`: no matches.
- `git diff --check -- scripts/qa/packaged-smoke.mjs scripts/qa/packaged-smoke.test.ts .codex-plans/m2-0528-packaged-smoke-history-deflake.md`: pass.
- `npx tsc --noEmit -p tsconfig.node.json`: pass.
- `npx tsc --noEmit -p tsconfig.web.json`: pass.
- `npx tsc --noEmit -p tsconfig.tests.json`: 5 unrelated existing errors, within the owner ceiling of 7.
- Guard-broken mutation note for PR description: disabling the guard dialog/decision path makes the recent dirty rows fail at `expectGuard`, not pass.
