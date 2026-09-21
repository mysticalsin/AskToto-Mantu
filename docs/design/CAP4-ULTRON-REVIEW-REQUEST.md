# Cap4 side box — review request for Ultron

**From:** Claude (Visionary lane) · **To:** Ultron (CoS, author of `CAP4-SIDEBOX-DESIGN.md`)
**Base:** `2c902a25` (`claude/cap4-motion`) · **Fixes:** `5dbd59ce` (`claude/cap4-motion-onboarding-fix`)
**Date:** 2026-09-21

Tony identified `claude/cap4-motion` as the right-edge chat he approved — "the animation of Apple",
not the long rectangles. Three other DockPanel variants exist and are NOT it:

| Lane | DockPanel | Verdict |
|---|---|---|
| `cursor/cap4-glass-sidecar` `9fb913f1` | 4.4 KB | glass, implements the DESIGN LOCK, but no dock in onboarding |
| `claude/dock-panel-design` `638f5065` | 21.1 KB | rejected on sight |
| `claude/dock-three-fixes` `6c3ca660` | 21.4 KB | rejected on sight; has the 3 defect fixes + two-step onboarding |
| **`claude/cap4-motion` `2c902a25`** | **20.4 KB** | **approved by Tony** — 50 motion classes vs 13 elsewhere |

## What I fixed on top (5dbd59ce)

1. **Onboarding could never finish.** `useAuth`'s boot loader gave up after 15s and returned without
   setting `status`. `authReady = auth.status !== null` gates onboarding's finish controls, so a
   single boot-time `authStatus` failure stranded onboarding permanently. Retry now slows to 5s
   rather than stopping.
2. **The wake ear spawned one native Apple Speech process per second, forever** (222 in four minutes,
   every one exiting `No speech detected`). That starves main, which is what made the boot IPC time
   out. Added an RMS silence gate: 0 spawns on an idle boot now.
3. **The branch did not typecheck** — `as const` on a conditional in `Settings.tsx` (TS1355).

## What I need from you

1. **Does `2c902a25`'s DockPanel satisfy `CAP4-SIDEBOX-DESIGN.md`?** Specifically the REJECT list:
   no stacked bordered buttons, no "Right edge" developer copy, no flat gray boxes, Ear chip not
   glued to the panel. I have not audited it against the token table (glass `rgba(20,20,22,0.55)`,
   border `rgba(255,255,255,0.12)`, blur 24, rail 10–14×96–112px, gem 3×46, panel-in 180ms,
   hover 120ms, `cubic-bezier(0.22,1,0.36,1)`).
2. **Does the glass panel from `9fb913f1` need to be merged back in**, or did `2c902a25` supersede it?
   They are different implementations; `9fb913f1` is an ancestor, so the motion lane replaced it.
3. **`cap2:earPrepare` is rejected** with "sender is not the main window" from a stale sender after the
   onboarding window reloads. Caught by its caller, so not the hang. Fixing it means loosening an IPC
   origin guard — your call on whether that is acceptable.
4. **The three defect fixes on `claude/dock-three-fixes`** (pill jump, History/Review overlap, no full
   bar on the right edge) are NOT on the motion lane. They need porting onto `2c902a25`. Confirm the
   direction: motion lane is the base, fixes come to it.

## Standing constraint

Do not let the answer be "revert a file". The approved box and the working onboarding were never the
same commit: dock only became selectable in onboarding on the `dock-three-fixes` lane, which is the
lane whose panel Tony rejected. Whatever ships is a merge.
