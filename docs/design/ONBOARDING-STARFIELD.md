---
project: Métis
type: scene-contract
scene: Layers.ai "Starfield Close"
owner-slice: exclusive onboarding tour bed + stay-visible chrome
status: implement-exactly
mac-show: Totos-Mac / PR 66
---

# Onboarding Starfield Close bed

Tony Mac-showed the combined onboarding on Totos-Mac and rejected it. This file is the contract after that show. Six-act copy stays locked. Overlay hide-park, island geometry, cursor-watch, and `BAR_MIN_HEIGHT` stay off limits (PR 58). Do not pack. Do not merge. READY TO MERGE stays no until Devon Mac-shows again.

## Outcome (verbatim intent, 2026-08-31)

1. Portal first paint: Métis logo on the **April 29** looping video. Keep it animated. Logo readable. Not the March 19 hillside-vortex clip.
2. After Next/Start: Starfield Close is **purple stars on black space**. Not mint/jade/bone on navy.
3. Next / Continue / Set me up are **always visible** on every act, full opacity. No hover-to-reveal. No fade-up on those CTAs.
4. Overview / Topics / Q&A (Act 2 recap) is 60fps-class. Next advances on the first click. Set me up already worked; Next must too.
5. Goldberg Aria **stops** when onboarding ends or the app closes. No leftover AudioContext.

## Portal first paint (HARD)

When the exclusive stage opens, the first thing on stage is the Métis mark over this looping bed:

```
https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260429_115139_0fc6bd3d-3631-4d26-ab9b-28293887dcc9.mp4
```

- `ONBOARDING_HERO_VIDEO_SRC` is that URL. The March 19 clip (`hf_20260319_055001_…`) is gone.
- `play()` on hero-video mount. Loop, muted, `object-fit: cover`. Do not freeze on frame 1. Kenburns may stay.
- Starfield does **not** mount on `hero`. Video is the portal-open bed. After Next, video unmounts.
- Logo stays on top (`z-index` above the video). Tint may stay so the mark reads.
- Six-act order unchanged. Swap the bed, not the acts.

## Starfield after that click (HARD)

Space bed after Next/Start: purplish and black. Stars are Mantu purple. Background is black like space.

```
CONFIG.bgColor     = #05010a
CONFIG.flameColor  = #9A2BF0
CONFIG.flameColor2 = #7F00DA
CONFIG.colorA      = #C084FC
CONFIG.colorB      = #9A2BF0
CONFIG.colorC      = #7F00DA
```

Clear / fog / scene background in the `#000` / `#05010a` range. Not `#0a0a24` navy. Not mint `#aef6cf` / jade `#5fe6a0` / bone `#eafff2`.

```
STARFIELD_SCENES = problem | setup | personalize | license | ready | skip
shouldMountStarfield(scene) === STARFIELD_SCENES.includes(scene)
shouldMountStarfield('hero') === false
shouldMountStarfield('reveal') === false
```

`reveal` (Overview / Topics / Q&A plus the live Bar demo) drops the WebGL bed so the act stays 60fps-class and Next hit-tests. Time-driven dive, no scrollbar, pixel cap 1.5, seed dt 1/60, appear floor 1.15 — unchanged for scenes that mount the bed.

## Next / Continue / Set me up always visible (HARD)

Those CTAs are on screen at all times, every act, **full opacity**.

Forbidden on those buttons: hover-to-reveal, fade-up, `animation-delay` that leaves them at opacity 0, parent `.scene-enter` / `.onboard-portal-content` opacity 0, `pointer-events: none`, a canvas/video sitting above them.

Required:

- Class `onboard-cta`. Solid high-contrast pill (`#f4f4f5` / `#09090b`). Not `.onboard-glass` (glass on a video looks like hover-to-reveal).
- `opacity: 1`, `pointer-events: auto`, `position: relative`, `z-index` above the video/starfield (`z-index: 0`).
- Outside `.scene-enter`. No fade-up. Geometry test that once required fade-up on hero Next is wrong; keep fade-up off.
- Stage chrome that holds the tour (`OnboardingExperience` root) is `z-index` above the beds.

## Overview / Topics / Q&A — not laggy, Next clicks (HARD)

Act 2 recap titles are Overview / Topics / Q&A (`demoRecapMarkdown`). That act was laggy and Next was dead. Set me up already called `onContinue`.

