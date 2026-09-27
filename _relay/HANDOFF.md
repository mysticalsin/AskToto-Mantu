---
project: Métis 2.0 traceability
agent: codex
updated: 2026-09-27
status: M2-0011 CLI usage fix ready for CI validation
---

# Handoff — M2-0011

## Current state

- Traceability matrix lives in the generated public traceability bundle, with 937/937 rows and 921/921 unique IDs mapped.
- CI runs `node scripts/trace/build-traceability.mjs --check` through the package traceability check.
- The CI failure from run 36322558901 was narrowed to the CLI usage guard in `scripts/trace/build-traceability.mjs`: output defaults were applied before validating whether `--check` or both output flags were explicitly supplied.
- `scripts/trace/build-traceability.mjs` now validates the explicit output-mode contract before applying default paths, so `--check` keeps default repository inputs and generation mode still requires both `--out-md` and `--out-json`.

## Done this shift

- Read `AGENTS.md`, `_relay/HANDOFF.md`, the traceability generator, generated matrix files, and the failing CLI-contract tests.
- Attempted the mandated graph navigation first; this worktree has no `graphify-out/graph.json` or `graphify-out/wiki/index.md`, so raw scoped files were used.
- Fixed the two failing CLI contract cases without changing tests or CI workflow files.
- Allowed local static verification:
  - `npx tsc --noEmit -p tsconfig.node.json`: PASS.
  - `npx tsc --noEmit -p tsconfig.web.json`: PASS.
  - `npx tsc --noEmit -p tsconfig.tests.json`: 24 TypeScript errors, within the allowed ceiling of 26.

## Blockers

- Local execution of `node scripts/trace/build-traceability.mjs --check`, `npm test`, Vitest, build, dev, and app runtime checks is intentionally skipped by D-28; the driver must push and read GitHub Actions for runtime proof.
- Vault startup reads for `Preferences/mistakes.md` and `_agent_state/codex/memory.json` timed out through OneDrive; `Preferences/dont.md` was reachable but empty.

## Next steps

1. Driver commits and pushes this worktree.
2. Confirm GitHub Actions reruns `scripts/trace/build-traceability.test.ts` and `npm run check:traceability`.
3. If CI still fails, inspect only the new failing traceability output first; the unrelated log noise in run 36322558901 was synthetic test coverage from other suites.

## Decisions made (don't relitigate)

- Tests and repository Node checks run in CI only; local verification is limited to allowed TypeScript compile checks and non-repo-code data inspection.
- Do not edit release workflow triggers, create tags, deploy, or run repository Node scripts locally.

## Watch out

- Do not run repository Node tests or the traceability Node check locally on a Mac.
- The relevant behavior tests already exist at `scripts/trace/build-traceability.test.ts:798` and `scripts/trace/build-traceability.test.ts:804`; they must remain intact.
