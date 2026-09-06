---
project: Métis
type: overlay-slice-contract
slice: orb-selection
owns:
  - Settings Appearance orb rest picker
  - overlayOrbStyle persist key
  - Circle rest (Jakub thinking-orbs)
  - Jarvis particle orb (tonys-jarvis) when that card is picked
does-not-own:
  - hide park 8×2
  - island peek 132×15
  - island/geometry hit rects
  - Goldberg Aria
  - Hide/Island minimize-to-circle
notes: DESIGN before UI. Tony lock 2026-09-06 live fail on 286ff55. Default Circle is Jakub thinking-orbs. Jarvis is the particle sphere. Never call Circle Jarvis. Never label Jarvis Obsidian.
---

# Orb selection (Bar rest look)

This file is the contract for one Settings power choice. Hide / Island / Bar overlay chrome stays frozen.

Tony lock 2026-09-06 (after the 286ff55 live fail) is source of truth.

## Why this exists

Tony already picks Hide / Island / Bar. That picker is perfect. Keep it.

Bar rest is a second choice: **Circle** (default, original thinking-orb) or **Jarvis** (tonys-jarvis particle sphere). No Full bar card.

## Settings cards

| Card | Persist | Title | Caption |
| --- | --- | --- | --- |
| Circle | `'jakub'` | Circle | Original thinking orb. Default rest. |
| Jarvis | `'obsidian'` | Jarvis | Particle sphere. Small rest pill. |

Circle shows the **Default** badge. Group label: "Bar rest". Helper: "Applies when Overlay chrome is Bar."

Naming: Circle is Circle. Jarvis is Jarvis. Never "Obsidian". Never "Jarvis / Obsidian". Never call Circle "Jarvis".

Clicking Circle or Jarvis while chrome is Bar rests as the 41 pill. Click the pill (not drag) to open the full bar again. Circle rest / Circle click must leave Settings. No 800+ gray Settings sheet under the bar.

## Hard law (do not break)

- Overlay layouts stay `hide` | `island` | `bar`. This slice does **not** add a fourth layout.
- `overlayAllowsMinimize(layout) === (layout === 'bar')`. Hide and Island never grow a minimize control.
- `overlayShowsBarOrb(layout, minimized) === (layout === 'bar' && minimized)`. Hide/Island never show a circle.
- `overlayDocksBarCircle(layout) === (layout === 'bar')`.
- `overlayUsesThinkingOrb(layout, style)` is Bar and style is not `obsidian`. Circle rest mounts `JarvisOrbButton` + `thinking-orbs`.
- Settings Circle card mounts the same `JarvisOrbButton` as Bar (live `ThinkingOrb`, `solving`, 64 avatar) as a non-clickable preview. Jarvis card mounts the same `ObsidianOrb`. 72px stage. Not a 22px CSS fake disc. Not a static CSS mock. No Full bar card.
- `overlayUsesJarvisOrb(layout, style)` is Bar and style is `obsidian` only. That path mounts `ObsidianOrb` + `data-orb-engine="jarvis-particles"`.
- `overlayShowsSettingsSheet(view, minimized)` is true only when Settings is the view and the Circle pill is not up. No `.cl-root` sheet when `view !== 'settings'` or when minimized.
- Hide park stays 8×2. Island peek stays 132×15.
- No em dash in user-facing copy. No Vibe Island trademark strings.

## Persist

Key: `overlayOrbStyle`.

Values: `'bar' | 'jakub' | 'obsidian'`.

Default: `'jakub'`.

Unknown / missing → `'jakub'`.

## Jarvis look (match tonys-jarvis, do not invent)

Reference: `tonys-jarvis` / `mysticalsin/jarvis2.0` `frontend/src/orb.ts`. Tree three is `three@0.143.0`.

- **Cloud.** Floating sphere with velocity + radius pull. Color `0x4ca8e8`. Not a fibonacci cage. Not a static Métis M.
- **Lines.** Connection segments between nearby particles, amount by state. Same blue.
- **Electrons.** Up to three bright dots that travel along those connections (thinking).
- **States.** `idle` / `listening` / `thinking` / `speaking`.
- **Host.** 41×41 visible box. Never `window.innerWidth`. Not a fullscreen canvas. Pill density and point size are retuned for that host.
- **Engine.** Three.js `WebGLRenderer` + `Points` + `LineSegments`. CSS rings / spark / purple halo is a fail.
- **Reduced-motion.** One static representative frame. Must still read as the particle cloud.
- **First paint.** Circular dark disc behind a transparent canvas. Do not flash a white hole or a square gray box. If WebGL is missing, keep that disc.
- **Captions.** None.

## Tests (required)

- Default `overlayOrbStyle` is `'jakub'`. Parse garbage → `'jakub'`.
- Hide/Island still refuse minimize and refuse `overlayShowsBarOrb`.
- Settings cards are Circle and Jarvis only. Copy has no em dash, no Obsidian, no "Jarvis / Obsidian". Circle is Default. Leftover persist `bar` selects Circle.
- Bar and ControlPill mount thinking-orbs unless `overlayUsesJarvisOrb`. Jarvis card mounts the particle orb.
- Engine color is `0x4ca8e8`. Import is `three@0.143.0`.
- Ghost: Settings closed + Bar/Circle never keeps lastBarHeight 800+ or a Settings sheet. Circle click does not reopen Settings.
- Persist key stays in the settings schema.

## Out of scope

- Packing DMG/EXE
- Aria / onboarding music
- Rewriting Hide/Island hover
- A fourth overlay layout
