---
project: Métis
type: overlay-quality-hats
applies: Bar minimized sentient circle
ship-bar: would Apple ship this overlay?
---

# Overlay quality hats

Every hat must **PASS**. One **REJECT** fails the slice. This is the gate for the Bar circle (`docs/design/BAR-PILL.md`). Hide park 8×2 and Island hover math are out of scope and must stay untouched.

## Contract

- Rest-only circle mounts when `overlayShowsBarOrb` is true (`bar` **and** minimized).
- Bar idle docks the same circle on the full bar (`overlayDocksBarCircle`). Never a stadium pill. Never Minimize2.
- Hide idle: no orb canvas. Island: no second circle.
- Hide and Island: no minimize control, minimize is a no-op, no layout jump to Bar.
- Click the docked circle collapses to the rest circle. Click the rest circle expands to the full bar. Drag does not expand.

**REJECT if** the circle can appear on Hide/Island, or while the bar is gone, or minimize switches layout.

## Motion

Fluid 60fps. Sentient, not a spinning demo blob.

- Idle breath of the glass core (not a rigid mesh, not a particle cloud).
- Listening: denser / pulse + red rec-dot on the glass. Hover: lean. Reduced-motion: one still **spherical** frame (glass + core + kiss), not a disc.
- Spring expand/collapse (`--ease-spring`). No snap.
- rAF does **not** read layout (`clientWidth`, `getBoundingClientRect`) or look up GL locations.

**REJECT if** the orb is a single radial blob / flat CSS disc, or the frame loop does layout / `getUniformLocation`.

## Interaction

Insanely low latency on click and drag.

- Expand is synchronous. No await, no layout read, no rAF work on the click path.
- Drag uses existing `useWindowDrag` + `moveBy`. Hover lean is skipped while dragging.
- Pointer-move does not call `getBoundingClientRect`.

**REJECT if** click or drag waits on measure, or hover math runs during a drag.

## Performance

- Orb rAF runs only while a Bar circle is mounted and should animate (docked idle or minimized rest).
- Hide/Island: **zero** orb rAF (`shouldRunOrbRaf` is false).
- Setup is one quad. No particle buffers. No O(n²) neighbor scan.
- `document.hidden` pauses the loop. `destroy` cancels rAF.
- No unpkg / CDN Three.js. No Spline runtime.

**REJECT if** Hide or Island can start the orb loop, or first minimize hitches on a particle setup.

## Visual

Apple-grade. Quiet luxury. Transparent edges. Fixed circle.

- Same width and height (`BAR_PILL_SIZE_PX`). Aspect 1 on every mood. Bounding box constant.
- Never a stadium, potato, or squashed capsule. Shader uses the same scale for X and Y.
- Idle is Fit Studio purple-magenta glass (`#b266e9` / `#e15cff` / `#8a00f8`), not Jarvis `#4CA8E8`. Thinking is hotter `#e15cff`. Fact-check may use a calm blue accent `#5AB8F0`. Connecting is dimmer purple `#8a00f8`, never indigo `#2A0A4A`. Color tints the volume; the box never changes.
- No constellation. No electron chords. No glitter ball.
- Energy volume: ray-sphere body, luminous core, indigo halo, one specular kiss, thin star flare. Not a 2D radial disc. Not a particle cloud.
- Rec-dot stays red and readable on the sphere while listening. Do not paint the sphere red.
- No glass chip of mic buttons. No dark fill.
- Transparent around the circle. No scrollbar. No CSS radial body.

**REJECT if** rest is a filled chip, a flat radial disc, an opaque oval, or any flatten of the circle.

## Stability

- Missing WebGL must not throw.
- One context per canvas (do not grab WebGL then 2D).
- Visibility + destroy clean up listeners and rAF.

**REJECT if** reduced-motion or a headless canvas throws.