- Next on a clip with a following beat: `advance()` (same as today).
- Next on the last beat (recap): `onContinue()` — first click leaves Act 2. No stuck state.
- `if (hasNext) advance()` alone is forbidden; last-beat Next must not be a no-op.
- No starfield rAF on `reveal`. Buttons hit-test above any leftover canvas/video (`pointer-events: none` on beds).

## Music dies on finish / quit (HARD)

`createOnboardingMusicBed` still starts on exclusive mount, retries on first click and Next, and does not stop on scene change. Mute still zeros.

`stop()` / teardown **ends playback** on all of:

1. Onboarding complete (`finish` / Ready Get started)
2. Skip Get started that leaves the tour
3. React unmount / renderer destroy
4. `pagehide` / `beforeunload`
5. Portal AudioContext from OPEN/CLOSE/bar-land: `close()` after play; `disposePortalAudio()` on music stop

`stop()` must `pause()`, zero volume, clear `src`, `load()`, and set `autoplay = false`. A leftover `Audio` / AudioContext after quit is a fail. Tests must call `stop()` and assert playback ended.

## Hard: no scroll, ever

Forbidden: `#scroll-host`, "scroll ↓", overflow auto/scroll on the bed, page-scroll dive, unpkg/jsdelivr three.

Required: `html, body, #root` overflow hidden. Starfield wrapper + canvas `position: fixed; inset: 0; overflow: hidden; pointer-events: none`.

## Scroll stand-in

```
breath(t) = 0.42 + 0.28 * (0.5 + 0.5 * sin(t * 0.32))
scrollTarget = reducedMotion ? 0 : breath(tSeconds) + nextBump
smooth += (scrollTarget - smooth) * 0.10
scroll  += (smooth - scroll) * 0.06
```

## Copy + CTAs stay

- Problem lines use `both`. Continue / Next / Set me up outside `.scene-enter`.
- Demo heading, helper, Next, Set me up stay mounted. No `{hasNext && (` around Next.

## Act 4 / tell / bar-land / springs

Unchanged from the prior pass: no white Act 4 wash, tell-the-room centered, bar-land overlay spring + 0.45× OPEN, mark 0.90→1.03→1, pop-in opacity+translate, persona hover `scale(1.02)`.

## Files

| Path | Role |
| --- | --- |
| `docs/design/ONBOARDING-STARFIELD.md` | this contract |
| `docs/ONBOARDING-EXPERIENCE.md` | Mac-show notes (layout/motion only) |
| `onboarding-hero-video.ts` | April 29 portal-open clip |
| `onboarding-starfield-spec.ts` | purple/black CONFIG, mount predicate skips hero + reveal |
| `onboarding-starfield-engine.ts` | WebGL1 scene |
| `OnboardingStarfield.tsx` | canvas host |
| `OnboardingExperience.tsx` | hero video, music start/stop, stay-visible CTAs |
| `OnboardingDemoScene.tsx` | Next advances recap; no starfield hitch |
| `onboarding-music.ts` | start + real stop/teardown |
| `onboarding-portal.ts` | OPEN/CLOSE/bar-land + dispose AudioContext |
| `styles.css` | CTA solid + z-index, starfield, springs |

Off limits: island geometry, cursor-watch, hide park, `BAR_MIN_HEIGHT`, overlay click sound, six-act user-facing copy strings, version 1.8.1, pack, merge, PR 58.

## Tests (must pass)

1. Portal-open video is the April 29 URL, not March 19.
2. Starfield does not mount on `hero` or `reveal`; mounts on problem+.
3. CONFIG is purple/black, not mint/jade.
4. Continue / Next / Set me up: `onboard-cta`, no fade-up, no glass, opacity 1, outside `.scene-enter`.
5. Demo last-beat Next calls `onContinue` (Overview/Topics/Q&A).
6. `stop()` ends Aria playback; `finish` / unmount / pagehide invoke it.
7. Dispose, reduced-motion surge = 0, no unpkg, no scroll-host.
8. Bar-land gain 0.4–0.5× OPEN; pixel cap 1.5; appear floor 1.15.

## Quality

Apple-grade. If a hat would reject, fail the round. 60fps on Retina. CTAs never hover-only. Next never dead. Aria never outlives the tour. Defaults friendly. No em dashes in user-facing copy. Never auto-send. Do not claim READY TO MERGE. Do not Mac-show from a cloud agent. Devon will Mac-show.
