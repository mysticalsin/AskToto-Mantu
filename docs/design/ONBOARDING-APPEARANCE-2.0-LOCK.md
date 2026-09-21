# ONBOARDING APPEARANCE 2.0 — DESIGN LOCK
**When:** 2026-09-20 20:00 ET  
**CoS:** Ultron  
**Tony (voice + chat):** First ask top vs right. Then, depending on that, offer Hidden / full bar that hides / full bar that stays / both circles.
**Status:** DESIGN before UI. Cap4 motion continues in parallel; this is a separate lane.
**Pack:** HOLD

## Replaces
Current onboarding three-card flat ask (Hidden / Island / Bar) in `ONBOARDING-APPEARANCE.md` is **superseded** for the guided appearance beat. Settings may keep its pickers; onboarding must match this two-step flow.

## Flow (HARD)

### Step 1 — Placement
Heading: **Where should Métis sit?**  
Two cards only:

| id | title | caption |
| --- | --- | --- |
| `top-center` | Top | Along the top of the screen. |
| `right-edge` | Right | Along the right edge. |

Live preview updates on the same tick. Persist `overlayPlacement` immediately via existing patch helpers.

### Step 2 — Chrome (depends on Step 1)
Heading: **How should it look?**  
Cards offered **after** placement is chosen. Selection persists `overlayLayout` + `overlayOrbStyle` (+ `autoHideOverlay` as today).

#### If Top (`top-center`)
| Card | Maps to | Caption |
| --- | --- | --- |
| Hidden | `overlayLayout: hide` | Move to the top, then click to open. Default. |
| Full bar that hides | `overlayLayout: bar` + auto-hide / minimize-to-edge behavior already used for hide-friendly bar | Full bar; tucks away when idle. |
| Full bar that stays | `overlayLayout: bar` + stays visible (no auto-hide) | Full bar stays on screen. |
| Circle | `overlayLayout: bar` + `overlayOrbStyle: jakub` | Thinking orb rest (default Circle). |
| Jarvis circle | `overlayLayout: bar` + `overlayOrbStyle: obsidian` | Particle sphere rest. |

Island: **omit from onboarding** unless Tony re-asks (he did not name Island in this lock). Settings can still expose Island.

#### If Right (`right-edge`)
| Card | Maps to | Caption |
| --- | --- | --- |
| Dock (panel) | `overlayLayout: dock` | Tall sidecar; hover opens. Default for right. |
| Full bar that hides | `bar` + auto-hide on right-edge placement | Full bar on the edge; tucks away. |
| Full bar that stays | `bar` stays on right edge | Full bar stays visible. |
| Circle | `bar` + `jakub` | Circle rest on the edge. |
| Jarvis circle | `bar` + `obsidian` | Jarvis rest on the edge. |

Exact auto-hide flags: reuse `autoHideOverlayForLayout` / existing bar minimize semantics — do not invent a third hide system. Document the chosen mapping in the tip note.

## Preview (HARD)
- Same exclusive-stage CSS mock rules as current contract: compositor-only, no real Bar/WebGL.
- Preview must reflect **placement + chrome** (top strip vs right rail; bar vs circle vs dock vs hidden).
- Card click remounts preview `key=${placement}:${layout}:${orbStyle}`.

## Copy / law
- No em dash. No Vibe Island strings.
- Geist/Inter + DESIGN.md tokens.
- Design skills OK for visual polish; **this FRAME owns information architecture**.
- Do not break Cap4 dock geometry / Cap2 ear while editing onboarding.

## Files (owners)
- `OnboardingAppearance.tsx` / `onboarding-appearance.ts` — two-step UI + helpers
- `ORB-SELECTION.md` / Settings: onboarding may set Circle/Jarvis; Settings Bar-rest picker stays for later changes
- Tests: seed/patch/preview phase for placement→chrome matrix
- Do not edit Hide 8×2 / Island hover geometry

## Sequence
1. DESIGN this file (done)
2. Claude implement two-step appearance on Cap4 tip tree (or dedicated branch off current dock HEAD)
3. Ultron Mac feel: Step1 → Step2 for Top and Right
4. Tony eye before stamp

## ETA
FRAME ACK now. First READY-FOR-FEEL **~9:00–9:30pm ET** (after Cap4 motion tip if same Claude seat — otherwise parallel).
