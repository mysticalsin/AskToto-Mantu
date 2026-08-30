# Métis (asktoto) — Product review & improvement roadmap (2026-08-29)

A full-application audit against the product vision: an on-device "second brain" meeting
copilot that captures voice/screen accurately, answers in real time (local model or API with
automatic background failover), produces a beautiful post-meeting summary with next steps, and
pushes structured meeting data into a CRM / other tools over MCP or APIs — with Apple-grade,
never-laggy UX, on native macOS and a Windows `.exe`, both fed by the existing GitHub release
update feed.

This document is the map + prioritized plan. It is deliberately honest about what already
exists (this codebase is far more mature than a first glance suggests: ~3,400 passing tests, a
mechanical `BUG-LEDGER`, a real failover stack) and about where the gaps are.

The full subsystem findings (with file/line citations) were produced by a six-way parallel
audit; this file is the synthesis and the actionable plan. The first increment
(**MQA-271**, below) is already implemented and tested in this branch.

---

## TL;DR — how the product maps to reality today

| Vision pillar | Reality | Biggest gap |
|---|---|---|
| Capture voice/screen accurately | Whisper + Parakeet + Apple Speech, VAD, loopback+mic, speaker ID | Packaged default is `whisper-base` WASM (not "best"); non-English decodes as English until a probe lands; 6 s hard window cuts sentences; single-threaded decode drops audio under load |
| Local model when selected, API otherwise, auto background failover | **Already substantial**: `pickFailover` waterfall, cooldowns, retries, hedging, 3-tier local routing | Not missing plumbing — a few correctness edges where "local looks ready" but isn't, and failover latency (stacked SDK retries) |
| Beautiful summary + next steps | `RECAP_PROMPT` (9 sections, mode focus, think-tier, anti-AI-tell) auto-fires at meeting end | Action items are prose-first with brittle owner/date parsing; no dedicated structured Review UI; recap next-steps and brain "commitments" are two unsynced pipelines |
| Second brain that corrects you | Real ingest/merge/correction stack (`.brain/`), Receipt-Mode context, grounding rail | Context injected only on typed asks (not live `suggest`); corrections are manual; a *second* graph (`graphify`) runs in parallel and diverges |
| Push to CRM via MCP/API | Security-hardened push-only MCP client (Streamable HTTP, ClickUp OAuth); "Push to CRM" + "Book next steps" | CRM gets 3 strings (`title/date/summary`); rich brain data unused; no field mapping, no stable idempotency key on the wire, no pull |
| Native Mac + Windows exe on same update feed | **Already one codebase, two packagers**; `native-app/` is a separate SwiftUI flagship track | Do **not** split the Electron source — see "Packaging" below |
| Apple-grade, never laggy | Heavily hardened renderer (rAF streaming, resize physics, code-split views) | Monolithic 3.3k-line `App.tsx`, 28 idle IPC listeners, streaming-time markdown re-parse + resize + Shiki, dual visual systems, native `confirm()` dialogs |

---

## Recommendation on "two sources (Native + Exe)"

**Keep one Electron source; do not fork it.** The repo is already structured as one TypeScript
codebase with platform packaging overlays (`electron-builder.yml` + `electron-builder.win.yml`),
platform-scoped native sidecars, and a single tagged release that publishes mac + Windows
artifacts together to `mysticalsin/Metis-Releases` with cross-validated `latest-mac.yml` /
`latest.yml`. ~95% of the logic (brain, routing, IPC, renderer) is shared. Splitting duplicates
the highest-churn code and breaks the version-synchronized update feed.

The genuine "native macOS" path already exists as `native-app/` (SwiftUI + MetisKit, Apple
Intelligence). That is an App-Store-distributed product with its own update mechanism — fund it
as a separate track if desired, but it is **not** a reason to fork the Electron app, and it does
not use `latest-mac.yml`.

"The update folders we have set up on git" = the public `Metis-Releases` repo (+ its Forgejo
twin via `scripts/push-both.sh`), not a tracked `release/` dir (that is build output, gitignored).

---

## Prioritized roadmap

Phased so each item ships as a small, tested, reviewable increment. Severities and IDs will be
tracked in `BUG-LEDGER.md` as work lands.

### Phase 0 — Reliability correctness (safe, high-value, mostly pure logic)

0.1 **[DONE — MQA-271]** Brain exclusive-local-summary honors the runtime `unavailable` lockout
    (prevents a rebuild from purging the brain then failing every re-extraction against a dead
    on-device runtime). See `src/main/brain/ingest-local-lockout.test.ts`.

0.2 **Local floor budgets for `answer`/`recap`** — `boundedLocalRequest()` and the output-token
    budgets only cover `suggest`/`summary`; when local is the last-resort floor for a typed
    question or recap, the transcript is not clamped and the token budget falls through to the
    vision cap. Extend budgets + transcript clamp for those modes. (LLM audit "B5".)

0.3 **Unify "local can actually run" into one predicate** used at every seam (routing, ingest,
    prewarm) so "provisioned on disk" and "runtime healthy" can never disagree.

