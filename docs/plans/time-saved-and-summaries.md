# DESIGN — Time Saved + Meeting/Email-ready Summaries

Date: 2026-08-09. Branch: fix/windows-audit-and-release-gate.

## Outcome
1. **Time saved** — an honest, transparent figure of the meeting write-up the user avoided by letting
   Métis summarize, shown as a dashboard card AND in a Settings tab, with the per-meeting assumption
   visible and adjustable. Never a measured-fact framing — always labeled an estimate.
2. **Summaries ready for meetings or emails** — two polished, paste-ready outputs on top of the existing
   recap pipeline: an **email-ready recap** and a **pre-meeting brief**, routed through **Spotlight Ref**
   by default when Dust is connected (grounded in the account/deal history and, on opt-in, our wins /
   case studies), falling back to the active provider otherwise.

## FRAME answers (locked with the user)
- Time-saved presentation: honest transparent tile. Also surfaced in a Settings tab.
- Build BOTH summary formats.
- Spotlight Ref default-on for grounded summaries; ask whether to include success stories (Spotlight Ref
  holds our wins).
- "Make the experience even better" — polish: every new surface gets loading/empty/error states,
  keyboard access, reduced-motion-safe animation, and honest copy.

## Epistemic law (repo-specific, non-negotiable)
Every other "fact" surface here (Mars, brain provenance) refuses to invent or predict numbers. Time saved
is inherently an ESTIMATE (recorded minutes × an assumed write-up ratio). It MUST read as an estimate —
"≈", the word "estimate", the assumption shown — never styled like the measured KPI tiles beside it.

## Data — what exists (from the scout)
- `MeetingSummary.durationMin` per meeting, via `recallList()`, already held in BrainView state. Live sum
  is free but shrinks under retention deletion.
- No word/char count persisted anywhere. Time saved rests on meeting COUNT + durationMin.
- No cumulative usage store exists.

## The model (transparent, one axis)
Default axis: **meeting write-up avoided**. Per meeting, the write-up you'd have done by hand ≈ a fraction
of the meeting length, floored and capped so a 3-minute call and a 3-hour call both land in a sane range:

    perMeetingSaved(durationMin) = clamp(durationMin * writeupRatio, floorMin, capMin)
    totalSaved = Σ perMeetingSaved  over summarized meetings

Defaults: `writeupRatio = 0.2`, `floorMin = 5`, `capMin = 30`. All three adjustable in Settings; the tile
shows the resulting average ("~13 min per meeting") so the number is legible, not magic. No speculative
second axis (per-ask recall time, live-suggestion value) — one defensible axis only.

## Persistence (durable, survives retention deletion)
New `usageStats` on settings, incremented ONCE when a meeting file is first written (`saveMeeting`):
`{ meetingsSummarized, conversationMinutes, nextStepsExtracted, firstMeetingAt }`. A rebuild/re-index must
NOT re-increment — only a brand-new save does. The dashboard headline uses this durable counter; the
per-meeting precise sum from `recallList()` is used where the meetings are still present.

Adjustable assumption persisted as `timeSaved: { writeupRatio, floorMin, capMin }`.

## Feature 1 build
- `src/shared/time-saved.ts` — pure, unit-tested. Two entry points: `timeSavedFromMeetings(MeetingSummary[], a)`
  (precise, per-meeting) and `timeSavedFromTotals(usageStats, a)` (aggregate, from the durable counter).
  Returns `{ savedMinutes, perMeetingAvgMin, meetings, conversationMinutes, nextSteps }`. Clamp math shared.
- `src/shared/ipc.ts` — `usageStats` + `timeSaved` on `BaseSettingsSchema` + `DEFAULT_SETTINGS`; both flow
  to the renderer through the existing settings snapshot (no new IPC).
- `src/main/transcripts.ts` — increment `usageStats` on a new meeting save; guard against re-count.
- UI: `TimeSavedCard` in `BrainView.tsx` (near the KPI row) + a "Time saved" section in `Settings.tsx`
  with the assumption editor. Empty state: "Summarize your first meeting to see time saved."

## Feature 2 build
- `src/shared/prompts.ts` — `EMAIL_RECAP_PROMPT` (greeting-ready recap + action items with owners,
  professional tone) and `MEETING_BRIEF_PROMPT` (who · last touchpoint · open commitments both sides ·
  suggested talking points). A `winsClause` appended when the user opts into success stories.
- Routing (reuses the existing seam, no choke-point plumbing): `providerOverride: 'dust'` +
  `agentOverride: providerModelsSpotlightRef['dust']` when Dust ready → pins the call to Spotlight Ref,
  inheriting the recap/summary 120s idle budget and the no-failover-on-pinned-agent contract already in
  `main/index.ts`. Falls back to the active provider when Dust is not connected.
- UI: "Copy as email" and "Prep for next meeting" actions in `Review.tsx` (brief also reachable per-entity
  from `BrainRecordPage.tsx`), each with an "Include our wins / case studies" toggle when Spotlight Ref is
  available. Reuse `openMailDraft` / `copyNotes` / clipboard verbatim. Loading + error + Dust-unavailable
  states on every action.

## Edge cases
- Zero meetings → empty state, not "0h saved".
- Dust not connected → summaries still work via the active provider; the wins toggle is hidden (nothing to
  ground against). No dead button.
- Retention deleted every meeting → durable counter still shows the honest lifetime total; the tile says so.
- A managed/locked settings key for the assumption → respect it (read-only), like every other locked field.
- Spotlight Ref down → the pinned-agent contract already surfaces the reconnect message; the action shows it.

## Test matrix
- Unit: time-saved clamp/sum math (both entry points, empty, one meeting, huge meeting, adjusted ratio).
- Migration: settings defaults for `usageStats`/`timeSaved`; a persisted profile without them parses.
- Increment: a new save bumps the counter once; a rebuild does not.
- Prompt: EMAIL/BRIEF prompts present, wins clause gated.
- Routing contract: brief/email route to Spotlight Ref when Dust ready, active provider otherwise (source
  or behavioral).
- Physical: cold profile — summarize a meeting, see the tile populate; generate an email recap and a brief;
  Settings tab shows + adjusts the assumption.
