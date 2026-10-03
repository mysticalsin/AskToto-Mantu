# Architecture fitness functions

## FF-04: files over 800 lines

Every production file over 800 lines under `src/`, `operator/src/`, `intelligence/src/` and `scripts/` has a ceiling in `scripts/architecture-baseline.json` that may only fall, and a dated size target plus owner ticket or lead-action handoff below. `npm run check:architecture` fails when the block drifts from `scripts/architecture-size-schedule.json`.
Rows marked `LEAD_ACTION` are placeholder targets until the lead assigns follow-up owner tickets.

<!-- FF-04 size schedule: generated from scripts/architecture-size-schedule.json, do not edit -->
| File | Target lines | By | Owner ticket / action |
| --- | ---: | --- | --- |
| `intelligence/src/views/GraphView.tsx` | 800 | 2027-03-31 | LEAD_ACTION: assign follow-up owner tickets in architecture-size-schedule.json |
| `operator/src/connectors/catalog.ts` | 800 | 2027-03-31 | LEAD_ACTION: assign follow-up owner tickets in architecture-size-schedule.json |
| `operator/src/d1.ts` | 800 | 2027-03-31 | LEAD_ACTION: assign follow-up owner tickets in architecture-size-schedule.json |
| `operator/src/store.ts` | 800 | 2027-03-31 | LEAD_ACTION: assign follow-up owner tickets in architecture-size-schedule.json |
| `scripts/check-architecture.mjs` | 800 | 2027-03-31 | LEAD_ACTION: assign follow-up owner tickets in architecture-size-schedule.json |
| `scripts/evidence/check.mjs` | 800 | 2027-03-31 | LEAD_ACTION: assign follow-up owner tickets in architecture-size-schedule.json |
| `scripts/qa/candidate-scenarios.mjs` | 800 | 2027-03-31 | LEAD_ACTION: assign follow-up owner tickets in architecture-size-schedule.json |
| `scripts/qa/census/lib.mjs` | 800 | 2027-03-31 | LEAD_ACTION: assign follow-up owner tickets in architecture-size-schedule.json |
| `scripts/qa/hk-m.mjs` | 800 | 2027-03-31 | LEAD_ACTION: assign follow-up owner tickets in architecture-size-schedule.json |
| `scripts/qa/sidecar-boot-reaper.mjs` | 800 | 2027-03-31 | LEAD_ACTION: assign follow-up owner tickets in architecture-size-schedule.json |
| `scripts/qa/st-1.mjs` | 800 | 2027-03-31 | LEAD_ACTION: assign follow-up owner tickets in architecture-size-schedule.json |
| `src/main/auth.ts` | 800 | 2027-03-31 | LEAD_ACTION: assign follow-up owner tickets in architecture-size-schedule.json |
| `src/main/brain/corrections.ts` | 800 | 2027-03-31 | LEAD_ACTION: assign follow-up owner tickets in architecture-size-schedule.json |
| `src/main/brain/ingest.ts` | 800 | 2027-03-31 | LEAD_ACTION: assign follow-up owner tickets in architecture-size-schedule.json |
| `src/main/brain/publish.ts` | 800 | 2027-03-31 | LEAD_ACTION: assign follow-up owner tickets in architecture-size-schedule.json |
| `src/main/brain/store.ts` | 800 | 2027-03-31 | LEAD_ACTION: assign follow-up owner tickets in architecture-size-schedule.json |
| `src/main/cli.ts` | 800 | 2027-03-31 | LEAD_ACTION: assign follow-up owner tickets in architecture-size-schedule.json |
| `src/main/import-jobs.ts` | 800 | 2027-03-31 | LEAD_ACTION: assign follow-up owner tickets in architecture-size-schedule.json |
| `src/main/index.ts` | 300 | 2027-06-30 (m10) | LEAD_ACTION: assign follow-up owner tickets in architecture-size-schedule.json |
| `src/main/store.ts` | 800 | 2027-03-31 | LEAD_ACTION: assign follow-up owner tickets in architecture-size-schedule.json |
| `src/main/transcripts.ts` | 800 | 2027-03-31 | LEAD_ACTION: assign follow-up owner tickets in architecture-size-schedule.json |
| `src/renderer/src/App.tsx` | 800 | 2027-03-31 | LEAD_ACTION: assign follow-up owner tickets in architecture-size-schedule.json |
| `src/renderer/src/components/Bar.tsx` | 800 | 2027-03-31 | LEAD_ACTION: assign follow-up owner tickets in architecture-size-schedule.json |
| `src/renderer/src/components/BrainRecordPage.tsx` | 800 | 2027-03-31 | LEAD_ACTION: assign follow-up owner tickets in architecture-size-schedule.json |
| `src/renderer/src/components/BrainView.tsx` | 800 | 2027-03-31 | LEAD_ACTION: assign follow-up owner tickets in architecture-size-schedule.json |
| `src/renderer/src/components/Onboarding.tsx` | 800 | 2027-03-31 | LEAD_ACTION: assign follow-up owner tickets in architecture-size-schedule.json |
| `src/renderer/src/components/OnboardingExperience.tsx` | 800 | 2027-03-31 | LEAD_ACTION: assign follow-up owner tickets in architecture-size-schedule.json |
| `src/renderer/src/components/RecallView.tsx` | 800 | 2027-03-31 | LEAD_ACTION: assign follow-up owner tickets in architecture-size-schedule.json |
| `src/renderer/src/components/Review.tsx` | 800 | 2027-03-31 | LEAD_ACTION: assign follow-up owner tickets in architecture-size-schedule.json |
| `src/renderer/src/features/settings/AiSection.tsx` | 800 | 2027-03-31 | LEAD_ACTION: assign follow-up owner tickets in architecture-size-schedule.json |
| `src/renderer/src/features/settings/AudioTab.tsx` | 800 | 2027-03-31 | LEAD_ACTION: assign follow-up owner tickets in architecture-size-schedule.json |
| `src/renderer/src/features/settings/DustSetup.tsx` | 800 | 2027-03-31 | LEAD_ACTION: assign follow-up owner tickets in architecture-size-schedule.json |
| `src/renderer/src/features/settings/SettingsRoot.tsx` | 800 | 2027-03-31 | LEAD_ACTION: assign follow-up owner tickets in architecture-size-schedule.json |
| `src/renderer/src/lib/listen.ts` | 800 | 2027-03-31 | LEAD_ACTION: assign follow-up owner tickets in architecture-size-schedule.json |
| `src/shared/ipc.ts` | 800 | 2027-03-31 | LEAD_ACTION: assign follow-up owner tickets in architecture-size-schedule.json |
<!-- /FF-04 size schedule -->
