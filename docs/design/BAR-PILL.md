---
project: Métis
type: overlay-slice-contract
slice: bar-pill
owns: Bar layout + minimized thinking-orb circle only
does-not-own: hide park 8×2 paint, island peek 132×15 paint, BAR_MIN_HEIGHT, onboarding, starfield, AgentStatus captions, ASR, identity
owns-also: Bar idle docked circle; Hide/Island must not minimize
notes: Island/Hide hover hit is the camera / Dynamic Island square (DESIGN.md + island/geometry). A 560-wide or 44-tall slab is a bug.
---

# Bar sphere: Jakub thinking-orb

This file is the contract for one slice. Implement only what it names. Hide and Island overlay chrome stay exactly as they are.

## Consultant (feel)

The Bar control is a **being** Tony can drag while using apps, not a badge and not a WebGL marble. At rest it is Jakub Antalik's `solving` orb: the playground Solving animation, always on, with no caption. It lives on the Métis glass Bar (Settings overlay Bar) and as the minimized circle. Same circle both places.

Reference (the real package, not a clone):
- **thinking-orbs** ([orbs.jakubantalik.com](https://orbs.jakubantalik.com/), `thinking-orbs@0.3.1` MIT). Dotted 2D canvas. Monochrome. Nine states. Two tuned sizes (`20` inline, `64` avatar). No WebGL. No `ctx.filter`.
- Idle on this control is `solving` (playground Solving at 64, no "Solving…" word). Listen is `listening` (waveform in the rings). Think is `working` (tilted orbits). Connecting is `connecting`. Fact-check is `searching` (scan meridian; it reads at 64).
- Theme is pinned `dark`: light dots on dark glass. The glass around the orb stays Métis chrome. The orb itself stays a circle.

Tony rejected the Fit Studio glow-core WebGL marble (magenta volume, bloom, specular kiss) and the particle constellation (glitter ball / fibonacci cloud / electron chords). Idle is **not** `#4CA8E8` and **not** Fit Studio `#b266e9`. A science viz is a fail. A magenta core on this control is a fail.

A flat CSS disc, a single radial fill, or a 2D glow quad is a fail. That is a status blob. This slice replaces that blob on the **existing** Bar orb (`bar-pill-orb` / `JarvisOrbButton`). Do not invent a second orb. Do not rewrite Jakub's renderer. Do not copy their canvas strings.

## Craftsman (spec)

### Size (HARD)

- Package canvas: `BAR_PILL_SIZE_PX === 64` (avatar preset). Pass `size={64}` only. Do not invent a third canvas size. Do not pass 51 or 52.
- Visible host / hit target: `BAR_PILL_WIDTH_PX === BAR_PILL_HEIGHT_PX === BAR_PILL_VISIBLE_PX === 51` (64 × 0.8). Scale the **circle CSS**, not the canvas preset.
- Aspect **1** on every mood. Bounding box constant at the visible size.
- Never a potato, stadium, lozenge, 44-tall pill, or flattened disc.
- Never squash or stretch on hover, listen, drag, or minimize. The rest size is 51 CSS, not a hover scale.
- Minimize (Bar only) is **this** circle. Not a different disc.

### no-squash M (HARD)

The left Settings mark (logo / M) is a locked 30×30 circle (`BAR_MARK_SIZE_PX`, `rounded-full`, `aspect-ratio: 1`). Listen / recording may expand the Bar for rec chrome. That M must not flatten, stretch into a capsule, or clip into a bar. Same for any other circular chrome in that left slot. Left grid track is `minmax(30px, 1fr)`. Image `max-width: none` so Tailwind preflight cannot squash it.

### Materials

The real `ThinkingOrb` from `thinking-orbs`. One 2D canvas, package size 64, visible CSS 51×51, theme `dark`, speed `1`. Transparent around the dots. No painted caption, no playground play button, no copy under the canvas.

1. **Package orb.** Dotted 2D canvas. Monochrome light ink. State from the map below. Do not wrap it in WebGL. Do not add a magenta core, bloom, or specular kiss. Do not clip the canvas with `border-radius`.
2. **Circular host.** Square box, `border-radius: 50%`, `background: transparent`. The Bar is the Métis glass. Never a lozenge. Dragging does not squash the orb.
3. **No rec-dot on this circle.** Listen is the `listening` state (waveform in the rings). A second red disc fights that state. The Bar Listen control may keep its own rec-dot; this circle does not.
4. **No Fit Studio.** No `#b266e9` / `#e15cff` / `#8a00f8` core on this control. Product chrome elsewhere may still use `#7F00DA`.

Reduced-motion: package static representative frame. Must not throw if canvas is missing. Do not invent a CSS fallback disc.

### Motion / state map

Product mood stays `orbMood: 'idle' | 'thinking' | 'factcheck' | 'connecting'` plus `listening?: boolean`. The package state is derived. Do not ask. Do not invent a fifth mood.

| Product | Package state | Feel |
| --- | --- | --- |
| **idle** (resting pill you drag) | `solving` | Playground Solving, no text, movable chrome |
| **listen** / capturing | `listening` | Waveform in the rings |
| **thinking** / agent busy | `working` | Tilted orbits |
| **connecting** | `connecting` | Constellation wiring |
| **fact-check** | `searching` | Scan meridian; reads at 64 |

Priority for the package state: `connecting` > `listening` > `factcheck` > `thinking` > `idle`.

```
resolveBarOrbState({ mood, listening })
  connecting → connecting
  listening  → listening
  factcheck  → searching
  thinking   → working
  idle       → solving
```

If connecting is not on the Bar yet, keep the map and default `idle` → `solving`. Do not build a fake product.

Hover: no squash, no lean that warps the circle. Drag: same circle, existing `useWindowDrag`. `document.hidden`: package pauses. Hide/Island: do not mount the orb (`shouldRunOrbRaf` is false unless Bar).

### Do

- Idle on this circle is `solving`, theme `dark`, canvas 64, visible 51. Light dots. No painted word.
- Same circle docked on the idle Bar and alone when minimized.
- Windows: same circle, top-center Bar. No notch, no Mac-only look.
- Use the real package (`import { ThinkingOrb } from 'thinking-orbs'`). Vite bundles it. No unpkg. No CDN.
- Compositor-cheap: package 2D canvas. First frame via existing `paintOrbFirstFrame` (package `MODE_DRAWS` / `resolvePreset`). No layout reads in a custom frame loop.

### Do not

- Flatten on hover or minimize.
- CSS `radial-gradient` as the body. WebGL marble. Fit Studio magenta core. Specular kiss on this control.
- Particle constellation we invented, fibonacci cloud, electron chords, glitter ball.
- Rainbow foil, emoji, a second orb.
- Rec-dot on this circle (the `listening` state is the affordance).
- Clone thinking-orbs strings or rewrite their renderer.
- Embed Spline. Port Jarvis voice, calendar, or Three.js from a CDN.
- Touch Island/Hide hit geometry (`src/main/island/geometry.ts` hit rects, `hoverRestWidth`, Teams-mute tests) except to keep them green.
- Onboarding, Local LLM, Brain MCP, installers.

## Layout (HARD)

Overlay chrome has three layouts. Minimize-to-circle is not a fourth layout and must never switch layouts.

| Layout | Rest | Minimize-to-circle |
| --- | --- | --- |
| **Hide** | Hover-to-reveal hairline (8×2 park). Reveal only from the hardware camera / Dynamic Island square, not a 560×44 menu-bar slab. The bar is **invisible** at rest. | **Forbidden.** The circle is invisible at rest too. Hide the minimize control. `minimize(true)` is a **no-op**. Do not park an orb while Hide is idle. Do not float a sphere in the notch. On hover the bar reveals; never a Hide circle. |
| **Island** | The small visible island (132×15) is already the rest. Hover the camera square at the top center. Left/right menu-bar items and Teams mute / camera / share must never reveal Métis. | **Forbidden.** Do not add a second circle. Island stays the island. Same as Hide: no control, ignore minimize, no layout jump. |
| **Bar** | The classic bar stays on screen **plus** the thinking-orb circle docked on that bar (never a lozenge / pill). | **Allowed — only here.** Click the docked circle to collapse to that same circle. Click the rest circle to expand back to full bar + circle. Drag the rest circle moves. Position is the existing Bar-minimize rest (not a wanderer). Layout stays `bar`. |

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

- Package canvas `BAR_PILL_SIZE_PX` (**64**). Visible box `BAR_PILL_WIDTH_PX === BAR_PILL_HEIGHT_PX === BAR_PILL_VISIBLE_PX` (**51**)
- Aspect ratio is **1** on every mood.
- Bounding box is **constant** across idle, thinking, factcheck, connecting, hover, listen, drag.
- Never a potato. Never a stadium. Never a squashed capsule. Never flatten.
- Never change size. Not on idle, hover, listen, drag, or click-to-expand (the **Bar** expands; the circle itself does not squash).
- It does not wander. Position is the existing Bar-minimize rest.
- Inside that fixed circle, the package dots may breathe. The box does not.

CSS: square box, `border-radius: 50%`. Dark glass chrome, not a lozenge. No scrollbar. No radial Fit Studio body.

## Color language (product, not decoration)

Monochrome thinking-orb. Theme `dark`. Color does not retint the dots. State changes the animation, not the box.

| Mood | Package state | When |
| --- | --- | --- |
| `idle` | `solving` | Standard. Rest. Default. Tony locked Solving with no caption. |
| `factcheck` | `searching` | Fact-check / cited answer. |
| `connecting` | `connecting` | Connecting handshake. |
| `thinking` | `working` | Thinking / ask in progress. |

Listen is not a fill. It is `listening` on the same handle.

```
orbMood: 'idle' | 'thinking' | 'factcheck' | 'connecting'
listening?: boolean
```

Wire from existing Bar signals (ask streaming, fact-check kind, listen chrome). If connecting is not on the Bar yet, keep the map and default `idle`. Do not build a fake product.

Priority: `connecting` > `listening` > `factcheck` > `thinking` > `idle`.

## Glass craft (look only)

From Jakub's playground at size 64, state `solving` (idle), plus `listening` / `working`. Take the **look**. Use the package. Do not clone strings. Do not paint "Solving…".

- Dotted 2D canvas, monochrome light ink, dark theme
- Circle host of Métis glass
- Equal width and height so the orb stays a circle
- Zero WebGL glitter. Zero Fit Studio magenta core. Zero invented constellation.

No `unpkg` / CDN. Bundle the package.

## Behavior (Bar + minimized only)

- **Drag** anywhere on the display uses the existing bar move (`useWindowDrag` + main `moveBy`). The window stays where the user left it (same in-session persistence as the full bar). Do not invent a new settings key. Dragging does not squash the orb.
- **Click** (not drag) expands to the full bar. Existing minimize → circle and expand → bar stay the API; this slice restyles the rest.
- `useWindowDrag` already swallows the trailing click of a real drag. Keep that. A click that never crossed the dead-zone expands. A drag does not.
- **Interior motion (package):**
  - Idle: `solving`
  - Listen: `listening`
  - Thinking: `working`
  - Fact-check: `searching`
  - Connecting: `connecting`
  - Hover: no squash
- **Reduced-motion:** package static frame. Must not throw if canvas is missing.
- **60fps / no jank:** package shared clock while the circle is mounted (docked on the idle bar, or alone when minimized). No custom WebGL loop. No layout reads in a frame loop. Hide/Island: **zero** orb rAF (`shouldRunOrbRaf` is false unless Bar). Pause when `document.hidden` (package).
- **Click / drag latency:** expand is synchronous. No `getBoundingClientRect` on pointer-move.
- **Spring** is for the **Bar** expanding (`--ease-spring: cubic-bezier(0.22, 1, 0.36, 1)`), not for turning the circle into a lozenge. This spring is Bar-circle only. Do not reuse or restyle Hide/Island overlay-spring, peek hover, or park timing.
- Hide layout and Island layout must not grow a minimize control or a second disk. Hover hit is the camera island square only (DESIGN.md). Hide 8×2 paint and Island 132×15 paint stay.
- Quality hats: `docs/design/QUALITY.md`. One REJECT fails the slice.

## Out of scope (do not touch)

- Hide park `8×2` **paint** / `.overlay-hide-target` (hover **sensor** height is in scope if a leftover pad remains)
- Island peek `132×15` **paint**
- `BAR_MIN_HEIGHT` as hide floor
- Onboarding, starfield, AgentStatus caption map, ASR, identity
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
- Aspect ratio **1** on every mood. Bounding box constant across moods. Visible size is 51. Canvas stays 64. Never scale-on-appear. no-squash M on Listen.
- Click expands; drag does not expand.
- Reduced-motion does not throw and still paints the package static frame (not a disc we invented).
- Hide/Island do not run the orb rAF (`shouldRunOrbRaf`). Bar may.
- Renderer is `ThinkingOrb` / package 2D canvas. No WebGL sphere shader. CSS body is circular glass, not a Fit Studio radial fill.
- No rec-dot on this circle. Listen maps to `listening`.
- Circle stays 51×51 visible (64 canvas) on every mood including listen.
- Idle maps to `solving`. Think maps to `working`. Fact-check maps to `searching`. Connecting maps to `connecting`. Theme is `dark`. No visible text node in the orb host.
