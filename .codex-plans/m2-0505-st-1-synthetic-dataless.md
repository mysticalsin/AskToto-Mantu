# M2-0505 ST-1 Synthetic Dataless

- [x] Inspect graph/wiki and scoped files
- [x] Resolve st-1 merge conflicts preserving both sides
- [x] Implement synthetic-dataless fixture/history-off/verdict behavior
- [x] Add/extend stat-flags local-only behavior
- [x] Update qa-candidate workflow and contract coverage
- [x] Run allowed tsc checks and record results

## Review

- Resolved the merge conflicts in `scripts/qa/lib/st-1-core.mjs` and `scripts/qa/st-1.mjs`, keeping synthetic-dataless fixture reporting, History idle mode, the History-row criteria switch, and window-construction reporting.
- Preserved bare `--history` as the History row and added `--history off` as the History-idle mode for synthetic dataless. `--history on` is accepted as explicit default probe mode.
- Confirmed the synthetic-dataless report path records fixture kind, fixture counts, FIFO-open exercise evidence, `sfDatalessSet`, `historyMode`, and raw history samples.
- Confirmed `qa-candidate.yml` includes `st1-mac-dataless-synthetic`, verifies both mac artifacts against provenance, runs `--fixtures synthetic-dataless --history off --minutes 5`, writes the real-cloud dataless NOT_RUN_ON_HOSTED row with the sudo SF_DATALESS probe, runs `stat-flags-fixture.sh --local-only` against the DMG helper, uploads required artifacts with `if: always()`, and keeps job-level `continue-on-error` equal to `st1-mac-fifo`.
- Confirmed no conflict markers remain in the scoped files with `rg -n "<<<<<<<|=======|>>>>>>>" ...`.
- Verified `npx tsc --noEmit -p tsconfig.node.json`: pass.
- Verified `npx tsc --noEmit -p tsconfig.web.json`: pass.
- Verified `npx tsc --noEmit -p tsconfig.tests.json`: 5 errors, all outside this ticket in `src/main/llm/dust*.test.ts` and `src/main/transcripts.test.ts`; within the allowed bar of not exceeding 7 errors.
- Did not run Vitest, npm scripts, Node on repository files, dev/build, Electron, git write commands, deploys, tags or releases.
