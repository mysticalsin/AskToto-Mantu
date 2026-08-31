---
project: Métis
type: overlay-slice-contract
slice: bar-pill
owns: Bar layout + minimized sentient circle only
does-not-own: hide park 8×2 paint, island peek 132×15 paint, BAR_MIN_HEIGHT, onboarding, starfield, thinking-orbs, ASR, identity
owns-also: Bar idle docked circle; Hide/Island must not minimize
notes: Island/Hide hover hit is the camera / Dynamic Island square (DESIGN.md + island/geometry). A 560-wide or 44-tall slab is a bug.
---

# Bar sphere: sentient 52 glass

This file is the contract for one slice. Implement only what it names. Hide and Island overlay chrome stay exactly as they are.

## Consultant (feel)

The Bar control is a **being**, not a badge. At 52px it must read as a glass sphere with mass: a highlight that says "I am round," a core that breathes, interior motion that is not the shell. Tony looks at it and it looks back.

Reference (feel only, not a clone):
- **Jarvis 3D sphere** (`mysticalsin/tonys-jarvis` `frontend/src/orb.ts`): perspective volume, quiet constellation, faint idle lines, electrons only while thinking (a handful). Idle color is Jarvis `#4CA8E8`. Port the sentience and that blue. Do not port voice, calendar, full-screen chrome, or product copy. Tony overrode Mantu purple on this control.
- **Fit Studio** ([amaris-fit-studio.pages.dev](https://amaris-fit-studio.pages.dev/)): premium small rest. Use only if WebGL is missing. The shipped Bar circle prefers the Jarvis **volume**.

A flat CSS disc, a single radial fill, or a 2D glow quad is a fail. That is a status blob. This slice replaces that blob on the **existing** Bar orb (`bar-pill-orb` / `JarvisOrbButton`). Do not invent a second orb.

## Craftsman (spec)

### Size (HARD)

- `BAR_PILL_WIDTH_PX === BAR_PILL_HEIGHT_PX === BAR_PILL_SIZE_PX === 52`
- Aspect **1** on every mood. Bounding box constant.
- Never a potato, stadium, lozenge, 44-tall pill, or flattened disc.
- Never scale, squash, or stretch on hover, listen, drag, or minimize.
- Minimize (Bar only) is **this** sphere. Not a different disc.

### Materials (layers, back to front)

One WebGL canvas, 52×52 CSS, DPR capped at 2. Transparent around the sphere. No dark chip. No CSS radial body.

1. **Glass body** (ray-sphere, not a 2D disc). Camera on +Z. Equal X/Y scale. Radius fills ~0.90 of the box. Lambert wrap in the mood color. Far side stays in the same blue (`mood * 0.62`), never crushed to teal (`mood * 0.16`). Idle must **read** `#4CA8E8`.
2. **Living core.** Brighter mass near the center. Breath is uniform scale of intensity, never of the box. Caustic bands (two slow sin fields) live *inside* the volume.
3. **Fresnel rim.** Thin bright edge. Reads as glass, not a sticker.
4. **Specular kiss.** One tight highlight, upper-left (`light = normalize(-0.45, 0.72, 0.85)`). White, small. Not a looping sheen. Hover may lean the kiss a few degrees. Never squash the sphere to follow the pointer.
5. **Quiet constellation.** `JARVIS_ORB_POINTS` is **56**, not 2000 (a sparse shell, not a snow globe). Two faint chord families (`[1, 19]`). Additive, O(n) chords. Same NDC scale on X and Y (`ORB_NDC_SCALE` 0.86). Sits on the glass, not a glitter fill inside. Idle lines are faint (`targetLineAmount` class ~0.15). Electrons **off at idle**. Thinking may draw at most 3 traveling dots.
6. **Rec-dot (listen only).** Existing red `#F0717A` (`.rec-dot`). 7×7, bottom-right of the 52 box, inside the circle. Dark ring so it reads on blue glass. Do **not** paint the sphere red.

Reduced-motion: paint one still frame of layers 1–5 (and 6 if listening). The still frame must still look spherical: core, rim, kiss, constellation. A flat disc at t=0 is a fail. Missing WebGL falls back to a 2D **shaded sphere** (volume + kiss + rim + a few points), never a single radial blob.

### Motion

| State | Volume | Interior | Color |
| --- | --- | --- | --- |
| **idle** | Slow breath (~1.3 Hz, amp 0.018) | Quiet shell, faint lines, **0 electrons** | `#4CA8E8` |
| **listen** | Slightly denser pulse | Same quiet shell | Idle blue. Rec-dot red on the glass. |
| **think** | Faster breath (~2.2 Hz) | A few traveling dots (≤3) | `#6EC4FF` |
| **fact-check** | Steady | Same blue family | `#5AB8F0` / `#4CA8E8` |
| **connecting** | Quiet | Dimmer lines, 0 electrons | Dimmer blue (not `#2A0A4A`, not purple) |

`orbMood: 'idle' | 'thinking' | 'factcheck' | 'connecting'`. Listen is `listening: true` on the same handle (motion + rec-dot), not a fifth fill. Priority for fill: `connecting` > `factcheck` > `thinking` > `idle`.

Hover: lean (particles + kiss), not squash. Drag: skip lean. `document.hidden`: pause rAF. Hide/Island: zero orb rAF.

### Do

- Idle on this sphere is Jarvis `#4CA8E8`. Not Mantu `#7F00DA`. Glass must read that hex, not murky teal.
- Same sphere docked on the idle Bar and alone when minimized.
- Windows: same sphere, top-center Bar. No notch, no Mac-only look.
- Rec-dot stays red and readable.
- Compositor-cheap: cached GL locations, no layout reads in the frame loop, setup O(n).

### Do not

- Flatten on hover or minimize.
- CSS `radial-gradient` as the body (that is the old disc).
- Purple-gradient slop, rainbow foil, emoji, a second orb.
- Paint the sphere rec-dot red.
- Clone Jarvis copy, chrome, voice, or Three.js from a CDN. The idle **color** is the Git blue.
- Touch Island/Hide hit geometry (`src/main/island/geometry.ts` hit rects, `hoverRestWidth`, Teams-mute tests) except to keep them green.
- Onboarding, Local LLM, Brain MCP, installers.

## Layout (HARD)

Overlay chrome has three layouts. Minimize-to-circle is not a fourth layout and must never switch layouts.

| Layout | Rest | Minimize-to-circle |
| --- | --- | --- |
| **Hide** | Hover-to-reveal hairline (8×2 park). Reveal only from the hardware camera / Dynamic Island square, not a 560×44 menu-bar slab. The bar is **invisible** at rest. | **Forbidden.** The circle is invisible at rest too. Hide the minimize control. `minimize(true)` is a **no-op**. Do not park an orb while Hide is idle. Do not float a sphere in the notch. On hover the bar reveals; never a Hide circle. |
| **Island** | The small visible island (132×15) is already the rest. Hover the camera square at the top center. Left/right menu-bar items and Teams mute / camera / share must never reveal Métis. | **Forbidden.** Do not add a second circle. Island stays the island. Same as Hide: no control, ignore minimize, no layout jump. |
| **Bar** | The classic bar stays on screen **plus** the sentient 52 sphere docked on that bar (never a lozenge / pill). | **Allowed — only here.** Click the docked sphere to collapse to that same sphere. Click the rest sphere to expand back to full bar + sphere. Drag the rest sphere moves. Position is the existing Bar-minimize rest (not a wanderer). Layout stays `bar`. |

Visibility must match the bar. Uniform. No leftover floating orb.

- If Settings Hide would leave the bar gone, the circle is gone.
- If Settings Island is the visible rest, that island is the rest — not this circle.
- If Settings Bar is up, the circle lives on that bar (idle) or as the minimized rest (collapsed).

Shared predicates (one source of truth for Settings, renderer, and main):

```
overlayAllowsMinimize(layout) === (layout === 'bar')
overlayDocksBarCircle(layout) === (layout === 'bar')
overlayShowsBarOrb(layout, minimized) === (layout === 'bar' && minimized)
```

- Bar docks the circle (not Minimize2, not a stadium pill) when `overlayDocksBarCircle` is true.
- The rest-only ControlPill mounts when `overlayShowsBarOrb` is true (Bar minimized). Hide/Island never.
- `onBarMinimize` / `window.toto.minimize(true)` / main `setMinimizedWidth(true)` no-op when `overlayAllowsMinimize` is false.
- Expanding (`minimize(false)`) still runs so a leftover rest circle cannot stick if layout leaves Bar.
- Leaving Bar while minimized unminimizes and parks Hide/Island with existing rest math. That is not a layout jump.
- Closing Settings onto Island/Hide parks immediately (`shouldForceParkOnBecameIdle`). Do not leave a full bar as the hover trigger.

## Shape (HARD — fail the round if violated)

A **fixed sphere**. Same width and height, always. See Materials above.

- `BAR_PILL_WIDTH_PX === BAR_PILL_HEIGHT_PX === BAR_PILL_SIZE_PX` (**52**)
- Aspect ratio is **1** on every mood.
- Bounding box is **constant** across idle, thinking, factcheck, connecting, hover, listen, drag.
- Never a potato. Never a stadium. Never a squashed capsule. Never flatten.
- Never change size. Not on idle, hover, listen, drag, or click-to-expand (the **Bar** expands; the sphere itself does not squash).
- It does not wander. Position is the existing Bar-minimize rest.
- Inside that fixed sphere, the glass, core, and constellation may move.

CSS: square box, `border-radius: 50%`, `background: transparent`. No dark fill. No scrollbar. No radial body.

## Color language (product, not decoration)

Tight palette. Color tints the volume. No size change with state.

| Mood | Hex family | When |
| --- | --- | --- |
| `idle` | Jarvis `#4CA8E8` | Standard. Rest. Default. Tony locked this from `orb.ts`. |
| `factcheck` | Blue family `#5AB8F0` / `#4CA8E8` | Fact-check / cited answer. Do not snap to purple. |
| `connecting` | Dimmer blue | Connecting handshake. Still glass. Not indigo, not purple. |
| `thinking` | `#6EC4FF` | Thinking / ask in progress. A few electrons only. |

Listen is not a fill. Rec-dot stays `#F0717A` on the glass.

```
orbMood: 'idle' | 'thinking' | 'factcheck' | 'connecting'
listening?: boolean
```

Wire from existing Bar signals (ask streaming, fact-check kind, listen chrome). If connecting is not on the Bar yet, keep the map and default `idle`. Do not build a fake product.

Priority: `connecting` > `factcheck` > `thinking` > `idle`.

## Particle craft (look only)

From Jarvis `frontend/src/orb.ts`. Take the **look**. Do not port Jarvis voice, calendar, Docker, or the full-screen overlay. Métis stays Métis.

- Sparse points on a **unit sphere** (far below 2000; no X-stretch, no Y-squash)
- Additive blending, faint idle lines, electrons only while thinking (≤3)
- Idle breath + slow drift (uniform scale / lean — never squash)
- Perspective: same X/Y scale, `1 / (1 - z * k)` so the cloud has depth
- Glass body is a ray-sphere, not `length(vUv)` disc falloff

No `unpkg` / CDN. No Three.js from the network. Bundle the renderer.

## Behavior (Bar + minimized only)

- **Drag** anywhere on the display uses the existing bar move (`useWindowDrag` + main `moveBy`). The window stays where the user left it (same in-session persistence as the full bar). Do not invent a new settings key.
- **Click** (not drag) expands to the full bar. Existing minimize → circle and expand → bar stay the API; this slice restyles the rest.
- `useWindowDrag` already swallows the trailing click of a real drag. Keep that. A click that never crossed the dead-zone expands. A drag does not.
- **Interior motion (sentient):**
  - Idle: calm blue glass, quiet constellation, 0 electrons
  - Listen: idle blue, rec-dot red on the glass
  - Thinking: brighter blue `#6EC4FF`, at most 3 traveling dots
  - Fact-check: same blue family, same box
  - Connecting: dimmer blue, quieter breath, same box
  - Hover: slight awareness (particles and kiss lean — lean, not squash)
- **Reduced-motion:** one still **spherical** frame (glass + core + kiss + constellation). Not a disc. Must not throw if WebGL is missing.
- **60fps / no jank:** one cheap WebGL rAF while the circle is mounted (docked on the idle bar, or alone when minimized). Cached GL locations. No layout reads in the frame loop. Hide/Island: **zero** orb rAF (`shouldRunOrbRaf` is false unless Bar). Setup is O(n), never an n² neighbor scan. Pause when `document.hidden`.
- **Click / drag latency:** expand is synchronous. Hover lean skipped while dragging. No `getBoundingClientRect` on pointer-move.
- **Spring** is for the **Bar** expanding (`--ease-spring: cubic-bezier(0.22, 1, 0.36, 1)`), not for turning the circle into a lozenge. This spring is Bar-circle only. Do not reuse or restyle Hide/Island overlay-spring, peek hover, or park timing.
- Hide layout and Island layout must not grow a minimize control or a second disk. Hover hit is the camera island square only (DESIGN.md). Hide 8×2 paint and Island 132×15 paint stay.
- Quality hats: `docs/design/QUALITY.md`. One REJECT fails the slice.

## Out of scope (do not touch)

- Hide park `8×2` **paint** / `.overlay-hide-target` (hover **sensor** height is in scope if a leftover pad remains)
- Island peek `132×15` **paint**
- `BAR_MIN_HEIGHT` as hide floor
- Onboarding, starfield, thinking-orbs, ASR, identity
- Packing, merging, Hide → Bar auto-switch

## Tests (required)

- Minimize control **absent** when `overlayLayout` is hide or island; Bar docks the circle, never Minimize2, never a stadium pill.
- Calling minimize on hide/island is a **no-op** (renderer and main).
- Hide idle: **no** orb canvas / no visible circle (`overlayShowsBarOrb('hide', *)` is false, `overlayDocksBarCircle('hide')` is false).
- Island: **no** extra orb (`overlayShowsBarOrb('island', *)` is false, `overlayDocksBarCircle('island')` is false).
- Bar minimized: rest circle shown (`overlayShowsBarOrb('bar', true)` and `data-bar-pill-orb`).
- Bar idle / expanded: circle **docked on the bar** (`overlayDocksBarCircle('bar')`), not a floating second disk and not a pill.
- Hover hit is the camera island: width = `notchWidth` (~180–250, not 560), height = housing only (not 44). Left menu-bar misses. Y=40 and `TEAMS_MEETING_CHROME_Y` miss.
- Settings close onto Island/Hide force-parks (`shouldForceParkOnBecameIdle`).
- Aspect ratio **1** on every mood. Bounding box constant across moods. Size is 52, never scale-on-appear.
- Click expands; drag does not expand.
- Reduced-motion does not throw and still looks spherical (glass + core + kiss, not a disc).
- Hide/Island do not run the orb rAF (`shouldRunOrbRaf`). Bar may.
- Shader is a ray-sphere (not `length(vUv)` disc falloff). CSS body is transparent (no radial fill).
- Rec-dot is red `#F0717A` on the sphere while listening; the sphere fill is never rec-dot red.
- Circle stays 52×52 on every mood including listen.
- Idle fill is `#4CA8E8`. Particle count is far below 2000. Idle electron count is 0.
