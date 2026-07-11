# Cross-model ship-audit + excellence loop — final record

Method: co-founder (V: claude · I: codex gpt-5.5) · 2026-07-11 07:20-08:30 EDT
Driver: rf-codex.sh read-only sessions, deterministic verdict parse each round.

## Round ledger

| Round | Verdict | Findings → disposition |
|---|---|---|
| r1 (01:40) | ABORTED | usage limit; rescheduled mechanically |
| r2 (07:15) | REVISE | 5 blockers + 4 risks → 4 bugs fixed (start-race, model-switch, quit-kill, prewarm prefix parity) + 2 hardening (cold-start sha256, prewarm allowlist); 1 rebutted (post-install model download = PLAN §4.5 design); 1 accepted-documented (abort-during-start) — commit c810f77 |
| r3 | REVISE | 2 blockers + 1 risk → generation-guarded exit handler, switch-time integrity re-verify; history-parity limitation documented honestly — commit 0c7c35e |
| r4 | REVISE | per-site requireProvider audit (1 change: summarize), honk gate reverted to providerReady (fires answer mode); contract test added; download-flow re-raise stayed rebutted — commit 465f5ec |
| r5 | REVISE | summarize chip itself was unreachable (QuickActions uniform disable) → per-chip enable — commit d4bc516; env-only vitest note discarded |
| r6 | REVISE | Rule 3 tie-break adopted: whatnext chip local-capable via its suggest route → enabled via localSuggestReady, text route re-gated bare — commits 48e3d81 + 6b7fef8 |
| r7 (08:28) | **SHIP** | zero findings — `VERDICT: SHIP`, rf-codex verdict exit 0 |

## Proof state at SHIP
typecheck clean (both tsconfigs) · vitest 788 passed / 2 skipped / 3 failed (the known
dustcli real-keychain environment trio, files untouched) · warm suggest TTFT 307 ms
(scripts/prove-local-ttft.mjs, exit 0) · every fix verified to FAIL on reverted source.

## Loop discipline
Refinement rounds consumed the full budget and stopped: findings narrowed monotonically
(9 → 3 → 3 → 1 → 1 → 0). Every fix cycle re-proved the whole suite plus the TTFT script
before the next attack. The final SHIP came from a fresh adversarial pass told explicitly
that the budget was spent and only evidence-backed defects counted.

Phase score: 95/100 — deductions: the r5/r6 chip-reachability class should have been
caught by the Visionary's own Level-10 UI review (−4), and one contract-test scope bug
briefly landed on the branch before being fixed (−1). Improvement applied: renderer
reachability (can the user actually REACH the gated path?) added to the standing review
checklist alongside gate correctness; never pipe a proof's exit code through grep before
committing.
