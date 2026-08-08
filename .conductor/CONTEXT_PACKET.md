# Context Packet — 2026-08-08-0126

## Project: Asktoto
## Branch: fix/windows-audit-and-release-gate

## Uncommitted Changes
 M .conductor/CONTEXT_PACKET.md
 M docs/cahe-windows-edition.md
 M src/main/brain/attention.test.ts
 M src/main/brain/attention.ts
 M src/main/brain/ingest-index-fallback.test.ts
 M src/main/brain/ingest.ts
 M src/main/index.ts
 M src/main/llm/local-routing.test.ts
 M src/main/llm/local-routing.ts
 M src/main/pinned-agent-boundary.contract.test.ts
 M src/renderer/src/App.tsx
 M src/renderer/src/components/BrainRecordPage.tsx
 M src/renderer/src/components/BrainView.tsx
 M src/renderer/src/components/RecallView.tsx
 M src/renderer/src/components/Settings.tsx
 M src/shared/brain.ts
 M src/shared/ipc.local-models.test.ts
 M src/shared/ipc.test.ts
 M src/shared/ipc.ts

## Recent Commits (last 5)
6bdbb66 feat(brain): fall back to on-device local model when the cloud index waterfall is exhausted
2db18a7 docs(win): correct AskToto -> Métis managed-config paths, spell out the exact ProgramData path
6ea40f9 fix(win): separate AppX/Store output from the NSIS feed, skip self-update in Store packages, add a real-launch release gate
2e50eb2 fix(win): gate DPAPI->file convergence on the active write backend, retry draft unlink under file locks
a97073f fix(win): quote every cmd-shim argument, stop an abort-signal race from orphaning child processes

## Active Tasks


## Mistakes Count
0 lines in MISTAKES.md

## Resume Instructions
1. Read this file + MISTAKES.md + PROGRESS.md
2. Check branch status and uncommitted changes
3. Continue from the first incomplete task
