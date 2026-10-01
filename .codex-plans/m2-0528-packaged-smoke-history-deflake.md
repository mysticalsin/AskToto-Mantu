# M2-0528 Plan

- [x] Inspect conflict state and scoped packaged-smoke files.
- [x] Resolve `scripts/qa/packaged-smoke.test.ts` conflict keeping both sides' intent.
- [x] Replace broad Review title detection with a stable app-side Review title marker.
- [x] Confirm behavior tests cover readiness diagnostics, the Recent-meetings false positive, and guard breakage risk.
- [x] Apply CI feedback: keep the Review title readiness marker while restoring `Review.tsx` to the FF-04 baseline line count.
- [x] Run allowed TypeScript checks only: node, web, tests.
- [x] Update relay baton with evidence.

## Review

- Conflict resolved by retaining both the M2-0528 `navigationViewReadiness` import and the `origin/m2/integration` overlay-stability imports.
- `src/renderer/src/components/Review.tsx` now exposes the open meeting title with `aria-label="Review meeting title"`.
- CI feedback from run 36823339551 fixed: `src/renderer/src/components/Review.tsx` is exactly 1,950 lines again, so FF-04 does not rise from the checked baseline.
- `scripts/qa/packaged-smoke.mjs` now sets `titleVisible` from that Review title marker, not from `document.body.innerText`; the History/recent rows cannot satisfy Review readiness by themselves.
- The History/review snapshot probe now prefers visible matching buttons before falling back to any matching button.
- `ensureHistory`, `clickHistory`, `openHistoryFromSettings`, and dirty discard/save History returns use `waitForNavigationView` so row failures include the harness readiness diagnosis.
- `scripts/qa/packaged-smoke.test.ts` covers the mutation where the target title appears only in Recent meetings and Review readiness remains `ready: false`.
- `rg -n "<<<<<<<|=======|>>>>>>>" scripts/qa/packaged-smoke.test.ts scripts/qa/packaged-smoke.mjs`: no matches.
- `git diff --check -- src/renderer/src/components/Review.tsx scripts/qa/packaged-smoke.mjs scripts/qa/packaged-smoke.test.ts .codex-plans/m2-0528-packaged-smoke-history-deflake.md _relay/HANDOFF.md`: pass.
- `wc -l src/renderer/src/components/Review.tsx`: 1,950.
- `npx tsc --noEmit -p tsconfig.node.json`: pass.
- `npx tsc --noEmit -p tsconfig.web.json`: pass.
- `npx tsc --noEmit -p tsconfig.tests.json`: 5 unrelated existing errors, within the owner ceiling of 7.
- Guard-broken mutation note for PR description: disabling the guard dialog/decision path makes both `HIST-dirty-discard-recent` and `HIST-dirty-save-recent` fail at `expectGuard`, not pass.
- Review-title mutation note for PR description: with the target title present only in Recent meetings and no matching Review header, `readNavigationViewSnapshot` returns `titleVisible: false`; `waitForNavigationView` reports `review view was not reached: target review was not visible`.
- LEAD_ACTION: remove the `HIST-dirty-discard-recent` and `HIST-dirty-save-recent` lines from `codex-queue/known-smoke-flakes.txt` after merge.
