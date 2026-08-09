# Context Packet — 2026-08-08-2017

## Project: Asktoto
## Branch: fix/windows-audit-and-release-gate

## Uncommitted Changes
 M .conductor/CONTEXT_PACKET.md
 M docs/cahe-windows-edition.md
 M src/main/brain/ingest.ts
 M src/main/brain/publish.test.ts
 M src/main/brain/publish.ts
 M src/main/cli.test.ts
 M src/main/cli.ts
 M src/main/ffmpeg-decoder.test.ts
 M src/main/ffmpeg-decoder.ts
 M src/main/graphify.test.ts
 M src/main/graphify.ts
 M src/main/index.ts
 M src/main/llm/dust.test.ts
 M src/main/llm/dust.ts
 M src/main/llm/retry.test.ts
 M src/main/llm/retry.ts
 M src/main/mcp/bidstackClient.ts
 M src/main/metrics.test.ts
 M src/main/metrics.ts
 M src/main/parakeet.ts
 M src/main/recall.test.ts
 M src/main/recall.ts
 M src/main/speaker-id.test.ts
 M src/main/transcripts.test.ts
 M src/main/transcripts.ts
 M src/main/updater.test.ts
 M src/main/updater.ts
 M src/renderer/src/App.tsx
 M src/renderer/src/components/Answer.test.tsx
 M src/renderer/src/components/Answer.tsx
 M src/renderer/src/components/BrainRecordPage.test.ts
 M src/renderer/src/components/BrainRecordPage.tsx
 M src/renderer/src/components/Onboarding.helpers.test.ts
 M src/renderer/src/components/Onboarding.tsx
 M src/renderer/src/components/OnboardingExperience.tsx
 M src/renderer/src/components/Review.tsx
 M src/renderer/src/components/Settings.contract.test.ts
 M src/renderer/src/components/Settings.tsx
 M src/renderer/src/lib/listen.ts
 M src/renderer/src/lib/tap/tap-control.ts
 M src/renderer/src/lib/vad.test.ts
 M src/renderer/src/lib/vad.ts
 M src/shared/redact.test.ts
 M src/shared/redact.ts
?? src/main/brain/ingest-audit-fixes.test.ts
?? src/main/index-audit-fixes.contract.test.ts
?? src/main/mcp/bidstackClient.audit.test.ts
?? src/renderer/src/app-audit-fixes.contract.test.ts
?? src/renderer/src/components/Review.audit.test.ts
?? src/renderer/src/lib/tap/tap-control.audit.test.ts

## Recent Commits (last 5)
0f28626 fix(qa): close 23 high-severity audited findings, each pinned by a regression test
4cd99e4 fix(qa): record 92 audited findings and fix the critical + highest-impact ones
84000c3 feat(qa): add DeepSeek V4, fix the dead-API-key path, make first-run readiness cross-platform
03068d1 chore(conductor): refresh context packet after the local-fallback commit
dda7c7a feat(local): enable on-device AI by default as a non-preempting safety net, surface indexing failures

## Active Tasks


## Mistakes Count
0 lines in MISTAKES.md

## Resume Instructions
1. Read this file + MISTAKES.md + PROGRESS.md
2. Check branch status and uncommitted changes
3. Continue from the first incomplete task
