# Métis Quality Scorecard

**Owner:** QA + platform · **Updated with:** Second-Brain Rebuild Wave 0  
**Purpose:** Single place to track whether Métis is getting better. Every wave must move at least one row green before ship.

Sources of truth for live numbers: `src/main/metrics.ts` (`aggregateMetrics`), Settings → Diagnostics, and `scripts/qa/asr-fixtures/` offline WER.

## Scorecard

| Metric | Target | Baseline | Measurement | Wave gate |
|---|---|---|---|---|
| WER Whisper (fast/floor) | ≤ 8 % | ~12 % | ASR fixtures + optional on-device calibrate clip | Wave 1 |
| WER Parakeet (EU live) | ≤ 6 % | — | `scripts/qa/asr-fixtures/en|fr` | Wave 1 |
| Partial / interim transcript latency p50 | < 300 ms | N/A (finals-only) | VAD endpoint → provisional UI emit | Wave 1 |
| Partial transcript latency p95 | < 600 ms | N/A | same | Wave 1 |
| Final commit latency p50 (endpoint → final line) | < 900 ms | — | listen pump metrics | Wave 1 |
| Answer TTFT p50 | < 1 000 ms | ~900 ms | `audit.log ttftMs` | Wave 2 |
| Answer TTFT p95 | < 2 000 ms | ~1 800 ms | `audit.log ttftMs` | Wave 2 |
| Failover success (failover resolves ask) | ≥ 95 % | — | `fallbacks / (failures + fallbacks)` | Wave 2 |
| Recap section completeness (Title+Actions+Open Q) | ≥ 98 % of saves | — | parse saved markdown headings | Wave 1 |
| Brain LLM consolidations / active day | ≤ 2 | per-meeting | `brain.tokens` / consolidation counter | Wave 3 |
| Brain tokens / active day (soft cap) | tracked | — | `metrics` brain ingest events | Wave 3 |
| MCP push success (first try or retry) | ≥ 99 % | — | push queue audit | Wave 4 |
| MCP push never drops meeting file | 100 % | — | contract + e2e | Wave 4 |
| Onboarding to first Listen | < 60 s | — | physical QA stopwatch | Wave 5 |
| Crash-free sessions | ≥ 99.5 % | — | unhandled exception log | every |
| User acceptance (thumbs-up / rated) | ≥ 75 % | — | `acceptance.rate` | Wave 6 |
| Closing-rate sample caveat shown when n < 5 | 100 % | — | Intelligence StatsView | Wave 6 |

## How to refresh

```bash
npm test -- scripts/qa/asr-fixtures
npm test -- src/main/metrics
# Physical: scripts/qa/e2e-workflows.mjs against a signed/dev build
```

Record deltas in the PR that closes a wave. Do not edit targets without Product sign-off.

## Related

- Architecture H.10 — historical targets in `docs/asktoto-architecture.md`
- Provider policy — `docs/PROVIDER-ROUTING-POLICY.md`
- Bug ledger — `docs/qa/BUG-LEDGER.md`
