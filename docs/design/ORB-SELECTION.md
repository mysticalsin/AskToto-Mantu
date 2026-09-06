---
project: Métis
type: overlay-slice-contract
slice: orb-selection
owns:
  - Settings Appearance orb rest picker
  - overlayOrbStyle persist key
  - Jarvis particle orb on the Bar circle
does-not-own:
  - hide park 8×2
  - island peek 132×15
  - island/geometry hit rects
  - Goldberg Aria
  - Hide/Island minimize-to-circle
notes: DESIGN before UI. Tony lock 2026-09-06 ~11:41pm ET. Bar circle is the tonys-jarvis particle orb. Never Obsidian. Never a gray box.
---

# Orb selection (Bar rest look)

This file is the contract for one Settings power choice. Hide / Island / Bar overlay chrome stays frozen.

Tony lock 2026-09-06 ~11:41pm ET is source of truth. It overrides the 2026-09-05 "do not replace default with Jarvis" line and QUALITY.md / BAR-PILL.md "no WebGL" **for the Bar circle only**.

## Why this exists

Tony already picks Hide / Island / Bar. That picker is perfect. Keep it.

Bar is the **full bar with a clickable circle**. That circle is the animated particle orb from `https://github.com/mysticalsin/tonys-jarvis.git` `frontend/src/orb.ts`. Not a gray box. Not static CSS rings. Not the broken thinking-orb minimize.

## Settings cards (two)

| Card | Persist | Title | Caption |
| --- | --- | --- | --- |
| bar | `'bar'` | Full bar | The bar stays on screen with a Jarvis circle. |
| Circle | `'obsidian'` (legacy `'jakub'` also selects this) | Circle | Jarvis particle orb. |

Full bar shows the **Default** badge. Group label: "Bar rest". Helper: "Applies when Overlay chrome is Bar."

Naming: **Circle** and/or **Jarvis**. Never "Obsidian". Never "Jarvis / Obsidian".

Clicking Circle while chrome is Bar may rest as just the 41 particle orb (minimized). Click the orb (not drag) to open the full bar again. Full bar expands back to 880 with the same Jarvis circle docked.

## Hard law (do not break)

- Overlay layouts stay `hide` | `island` | `bar`. This slice does **not** add a fourth layout.
- `overlayAllowsMinimize(layout) === (layout === 'bar')`. Hide and Island never grow a minimize control.
- `overlayShowsBarOrb(layout, minimized) === (layout === 'bar' && minimized)`. Hide/Island never show a circle.
- `overlayDocksBarCircle(layout) === (layout === 'bar')`.
- `overlayUsesJarvisOrb(layout)` is true only for Bar. The docked circle and the minimized circle both mount the particle orb (`ObsidianOrb` + `data-orb-engine="jarvis-particles"`).
- Do not mount `JarvisOrbButton` / thinking-orb on Bar or ControlPill. That path was the gray box.
- Hide park stays 8×2. Island peek stays 132×15.
- No em dash in user-facing copy. No Vibe Island trademark strings.

## Persist

Key: `overlayOrbStyle`.

Values: `'bar' | 'jakub' | 'obsidian'`.

Default: `'bar'`.

Unknown / missing → `'bar'`. `'jakub'` and `'obsidian'` both mean Circle (Jarvis particle). The picker writes `'obsidian'` for Circle.

## Jarvis look (match tonys-jarvis, do not invent)

Reference: `tonys-jarvis` `frontend/src/orb.ts`. Tree three is `three@0.143.0`.

- **Cloud.** Fibonacci particle sphere. Color `0x4ca8e8`.
- **Lines.** Connection segments between nearby particles. Same blue.
- **Electrons.** Three small orbiting electrons.
- **States.** `idle` / `listening` / `thinking` / `speaking`.
- **Host.** 41×41 visible box. Not a fullscreen canvas.
- **Engine.** Three.js `WebGLRenderer` + `Points` + `LineSegments`. CSS rings / spark / purple halo is a fail.
- **Reduced-motion.** One static representative frame. Must still read as the particle cloud.
- **First paint.** Dark disc behind the canvas (`#050508`). Do not flash a white hole. If WebGL is missing, keep that disc. Do not fall back to a gray thinking-orb box.
- **Captions.** None.

## Tests (required)

- Default `overlayOrbStyle` is `'bar'`. Parse garbage → `'bar'`.
- Hide/Island still refuse minimize and refuse `overlayShowsBarOrb`.
- Settings cards are Full bar and Circle. Copy has no em dash, no Obsidian, no "Jarvis / Obsidian".
- Bar and ControlPill mount the particle orb (`data-orb-engine="jarvis-particles"`). No `JarvisOrbButton`.
- Engine color is `0x4ca8e8`. Import is `three@0.143.0`.
- Persist key stays in the settings schema.

## Out of scope

- Packing DMG/EXE
- Aria / onboarding music
- Rewriting Hide/Island hover
- A fourth overlay layout
