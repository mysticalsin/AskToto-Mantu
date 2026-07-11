# BATON — Local LLM ("Métis Local") engagement

Updated: 2026-07-10 23:27 EDT · Model shift: Claude Fable 5 (Visionary)

## What this is
Feature engagement in AskToto (Métis): add local-LLM provider — llama-server sidecar
(pinned llama.cpp b9957) + Qwen3.5 small GGUFs (0.8B lite / 2B default / 4B pro) for
suggest / summary / vision; cloud (Dust etc.) keeps recap / answer / think / deep.
Owner: Tony. Executors: Sonnet subagents write code; Codex attacks plans/audits; Fable
plans/reviews.

## Where things stand (truthful now)
- Worktree: /Users/tony/AI-Brain-build/asktoto-local-llm · branch feat/local-llm @ e544111
  (OneDrive main checkout unusable for worktrees until .git fully hydrated — was fixed by
  `/usr/bin/find .git -type f | xargs cat > /dev/null`; rtk proxy breaks find -exec).
- PLAN: .rocket-fuel/PLAN.md v3 (post 2 Codex REVISE rounds; all findings IDS'd in
  meetings/001+002; cache-reuse blocker REBUTTED with README quote).
- Same Page Meeting: thread 019f4f1c-6bbb-7121-a0c2-e423b53170e6; r3 launch ABORTED
  (Codex usage limit, reset 23:40 EDT). Round counter still 3/5.
- Baseline: typecheck green; vitest 614 pass/19 skip; bidstackClient suite fails ONLY in
  agent sandbox (listen EPERM) — run test proofs with sandbox disabled.
- Spike in flight: /Users/tony/AI-Brain-build/llama-spike — b9957 mac binary extracted
  (tar.gz sha256 7a43fd3c4ddd30f3c408da7c80975503f18b829da023a7d0e34bdb6f1b1a056f);
  downloading unsloth/Qwen3.5-0.8B-GGUF UD-Q4_K_XL (558,772,480 B) + mmproj-F16.gguf
  (204,987,232 B) to prove load+text+vision on this mac.
- Tasks: #4 (codex review) in progress; #5 build, #6 verify, #7 ship pending.
- Estimate surfaced to Owner: 600k-1.2M tokens · 1.5-3 h · ≈ $25-50.

## Next single action
Await Rock 3 executor completion → dispatch Rock 4 (Settings card) then Rock 5 (prewarm
+ e2e proof) → Visionary re-proof of ALL rock proofs unsandboxed → codex Level-10 diff
attack (ship-audit) → commit on feat/local-llm → push + draft PR → G6 presentation to
Tony, delivery into the OneDrive checkout (Owner instruction 2026-07-11).

## Build progress
- Meeting closed at cap via Rule 3 (receipts meetings/001-006); PLAN v6; ROCKS.md locked.
- Rock 1 DONE (proof 13/13 + real spawn integration vs b9957 + 0.8B: health 200): fetch/
  guard scripts, local-runtime.ts, wiring in package.json/build-installers/build.yml/
  electron-builder.yml/.gitignore; AuditEvent gained local.runtime.*.
- Rock 2 DONE (proof 13/13, typecheck clean): local-models.ts manifest (0.8B+2B pinned),
  Range-resume + streamed sha256, RAM gate; note: local.model.* audit names cast — Rock 3
  removes cast after widening the union.
- Rock 3 IN FLIGHT: providers/ipc/store/llm dispatcher/shared llamaSlotOptions/openai
  two-key copy/local.ts strategy/index.ts eligibility+precedence+readiness/App.tsx gates
  +cascade/state.ts types/local-routing tests.
- Known env facts for verification: tests binding 127.0.0.1 need sandbox disabled;
  dustcli.test.ts fails UNsandboxed (hits real keychain) — run it sandboxED.
