---
project: Métis
type: overlay-slice-contract
slice: bar-pill
owns: Bar layout + minimized sentient circle only
does-not-own: hide park 8×2 paint, island peek 132×15 paint, BAR_MIN_HEIGHT, onboarding, starfield, thinking-orbs, ASR, identity
owns-also: Bar idle docked circle; Hide/Island must not minimize
notes: Island/Hide hover hit-band (menu-bar/notch strip only) lives in DESIGN.md + island/geometry. A leftover 80–120px pad is a bug.
---

# Bar pill: sentient circle

This file is the contract for one slice. Implement only what it names. Hide and Island overlay chrome stay exactly as they are.

Tony's visual source for the **small rest** is the purple sentient orb at the bottom-right of [Amaris Fit Studio](https://amaris-fit-studio.pages.dev/). Round. Alive. Interior moves. Click opens it. Particle craft (look only) from `mysticalsin/tonys-jarvis`. Fit Studio **wins for small rest shape**. Jarvis cyan is a **mood color**, not the resting chrome.

## Layout (HARD)

Overlay chrome has three layouts. Minimize-to-circle is not a fourth layout and must never switch layouts.

| Layout | Rest | Minimize-to-circle |
| --- | --- | --- |
| **Hide** | Hover-to-reveal hairline (8×2 park). Reveal only from the menu-bar / notch top band, not a 80–120px pad. The bar is **invisible** at rest. | **Forbidden.** The circle is invisible at rest too. Hide the minimize control. `minimize(true)` is a **no-op**. Do not park an orb while Hide is idle. Do not float a sphere in the notch. On hover the bar reveals; never a Hide circle. |
| **Island** | The small visible island (132×15) is already the rest. Hover the **top** menu-bar / notch strip. Teams mute / camera / share (below the menu bar) must never reveal Métis. | **Forbidden.** Do not add a second circle. Island stays the island. Same as Hide: no control, ignore minimize, no layout jump. |
| **Bar** | The classic bar stays on screen **plus** the sentient circle docked on that bar (Fit Studio 52×52, never a lozenge / pill). | **Allowed — only here.** Click the docked circle to collapse to that circle alone. Click the rest circle to expand back to full bar + circle. Drag the rest circle moves. Position is the existing Bar-minimize rest (not a wanderer). Layout stays `bar`. |

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

A **fixed circle**. Same width and height, always.

- `BAR_PILL_WIDTH_PX === BAR_PILL_HEIGHT_PX === BAR_PILL_SIZE_PX` (Fit Studio rest is **52**)
- Aspect ratio is **1** on every mood.
- Bounding box is **constant** across idle, thinking, factcheck, connecting, hover, listen, drag.
- Never a potato. Never a stadium. Never a squashed capsule. Never flatten.
- Never change size. Not on idle, hover, listen, drag, or click-to-expand (the **Bar** expands; the circle itself does not squash or scale into a lozenge).
- It does not wander. Position is the existing Bar-minimize rest. No bounce / travel animation (lack of that is fine).
- Inside that fixed circle, things **may** change: particles, robot/face, color. That interior motion is the product.

CSS: square box, `border-radius: 50%`, transparent around the particles. No dark fill. No scrollbar.

## Color language (product, not decoration)

Tight palette. Do not invent a rainbow. Color is the **only** chrome change. No size change with state. Rec-dot stays the red recording mark elsewhere; do not paint this sphere red.

| Mood | Hex family | When |
| --- | --- | --- |
| `idle` | Mantu purple `#7F00DA` | Standard. Rest. Default. |
| `factcheck` | Grounded blue / `#4ca8e8` Jarvis cyan | Fact-check / Brain retrieval / cited answer in progress. Tony named this. |
| `connecting` | Deep indigo `#2a0a4a` mix, not a new shape | Connecting (OAuth/MCP handshake). |
| `thinking` | Soft violet brighter (`#9A2BF0` family), same circle, higher energy | Thinking / ask in progress (orb language, not a spinner). |

API (one map, default idle purple):

```
orbMood: 'idle' | 'thinking' | 'factcheck' | 'connecting'
```

Wire from existing Métis signals if they are already on the Bar (ask streaming, fact-check kind, MCP handshake). If a signal is not on the Bar yet, keep the map and default `idle`. Do not build a fake fact-check product. Do not block on Brain work.

Priority: `connecting` > `factcheck` > `thinking` > `idle`.

## Particle craft (look only)

From `mysticalsin/tonys-jarvis` (`frontend/src/orb.ts` / transparent WebGL orb). Take the **look**. Do not port Jarvis voice, calendar, Docker, or the full-screen desktop overlay. Métis stays Métis.

- ~2000 points on a **unit sphere** (no X-stretch, no Y-squash)
- Additive blending
- Connection lines between nearby points
- Electrons on slow orbits
- Idle breath + slow particle drift (uniform scale / lean — never squash)
- Shader projects X and Y with the **same** NDC scale

The circle is transparent around the particles. No `unpkg` (or any CDN) at runtime in Electron. If WebGL is used, vendor or bundle the renderer. Do not load Three.js from the network.

## Behavior (Bar + minimized only)

- **Drag** anywhere on the display uses the existing bar move (`useWindowDrag` + main `moveBy`). The window stays where the user left it (same in-session persistence as the full bar). Do not invent a new settings key.
- **Click** (not drag) expands to the full bar. Existing minimize → circle and expand → bar stay the API; this slice restyles the rest.
- `useWindowDrag` already swallows the trailing click of a real drag. Keep that. A click that never crossed the dead-zone expands. A drag does not.
- **Interior motion (almost sentient):**
  - Idle: purple breath + slow drift
  - Thinking: brighter violet, denser interior (same box)
  - Fact-check: cyan, same box
  - Connecting: deep indigo, quieter breath, same box
  - Hover: slight awareness (particles lean toward the pointer — lean, not squash)
- **Reduced-motion:** one still but alive-looking **round** frame. No thrash. Must not throw if WebGL is missing.
- **60fps / no jank:** one cheap WebGL rAF while the circle is mounted (docked on the idle bar, or alone when minimized). Cached GL locations. No layout reads in the frame loop. Hide/Island: **zero** orb rAF (`shouldRunOrbRaf` is false unless Bar). Setup is O(n), never an n² neighbor scan. Pause when `document.hidden`.
- **Click / drag latency:** expand is synchronous. Hover lean skipped while dragging. No `getBoundingClientRect` on pointer-move.
- **Spring** is for the **Bar** expanding (`--ease-spring: cubic-bezier(0.22, 1, 0.36, 1)`), not for turning the circle into a lozenge. This spring is Bar-circle only. Do not reuse or restyle Hide/Island overlay-spring, peek hover, or park timing.
- Hide layout and Island layout must not grow a minimize control or a second disk. Hover hit-band is the menu-bar / notch strip only (DESIGN.md). Hide 8×2 paint and Island 132×15 paint stay.
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
- Hover hit band height ≤ menu-bar / notch strip. A Teams-control Y (below the menu bar) must not reveal. No 80–120px pad. `HOVER_HIT_BAND_MAX_PX`.
- Settings close onto Island/Hide force-parks (`shouldForceParkOnBecameIdle`).
- Aspect ratio **1** on every mood. Bounding box constant across moods. Size is 52, never scale-on-appear.
- Click expands; drag does not expand.
- Reduced-motion does not throw.
- Hide/Island do not run the orb rAF (`shouldRunOrbRaf`). Bar may.
