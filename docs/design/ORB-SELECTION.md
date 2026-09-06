---
project: Métis
type: overlay-slice-contract
slice: orb-selection
owns:
  - Settings Appearance orb rest picker
  - overlayOrbStyle persist key
  - Obsidian-style animated orb (Bar only)
does-not-own:
  - hide park 8×2
  - island peek 132×15
  - island/geometry hit rects
  - Goldberg Aria
  - Hide/Island minimize-to-circle
  - Jakub thinking-orbs renderer internals
notes: DESIGN before UI. Bar minimize-to-circle stays Bar-only. Defaults stay the current full Bar.
---

# Orb selection (Bar rest look)

This file is the contract for one Settings power choice. Implement only what it names. Hide and Island overlay chrome stay exactly as they are.

## Why this exists

Tony already picks Hide / Island / Bar. That picker is frozen overlay-chrome law (`DESIGN.md`, `docs/design/BAR-PILL.md`).

This slice adds a second, optional look for **Bar only**:

1. **Full bar** (default). Current Bar layout. 880-wide bar. Jakub thinking-orb stays docked on the bar. Same as today.
2. **Circle**. Current pill / circle orb (Jakub `solving` idle). Same 41 visible host, package canvas 64, 2x backing. Minimize-to-circle is this circle. Bar only.
3. **Obsidian**. Animated orb matching the Obsidian Graph View reference: dark disc, electric-cyan spark core, soft purple rings. Same 41 host box. Bar only.

Defaults stay friendly: a fresh install is still **Hide** chrome, and a user who later picks Bar still gets **Full bar**. Circle and Obsidian are power choices. No reinstall. Changes apply immediately.

## Hard law (do not break)

- Overlay layouts stay `hide` | `island` | `bar`. This slice does **not** add a fourth layout.
- `overlayAllowsMinimize(layout) === (layout === 'bar')`. Hide and Island never grow a minimize control.
- `overlayShowsBarOrb(layout, minimized) === (layout === 'bar' && minimized)`. Hide/Island never show a circle, even if `overlayOrbStyle` is circle or obsidian.
- `overlayDocksBarCircle(layout) === (layout === 'bar')`.
- Bar minimize-to-circle stays Bar-only. Do not jump Hide → Bar to show an orb.
- Hide park stays 8×2 at `display.bounds.y`. Island peek stays 132×15 at the same Y. Hover hit stays the camera / notch square only.
- Goldberg Aria is out of scope. Do not retune onboarding audio.
- No em dash in user-facing copy. No Vibe Island trademark strings.

## Persist

Key: `overlayOrbStyle`.

Values: `'bar' | 'jakub' | 'obsidian'`.

Default: `'bar'` (full bar).

Unknown / missing / locked-absent → `'bar'`. Same sparse `settings.json` layer as `overlayLayout`. IT may lock the key via `managedKeys`.

`'jakub'` and `'obsidian'` only change the **Bar** rest look. They do nothing while chrome is Hide or Island.

Picking Circle or Obsidian while chrome is Bar may park the idle rest as that circle (minimized). Picking Full bar expands back to the 880 bar. Expanding the circle (click, not drag) still opens the full bar. Listen / Operator / onboarding are unchanged.

## Obsidian look (match the reference, do not invent)

Reference: Obsidian Graph View orb (dark disc, cyan spark, purple rings).

- **Disc.** Near-black circle. Soft edge. Not a lozenge, not a 44-tall pill, not a WebGL marble.
- **Core.** Electric cyan / spark blue at center. Short filaments. Not Fit Studio magenta. Not Jarvis `#4CA8E8`.
- **Rings.** Soft purple-to-blue concentric halo. Pulse with transform + opacity only.
- **Host.** Same 41×41 visible box as the Jakub circle. Same minimize hit target.
- **Motion.** CSS (and optional 2D canvas for the spark). Compositor-only: `transform` and `opacity`. No `filter: blur` on a full-viewport layer. No WebGL.
- **Reduced-motion.** Static representative frame. Must still read as the same disc + spark + rings.
- **First paint.** CSS is visible on the first frame. Do not flash a white or empty hole.
- **Captions.** None. No painted "Solving" word.

Do not restyle Jakub's `thinking-orbs` renderer. Obsidian is a sibling control in the same slot, not a third unrelated blob.

## Settings UI

Cards with a tiny diagram, same grammar as Overlay chrome (`OverlayChromePicker`).

| Card | Title | Caption |
| --- | --- | --- |
| bar | Full bar | The bar stays on screen. |
| jakub | Circle | Jakub solving orb on the bar. |
| obsidian | Obsidian | Dark disc, blue spark, purple rings. |

Group label: "Bar rest". Helper: "Applies when Overlay chrome is Bar."

Selected card is obvious. Locked when `managedKeys` includes `overlayOrbStyle`.

## Tests (required)

- Default `overlayOrbStyle` is `'bar'`. Parse garbage → `'bar'`.
- Hide/Island still refuse minimize and refuse `overlayShowsBarOrb`.
- Settings cards exist for all three styles. Copy has no em dash.
- Obsidian CSS/markup has a dark disc, a spark, and purple rings. Reduced-motion freezes animation.
- Persist key is in the settings schema and `DEFAULT_SETTINGS`.

## Out of scope

- Packing DMG/EXE
- Aria / onboarding music
- Rewriting Hide/Island hover
- A fourth overlay layout
- Inventing a third orb language that is not Jakub and not the Obsidian reference
