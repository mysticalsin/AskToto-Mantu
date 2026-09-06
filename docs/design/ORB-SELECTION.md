---
project: Métis
type: overlay-slice-contract
slice: orb-selection
owns:
  - Settings Appearance orb rest picker
  - overlayOrbStyle persist key
  - Jarvis / Obsidian particle orb (Bar only, option 2)
does-not-own:
  - hide park 8×2
  - island peek 132×15
  - island/geometry hit rects
  - Goldberg Aria
  - Hide/Island minimize-to-circle
  - Jakub thinking-orbs renderer internals (default Métis orb)
notes: DESIGN before UI. Tony lock 2026-09-05. Default stays the shipped Métis / Jakub orb. Option 2 is the real tonys-jarvis particle orb, not CSS rings.
---

# Orb selection (Bar rest look)

This file is the contract for one Settings power choice. Implement only what it names. Hide and Island overlay chrome stay exactly as they are.

Tony lock 2026-09-05 ~10:19pm ET is source of truth. It overrides QUALITY.md / BAR-PILL.md "no WebGL" **for option 2 only**. Default Métis / Jakub stays the shipped thinking-orb.

## Why this exists

Tony already picks Hide / Island / Bar. That picker is frozen overlay-chrome law (`DESIGN.md`, `docs/design/BAR-PILL.md`).

This slice adds a second look for **Bar only**:

1. **DEFAULT = Métis.** The existing Jakub thinking-orb you already ship. Full bar keeps that orb docked. Circle uses the same Métis orb in the 41 host. Do not replace default with Jarvis.
2. **SECOND OPTION = Jarvis / Obsidian.** Tony's particle orb from `https://github.com/mysticalsin/tonys-jarvis.git` `frontend/src/orb.ts`: Three.js particle cloud + connection lines + electrons, color `~0x4ca8e8`, states idle / listening / thinking / speaking. Same 41 Bar / pill host. Not a fullscreen canvas. CSS-only rings / spark (`ObsidianOrb` fake) is WRONG for this option.

Defaults stay friendly: a fresh install is still **Hide** chrome, and a user who later picks Bar still gets **Full bar** with the Métis orb. Circle (Métis) and Jarvis / Obsidian are power choices. No reinstall. Changes apply immediately.

## Hard law (do not break)

- Overlay layouts stay `hide` | `island` | `bar`. This slice does **not** add a fourth layout.
- `overlayAllowsMinimize(layout) === (layout === 'bar')`. Hide and Island never grow a minimize control.
- `overlayShowsBarOrb(layout, minimized) === (layout === 'bar' && minimized)`. Hide/Island never show a circle, even if `overlayOrbStyle` is circle or obsidian.
- `overlayDocksBarCircle(layout) === (layout === 'bar')`.
- Bar minimize-to-circle stays Bar-only. Do not jump Hide → Bar to show an orb.
- Hide park stays 8×2 at `display.bounds.y`. Island peek stays 132×15 at the same Y. Hover hit stays the camera / notch square only.
- Goldberg Aria is out of scope. Do not retune onboarding audio.
- No em dash in user-facing copy. No Vibe Island trademark strings.
- Do not restyle `JarvisOrbButton` / `thinking-orbs`. That is the default Métis look.

## Persist

Key: `overlayOrbStyle`.

Values: `'bar' | 'jakub' | 'obsidian'`.

Default: `'bar'` (full bar + Métis orb).

Unknown / missing / locked-absent → `'bar'`. Same sparse `settings.json` layer as `overlayLayout`. IT may lock the key via `managedKeys`.

`'jakub'` only changes the **Bar** rest to the Métis circle. `'obsidian'` only changes the **Bar** rest to the Jarvis particle orb. They do nothing while chrome is Hide or Island.

Picking Circle or Jarvis / Obsidian while chrome is Bar may park the idle rest as that circle (minimized). Picking Full bar expands back to the 880 bar. Expanding the circle (click, not drag) still opens the full bar. Listen / Operator / onboarding are unchanged.

## Jarvis / Obsidian look (match tonys-jarvis, do not invent)

Reference: `tonys-jarvis` `frontend/src/orb.ts`. Tree three is `three@0.143.0`. Prefer that. Do not add another Three.

- **Cloud.** Fibonacci particle sphere. Color `0x4ca8e8`.
- **Lines.** Connection segments between nearby particles. Same blue.
- **Electrons.** Three small orbiting electrons.
- **States.** `idle` / `listening` / `thinking` / `speaking`. Listening expands. Thinking spins faster. Speaking pulses.
- **Host.** Same 41×41 visible box as the Métis circle. Same minimize hit target. Not a fullscreen canvas.
- **Engine.** Three.js `WebGLRenderer` + `Points` + `LineSegments`. CSS rings / spark / purple halo is a fail for this option.
- **Reduced-motion.** One static representative frame. Must still read as the particle cloud.
- **First paint.** Dark disc behind the canvas (`#050508`). Do not flash a white or empty hole. If WebGL is missing, keep that disc.
- **Captions.** None. No painted word.

Do not restyle Jakub's `thinking-orbs` renderer. Jarvis is a sibling control in the same slot.

## Settings UI

Cards with a tiny diagram, same grammar as Overlay chrome (`OverlayChromePicker`).

| Card | Title | Caption |
| --- | --- | --- |
| bar | Full bar | The bar stays on screen. |
| jakub | Circle | Métis orb on the bar. |
| obsidian | Jarvis / Obsidian | Tony particle orb. Blue cloud, lines, electrons. |

Full bar shows the **Default** badge.

Group label: "Bar rest". Helper: "Applies when Overlay chrome is Bar."

Selected card is obvious. Locked when `managedKeys` includes `overlayOrbStyle`.

## Tests (required)

- Default `overlayOrbStyle` is `'bar'`. Parse garbage → `'bar'`.
- Hide/Island still refuse minimize and refuse `overlayShowsBarOrb`.
- Settings cards exist for all three styles. Copy has no em dash. Option 2 is labeled Jarvis / Obsidian.
- `ObsidianOrb` mounts a canvas and `data-orb-engine="jarvis-particles"`. No CSS spark / ring markup.
- Engine color is `0x4ca8e8`. States include idle / listening / thinking / speaking. Import is `three@0.143.0`.
- Persist key is in the settings schema and `DEFAULT_SETTINGS`.
- Default Métis path still uses `ThinkingOrb` (`JarvisOrbButton`).

## Out of scope

- Packing DMG/EXE
- Aria / onboarding music
- Rewriting Hide/Island hover
- A fourth overlay layout
- Replacing the default Métis / Jakub orb with Jarvis
