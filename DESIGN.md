# Overlay contract

This file is the gate. Do not add or restyle overlay / onboarding UI unless it matches this document.

## Chrome

Three modes in Settings (persist, no reinstall). Default on a fresh install is **hide**.

1. **hide** (default). Fully hidden until the pointer is at the top, then reveal down. Leave hides. Mac: below-notch hover target (path A then C). Windows: top-center of the work area, taskbar-aware, **no fake notch**.
2. **island**. The always-visible peek capsule. Hover expands down. Leave returns to the peek.
3. **bar**. Classic bar and pill. Always visible.

## Island Y

When hide or island is revealed (or island is peeking), the top sits **fully below** the Mac hardware notch. It is not clipped.

- **Path A (chosen).** Electron `display.workArea.y` — first unobstructed row under the notch / menu bar. Never park at `display.bounds.y` (0). That is the hardware island and clips the capsule.
- **Path C.** Only when `workArea.y` is 0 (Electron reported no inset) on a notched display: apply a notch strut (`menuBarHeight`, or 37px). Do not push `y = 0` again.

Peek/hide-target and revealed share that Y. Height changes; Y does not. Windows never applies a notch strut.

## Hover / leave

Hide and island: hover or click expands **down** from the safe top to the full bar (same top edge, taller height). Leave collapses (`pointer-leave` → grace → hide or peek). Bar does not auto-collapse.

## Onboarding

Every act stays on one **exclusive fullscreen** until `onboardingDone`. Then destroy that stage and leave the small island. Do not shrink to a mid-flow card.
Stage API: `exclusiveOnboardingBounds(display.bounds, display.workArea)`; exit only on `onboardingDone`.

**Portal.** First paint of the exclusive stage is an iris (circle / rounded opening from the notch or top-center) that expands to the full stage. Compositor-only (`clip-path` or mask + transform), 500–700ms ease-out. Stage content (stripes, hero) is already composited behind the mask. Original short OPEN whoosh (tiny precomputed buffer at module load, never synthesized on the click). Play with the iris. OS mute applies. Reduced-motion: no iris (instant stage); do not mute sound unless the OS or the onboarding mute chip is muted.

**Portal close.** When `onboardingDone` is about to flip (Ready or Skip Get started): reverse iris into the island, CLOSE whoosh (slightly lower than open), then exit exclusive fullscreen and park path A (`Y >= 25`). Do not call `setSimpleFullScreen(false)` before the close has been seen (or reduced-motion skip). Renderer plays close, then persists `onboardingDone` so main can `exitExclusiveOnboardingStage`. Do not leave a 1800×1169 hole or a `y=0` peek.

