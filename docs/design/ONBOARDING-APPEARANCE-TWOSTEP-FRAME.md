# ONBOARDING APPEARANCE — two-step FRAME (Tony voice 20 Sep)
**When:** 2026-09-20 20:00 ET  
**CoS:** Ultron  
**Source:** Tony voice call — fix onboarding; first top vs right; then chrome options that depend on that.  
**Supersedes (flow only):** flat three-card Hidden/Island/Bar ask in ONBOARDING-APPEARANCE.md — rewrite to two beats. Park/geometry surfaces still frozen.

## Intent
Onboarding appearance must feel clear and Apple-grade, not a random three-card dump. **Placement first. Chrome second.** Live preview stays lag-free (compositor-only).

## Beat 1 — Placement
Heading e.g. **Where should Métis sit?**

| id | title | caption |
| --- | --- | --- |
| `top-center` | Top | Along the top of the screen. |
| `right-edge` | Right | Along the right edge. |

Default: `top-center`. Persist `overlayPlacement` immediately on choose (existing `placementSettingsPatch`). Live preview switches mock desktop edge same tick.

## Beat 2 — Chrome (depends on Beat 1)
Heading e.g. **How should it look?**

### If Top (`top-center`)
| choice | Maps to | Caption (Tony voice) |
| --- | --- | --- |
| Full bar that hides | `overlayLayout: hide` (+ autoHide) | Move to the top, then click to open. |
| Full bar that stays | `overlayLayout: bar`, orb rest full / non-minimized default | The bar stays on screen. |
| Circle | `overlayLayout: bar` + `overlayOrbStyle: jakub` | Circle rest — original thinking orb. |
| Circle (Jarvis) | `overlayLayout: bar` + `overlayOrbStyle: obsidian` | Particle sphere rest. |

Both circles are first-class options (Tony: "both circles as an option"). Island: **keep as optional fifth card** only if preview already exists — do not drop without Tony; default order puts Island after hide or omit until he asks. Prefer Tony's four: hide bar / stay bar / Circle / Jarvis.

### If Right (`right-edge`)
| choice | Maps to | Caption |
| --- | --- | --- |
| Dock sliver | `overlayLayout: dock`, dock rest sliver | Thin rail; hover opens the panel. |
| Dock invisible | `overlayLayout: dock`, invisible rest | Nothing on screen until you approach the edge (paint-only; hit band identical). |

(If Bar-on-right is already supported by geometry, offer "full bar on the right" only when contract tests already allow it — else dock-only for right.)

## UX rules
1. Beat 1 → Continue → Beat 2 (or auto-advance on card click if preview is clear).
2. Back from Beat 2 returns to Beat 1 without wiping placement.
3. Live preview at top of stage: placement mock + chrome rest/expand per DESIGN.md motion (320–380ms spring).
4. Finish still must **not** overwrite layout/placement in `onDone` — only the appearance scene patches.
5. Settings Appearance remains the power surface; onboarding stays the friendly path.
6. No em dash. No Vibe Island strings. DESIGN before UI.

## Do not touch
Hide 8×2 park geometry, Island hover rects, Cap2 wake, Cap4 dock Integrator path (except reading dock rest enums), pack, merge.

## Prove
- Mac feel: Beat 1 Top/Right; Beat 2 options change with placement
- Persist round-trip settings
- Preview no lag / reduced-motion snap
- Ultron stamp after Tony eye

## ETA
FRAME implement READY-FOR-FEEL **~9:00–9:30pm ET** (after Cap4 motion tip if same Claude seat — prefer parallel worktree if Cap4 motion still open).
Pack HOLD.
