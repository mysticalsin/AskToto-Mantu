# AGENTS.md — Métis (AskToto-Mantu)

Instructions for every coding agent working in this repository: OpenAI Codex, Cursor, Claude Code,
ChatGPT (GitHub plugin), Antigravity and humans. Keep it short enough to read every session.

## 1. Start every session here

1. Read `_relay/HANDOFF.md` in the private program repository `mysticalsin/Metis-2.0-Program` — the live baton.
   It is fresher than git log. Honour its "Decisions made". (`_relay/` is git-ignored here because this repository is public.)
2. If you are working on Métis 2.0, the plan, ticket ledger and evidence live in the private program repository `mysticalsin/Metis-2.0-Program`
   (`docs/metis-2.0/`). Read its `README.md`, then only the ticket you are assigned (`docs/metis-2.0/ledger/tickets/M2-####.md`).
   Do not reload the whole plan or kit for every subtask. Program documents never go into this public repository.
3. Say in one line what you are resuming, then work.

## 2. What this repository is

Métis (npm package `asktoto`, bundle id `com.mantu.asktoto`) is an Electron + React + TypeScript desktop
meeting copilot / note-taker: a frameless, transparent, always-on-top overlay for macOS and Windows.

| Path | Role |
|---|---|
| `src/main/` | Electron main process: lifecycle, windows, IPC handlers, sidecars (local LLM, ASR, watchers), brain/recall data |
| `src/preload/` | contextBridge API exposed to the renderer (`window.toto`) |
| `src/renderer/` | React UI (overlay bar, panels, Review, History/Recall, Settings, onboarding) |
| `src/shared/` | Types and IPC channel contracts shared by main and renderer |
| `operator/` | Cloudflare Worker "Operator" admin backend (D1) + its client |
| `cloudflare-proxy/` | Cloudflare Worker proxy for provider traffic |
| `license-server/` | License service (separate `npm test`) |
| `intelligence/` | Mantu Intelligence sub-app bundle |
| `native-app/`, `native/` | Swift MetisKit / native macOS helper |
| `scripts/` | Build, packaging, release and gate scripts |
| `docs/` | Product and engineering docs (the 2.0 program docs live in the private program repository `mysticalsin/Metis-2.0-Program`) |

## 3. Commands

Node `22.22.3` (`.nvmrc`). Install with `npm ci`.

**Hard rule: where tests may run (owner decision D-28, 2026-09-26): CI only.** At `2bf21f1c`, test processes
resolved the owner's real OneDrive meetings folder and quarantined the real brain index; M2-0001 fixed the resolution,
but the owner has decided that no repository test, script or app runs on any Mac (`npm test`, `npx vitest`,
`node --test`, `npm run dev`, `npm run typecheck`'s node checks included). Tests run only in GitHub Actions: push the
branch and read the run with `gh run view`. `npx tsc --noEmit -p <tsconfig>` is allowed locally because it executes no
repository code. The commands below are subject to this rule.

| Purpose | Command |
|---|---|
| Type-check everything | `npm run typecheck` |
| All tests (desktop + proxy + operator + mode-skills lock) | `npm test` |
| One test file | `npx vitest run path/to/file.test.ts` |
| Dev app | `npm run dev` |
| Production bundle (no installer) | `npm run build` |
| Skipped-test audit | `npm run check:skips` |

Never run `dist*`, `release*`, `installers*`, `deploy:operator`, `migrate:operator` or `embed-cloudflare-key`
scripts unless the ticket explicitly authorizes it: they embed keys, sign binaries, deploy or migrate.
Pushing a `v*` tag triggers the public release pipeline — never push tags.

## 4. Métis 2.0 program conventions

- **Ticket IDs.** Program tickets are `M2-0001`…, defined in `docs/metis-2.0/ledger/` of the private program repository `mysticalsin/Metis-2.0-Program`. Each ticket lists the kit
  references it satisfies (`TASK-027`, `UC-014`, `OBU-02`, `HMSTEP-05`, …) and review findings it closes
  (`L01-F3`, `B2-F1`, …). Never renumber or delete a ticket; mark it `CANCELLED` with a reason instead.
- **Branches.** `m2/M2-0001-short-slug` for program work, `fix/<slug>` for hotfixes. Branch from `main`.
- **Commits.** Conventional commits with the ticket id: `fix(recall): cap read concurrency [M2-0012]`.
- **Pull requests.** One ticket per PR, targeting `main`, using `.github/pull_request_template.md`. Keep a PR
  in draft until its Opus validation is recorded in the ticket. No direct pushes to `main`.
- **Ledger and merges.** Only the Opus orchestrator edits ticket status in `ledger/tickets.json` and merges PRs,
  in merge-queue order (M2-0188). Ask it to claim a ticket; do not change status yourself.
- **Evidence levels** (from the Stark method, distinct and unordered): `DESIGNED`, `LOCALLY_TESTED`,
  `HOST_CONFIGURED`, `LIVE_VERIFIED`, `ACCEPTED`, `MEASURED`. Claims use the software-architecture-engineer labels
  `OBSERVED`, `PROVIDED`, `DERIVED`, `ASSUMED`, `PROPOSED`, `UNKNOWN`. Anything that needs an outside account or owner
  is `BLOCKED_EXTERNAL` with the exact unblock step. Work that relies on an open decision (`needs_decision`) uses its
  recorded default and says so as `ASSUMED`.
- **No fakes in production paths.** No mock metrics, stub endpoints, guessed model IDs, placeholder receipts or
  "success" templates outside tests.
- **Tests first.** Reproduce a bug with a failing test before fixing it; keep the test.

## 5. Who does what

| Agent | Role |
|---|---|
| Claude Code (Opus) | Plans, validates every deliverable, implements design/animation work |
| Claude Code (Sonnet) | Implements ledger tickets in isolated worktrees |
| OpenAI Codex / ChatGPT | Independent audits and reviews; reviews never approve their own work |
| Cursor | Human-driven edits; follow the same tickets, branches and PR template |

A reviewer never approves work it wrote. A different model's agreement is not end-to-end proof — run the checks.

## 6. Guardrails

- No secrets, tokens, account IDs or personal emails in code, docs, commits, `_relay/` or PR text.
- Preserve existing security controls (IPC sender validation, content protection, encryption at rest, audit hash chain).
- Apple public signing/notarization is out of scope for the 2.0 program.
- Meeting content is private user data: never paste transcripts into issues, PRs, logs or prompts.

## Relay Baton — shift handoff (MANDATORY)

This project uses `_relay/HANDOFF.md` in the private program repository `mysticalsin/Metis-2.0-Program` as shared memory between AI tools (Claude Code, Codex, Cursor, Antigravity, Xcode). Treat every session as a shift:

1. **Shift start:** Read `_relay/HANDOFF.md` BEFORE anything else. It is the freshest ground truth. Honor the "Decisions made" section — do not relitigate settled decisions. Tell the user in one line what you're resuming.
2. **During:** Update `HANDOFF.md` at milestones and the moment you hit a blocker.
3. **Shift end:** Archive the current baton to `_relay/archive/<YYYY-MM-DD-HHMM>-<your-tool-name>.md`, then rewrite `HANDOFF.md` as a fresh snapshot: frontmatter (project, shift n+1, agent, updated, status) + sections: **Current state** (verifiable facts), **Done this shift**, **Blockers** (exact errors), **Next steps** (ordered, executable without conversation context), **Decisions made (don't relitigate)**, **Watch out**.

Rules: facts over narrative; name files/commands/errors; never delete `archive/`; no secrets in `_relay/`; commit `_relay/` to the private program repository, never to this public one.
