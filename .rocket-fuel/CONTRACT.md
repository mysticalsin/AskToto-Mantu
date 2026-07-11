# Rocket Fuel — Engagement Contract

Date: 2026-07-10
Mode: kickoff (feature engagement inside existing repo — full pipeline: plan → Same Page Meeting → rocks → build → Level 10 → excellence loop → ship gate)

## Accountability Chart

| Seat | Who | Accountabilities |
|---|---|---|
| Visionary | Claude (Fable 5) | Vision, PLAN.md, standards, big calls, final review. Never builds in delegated-build lanes. |
| Integrator | Codex CLI (codex-cli 0.142.4) | Attacks the plan read-only, builds/audits delegated rocks, reports with proof. Tie-breaker on execution stalemates. |
| Owner | Tony Walteur | Interview answers, vision-level deadlocks, degradation acknowledgments, G6 ship approval. |

## Engagement

Feature: embed a local LLM runtime (llama.cpp `llama-server` sidecar + Qwen3.5 small
models) into Métis (AskToto Electron app) as a new `local` provider — handling lightweight
tasks (live suggestions, summaries, screenshot understanding) on-device, with heavy tasks
(recaps, deep answers, brain Q&A) staying on cloud providers (Dust et al.).

Build executor note (Owner directive): implementation code is written by Sonnet-class
subagents; Fable plans and reviews; Codex attacks and audits.

Environment note: the primary checkout lives on OneDrive where `git worktree add`
initially failed (`fatal: mmap failed` — dataless File Provider placeholders); fixed by
full `.git` hydration. Work happens in the worktree `/Users/tony/AI-Brain-build/asktoto-local-llm`
on branch `feat/local-llm`. Never push to main; ship = push branch + draft PR + Owner G6.
