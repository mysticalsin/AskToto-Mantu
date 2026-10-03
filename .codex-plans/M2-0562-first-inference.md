# M2-0562 first-inference census

## Plan

- [x] Read session contracts, scoped workflow, helper, and tests.
- [x] Confirm graphify navigation has no usable graph/wiki in this worktree.
- [x] Tighten first-inference precondition evidence so refused start paths name the refusing gate.
- [x] Verify workflow contract pins cold-start, settled-idle, parked-idle, first-inference for both legs and override is scoped.
- [x] Run allowed TypeScript checks only.

## Review

- `npx tsc --noEmit -p tsconfig.node.json`: pass.
- `npx tsc --noEmit -p tsconfig.web.json`: pass.
- `npx tsc --noEmit -p tsconfig.tests.json`: 5 diagnostics, all outside M2-0562 scope; meets the owner bar of not exceeding 5 errors.
- Not run by rule: npm tests, Vitest, node test scripts, dev/build, or packaged app.
