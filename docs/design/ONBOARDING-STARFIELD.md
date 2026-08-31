---
project: Métis
type: scene-contract
scene: purple constellation-grid bed (replaces Starfield Close after hero)
owner-slice: exclusive onboarding tour bed + stay-visible chrome
status: implement-exactly
mac-show: Totos-Mac / PR 66
---

# Onboarding constellation-grid bed

Tony overrode the 3D starfield on Totos-Mac. After the April 29 girl clip, the bed is a **2D canvas spring-mass constellation grid**. Not a new page. Not shadcn. Not `/components/ui`. Overlay hide-park, island geometry, cursor-watch, and `BAR_MIN_HEIGHT` stay off limits (PR 58). Do not pack. Do not merge. READY TO MERGE stays no.

## Outcome

1. **Hero.** Métis mark on the April 29 looping girl clip. Keep it animated.
2. **After Next.** Crossfade that clip into a purple kinetic constellation grid. Do not cut. Do not mount three.js starfield or torus after hero.
3. **Mandatory tour.** No Skip the tour, skip chips, skip scene, skip hatch, or Skip to the end.
4. **Locked copy.** Hero tagline and the three problem lines. No em dashes. Do not identify as AI.
5. **CTAs.** Next / Continue / Set me up always visible, full opacity.
6. **Sound.** Aria gain 0.255 (0.3 × 0.85). Portal / bar-land one-shots about +20%. Aria still fully stops on finish / unmount / pagehide.
7. **No crash.** One 2D canvas context for the rest of the tour. Never dispose/recreate on scene change. Never throw out of the renderer.

## Portal first paint (HARD)

```
https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260429_115139_0fc6bd3d-3631-4d26-ab9b-28293887dcc9.mp4
```

- `ONBOARDING_HERO_VIDEO_SRC` is that URL.
- Video mounts on `hero` only for first paint. Loop, muted, `object-fit: cover`.
- On Next: crossfade clip → purple grid (`opacity` only, ~640ms). Do not hard-cut.
- After the fade, unmount the video. Grid stays.

## Constellation grid (HARD)

Port of Tony's 2D spring-mass mesh. Silent full-bleed bed behind existing onboarding copy.

```
GRID.spacing      = 55
GRID.mouseRadius  = 220
GRID.springK      = 18
GRID.damping      = 0.82
GRID.linkDist     = 75
GRID.dprCap       = 2
GRID.bg           = #05010a
GRID.bgDeep       = #030407
GRID.node         = #7F00DA
GRID.line         = #9A2BF0
GRID.ring         = #C084FC
GRID.highlight    = #C084FC
```

Required physics: Hooke spring to rest, damping 0.82, nodes recede from the cursor inside radius 220, shockwave from cursor speed, connecting lines when dist < 75, proximity pulse rings.

FORCE dark. Do not follow `prefers-color-scheme` light. No cyan `56,189,248`. No white-on-slate tech-demo look.

Forbidden from the paste: "Constellation" h1, "High-velocity dynamic mesh" paragraph, hex coordinate readouts, `mix-blend-difference` overlay, cursor-crosshair as a product cursor, Unsplash, lucide-for-the-demo, `demo.tsx` wrapper, `src/components/ui/constellation-grid.tsx`.

Keep mouse interaction. Smooth dt (clamp, seed 1/60). Resize: `setTransform` identity, then set canvas pixel size, then `setTransform(dpr,0,0,dpr,0,0)`. Do not `ctx.scale` every resize without reset. Dispose rAF + listeners on unmount so the bed cannot leak after finish.

```
CONSTELLATION_SCENES = problem | reveal | setup | personalize | license | ready
shouldMountConstellation(scene) === scene !== 'hero' && scene !== 'skip'
shouldMountConstellation('hero') === false
shouldMountStarfield(*) === false after hero  // three.js bed is retired
```

One canvas for the whole post-hero tour. Empty-deps mount. Failed `getContext('2d')` returns null and hides the canvas. Tick and dispose are try/catch.

## Locked copy (HARD)

Hero tagline:

```
Your second brain in the corner.
```

`PROBLEM_STORY`:

```
Never lose the room.
Métis remembers every word of the meeting.
When the question lands, you already have the answer.
```

Staged one-at-a-time (`both`). Old four lines are not user-visible.

## Mandatory tour (HARD)

Forbidden: `Skip the tour`, `Skip to the end`, `onboard-skip-chip`, `setScene('skip')`, skip-the-tour legacy hatch.

Required: Next / Continue / Set me up, `onboard-cta`, opacity 1, no fade-up, no glass on those CTAs.

## Sound (HARD)

```
ONBOARDING_MUSIC_GAIN          = 0.255   // 0.3 * 0.85
ONBOARDING_PORTAL_OPEN_GAIN    = 0.192   // 0.16 * 1.2
ONBOARDING_PORTAL_CLOSE_GAIN   = 0.144   // 0.12 * 1.2
ONBOARDING_BAR_LAND_GAIN       = 0.0864  // 0.072 * 1.2
```

Construct Audio once in `useEffect`, not during render. `autoplay` false until `start()`. `start()` no-ops after `stop()`. `haltOnboardingAudio` remains pause + loop false + volume 0 + src cleared + load. `finish` stops before `onDone` and again in `finally` if `onDone` throws. `pagehide` / `beforeunload` / unmount also stop. `disposePortalAudio()` on stop. No Skip path as the only teardown.

## Files

| Path | Role |
| --- | --- |
| `docs/design/ONBOARDING-STARFIELD.md` | this contract (grid, not 3D starfield) |
| `onboarding-constellation-spec.ts` | GRID constants + mount predicate |
| `onboarding-constellation-engine.ts` | 2D canvas spring-mass bed |
| `OnboardingConstellation.tsx` | one canvas host after hero |
| `OnboardingExperience.tsx` | hero clip, crossfade, locked copy, no skip |
| `onboarding-music.ts` | gain 0.255 + real stop |
| `onboarding-portal.ts` | one-shots +20% |

Off limits: island geometry, cursor-watch, hide park, `BAR_MIN_HEIGHT`, version 1.8.1, pack, merge, PR 58, shadcn scaffold, Brain/orbs.

## Tests (must pass)

1. Portal-open video is the April 29 URL.
2. After Next, constellation mounts; three.js starfield / torus do not.
3. GRID pins: spacing 55, mouse 220, K 18, damping 0.82, link 75, purple/black, no cyan.
4. No demo title / hex readout / mix-blend-difference / light theme.
5. Skip strings gone. Locked copy present. Old four lines gone.
6. CTAs `onboard-cta`, opacity 1, no fade-up, no glass.
7. Music gain 0.255. Portal/bar-land ×1.2. `haltOnboardingAudio` ends playback. `finish` stops even if `onDone` throws.
8. One 2D context, rAF disposed on unmount, resize uses setTransform reset, engine never throws.

## Quality

Apple-grade. 60fps-class. CTAs never hover-only. Piano quieter. Ticks more present. Aria silent the moment the tour completes. Do not claim READY TO MERGE. Devon will Mac-show.
