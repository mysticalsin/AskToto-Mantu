# Intelligence update and the 3x daily index

Date: 2026-08-31

Status: **Active.** Overlay Hide / Island / Bar stay frozen. Do not pack. READY TO MERGE stays **no** until a Mac-show.

This is the design for a solid Intelligence index: Update Intelligence always does work or fails loudly, recap writes itself in the background, and the product cadence is three named slots in `America/Toronto`.

## Outcome

1. **Click always works.** Update Intelligence shows Updating and a working orb immediately, then a filled dashboard or a loud real error. Never a dead click. `requireAuth` failures surface (`Sign in with your Mantu account first.`). No-provider copy: `Connect an AI provider in Settings → AI, or enable Métis Local there to index meetings on this device.`
2. **Empty Today / coaching / relationships with `meetings.length > 0` is a bug.** Force ingest of unextracted saved transcripts. `queued: 0` + `upToDate` is illegal in that case (`classifyIntelligenceClick` returns `illegal-empty` and the pass re-queues).
3. **Recap writes itself.** After import ASR, the transcript is saved first. Recap is one background LLM call at the summary/base tier. Sequential polish-before-recap is not on the critical path. Bounded retries (max 3). Trailing-stream text `>= 200` chars is kept.
4. **Index three times a day.** Same work as Update Intelligence: recap still-missing summaries, extract people / accounts / deals / coaching / Today from saved meetings, refresh the dashboard. Never auto-send to CRM, Outlook, or MCP.

## Named slots (HARD)

Timezone: `America/Toronto`. Hours: **06:00, 12:00, 18:00**.

- Scheduled in the Métis **main process** with `setTimeout` to the next slot (`scheduleIntelligenceIndex`). Not a Grok Bot cron. Not a 60-minute poll.
- If Métis is closed at a slot, **catch up on next launch**: if `lastSuccessAt` is before the most recently elapsed slot, run once (`catchUpIntelligenceIndexIfNeeded`).
- Do not stack a second pass if one is already running; coalesce.
- Persist `lastSuccessAt` in `.brain/intelligence-index.json`. Fail loud in logs (`brain.intelligence_index` audit). UI may show last indexed time.
- Hourly consolidation is demoted. `runConsolidationIfDue` may still run once at boot as a no-op when the feature is off. The three named slots are the product cadence.
- Import FIFO idle may start **one** pass (`reason: 'import-idle'`). BrainView may one-shot auto-backfill on mount when saved meetings are ahead of the brain. It must not grow a repeating mount timer.

## Click contract

`runIntelligenceIndex('click')` (IPC `brain:backfill`):

1. Recap meetings whose Notes body is still empty.
2. `requestBackfill({ force: true })` so the old 3-per-day reconcile budget cannot swallow the click.
3. If `classifyIntelligenceClick` is `illegal-empty`, `startBackfill({ force: true })` so source-refresh deferral cannot return a silent `queued: 0`.
4. Return `queued > 0`, `preparing: true`, or a real `error` / `deferred: 'no-provider'`. Never `upToDate` when unextracted meetings exist.

## What the pass does not do

- No CRM push, no Outlook draft, no MCP outbound.
- No overlay edits.
- No packing.

## Tests (required)

- Next-slot math for 06:00 / 12:00 / 18:00 America/Toronto (including DST).
- Missed-slot catch-up.
- Coalesce if a pass is already running.
- Click with meetings and an empty brain queues work (`queued > 0` or `preparing`), not `upToDate`.
- Click with no provider surfaces the no-provider copy.
- Import idle may start one pass. BrainView has no repeating index timer.
