# Cap4 MOTION LOCK — Apple-smooth dock in/out
**When:** 2026-09-20 19:58 ET  
**CoS:** Ultron  
**Tony:** "Make sure the animation when it comes out and goes in is super smooth and perfect like Apple would make it"  
**Base tip:** `3d6825f9` (Bar-centralize READY; stamp still needs Tony eye + mic pill)

## Intent
Dock reveal and hide must feel like native macOS / Dynamic Island / CodeNotch: mass, spring, no jank. Not a CSS fade slapped on a resize.

## Spec (DESIGN.md + RocketFuel PLAN)
| Param | Value |
| --- | --- |
| Ease | `cubic-bezier(0.22, 1, 0.36, 1)` (`--ease-spring`) |
| Reveal | **320–380ms** edge-anchored (origin = right edge) |
| Hide | **280–340ms** reverse into the rail |
| Properties | **transform + opacity only** during spring — never width/height/layout mid-flight; never `filter` / `backdrop-filter` mid-spring |
| Backdrop blur | off during spring; restore after settle |
| Reduced motion | instant snap (no spring) |
| Hover | must not start mic/camera/model |
| Keep-open | brief pointer leave does not collapse during Ask focus / Listen |

## Choreography
1. **Rest → Expand:** sliver widens via window geometry OR content translates from `translateX(12–20px)` + opacity 0→1; header → body → composer stagger ≤40ms each (subtle, not theatrical).
2. **Expand → Rest:** reverse; OverlayPeek remounts only after hide settles.
3. **No flash:** no white frame, no 880-bar flash, no Ear chip jump.
4. Match Bar / Island motion DNA already in `overlay-spring-in/out` if present — reuse, do not invent a second motion system.

## Skills
- `improve-animations` / `find-animation-opportunities`
- `high-end-visual-design` motion section — tempered by DESIGN.md (no Awwwards 700ms chaos)

## Prove
- Screen recording or 3-frame strip: rest → mid → expanded, and expanded → mid → rest
- `prefers-reduced-motion` path still works
- Cap2 Ear / Bar tools unchanged

## ETA
READY-FOR-FEEL motion tip **~8:25–8:45pm ET**. Pack HOLD. No Ultron stamp until Tony eye + mic + motion PASS.
