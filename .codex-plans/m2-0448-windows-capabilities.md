## M2-0448 Plan

- [x] Read scoped workflow/test files and neighboring contract-test style.
- [x] Resolve `.github/workflows/windows-qa.yml` conflict, preserving `hk-w` intent and adding `capabilities`.
- [x] Add/adjust `scripts/ci/windows-qa-workflow.contract.test.ts` assertions for acceptance criteria.
- [x] Run only allowed TypeScript checks: `tsconfig.node.json`, `tsconfig.web.json`, `tsconfig.tests.json`.
- [x] Record evidence and blockers in this plan.

## Review

- `.github/workflows/windows-qa.yml` has no conflict markers; `git diff --check -- .github/workflows/windows-qa.yml scripts/ci/windows-qa-workflow.contract.test.ts .codex-plans/m2-0448-windows-capabilities.md` passed.
- `capabilities` is guarded by `workflow_dispatch`, `suite=capabilities`, repository, and main branch; it runs on `windows-latest` with a 10 minute timeout and `contents: read`.
- The `capabilities` job has no checkout, no token or secrets references, and no repository script/package-manager execution in its job block.
- Probe keys and artifact fields were statically verified in the `capabilities` block.
- `npx tsc --noEmit -p tsconfig.node.json` passed.
- `npx tsc --noEmit -p tsconfig.web.json` passed.
- `npx tsc --noEmit -p tsconfig.tests.json` returned exactly 7 unrelated errors in existing LLM/transcript tests, meeting the allowed bar of no more than 7 errors.
- `npm run check:workflow-pins` was not run locally because the owner rule forbids running repository Node scripts on this Mac; the only new `uses:` line is pinned to a 40-character SHA with a version comment.
- `git status --short` still reports `UU .github/workflows/windows-qa.yml` because `git add` is a write-side git command and was explicitly forbidden; the file content itself is conflict-marker-free.
