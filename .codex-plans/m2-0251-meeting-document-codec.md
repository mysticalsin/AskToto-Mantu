# M2-0251 meeting-document codec closeout

- [x] Read AGENTS.md and attempted baton/vault startup reads.
- [x] Query graphify before raw file reads; graph missing in this worktree.
- [x] Read scoped files and existing tests.
- [x] Patch reviewer-required duplicate confidential behavior.
- [x] Run allowed TypeScript verification.
- [x] Record review/evidence.

## Review / Evidence

- Changed `isMeetingConfidentialOnDisk` to keep its missing/undecryptable/missing-frontmatter fail-closed guard, then use `hasMeetingFlag(text, 'confidential')` so any duplicated `confidential: true` wins.
- Added the defense-in-depth regression for `confidential: true` followed by `confidential: false` in the meeting frontmatter.
- Added the advisory `serialize` invariant comment: frontmatter data, body and line endings are preserved, while delimiter trailing whitespace is canonicalized.
- Verified `npx tsc --noEmit -p tsconfig.node.json`: pass.
- Verified `npx tsc --noEmit -p tsconfig.web.json`: pass.
- Verified `npx tsc --noEmit -p tsconfig.tests.json`: 7 errors, all unrelated existing errors in `src/main/llm/dust*.test.ts` and `src/main/transcripts.test.ts`; meets the stated bar of not exceeding 7 errors.
- Static inspected production frontmatter delimiter surface with `rg` excluding tests and the codec. Remaining hits are prompt separator strings in `src/main/personas.ts` and codec-delegating helpers in `src/main/brain/publish.ts`; no independent meeting-frontmatter delimiter regex found outside `src/main/features/meetings/meeting-document.ts`.
- Addressed CI run 36735477064 quality failure: `src/main/recall.ts` was 918 lines against the FF-04 baseline of 917, so removed one non-semantic blank line; `wc -l src/main/recall.ts` now reports 917.
- Re-ran allowed verification after the CI-failure fix: `npx tsc --noEmit -p tsconfig.node.json` pass; `npx tsc --noEmit -p tsconfig.web.json` pass; `npx tsc --noEmit -p tsconfig.tests.json` still reports 7 unrelated existing errors in `src/main/llm/dust*.test.ts` and `src/main/transcripts.test.ts`, within the stated bar.
- Did not run Vitest, npm scripts, dev/build, Electron, git write commands, deploys, tags or releases.
