# Cap4 MOTION RESULT

**Tip:** (this commit) on `claude/cap4-motion` base `3d6825f9`  
**When:** 2026-09-20 ~8:00pm ET

## What changed
- Edge spring travel `translateX(16px)` + opacity 0→1 (in) / reverse (out); durations remain **360ms in / 320ms out** via `.overlay-spring--in/out` + `--edge-right` keyframes.
- Zone cascade: **280ms**, stagger **0/32/64/96ms** (≤40ms), `translateX(16px)`.
- Continuity rail `.dock-panel__rail` grows `scaleY(0.2→1)` in **340ms** so sliver→panel reads as one object.
- Header hairline only when scrolled; tooltip hover INTENT 400ms; Thinking shimmer.
- Blur still off mid-spring (existing `.overlay-spring--in/out .aw-widget` rule). Reduced-motion: global duration 0 snap.

## Prove strip
Mac CDP: rest → mid (~160ms into spring) → expanded; reverse expanded → mid → rest. Paths under `proof/cap4-notch/CAP4-MOTION-*`.

## Unchanged
Bar-centralized tools + Cap2 Ear top-center contract.