### Phase 1 — Transcription/voice quality (the #1 reported pain)

1.1 **Close MQA-234 (OPEN)** — on packaged Windows, "Whisper" import can silently run Parakeet
    because `sherpa-onnx` and `onnxruntime-node` ship a same-named native DLL. Finish the
    process isolation so the import engine is honest; audit-log the engine actually used.

1.2 **Make "best" mean best** — packaged installs default to `whisper-base` WASM. Surface a
    persistent, actionable prompt when `qualityDegraded` is true and make the high-tier
    fetch-on-first-use flow obvious; consider defaulting to Parakeet where it is bundled.

1.3 **Explicit language selection** + faster/robust language pin so non-English meetings are not
    transcribed as English until the probe succeeds.

1.4 **Backpressure & window boundaries** — raise/monitor the decode queue (currently drops audio
    after ~24 windows), parallelize Parakeet decode, and revisit the 6 s hard cap / 0.6 s
    endpoint that fragment sentences.

### Phase 2 — Beautiful summary + next steps (most visible win)

2.1 **Structured action items** — tighten `RECAP_PROMPT`'s "Action items" to the same
    `- [owner] will [action] by [date]` contract the email recap already uses, keeping the
    parsed section skeleton byte-identical (so `transcripts.ts` / `recall.ts` parsers stay
    valid), and harden `parseRecapMarkdown` owner/date extraction.

2.2 **Section validation + one retry** — after generation, re-parse; if critical sections are
    empty, retry once asking only to fill the missing sections.

2.3 **Dedicated Review UI** — render parsed action items as a structured checklist (owner, due,
    source) above the raw markdown.

2.4 **Single source of truth for "next steps"** — reconcile recap action items with the brain's
    `commitments[]` so CRM/task push and the Review UI agree.

### Phase 3 — First-class CRM push (MCP/API)

3.1 **Canonical push envelope** — `{ meetingId, recapMarkdown, structured RecapExport, brain
    account/deal/people/commitments, idempotencyKey }` instead of 3 strings; wire the brain's
    structured deal/account data into the payload.

3.2 **Stable idempotency key on the wire** (meeting id) so CRM-side dedupe survives client state
    loss; durable dedupe for "Book next steps" (mirror the `crm_pushed` frontmatter marker).

3.3 **Tool-schema-aware field mapping UI** (cache `inputSchema` from `listTools`) + generalized
    OAuth (reuse the ClickUp pattern) to support HubSpot/Salesforce-style MCP servers; optional
    connection registry v2 (multiple connections per kind).

### Phase 4 — Apple-grade UX / performance

4.1 **Decouple streaming from re-render/resize** — extract an ask context (one listener set
    instead of 7×4), throttle the resize MutationObserver during streaming, and gate markdown
    re-parse for very long answers.

4.2 **First-code-block latency** — pre-warm Shiki on first keystroke; unify on one theme; gate
    the 591 kB Mermaid subgraph behind an opt-in.

4.3 **Consistency pass** — one loading/thinking indicator, replace native `confirm()/alert()`
    with in-app glass modals, extract duplicated primitives (`MsLogo`, notice banners), and
    settle the glass-vs-`cl-*` design-system boundary.

4.4 **Structurally split `App.tsx`** into `useMeetingSession` / `useHotkeyRouter` /
    `useRecapPersistence` hooks to reduce the re-render surface.

### Phase 5 — Second-brain depth

5.1 **Live grounding in `suggest`** (opt-in) so the copilot can say "you promised X on May 14"
    during the call, plus a proactive "record check" nudge when context contradicts a claim.

5.2 **Consolidate `graphify` and `.brain`** onto one canonical graph to stop paying for two LLM
    extractions per meeting.

5.3 **Smarter entity resolution** (pronouns / recent-meeting entities, not just explicit names).

---

## Testing posture

- `npm test` (vitest) is the workhorse: ~3,400 tests, strong on `src/shared/**` and
  `src/main/**`. Every `BUG-LEDGER` FIXED row must cite a regression test (`npm run check:bugs`).
- `npm run typecheck` gates both tsconfigs; a frozen baseline of known test-file type errors is
  enforced (never rising).
- The physical QA suite (`scripts/qa/e2e-workflows.mjs`) drives a running build over CDP for
  end-to-end workflows (ask/capture/listen/recall/failover/gateway matrix); it is not in
  `npm test` because it needs a launched app.
- Note: `src/main/mcp/bidstackClient.test.ts` (now `mcpClient.test.ts`) binds a real localhost
  port and can fail in a network-sandboxed environment — that is an environment limitation.

## Environment / build notes

- Node is pinned to `22.22.3` (`.nvmrc` / `.node-version` / `engines`). A `.cursor/environment.json`
  bootstrap for Cloud Agents is proposed on a separate branch.
- Do not split the source. Keep publishing mac + Windows under one `v*` tag to `Metis-Releases`
  via `scripts/push-both.sh`; enterprise fleets use managed-config `updateFeedUrl`.
