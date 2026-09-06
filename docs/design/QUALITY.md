---
project: Métis
type: overlay-quality-hats
applies: Bar minimized thinking-orb circle
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

Fluid 60fps. Jakub thinking-orb, not a spinning demo blob.

- Idle is `solving` (no caption). Listening is `listening` (waveform). Thinking is `working`. Reduced-motion: package static frame.
- Spring expand/collapse (`--ease-spring`). No snap.
- No custom WebGL loop. No layout reads (`clientWidth`, `getBoundingClientRect`) in a frame loop we own.

**REJECT if** the orb is a Fit Studio magenta core, a WebGL marble, a single radial blob, or a particle constellation we invented.

## Interaction

Insanely low latency on click and drag.

- Expand is synchronous. No await, no layout read, no rAF work on the click path.
- Drag uses existing `useWindowDrag` + `moveBy`. Dragging does not squash the orb.
- Pointer-move does not call `getBoundingClientRect`.

**REJECT if** click or drag waits on measure, or the circle flattens while dragging.

## Performance

- Package clock runs only while a Bar circle is mounted (docked idle or minimized rest).
- Hide/Island: **zero** orb rAF (`shouldRunOrbRaf` is false).
- Setup is the package 2D canvas. No WebGL program. No particle buffers we own. No O(n²) neighbor scan.
- `document.hidden` pauses (package). Unmount cleans up.
- No unpkg / CDN Three.js. No Spline runtime. No cloned thinking-orbs strings.

**REJECT if** Hide or Island can start the orb loop, or first minimize hitches on a WebGL setup.

## Visual

Apple-grade. Quiet luxury. Light dots on dark glass. Fixed circle.

- Same width and height (`BAR_PILL_VISIBLE_PX` 41). Package canvas stays `BAR_PILL_SIZE_PX` 64 with 2x backing (128). Aspect 1 on every mood. Bounding box constant. No muddy 1x CSS downscale.
- Never a stadium, potato, or squashed capsule.
- Idle is `solving`, theme `dark`. Not Fit Studio `#b266e9`. Not Jarvis `#4CA8E8`. No painted "Solving…" word.
- No constellation we invented. No electron chords. No glitter ball. No magenta core.
- No rec-dot on this circle. Listen is the `listening` state.
- No glass chip of mic buttons. No lozenge fill.
- Transparent circular host. The Bar is the Métis glass. No scrollbar. No CSS radial Fit Studio body. No playground play button or copy.

**REJECT if** rest is a filled lozenge, a flat radial disc, an opaque oval, a WebGL marble, or any flatten of the circle.

## Stability

- Missing canvas must not throw.
- Reduced-motion is the package static frame.
- Visibility + unmount clean up.

**REJECT if** reduced-motion or a headless canvas throws.
