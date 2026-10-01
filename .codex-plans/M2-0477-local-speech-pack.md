# M2-0477 localSpeechPack

## Plan

- [x] Map existing Operator policy, desktop policy client, onboarding speech-pack, tests, and packaged POLICY-01 tooling.
- [x] Add behavior tests for default/offered, required, blocked, and MDM-only-toward-blocked semantics.
- [x] Implement localSpeechPack through the signed policy model, desktop policy client merge, onboarding behavior, and packaged evidence row.
- [x] Run allowed TypeScript checks:
  - `npx tsc --noEmit -p tsconfig.node.json`
  - `npx tsc --noEmit -p tsconfig.web.json`
  - `npx tsc --noEmit -p tsconfig.tests.json`
- [x] Review constraints: no local tests/app/build, no git writes, no private program paths or secrets.

## Review

Implemented `localSpeechPack: required | offered | blocked` in the signed Operator model policy, desktop policy client, MDM narrowing, onboarding behavior, native policy parity, and POLICY-01 packaged smoke evidence.

Verification:

- `npx tsc --noEmit -p tsconfig.node.json`: pass.
- `npx tsc --noEmit -p tsconfig.web.json`: pass.
- `npx tsc --noEmit -p tsconfig.tests.json`: 5 unrelated existing errors, at the owner bar of <=5 errors.

Skipped by owner rule: local Vitest/npm test/dev/build/Electron execution. CI Build & Test remains the required live test runner.
