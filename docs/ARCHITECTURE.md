# Architecture fitness functions

## FF-04: files over 800 lines

Every production file over 800 lines under `src/`, `operator/src/`, `intelligence/src/` and `scripts/` has a ceiling in `scripts/architecture-baseline.json` that may only fall, and a dated size target and owner ticket below. `npm run check:architecture` fails when the block drifts from `scripts/architecture-size-schedule.json`.

<!-- FF-04 size schedule: generated from scripts/architecture-size-schedule.json, do not edit -->
| File | Target lines | By | Owner ticket |
| --- | ---: | --- | --- |
| `intelligence/src/views/GraphView.tsx` | 800 | 2027-03-31 | M2-0247 |
| `operator/src/connectors/catalog.ts` | 800 | 2027-03-31 | M2-0247 |
| `operator/src/d1.ts` | 800 | 2027-03-31 | M2-0247 |
| `operator/src/dashboard.ts` | 800 | 2027-03-31 | M2-0247 |
| `operator/src/render/fixture.ts` | 800 | 2027-03-31 | M2-0247 |
| `operator/src/spa/css.ts` | 800 | 2027-03-31 | M2-0247 |
| `operator/src/store.ts` | 800 | 2027-03-31 | M2-0247 |
| `scripts/check-architecture.mjs` | 800 | 2027-03-31 | M2-0247 |
| `scripts/e2e-smoke.mjs` | 800 | 2027-03-31 | M2-0247 |
| `scripts/qa/e2e-workflows.mjs` | 800 | 2027-03-31 | M2-0247 |
| `scripts/qa/packaged-smoke.mjs` | 800 | 2027-03-31 | M2-0247 |
| `src/main/auth.ts` | 800 | 2027-03-31 | M2-0247 |
| `src/main/brain/corrections.ts` | 800 | 2027-03-31 | M2-0247 |
| `src/main/brain/ingest.ts` | 800 | 2027-03-31 | M2-0247 |
| `src/main/brain/publish.ts` | 800 | 2027-03-31 | M2-0247 |
| `src/main/brain/store.ts` | 800 | 2027-03-31 | M2-0247 |
| `src/main/cli.ts` | 800 | 2027-03-31 | M2-0247 |
| `src/main/import-jobs.ts` | 800 | 2027-03-31 | M2-0247 |
| `src/main/index.ts` | 300 | 2027-06-30 (m10) | M2-0247 |
| `src/main/recall.ts` | 800 | 2027-03-31 | M2-0247 |
| `src/main/store.ts` | 800 | 2027-03-31 | M2-0247 |
| `src/main/transcripts.ts` | 800 | 2027-03-31 | M2-0247 |
| `src/renderer/src/App.tsx` | 800 | 2027-03-31 | M2-0247 |
| `src/renderer/src/components/Bar.tsx` | 800 | 2027-03-31 | M2-0247 |
| `src/renderer/src/components/BrainRecordPage.tsx` | 800 | 2027-03-31 | M2-0247 |
| `src/renderer/src/components/BrainView.tsx` | 800 | 2027-03-31 | M2-0247 |
| `src/renderer/src/components/Onboarding.tsx` | 800 | 2027-03-31 | M2-0247 |
| `src/renderer/src/components/OnboardingExperience.tsx` | 800 | 2027-03-31 | M2-0247 |
| `src/renderer/src/components/RecallView.tsx` | 800 | 2027-03-31 | M2-0247 |
| `src/renderer/src/components/Review.tsx` | 800 | 2027-03-31 | M2-0247 |
| `src/renderer/src/components/Settings.tsx` | 800 | 2027-03-31 | M2-0247 |
| `src/renderer/src/lib/listen.ts` | 800 | 2027-03-31 | M2-0247 |
| `src/shared/ipc.ts` | 800 | 2027-03-31 | M2-0247 |
<!-- /FF-04 size schedule -->
