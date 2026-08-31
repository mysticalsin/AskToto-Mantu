---
project: Métis
type: scene-contract
scene: Layers.ai "Starfield Close"
owner-slice: exclusive onboarding tour bed + stay-visible chrome
status: implement-exactly
mac-show: Totos-Mac / PR 66
---

# Onboarding Starfield Close bed

Tony Mac-showed PR 66 on Totos-Mac. The first image was a frozen poster, Aria was silent, copy vanished, Continue arrived late, Act 4 had a bleached white bar, Tell the room sat left of the bar, and the landing bar had no quieter dimension cue.

This file is the contract after that show. Six-act copy stays locked. Overlay hide-park, island geometry, cursor-watch, and `BAR_MIN_HEIGHT` stay off limits. Do not pack. Do not merge.

## Outcome (verbatim intent)

1. First image is **animated**. He needs to see the galaxy move from frame one.
2. Goldberg Aria **must play** on exclusive-stage mount. Retry on first click and on Next.
3. Space/starfield acts: Continue visible from the start. Text appears and **stays**. Next and Set me up stay on screen.
4. When the Métis bar appears after the tour: quieter dimension-open (about 0.4–0.5× portal OPEN gain, shorter). Keep portal OPEN and CLOSE working.
5. How should Métis show up: **no** light white rectangle at the top.
6. Tell the room: text really **centered**, not stuck on the left of the bar.
7. More animation on the logo landing and persona/setup pops. Must feel interactive. Reduced-motion: still land, no bounce.

## Galaxy from frame one

`shouldMountStarfield` includes `hero` (and the rest of the exclusive stage: problem, reveal, setup, personalize, license, ready, skip). Act 1 is a live mint/jade tunnel, not a poster.

```
STARFIELD_SCENES = hero | problem | reveal | setup | personalize | license | ready | skip
shouldMountStarfield(scene) === STARFIELD_SCENES.includes(scene)
```

- Time-driven dive already specified below. No scrollbar. Canvas `pointer-events: none` under UI.
- Keep the looping CloudFront hero video **if it actually plays**. Call `play()` on hero-video **mount**, not only on Next. Never leave a frozen first frame. Kenburns on a still is not enough.
- Video sits under the starfield on hero. If WebGL1 fails, keep the video bed. Never blank the tour.
- Appear must not hide the galaxy for a long hold:

```
appearProgress = clamp(elapsedMs / 480, 0, 1)
uOpacity = appearProgress * CONFIG.opacity   // 0 → 2 in 480ms, no 300ms black hold
```

## Hard: no scroll, ever

Forbidden: `#scroll-host`, "scroll ↓" / scroll-down hint, overflow auto/scroll on the bed, driving `scrollTarget` from page scroll, unpkg/jsdelivr three.

Required: `html, body, #root` overflow hidden. Stage overflow hidden. Starfield wrapper + canvas `position: fixed; inset: 0; overflow: hidden; pointer-events: none`. Tunnel keeps moving on its own.

## Scroll stand-in

```
breath(t) = 0.42 + 0.28 * (0.5 + 0.5 * sin(t * 0.32))
scrollTarget = reducedMotion ? 0 : breath(tSeconds) + nextBump
smooth += (scrollTarget - smooth) * 0.10
scroll  += (smooth - scroll) * 0.06
```

`nextBump` += 0.16 on Next/Continue, decays `exp(-dt * 2.4)`. Reduced motion: `scrollTarget = 0`, drift/spin at 12%.

## Music (Goldberg Aria)

`createOnboardingMusicBed` lives for the whole exclusive mount. Do not pause or destroy it on scene change. Mute chip still zeros gain. Portal SFX stay a separate AudioContext and must not call `audio.pause()` or `bed.stop()`.

Required play path:

1. `music.start()` on exclusive-stage mount (same effect as `playPortalOpen`).
2. `music.start()` again on the first pointerdown/click on the stage (Mac autoplay often rejects mount play).
3. `music.start()` on Next / Start / Continue (not only `retryIfNeeded`).
4. `play()` is the first media call. Do not seek before play.

## Copy + CTAs stay

- `.fade-up` uses `forwards` (or `both`). Never `backwards` alone on problem-story lines. Text that fades in remains.
- Problem Continue is visible immediately. No `${200 + PROBLEM_STORY.length * 1100}ms` delay on that button. Line stagger may stay.
- Demo (`OnboardingDemoScene`): heading, helper line, **Next**, and **Set me up** stay mounted for the whole clip. Do not `{hasNext && (` unmount Next when beats advance.
- Setup / personalize Continue stays (already mounted).

