# M2-0538 Owner-Runner Sandbox

## Plan

- [x] Load AGENTS.md and scoped files.
- [x] Attempt graphify/wiki/baton/vault startup reads and record unreachable sources.
- [x] Inspect owner-runner profile, proof script, workflow contract, ST-1 launcher and tests.
- [x] Restore History design capture to enforcing integration behavior per review feedback.
- [x] Add a contract self-test for the probe's writable workspace and RUNNER_TEMP exceptions.
- [x] Run allowed TypeScript checks only:
  - `npx tsc --noEmit -p tsconfig.node.json`
  - `npx tsc --noEmit -p tsconfig.web.json`
  - `npx tsc --noEmit -p tsconfig.tests.json`

## Review Notes

- `_relay/HANDOFF.md`, `graphify-out/wiki/index.md`, and `graphify-out/graph.json` are absent in this worktree.
- `graphify query "M2-0538 owner-runner sandbox strict ST-1 owner-account qa-candidate"` failed because the graph file is absent.
- `Preferences/mistakes.md` could not be read because the filesystem returned `Resource deadlock avoided`; `Preferences/dont.md` and Codex recent learnings were read.
- History design remains the known first-capture flake owned outside this ticket; this ticket does not make it report-only.
- `bash -n scripts/hermetic/prove-owner-sandbox.sh scripts/hermetic/run-under-owner-sandbox.sh`: pass.
- `git diff --check`: pass.
- `npx tsc --noEmit -p tsconfig.node.json`: pass.
- `npx tsc --noEmit -p tsconfig.web.json`: pass.
- `npx tsc --noEmit -p tsconfig.tests.json`: 5 errors, within the ticket limit; all are in existing unrelated tests.
