---
project: Métis
type: scene-contract
scene: Lady+universe then KineticGrid (rest of tour)
owner-slice: exclusive onboarding bed + no-skip lock
status: implement-exactly
mac-show: Totos-Mac / PR 101
---

# Onboarding KineticGrid (after the lady)

Tony 11:34–35pm America/Toronto. Exclusive first-run is one scene. The first beat is the lady looking at space. After that click, the only bed is a Mantu-purple KineticGrid. No second space shot. No starfield. No Skip. Do not pack. Do not merge. READY TO MERGE stays no. Version stays 1.8.3.

## Outcome

1. First image is the lady-and-universe clip. That is the only space shot.
2. After Next (Tony: “once you log in”), KineticGrid is the only background until Ready finishes the tour.
3. Mouse warps **tiles**. The stage does not slide. Canvas `pointer-events: none`. CTAs stay visible.
4. Users cannot skip. Replay after a completed tour (Settings) still works and still halts Goldberg first.

## First beat — lady + universe (HARD)

Portal first paint is the Métis mark over this looping bed:

```
https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260429_115139_0fc6bd3d-3631-4d26-ab9b-28293887dcc9.mp4
```

- `ONBOARDING_HERO_VIDEO_SRC` is that April 29 URL. March 19 hillside-vortex is gone.
- Mount video only on `hero`. Unmount on Next. Do not keep playing it under later acts.
- Starfield / space-with-moving-lights does **not** mount on any scene after this beat.

## After that beat — KineticGrid only (HARD)

```
KINETIC_GRID_SCENES = problem | reveal | appearance | setup | personalize | license | ready
shouldMountKineticGrid(scene) === KINETIC_GRID_SCENES.includes(scene)
shouldMountKineticGrid('hero') === false
```

There is no `skip` scene. KineticGrid unmounts when `OnboardingExperience` unmounts (tour end / Replay remount).

Canvas host: `src/renderer/src/components/onboarding/KineticGrid.tsx`  
Pure math: `src/renderer/src/lib/onboarding-kinetic-grid.ts`  
Not a shadcn rewrite. Electron + Vite + Tailwind. Do not create `/components/ui`. Do not run the shadcn CLI.

## Colors (HARD)

```
bg           = #05010a
bgDeep       = #1A0033
lineActive   = #7F00DA
nodeActive   = #9A2BF0
glow         = #9A2BF0
ripple       = #7F00DA
lineBase     = faint white/purple (rgba 196,132,252 ~0.16). Not blue. Not #161618.
```

Wrapper / clear color is those purples. Not `#161618`. Not blue.

## Tile warp, not stage slide (HARD)

Port kinetic-grid.tsx behavior: cell warp, ripples, pinned edges, lerp mouse.

Forbidden:

- `camera.position.set(ndc.x * CONFIG.parallax, …)` / `camera.lookAt(ndc.x * CONFIG.parallax, …)`
- CSS `transform: translate` on `.onboard-tour` / `.onboard-stage` driven by pointer
- A second square bed that slides the whole stage

Required:

- Mouse displaces **tiles** with falloff. Edge cells stay pinned.
- Pointer is lerped (not raw). Ripples fade.
- Canvas and wrapper: `position: fixed; inset: 0; pointer-events: none; z-index: 0`
- CTAs: `onboard-cta`, opacity 1, `pointer-events: auto`, z-index above the bed

## Perf (HARD) — the tour is choppy

- `devicePixelRatio` cap **2**
- One `requestAnimationFrame` loop. No extra timers for the bed
- Resize the backing store only on `resize`, never every frame
- Pause rAF when `document.hidden` or the host unmounts
- Do not create the Goldberg `Audio` bed during render (effect only)
- No giant `filter` / `backdrop-filter` on the live exclusive layer (liquid glass stays on small chips, blur ≤ 12px)

## No Skip (HARD)

Delete from the live onboarding tree:

- “Skip the tour”
- `scene === 'skip'` / `setScene('skip')`
- “Skip to the end” / `onSkipToEnd`
- Get started on a skip screen
- Any path that sets `onboardingDone: true` before Ready

`canMarkOnboardingDone({ scene, asrReady, consent })` is true only when `scene === 'ready'` and `firstRunCanFinish({ asrReady, consent })`.

Escape still **halts Goldberg**. Escape does not mark onboarding done.

Replay (Settings, after a completed tour) still patches `onboardingDone: false` and **must** call `haltAllOnboardingAudio()` first. Ready Get started still calls `haltAllOnboardingAudio()` before the `onboardingDone: true` patch.

## Exclusive window (already landed)

While `!onboardingDone`: opaque `#3A0B6B`, `transparent: false`. Never `setSimpleFullScreen` on a transparent window. After done: transparent overlay again.

## Files

| Path | Role |
| --- | --- |
| `docs/design/ONBOARDING-KINETIC-GRID.md` | this contract |
| `onboarding-kinetic-grid.ts` | colors, mount predicate, tileWarp / lerp / ripple |
| `components/onboarding/KineticGrid.tsx` | 2D canvas host |
| `OnboardingExperience.tsx` | hero video, then KineticGrid, no Skip |
| `onboarding-hero-video.ts` | April 29 lady+universe |
| `onboarding-starfield-engine.ts` | no ndc parallax (dead if leftover) |
| `styles.css` | `.onboard-kinetic-grid` |

Off limits: Hide 8×2, Island hover, `BAR_MIN_HEIGHT`, pack, merge, version bump.

## Tests (must pass)

1. KineticGrid file exists. Mantu colors. `pointer-events: none`. No whole-stage translate.
2. Starfield is not mounted after the lady beat.
3. No Skip control in the live onboarding tree.
4. `onboardingDone` cannot become true without completing Ready.
5. `haltAllOnboardingAudio` still before Ready and Replay.
6. Exclusive window still opaque `#3A0B6B` while `!onboardingDone`.