## Act 4: no white rectangle

Starfield is the bed. Remove:

- `.onboard-act4::before` white radial `rgba(255,255,255,0.48)` at 50% 12%
- `.onboard-stage:has(.onboard-act4)` white wash `rgba(255,255,255,0.36)` at 50% 0%

No bleached bar across the top. `onboarding-tell-the-room.test.ts` must pin the absence of that wash.

## Tell the room centered

`.onboard-tell-card` is centered in the stage (`margin-inline: auto`, `text-align: center`, `align-items: center`). Title, lead, quote, why, and checkbox row are centered. Quote stays a pill, still centered. Not `text-align: left` plus stretch that sticks the block to the left of the bar.

## Bar appears = quieter dimension

Portal OPEN gain 0.16 / CLOSE 0.12 stay the loud pair. Keep those animations working.

When onboarding finishes and the island/bar lands:

- SFX: shorter quieter dimension-open, **0.4–0.5× OPEN gain** (0.072), about 0.56s. Lives next to portal SFX in `onboarding-portal.ts` (`playBarLand`). Must not kill the Aria.
- Visual: brief portal-slit / dimension peel on `.aw-widget` via `html.metis-bar-land` (clip-path inset opening). Not as loud or as long as exclusive open/close.
- Do **not** change hide-park 8×2, island geometry, cursor-watch, `BAR_MIN_HEIGHT`, or hover math. Do not edit overlay chrome files for park/hover.

## Interactive logos

- Hero Métis mark: real land spring (scale + settle), not a static dump. Class `hero-mark` / `onboard-mark-land`.
- Persona cards: pressable spring (`:active` scale). Hover lift allowed.
- Setup rows / meeting-type chips: pop-in stagger, fill-mode forwards. Not a dump.
- Reduced-motion: still land (opacity/translate to rest). No bounce, no scale overshoot.

## Scene (unchanged geometry)

CONFIG, LAYERS, shaders, three composers, pointer, per-frame drift/spin: same as the original Starfield Close spec. `three@0.143.0` vendored. WebGL1Renderer, antialias, VSMShadowMap.

## Files

| Path | Role |
| --- | --- |
| `docs/design/ONBOARDING-STARFIELD.md` | this contract |
| `docs/ONBOARDING-EXPERIENCE.md` | Mac-show notes (layout/motion only) |
| `src/renderer/src/lib/onboarding-starfield-spec.ts` | CONFIG, shaders, breath, mount predicate includes hero |
| `src/renderer/src/lib/onboarding-starfield-engine.ts` | WebGL1 scene |
| `src/renderer/src/components/OnboardingStarfield.tsx` | canvas host |
| `OnboardingExperience.tsx` | mount on hero+, music start/retry, stay-visible copy |
| `OnboardingDemoScene.tsx` | Next + Set me up stay mounted |
| `onboarding-portal.ts` | quieter `playBarLand` (OPEN/CLOSE unchanged) |
| `styles.css` | starfield, fade-up forwards, no Act 4 white wash, tell-card center, mark/persona springs, bar-land slit |

Off limits: island geometry, cursor-watch, hide park, `BAR_MIN_HEIGHT`, overlay click sound, `onboarding-hero-video.ts` clip URL, six-act user-facing copy strings, version 1.8.1, pack, merge.

## Tests (must pass)

1. Starfield mounts on `hero` (and the other exclusive scenes).
2. Music `start()` is invoked on mount and again on Next (and first-click path exists).
3. Problem Continue is present at t=0 (no 1100ms * lines delay on that button).
4. Problem fade-up uses forwards/both, not backwards-only.
5. Demo Next + Set me up still mounted after playback beats (no `hasNext &&` around Next).
6. No white Act 4 top wash (`::before` 0.48 and `:has(.onboard-act4)` 0.36 gone).
7. Tell-the-room card is centered (`text-align: center`).
8. Dispose, WebGL fail fallback, reduced-motion surge = 0, no unpkg, no scroll-host.
9. Bar-land gain is 0.4–0.5× portal OPEN; OPEN/CLOSE gains unchanged.

## Quality

Apple-grade. Defaults friendly. Power stays in Settings. No em dashes in user-facing copy. Never auto-send. Do not claim READY TO MERGE. Devon will Mac-show.
