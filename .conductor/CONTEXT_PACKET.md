# Context Packet — 2026-08-08-1543

## Project: Asktoto
## Branch: fix/windows-audit-and-release-gate

## Uncommitted Changes
 M .conductor/CONTEXT_PACKET.md
 M .github/workflows/build.yml
 M package.json
 M src/main/ask-freshness.contract.test.ts
 M src/main/index.ts
 M src/main/llm/local-prewarm.test.ts
 M src/main/llm/local-routing.ts
 M src/main/platform-perms.test.ts
 M src/main/platform-perms.ts
 M src/main/store.test.ts
 M src/main/store.ts
 M src/shared/ipc.ts
 M src/shared/providers.test.ts
 M src/shared/providers.ts
?? docs/qa/BUG-LEDGER.md
?? scripts/check-bug-ledger.mjs
?? scripts/qa/
?? src/main/llm/provider-health.test.ts
?? src/main/llm/provider-health.ts
?? src/main/provider-health-ux.contract.test.ts

## Recent Commits (last 5)
03068d1 chore(conductor): refresh context packet after the local-fallback commit
dda7c7a feat(local): enable on-device AI by default as a non-preempting safety net, surface indexing failures
6bdbb66 feat(brain): fall back to on-device local model when the cloud index waterfall is exhausted
2db18a7 docs(win): correct AskToto -> Métis managed-config paths, spell out the exact ProgramData path
6ea40f9 fix(win): separate AppX/Store output from the NSIS feed, skip self-update in Store packages, add a real-launch release gate

## Active Tasks


## Mistakes Count
0 lines in MISTAKES.md

## Resume Instructions
1. Read this file + MISTAKES.md + PROGRESS.md
2. Check branch status and uncommitted changes
3. Continue from the first incomplete task
