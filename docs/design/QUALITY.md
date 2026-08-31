---
project: Métis
type: overlay-quality-hats
applies: Bar minimized Jarvis pill
ship-bar: would Apple ship this overlay?
---

# Overlay quality hats

Every hat must **PASS**. One **REJECT** fails the slice. This is the gate for the Bar pill (`docs/design/BAR-PILL.md`). Hide park 8×2 and Island hover math are out of scope and must stay untouched.

## Contract

- Jarvis pill mounts **only** when `overlayLayout === 'bar'` **and** minimized.
- Hide and Island: no minimize control, minimize is a no-op, no layout jump to Bar.
- Click expands to the full bar. Drag does not expand.

**REJECT if** the pill can appear on Hide/Island, or minimize switches layout.

## Motion

Fluid 60fps. Sentient, not a spinning demo blob.

- Idle breath + per-particle drift (not a rigid mesh).
- Listening: denser / pulse. Hover: lean. Reduced-motion: one still, alive-looking frame.
- Spring expand/collapse (`--ease-spring`). No snap.
- rAF does **not** read layout (`clientWidth`, `getBoundingClientRect`) or look up GL locations.

**REJECT if** the orb is a single radial blob, or the frame loop does layout / `getUniformLocation`.

## Interaction

Insanely low latency on click and drag.

- Expand is synchronous. No await, no layout read, no rAF work on the click path.
- Drag uses existing `useWindowDrag` + `moveBy`. Hover lean is skipped while dragging.
- Pointer-move does not call `getBoundingClientRect`.

**REJECT if** click or drag waits on measure, or hover math runs during a drag.

## Performance

- Orb rAF runs only while the Jarvis pill is mounted and should animate.
- Idle full bar: **zero** orb rAF (`shouldRunOrbRaf` is false).
- Setup is O(n). No O(n²) neighbor scan on 2000 points.
- `document.hidden` pauses the loop. `destroy` cancels rAF.
- No unpkg / CDN Three.js.

**REJECT if** an idle bar can start the orb loop, or first minimize hitches on an n² scan.

## Visual

Apple-grade. Quiet luxury. Transparent edges.

- Capsule of Jarvis cyan particles (`0x4ca8e8`), additive blending, connection lines, electrons.
- No glass chip of mic buttons. No dark fill that reads as a blob.
- Transparent around the pill. No scrollbar.

**REJECT if** the resting pill is a filled chip or an opaque oval.

## Stability

- Missing WebGL must not throw.
- One context per canvas (do not grab WebGL then 2D).
- Visibility + destroy clean up listeners and rAF.

**REJECT if** reduced-motion or a headless canvas throws.
