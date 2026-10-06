# M2-0202 Slice 3 Reader Plan

## Scope
- Resolve current merge conflicts in the listed files without git-writing commands.
- Add the right-edge Reader surface only for slice M2-0202.3.
- Keep later island replacement, edge classes, evidence capture, and release work out of scope.

## Checklist
- [x] Read scope files and tests around right-edge surface/state behavior.
- [x] Resolve conflicts in `scripts/architecture-baseline.json`, `src/main/index.ts`, `src/main/overlay-cursor-stability.test.ts`, `src/renderer/src/App.tsx`, and `src/renderer/src/components/RightEdgeSidecar.tsx`.
- [x] Implement `readerRect` use, Reader surface lifecycle, parking/reveal rules, and blur grace behavior.
- [x] Add `RightEdgeReader` with exactly one `data-re-reader-scroll` scroller plus CSS tokens.
- [x] Wire History, Review, Agenda, Brain, answer, transcript, approval and error details only under `data-re-surface="reader"`.
- [x] Add strings and contrast helpers needed by layout checks.
- [x] Update behavior/layout tests for RE-L05, R30-R33, Reader header, and earlier failed rows.
- [x] Run only allowed TypeScript checks and document skipped CI-only tests.

## Review
- Conflict markers removed from the five listed files; `git diff --check` passes.
- `npx tsc --noEmit -p tsconfig.node.json` passed.
- `npx tsc --noEmit -p tsconfig.web.json` passed.
- `npx tsc --noEmit -p tsconfig.tests.json` reported 5 errors, within the owner bar; all are outside this slice in Dust/transcripts tests.
- Local Vitest, npm scripts, dev/build, and Electron were not run because D-28 requires CI-only execution.
- `_relay/` is absent in this public worktree, so no baton update was possible here.
