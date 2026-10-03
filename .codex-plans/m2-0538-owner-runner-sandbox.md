# M2-0538 Owner-Runner Sandbox

## Plan

- [x] Load AGENTS.md and scoped files.
- [x] Attempt graphify/wiki/baton/vault startup reads and record unreachable sources.
- [x] Inspect owner-runner profile, proof script, workflow contract, ST-1 launcher and tests.
- [x] Pin report-only History design workflow behavior so a single failed capture does not red-check the lane.
- [x] Apply the smallest workflow change matching the contract.
- [x] Run allowed TypeScript checks only:
  - `npx tsc --noEmit -p tsconfig.node.json`
  - `npx tsc --noEmit -p tsconfig.web.json`
  - `npx tsc --noEmit -p tsconfig.tests.json`

## Review Notes

- `_relay/HANDOFF.md` and `graphify-out/wiki/index.md` are absent in this public worktree.
- `/graphify` is not installed in this shell.
- `Preferences/dont.md` and `Preferences/mistakes.md` in the vault could not be read because OneDrive returned `Resource deadlock avoided`.
- `tsconfig.node.json`: pass.
- `tsconfig.web.json`: pass.
- `tsconfig.tests.json`: 5 unrelated existing errors, within the ticket's maximum of 5.
- `git diff --check`: pass.
