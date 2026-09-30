# M2-0042 follow-up plan

## Checklist

- [x] Confirm current M2-0042 implementation against scope files and failing CI signals.
- [x] Fix the architecture baseline delta without broadening the baseline.
- [x] Patch any remaining renderer URL guard or Act 2 Next acceptance gaps.
- [x] Run allowed verification only: `npx tsc --noEmit -p tsconfig.node.json`, `tsconfig.web.json`, `tsconfig.tests.json`, plus static hygiene.
- [x] Update relay baton with evidence and CI-only blockers.

## Review

- Graphify query was attempted first, but `graphify-out/graph.json` and `graphify-out/wiki/index.md` are absent in this worktree, so review proceeded through scoped raw files.
- `src/main/renderer-url.ts` owns overlay/decoder URL building; `src/main/index.ts` call sites pass `devEnv('ELECTRON_RENDERER_URL')`, matching historical guard `7d684b24`.
- `src/renderer/src/components/OnboardingDemoScene.tsx` keeps Act 2 `Next` disabled until `demoStepComplete(...)` and rechecks completion in the click handler before `advance()` / `onContinue()`.
- CI architecture failure was the ratchet's lowered-count case: `scripts/architecture-baseline.json` was already lowered for `src/main/index.ts` line count (`9884` to `9876`), not broadened for FF-14.
- Allowed checks:
  - `npx tsc --noEmit -p tsconfig.node.json` passed.
  - `npx tsc --noEmit -p tsconfig.web.json` passed.
  - `npx tsc --noEmit -p tsconfig.tests.json` reported the known 7 existing errors in Dust/transcripts tests, at the allowed ceiling.
  - `git diff --check` passed.
- Runtime Vitest, app launch, packaging, packaged smoke, and architecture script execution remain CI-only under the ticket constraints.
