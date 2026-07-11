# Level 10 Review — Métis Local build

⚠️ DEGRADED: solo-visionary (Integrator usage limit at ship-audit launch; reset 4:40 AM —
cross-model diff attack auto-scheduled for after reset; this banner comes off when that
exact diff passes the Integrator's review)

Method: co-founder (V: claude · I: codex UNAVAILABLE for this pass) · 2026-07-11 01:40 EDT

1. Segue: all 5 rocks built by Sonnet executors under locked ROCKS.md; kickoff lane (not
   RF_MODE=build).
2. Scorecard — proofs RUN BY THE VISIONARY'S OWN HANDS:
   - Rocks DONE: 5/5.
   - `npm run typecheck` → exit 0 (both tsconfigs).
   - Full suite unsandboxed → 737 passed / 3 failed / 2 skipped; the 3 = dustcli.test.ts
     real-keychain environment collisions (pass sandboxed; pre-existing, untouched files).
   - `npm test -- local` → 109/109 across 5 suites incl. REAL sidecar spawn integration.
   - `node scripts/prove-local-ttft.mjs` (models from llama-spike) → "warm TTFT: 299 ms",
     exit 0; prefill 4336 tok/s, decode 135 tok/s.
   - git diff read IN FULL (16 edited files, +726/−62, 9 new files). Reward-hacking sweep:
     ZERO existing test files modified; zero .skip/.only introduced; proof scripts assert
     their actual contracts.
3. Rock review: R1-R5 proof commands re-executed, outputs above match ROCKS.md expectations.
4. Headlines:
   - Executor quality above expectation: chunk-boundary-safe port parsing, abort-during-
     start race handled, `.strict()` outbound IPC schemas (leak-proof by construction),
     snapshot readiness derived from the SAME helper routing uses (no drift possible).
   - dist:win relies on npm's predist:win lifecycle hook (verified npm behavior) — every
     other path carries the guard inline.
   - Residuals for G6: (a) live Windows spawn smoke needs win hardware (CI guard + platform-
     parameterized tests cover the rest); (b) interactive UI click-through not performed
     (headless session) — Settings card exercised via typecheck+schema tests only;
     (c) Integrator ship-audit pending quota reset (this banner).
5. To-dos: none open from build (executor deviations were all accepted-and-documented).
6. IDS: no failures to solve — no fix briefs issued.
7. Conclude: meeting rated 9/10 (deduction: cross-model audit blocked by quota).
   VERDICT: SHIP (Visionary hands; DEGRADED pending Integrator pass + Owner G6).

Phase score: 92/100 — deductions: integrator pass unavailable (−6, environmental), UI
click-through residual (−2). Improvement applied: ship-audit scheduled mechanically
(cron at quota reset) instead of relying on a manual follow-up.