**Skip the tour.** Skip leaves the six-act narrative but stays on the exclusive Métis stage. It is one screen: the Tell the room glass card (same copy, required checkbox) plus Get started. Same portal close. `recordingConsent` still required (CMO-QA #1). Do not mount the legacy `Onboarding.tsx` slides for Skip. Hero Skip is a quiet secondary glass chip, never louder than Get Started.

The stage is a **Mantu purple** brand wash (`#3A0B6B` / `#7F00DA` / `#9A2BF0`), exclusive, rich — never a solid black void and never amber. Depth is the purple radial wash plus two oversized GPU stripe layers (repeating linear-gradient bands in that palette, plus a thin light sheen). The layers rotate opposite directions with `transform: rotate` only (~40s and ~70s linear infinite), `mix-blend-mode` screen/overlay, opacity ~0.28–0.4, `will-change: transform`, `pointer-events: none`. They cover the full stage after Act 1 unmounts the hero video. No `filter: blur` drifting orbs. `prefers-reduced-motion` freezes rotation at 0deg and **keeps the stripe pattern** (still not a flat fill).

**Motion budget (60fps-class).** Compositor-only: `transform` and `opacity`. Never animate `filter`, `backdrop-filter`, blur, box-shadow, or layout. Scene enter is opacity + translate only, ~300ms ease-out — no scale-down, no `develop-in` filter blur on onboarding. Hover on large surfaces does not scale; CTA hover is brightness or `scale(1.02)` max. Liquid glass (backdrop-filter ≤ 12px) is on small CTAs / chips only — no full-viewport glass, no 50px blur over video.

Act 1 (welcome) plays a full-viewport muted looping video behind the Métis mark (`object-cover`, z-0; UI z-10). No CSS `filter` on the `<video>`. A purple Mantu tint sits on the video. Not a Bloom or Axon landing page. If the video fails or motion is reduced, the purple wash stays. **Leave Act 1: pause and unmount/hide the hero video** so it is not compositing after welcome. Get Started, Skip, and the Tony Walteur byline use liquid glass (capped blur, inset highlight, gradient-border). Steal the technique, not Bloom copy.

Primary CTAs (Get Started / Continue / Next) are **large** hit targets (min 52×220), high contrast, bottom-safe, and visible. They must not hitch.

Act 2 is a scripted **Métis** demo on the real product: meeting / transcript / copilot / Intelligence, fake data only. Not an mp4. Not coding terminals. Not Vibe Island strings. The recap uses the **chosen** built-in role's summary layout. Each `DEMO_STAGE` is one video: the current clip **plays by itself**. **No auto-advance** to the next video. Next is the only way to change clips; it resets the rAF clock to 0 in the same click so the next clip plays immediately (it does not sit frozen at the previous hold). No 1100ms timer that jumps stages. Continue leaves the whole demo act.

**Demo clock.** Do not `setState` every rAF. Drive the synthetic cursor with a ref + DOM `transform`. Commit React state at beat boundaries, or at most ~10 Hz for transcript text. Prefetch Answer / Copilot (Markdown + shiki) during Act 1 so the first Next does not compile on the click.

Get Started calls `audio.play()` and `video.play()` **as the first media calls in that click** (browser autoplay policy). Next still `play()`s first, then seek 0. Do not `play()` after seek, after `setState`, or after the click stack returns. Do not auto-skip beats. `prefers-reduced-motion` may drop the video; it must not hide the mute control and must not mute the piano.

Welcome byline: `Tony Walteur` is a real link to his LinkedIn (`https://www.linkedin.com/in/tonywalteur/`). It opens in the system browser. Do not make the whole stage a link.

Onboarding music: a bundled, hardware-decoded `<audio>` of J.S. Bach, Goldberg Variations BWV 988, Aria, performed by Kimiko Ishizaka (Open Goldberg Variations, 2012). Composition is public domain. Recording is CC0 1.0. No Web Audio choir pad, no `synthesizeOnboardingPad` on the production path, no synthesis on the click. File ≤ 4MB (ogg/m4a). Loop quietly with cosine fades. Default gain is present but not a concert (`ONBOARDING_MUSIC_GAIN` ~0.40). Mute control stays: mute zeros volume. Reduced-motion does **not** auto-mute. OS mute still applies (system output). LICENSE note: performer, piece, CC0, source URL. Never auto-send.

User-facing onboarding copy never uses an em dash (U+2014). Use a comma, period, colon, or parentheses.

**Tell the room.** After the Act 4 mode cards, before Continue, on the personalize scene: one `.onboard-glass` card (backdrop-filter ≤ 12px). Not a seventh act, not a red legal banner, not a TOS, not a GDPR logo. Title, two short sentences, a spoken sample as a quote chip, then the required `recordingConsent` checkbox (CMO-QA #1). Continue stays disabled until checked. Quiet echo on Act 6 Ready (keep the Listen line; add the sample quote under it). Skip lands on this same card plus Get started (not legacy slides). Do not add a second checkbox. Pin this copy:

- Title: Tell the room
- Lead: Métis captures the meeting so you can keep quality high and actually get things done. People on the call deserve to hear that first.
- Sample quote: I'm using Métis to capture this for notes, follow-ups, and quality.
- Why: Saying it out loud is how we stay transparent and aligned with GDPR.
- Checkbox: I'll tell everyone on the call before I record.

Act 3 shows on-device model **download/install progress** (weights already fetch via `ensureLocalModel` on app open). Never copy "not installed" as a dead state. If RAM-gated, say so honestly.

## Summaries

Each built-in mode (`BUILTIN_MODE_LABELS`: general, meeting, sales, interview, recruiting, negotiation, presentation, support, cold-call) has its **own** recap section layout via `recapPromptFor` / `MODE_RECAP_LAYOUTS`. Not one generic skeleton plus a footnote. Sales focuses on next steps and what a seller must know. Recruiting is an interview sheet. Meeting is decisions and owners. Ship layouts for all nine.

## Copy

Métis voice. Do not clone Vibe Island strings.
