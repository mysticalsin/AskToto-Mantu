# M2-0471 Stall Sampler Candidate Lane

- [x] Restore reviewer-flagged `RUNNER_TEMP` workflow contract coverage from integration.
- [x] Audit scoped implementation against the M2-0471 acceptance criteria.
- [x] Patch only scoped files needed for the candidate stall-sampler lane and tests.
- [x] Run allowed static checks: `npx tsc --noEmit -p tsconfig.node.json`, `tsconfig.web.json`, `tsconfig.tests.json`.
- [x] Record review evidence and any skipped CI-only tests.

## Review

- Restored the `RUNNER_TEMP` contract coverage for the candidate DMG mountpoint.
- Kept the install target repository-relative so `candidate-scenarios.mjs run` can record a content-free command.
- Made the hosted stall-sampler BLOCKED_EXTERNAL unblock text slash-free for the content-free report assertion.
- Verification:
  - `npx tsc --noEmit -p tsconfig.node.json`: PASS.
  - `npx tsc --noEmit -p tsconfig.web.json`: PASS.
  - `npx tsc --noEmit -p tsconfig.tests.json`: 7 errors, within the owner bar; errors are in existing Dust/transcript test typing outside this ticket scope.
- CI-only tests not run locally by owner rule D-28: `stall-sampler-hosted.test.ts`, `candidate-scenarios.test.ts`, `candidate-scenarios-workflow.contract.test.ts`.
