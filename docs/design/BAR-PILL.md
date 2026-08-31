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
- **Fit Studio energy volume** ([amaris-fit-studio.pages.dev](https://amaris-fit-studio.pages.dev/)): the sphere behind the black MANTU robot (Spline scene). Live look: soft luminous purple-magenta **core**, indigo/violet **halo**, thin radial **star flare**, translucent light volume, feathered edge. Not a hard marble. Not a particle constellation. Not cyan.
- Fit Studio fallback recipe (feel, not a string clone): `--grad: linear-gradient(100deg, #e15cff 0%, #b266e9 46%, #8a00f8 100%)`, accent `#b266e9` / `#8a00f8`, specular `radial-gradient(38% 38% at 36% 32%, white)`. Do not embed the Spline runtime.

Tony rejected the particle constellation (glitter ball / fibonacci cloud / electron chords) and then rejected the quieter Jarvis-blue particle version. Idle is **not** `#4CA8E8`. A science viz is a fail.

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

1. **Energy volume** (ray-sphere, not a 2D disc). Camera on +Z. Equal X/Y scale. Radius fills ~0.90 of the box. Translucent — the center holds, the edge feathers. Deep `#8a00f8` halo, mid `#b266e9`, hot `#e15cff` core. Not a painted marble.
2. **Living core.** Brightest mass is the center (magenta-pink). Breath is uniform scale of intensity, never of the box. Soft internal caustic bands live *inside* the volume as light, not as points.
3. **Indigo halo.** Soft violet bloom just outside the hit, still inside the 52 box. Feathered, not a sticker ring.
4. **Specular kiss.** One tight highlight, upper-left (`~36% 30%`, `light = normalize(-0.38, 0.52, 0.80)`). White, small. Not a looping sheen. Hover may lean the kiss a few degrees. Never squash the sphere to follow the pointer.
5. **Thin star flare.** A handful of radial rays from the core (shader spikes, not a point cloud). Subtle at 52px. Calm.
6. **No constellation.** No fibonacci point cloud. No electron chords. No glitter ball.
7. **Rec-dot (listen only).** Existing red `#F0717A` (`.rec-dot`). 7×7, bottom-right of the 52 box, inside the circle. Dark ring so it reads on purple glass. Do **not** paint the sphere red.

Reduced-motion: paint one still frame of layers 1–5 (and 7 if listening). The still frame must still look spherical: core, halo, kiss, flare. A flat disc at t=0 is a fail. Missing WebGL falls back to a 2D **shaded energy volume** (core + halo + kiss + a few rays, Fit Studio stops), never a single radial blob and never a point cloud.

### Motion

| State | Volume | Interior | Color |
| --- | --- | --- | --- |
| **idle** | Slow breath (~1.3 Hz, amp 0.018) | Soft core, no particles | Fit Studio `#b266e9` (hot `#e15cff`, deep `#8a00f8`) |
| **listen** | Slightly denser pulse | Same glass | Idle purple glass. Rec-dot red on the glass. |
| **think** | Faster breath (~2.2 Hz) | Hotter core, still glass | `#e15cff` family |
| **fact-check** | Steady | Same glass | Calm blue accent `#5AB8F0` (fact-check only) |
| **connecting** | Quiet | Dimmer core | Dimmer purple `#8a00f8` (not indigo `#2A0A4A`) |

`orbMood: 'idle' | 'thinking' | 'factcheck' | 'connecting'`. Listen is `listening: true` on the same handle (motion + rec-dot), not a fifth fill. Priority for fill: `connecting` > `factcheck` > `thinking` > `idle`.

Hover: lean (kiss + volume), not squash. Drag: skip lean. `document.hidden`: pause rAF. Hide/Island: zero orb rAF.

### Do

- Idle on this sphere is Fit Studio purple-magenta glass (`#b266e9` / `#e15cff` / `#8a00f8`). Not Jarvis `#4CA8E8`. Product chrome elsewhere may still use `#7F00DA`; idle on this control is the Fit Studio accent, not that fill hex.
- Same sphere docked on the idle Bar and alone when minimized.
- Windows: same sphere, top-center Bar. No notch, no Mac-only look.
- Rec-dot stays red and readable.
- Compositor-cheap: cached GL locations, no layout reads in the frame loop, setup is constant-time (one quad).

### Do not

- Flatten on hover or minimize.
- CSS `radial-gradient` as the body (that is the old disc). The WebGL / 2D fallback may shade a sphere; the CSS box stays transparent.
- Particle constellation, fibonacci cloud, electron chords, glitter ball.
- Rainbow foil, emoji, a second orb.
- Paint the sphere rec-dot red.
- Embed Spline. Clone Fit Studio copy or chrome. Port Jarvis voice, calendar, or Three.js from a CDN.
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
- Inside that fixed sphere, the glass and core may breathe. The box does not.

CSS: square box, `border-radius: 50%`, `background: transparent`. No dark fill. No scrollbar. No radial body.

## Color language (product, not decoration)

Tight palette. Color tints the volume. No size change with state.

| Mood | Hex family | When |
| --- | --- | --- |
| `idle` | Fit Studio `#b266e9` / `#e15cff` / `#8a00f8` | Standard. Rest. Default. Tony locked this from the Fit Studio sphere. |
| `factcheck` | Calm blue `#5AB8F0` | Fact-check / cited answer. The only mood that may leave the purple family. |
| `connecting` | Dimmer purple `#8a00f8` | Connecting handshake. Still glass. Not indigo `#2A0A4A`. |
| `thinking` | Hot magenta `#e15cff` | Thinking / ask in progress. Hotter core, no traveling dots. |

Listen is not a fill. Rec-dot stays `#F0717A` on the glass.

```
orbMood: 'idle' | 'thinking' | 'factcheck' | 'connecting'
listening?: boolean
```

Wire from existing Bar signals (ask streaming, fact-check kind, listen chrome). If connecting is not on the Bar yet, keep the map and default `idle`. Do not build a fake product.

Priority: `connecting` > `factcheck` > `thinking` > `idle`.

## Glass craft (look only)

From Fit Studio's sphere (Spline + `.orb-lite` fallback). Take the **look**. Do not embed Spline. Do not port Fit Studio copy or chrome. Métis stays Métis.

- Ray-sphere energy volume, not `length(vUv)` disc falloff
- Luminous magenta core + indigo halo + one specular kiss + thin star flare
- Equal X/Y scale so the volume stays a sphere
- Zero particle constellation. Zero electron chords.

No `unpkg` / CDN. No Three.js from the network. Bundle the renderer.

## Behavior (Bar + minimized only)

- **Drag** anywhere on the display uses the existing bar move (`useWindowDrag` + main `moveBy`). The window stays where the user left it (same in-session persistence as the full bar). Do not invent a new settings key.
- **Click** (not drag) expands to the full bar. Existing minimize → circle and expand → bar stay the API; this slice restyles the rest.
- `useWindowDrag` already swallows the trailing click of a real drag. Keep that. A click that never crossed the dead-zone expands. A drag does not.
- **Interior motion (sentient):**
  - Idle: calm purple-magenta glass, breathing core, no particles
  - Listen: idle purple glass, rec-dot red on the glass
  - Thinking: hotter magenta `#e15cff`, faster breath, still a volume
  - Fact-check: calm blue accent, same box
  - Connecting: dimmer purple, quieter breath, same box
  - Hover: slight awareness (kiss leans — lean, not squash)
- **Reduced-motion:** one still **spherical** frame (core + halo + kiss + flare). Not a disc. Must not throw if WebGL is missing.
- **60fps / no jank:** one cheap WebGL rAF while the circle is mounted (docked on the idle bar, or alone when minimized). Cached GL locations. No layout reads in the frame loop. Hide/Island: **zero** orb rAF (`shouldRunOrbRaf` is false unless Bar). Setup is one quad. Pause when `document.hidden`.
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
- Idle fill is Fit Studio purple-family glass (`#b266e9`), not Jarvis `#4CA8E8`, not a particle-cloud contract.
