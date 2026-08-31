---
project: Métis
type: overlay-slice-contract
slice: bar-pill
owns: Bar layout + minimized pill only
does-not-own: hide park, island hover, BAR_MIN_HEIGHT, cursor-watch, onboarding, starfield, thinking-orbs, ASR, identity
---

# Bar pill: Jarvis sentient orb

This file is the contract for one slice. Implement only what it names. Hide and Island overlay chrome stay exactly as they are.

## Layout (HARD)

Overlay chrome has three layouts. Minimize-to-pill is not a fourth layout and must never switch layouts.

| Layout | Rest | Minimize-to-pill |
| --- | --- | --- |
| **Hide** | Hover-to-reveal hairline (8×2 park). Not a pill. | **Forbidden.** Hide the minimize control. If any path still calls minimize while layout is hide, **ignore it**. Do not collapse to a pill. Do not jump layout to Bar. |
| **Island** | The small visible island is already the minimized form. | **Forbidden.** Same as Hide: no control, ignore minimize. Do not jump layout. |
| **Bar** | The classic bar stays on screen. | **Allowed.** This is the only layout that can collapse to the Jarvis sentient pill. Click the pill → full bar (layout stays `bar`). Drag the pill around. Position persists via the existing bar-move path. |

Do **not** auto-switch Hide → Bar on minimize. Just make minimize impossible outside Bar.

Shared predicate (one source of truth for Settings, renderer, and main):

```
overlayAllowsMinimize(layout) === (layout === 'bar')
```

- Bar renders the minimize control only when `overlayAllowsMinimize` is true.
- `onBarMinimize` / `window.toto.minimize(true)` / main `setMinimizedWidth(true)` no-op when it is false.
- Expanding (`minimize(false)`) still runs so a leftover pill cannot stick if layout leaves Bar.
- Leaving Bar while minimized unminimizes and parks Hide/Island with existing rest math. That is not a layout jump.

## What the Bar pill is

Only when `overlayLayout === 'bar'` **and** the overlay is minimized:

- The resting control is a rounded **pill / capsule**.
- Tony's JARVIS particle orb lives **inside** it. It is not a static glass chip of mic / pause / stop / ✕ buttons.
- Visual source (look only, not the product): `mysticalsin/tonys-jarvis`
  - `frontend/src/orb.ts` (Three.js particle orb)
  - `desktop-overlay/JarvisOverlay.swift` (transparent WebGL orb)
- Take the **look**. Do not port Jarvis voice, calendar, Docker, or the full-screen desktop overlay. Métis stays Métis.

Locked look (from that orb):

- ~2000 points
- Color `0x4ca8e8` (Jarvis cyan). Not Métis indigo. Not a second accent system.
- Additive blending
- Connection lines between nearby points
- Electrons on slow orbits
- Idle breath + slow particle drift

The capsule is transparent around the particles. No scrollbar. No `unpkg` (or any CDN) at runtime in Electron. If WebGL is used, vendor or bundle the renderer. Do not load Three.js from the network.

## Behavior (Bar + minimized only)

- **Drag** anywhere on the display uses the existing bar move (`useWindowDrag` + main `moveBy`). The window stays where the user left it (same in-session persistence as the full bar). Do not invent a new settings key.
- **Click** (not drag) expands to the full bar. Existing minimize → pill and expand → bar stay the API; this slice restyles the pill.
- `useWindowDrag` already swallows the trailing click of a real drag. Keep that. A click that never crossed the dead-zone expands. A drag does not.
- **Motion (almost sentient):**
  - Idle: breath + slow drift
  - Listening: denser / pulse
  - Paused: dimmer, quieter breath
  - Degraded capture: amber lean (the pill is the last surface that can tell the truth; do not keep a confident cyan while mic-only)
  - Hover: slight awareness (particles lean toward the pointer)
- **Reduced-motion:** one still but alive-looking orb frame. No thrash. Must not throw if WebGL is missing.
- **60fps / no jank:** one cheap WebGL rAF while the pill is mounted. Cached GL locations. No layout reads in the frame loop. **Idle full bar: zero orb rAF** (`shouldRunOrbRaf` is false). Setup is O(n), never an n² neighbor scan. Pause when `document.hidden`.
- **Click / drag latency:** expand is synchronous. Hover lean skipped while dragging. No `getBoundingClientRect` on pointer-move.
- **Spring** expand / collapse (`--ease-spring: cubic-bezier(0.22, 1, 0.36, 1)`), not a snap. This spring is Bar-pill only. Do not reuse or restyle Hide/Island overlay-spring, peek hover, or park timing.
- Hide layout and Island layout must not change size, hover, or rest.
- Quality hats: `docs/design/QUALITY.md`. One REJECT fails the slice.

## Out of scope (do not touch)

- Hide park `8×2` / `.overlay-hide-target`
- Island peek `132×15` / island hover math / cursor-watch
- `BAR_MIN_HEIGHT` as hide floor
- Onboarding, starfield, thinking-orbs, ASR, identity
- Packing, merging, Hide → Bar auto-switch

## Tests (required)

- Minimize control **absent** when `overlayLayout` is hide or island; **present** when bar.
- Calling minimize on hide/island is a **no-op** (renderer and main).
- Bar + minimized renders the Jarvis orb pill (`data-bar-pill-orb`).
- Hide/Island rest sizes unchanged (`OVERLAY_HIDE_PARK` 8×2, `OVERLAY_ISLAND_PEEK` 132×15).
- Click expands; drag does not expand.
- Reduced-motion does not throw.
- Idle full bar does not run the orb rAF (`shouldRunOrbRaf`).
