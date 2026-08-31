---
project: Métis
type: design-system-contract
surface: Mantu Intelligence Update
basis: WALTEUR design law (this file before UI)
tokens:
  accent: "#7F00DA"
  ink: "rgba(255,255,255,1)"
  ink-2: "rgba(255,255,255,0.86)"
  ink-3: "rgba(255,255,255,0.74)"
  danger: "#F0717A"
typography:
  ui: "Geist, -apple-system, system-ui, sans-serif"
  control: { size: 12, weight: 600 }
radius: { control: 9999 }
motion:
  ease: "cubic-bezier(0.22, 1, 0.36, 1)"
  hover: "120ms"
  reduced-motion: respected
---

# Intelligence Update

A single explicit control on Mantu Intelligence. The user starts one agent pass. The dashboard
refreshes when that pass finishes. Nothing else.

This is **not** leftover PR 61 (dashboard glass, charts, motion). Do not revive that head.
This is **not** a Bar / Island / Hide change.

## Outcome

The glance (`BrainView`) and the Intelligence window both show **Update Intelligence**.

- Click starts one Intelligence agent pass (index pending meetings into the brain).
- When the pass settles, the dashboard re-reads. The user sees current knowledge, not a stale
  snapshot.
- The button is the trigger. This pass never starts on mount, on poll, or from a timer.
- Never auto-send. The pass does not push Outlook, CRM, or any MCP write.

## Routing (this action only)

Local AI is primary. The configured API is secondary. Once.

1. If Settings → Local AI is ready (enabled, weights on disk, RAM ok, runtime not locked out),
   the pass uses Local first.
2. If Local is missing, refused (disk / RAM), locked out, or errors, fail over to the configured
   API **once**.
3. Do not stay on the API when Local is ready.
4. If both Local and the API fail, fail loud. Name the failure. Do not invent a success.

Default meeting ingest (live save, auto-backfill, hourly consolidation) keeps its existing
waterfall. This local-first rule is only the Update button.

## Copy (fixed)

- Button idle: `Update Intelligence`
- Button working: `Updating`
- No provider: `Turn on Local AI in Settings, or connect an API provider, to update Intelligence.`
- Both failed: surface the provider error already recorded on the pass. Do not say
  "Something went wrong."
- Empty glance: keep the heading. Add that Update Intelligence builds knowledge from saved
  meetings.
- Up to date (nothing pending): refresh quietly. No fake progress.

No lab-demo strings. No "Run agent". No "Trigger pass". No em dash.

## Progress

Jakub thinking-orb, already in the app.

- Button working: inline orb, kind `working` (caption optional on the tight chip).
- Index in flight: existing Searching + `searching` row and `WorkProgressMeter` when a percent
  exists.
- Do not add a CSS spinner. Do not restyle the Bar orb.

## Empty / error

- Empty brain: heading, one sentence, Update Intelligence still visible.
- Error: danger glass, the real reason, button stays so the user can try again.
- Last good dashboard numbers stay on screen while a refresh fails (existing stale rule).

## Do

- One accent (Mantu purple). Everything else is white-alpha on dark glass.
- One logical change. No installer. No PR 61 merge. READY TO MERGE: no.
- Island / Hide geometry frozen. Overlay chrome out of scope.

## Do not

- Auto-start this pass when Intelligence opens.
- Auto-send mail, CRM, or MCP from this pass.
- Silently upload to the API while Local is ready.
- Walk the full cloud waterfall for this action. API is one configured failover.
- Restyle Bar, Island, or Hide.
