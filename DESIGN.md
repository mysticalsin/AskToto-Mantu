# Overlay contract

This file is the gate. Do not add or restyle overlay / onboarding UI unless it matches this document.

## Chrome

Three modes in Settings (persist, no reinstall). Default on a fresh install is **hide**.

1. **hide** (default). Fully hidden until the pointer is in the Mac Dynamic Island / top-center notch strip, then reveal down. Leave hides. Windows: top-center of the display, **no fake notch**.
2. **island**. The always-visible peek capsule (may sit in the island / notch). Hover expands down. Leave returns to the peek.
3. **bar**. Classic bar and pill. Always visible.

Settings shows these as **cards with a tiny desktop diagram**, not three text radios. Hide: empty top-middle, faint hover hint, caption "Hidden until you move to the top." Island: small capsule at the top-middle, caption "A small island stays visible. Hover opens it." Bar: full bar at the top, caption "The bar stays on screen." Selected card is obvious. Changes apply immediately. No reinstall. Original Métis copy. No em dash. No Vibe Island trademark strings.

## Island Y

Hide and island **rest in** the Mac menu-bar / Dynamic Island strip so hovering the hardware island hits the window.

- **Hide/island watch rect.** `y = display.bounds.y` (0 on the built-in Retina). Height covers that strip (`workArea.y` / `menuBarHeight`, ~37-44). Width at least the notch (min ~220, cap ~560), top-center. Cursor watch hit-tests this rect. The parked **hide window** is not this strip.
- **Hide park (invisible).** 1–8px fully transparent hairline (or click-through). Not a 44px tint, not a 103px stub, not a 560-wide glass chip. Apple Hide is gone until the pointer enters the island. `clampHeight` / `BAR_MIN_HEIGHT` 44 must not grow this rest after a display move — stay 8×2 on every display.
- **Path A.** Electron `display.workArea.y` is the first unobstructed row under the notch / menu bar — used by **bar** chrome (`workArea.y + margin`) and as the strip **height** for hide/island. Do not park hide/island *below* the island at `workArea.y` (Tony live: Y=39 pad never intersects the island).
- **Path C.** When `workArea.y` is 0 on a notched display, hide/island still rest at `bounds.y` with a strut-tall strip (`menuBarHeight`, or 37px) so the hit rect covers the notch. Bar still floats; never a fake notch on Windows.

Hide/island **rest** stays at `bounds.y` (the hit strip). Revealed chrome sits at `islandSafeTop` / `workArea.y` (~39) so content is fully below the notch — macOS clamps there anyway. Cursor watch **stays** open if the pointer is in the rest strip **or** the revealed bar. Do not fight the OS with `setBounds(y=0)` on the full bar (that hide/reveal loop is the live stutter). Windows: top-center of the display, **no fake notch**.

## Hover / leave

Hide and island: hover or click expands **down** from the rest strip to the full bar at `islandSafeTop` (below the notch). Leave collapses (`pointer-leave` → grace → hide or peek). Bar does not auto-collapse. Pushing the pointer **up** into the Dynamic Island must keep the bar open (smooth, no flicker).

**Hide (default).** Fully gone until the pointer enters the island. The parked window is a **1–8px fully transparent** rest (`ignoreMouseEvents` click-through). `.overlay-hide-target` must not paint a visible rectangle (`background: transparent`). Cursor watch (`getCursorScreenPoint` vs `hoverWatchRestRect`) is the sensor — the window is not a 560×44 hittable slab. Do not park a 44px/103px card. Do not hug hide to 120px.

**Cursor watch (required).** macOS menu bar / Dynamic Island often does **not** deliver `mouseenter` to an Electron window, even at Y=0. Renderer `onMouseEnter` is not enough. Main polls `screen.getCursorScreenPoint()` every ~16-32ms on darwin and Windows top-edge while hide/island is resting and `onboardingDone`: cursor inside the hide/island rest rect → reveal; cursor in the rest strip **or** the revealed bar (+ small grace) → stay (never `setBounds` on a stay tick); cursor in neither → hide. No Accessibility / CGEvent tap required. Do not animate window y every frame.

**Motion (Apple-grade).** Live Dynamic Island feel. Transform and opacity only. `--ease-spring: cubic-bezier(0.22, 1, 0.36, 1)`. The bar is **one surface** (no peek/bar React unmount pop).
- **Reveal:** 320–380ms, `transform-origin: top center`, from `scale(0.92) translateY(-8px)` opacity 0.85 → full. One `setBounds` to the below-notch full bar (`islandSafeTop`) **before** the spring plays.
- **Hide:** 280–340ms reverse spring, **then** park the rest rect. `overlayParkAfterHide` from the renderer on `transitionend` / `animationend`, with a **400ms** timeout fallback so a missed event cannot leave a stuck full bar. Do not `setBounds(park)` on the same tick as hide.
- **Blur:** `backdrop-filter` only when the bar is **settled**, not during the spring.
- **Reduced-motion:** skip the spring, instant size change, still no 24ms fight.
- Leave grace stays ~500ms (`AUTO_HIDE_GRACE_MS`). Island hover may skip dwell (`pointer-enter` + `dwell-elapsed`).

**Leave pill / Settings → Hide.** Pill mode may stay on screen. Putting chrome back on Hide must **disappear** (park the invisible 1–8px rest). Do not `restoreBarWidth` / `setMinimizedWidth(false)` into a ~100px stub or a 560×44 slab at `islandSafeTop`. Closing Settings after picking Hide, or closing Settings back to the idle overlay, parks this invisible rest when the pointer is not in the island or the bar. OverlayIdle + Hide + pointer not hovering is nothing visible. Island may keep the visible 132×15 peek. Bar keeps the full bar.

**Island.** Always-visible peek capsule. May sit in the island / notch (same Y). Hover expands down. Leave returns to the peek. Hug-width is OK on the visible capsule only.

**Bar.** Always the bar. No hide.

`createWindow` when `onboardingDone` + hide/island parks this rest rect immediately (same as exclusive exit). Never boot at 880×84 and hope hug wins. Never rest as 880×816. Never hug hide down to 120px.

## After exclusive exit

When `onboardingDone` flips true, `exitExclusiveOnboardingStage` leaves exclusive fullscreen and parks the default **hide** rest (or island / bar if Settings already chose one). Never an **880×816** mid-flow card. Never a 120×50 pill for hide. Re-apply `setAlwaysOnTop(true, 'screen-saver')` (the level exclusive used). Hide parks a 1–8px transparent rest; `hoverWatchRestRect` still covers the notch strip (`y = display.bounds.y`, height ~37-44). Island is the peek capsule at the same Y. Bar keeps `workArea.y + margin`. Auto-resize must not grow hide into a 44px/103px slab or 880×816. Then destroy the exclusive stage. Do not leave layer 0. Start the cursor watch when layout is hide/island.

## Onboarding

Every act stays on one **visible exclusive stage** until `onboardingDone`. Then park Hide/Island as chosen. Do not shrink to a mid-flow card. Do not paint the tour inside the Hide 8×2 strip or the Island pill.

**Visible tour window (HARD).** While onboarding is running, people must actually see Métis. The tour BrowserWindow covers the user's current display (`exclusiveOnboardingBounds(display.bounds, display.workArea)`), alwaysOnTop, clickable, opacity 1, not off-screen, not under the Dock, not `setIgnoreMouseEvents(true)`. It does **not** inherit Hide 8×2 bounds, Island peek bounds, or Hide click-through. `skipTaskbar` is off and Mission Control / Cmd-Tab can find it for the tour only (show Dock / `regular` activation on darwin). Do **not** use `setSimpleFullScreen(true)`: LSUIElement + simple-fullscreen parks the tour on a space the user cannot find. Overlay Hide / Island / LSUIElement / skipTaskbar stay correct **after** `onboardingDone`. Exit only on `onboardingDone`. Overlay chrome math (PR 58) is untouched.

**Portal.** First paint is the looping CloudFront girl clip + Métis logo (`ONBOARDING_HERO_VIDEO_SRC`) on that full visible stage. Do not start the open as a 120×36 notch pill (that reads as Hide). Close still collapses to a soft island pill (1.1–1.4s, `mask-image`, never a razor `clip-path: circle(...)` on `.onboard-stage`). Close easing `cubic-bezier(0.4, 0, 0.2, 1)`. Reduced-motion: no portal (instant stage); do not mute sound unless the OS or the onboarding mute chip is muted.

**Portal sound.** Original, copyright-free, precomputed at module load. Never synthesize on the click. OPEN and CLOSE are different sounds (not one whoosh played twice, not a 160ms noise burst). OPEN: slow rising sci-fi entry (clean shimmer / rising air-tone), ~1.1–1.4s, quiet. CLOSE: different falling sci-fi close (darker, descending), ~1.1–1.4s. OS mute and the onboarding mute chip zero both. This is not the Goldberg Aria gain.

**Portal close.** When `onboardingDone` is about to flip (Ready Get started): collapse the visible stage to the top-center island pill (1.1–1.4s), play the CLOSE tone, then `exitExclusiveOnboardingStage` and park Hide/Island (`Y >= 25` path A). Do not snap the BrowserWindow to Hide 8×2 or Island peek while the stage is still full-bleed. Renderer plays close, then persists `onboardingDone`. Restore accessory / skipTaskbar / hidden-in-Mission-Control after exit. Do not leave a 1800×1169 hole or a `y=0` peek.

**Mandatory tour.** The exclusive onboarding is not optional. No skip control, skip chips, skip scene, skip-the-tour legacy hatch, or a skip-to-the-end CTA. Next / Continue / Set me up stay always visible. `recordingConsent` still required (CMO-QA #1) on Ready. Do not mount the legacy `Onboarding.tsx` slides.

The stage is a **Mantu purple** brand wash (`#3A0B6B` / `#7F00DA` / `#9A2BF0`), exclusive, rich — never a solid black void and never amber. Depth is the purple radial wash plus two oversized GPU stripe layers (repeating linear-gradient bands in that palette, plus a thin light sheen). The layers rotate opposite directions with `transform: rotate` only (~40s and ~70s linear infinite), `mix-blend-mode` screen/overlay, opacity ~0.28–0.4, `will-change: transform`, `pointer-events: none`. They cover the full stage after Act 1 unmounts the hero video. No `filter: blur` drifting orbs. `prefers-reduced-motion` freezes rotation at 0deg and **keeps the stripe pattern** (still not a flat fill).

**Motion budget (60fps-class).** Compositor-only on the stage and bed: `transform` and `opacity`. Never animate `filter`, `backdrop-filter`, blur, box-shadow, or layout on the constellation canvas, hero video, or full viewport. Scene enter is opacity + translate with a short gooey overshoot (~360ms). Hover on large surfaces does not scale; CTA hover is brightness or `scale(1.02)` max. Liquid glass (backdrop-filter ≤ 12px) is on small chips only — no full-viewport glass, no 50px blur over video.

**Gooey micro-motion.** Jakub Antalik `liquid-gooey@0.2.1` (https://gooey.jakubantalik.com/) is the premium press/settle language on CTA pills and thinking-orb hosts. Pin it in `package.json` **and** `package-lock.json`. SVG silhouette under crisp content. Not a second particle system. Not a full-screen goo. Not wait language (that is `thinking-orbs`). `GooeySurface` must not static-import the package: a missing or failed `liquid-gooey` load is a pass-through (solid CTA / orb host). The girl clip, constellation bed, and orbs still show. See `docs/design/GOOEY-MOTION.md`.

Act 1 (welcome) plays a full-viewport muted looping video behind the Métis mark (`object-cover`, `object-position: center`, z-0; UI z-10). Clip: CloudFront `hf_20260429_115139_0fc6bd3d` (April 29). Not the March 19 hillside-vortex. Not the July 14 clip. Not the April 11 clip. No CSS `filter` on the `<video>`. A purple Mantu tint sits on the video. A very slight loop-safe Ken Burns (`transform: scale` only) may run on the video. **Métis** (mark + wordmark) lands and **stays**. The wordmark is static. **No scramble.** Tagline: **Your second brain in the corner.** The Tony Walteur byline uses liquid glass (capped blur, inset highlight, gradient-border). Primary Next is a solid high-contrast `onboard-cta` pill — always visible, never hover-only, never glass. Steal the glass technique for chips, not Bloom copy. If the video fails or motion is reduced, the purple wash stays (drop the video). **Leave Act 1: crossfade the hero video out** (opacity only, ~640ms) into the purple constellation-grid bed. Do not hard-cut. After the fade, unmount the clip. After Next, the bed is a 2D canvas spring-mass constellation grid (Mantu purple `#7F00DA` / `#9A2BF0` / `#C084FC` on `#05010a`). Not three.js starfield. Not torus. Not cyan. FORCE dark. Silent bed: no "Constellation" title, no hex readouts, no mix-blend-difference, no product crosshair. One 2D context for the rest of the tour.

Primary CTAs (Next / Continue / Get started / Set me up) are **large** hit targets (min 52×220), high contrast, bottom-safe, and **always visible** at full opacity. They must not hitch. Hero primary is **Next**. That click starts the six-act tour (problem scene). Ready says Get started.

Act 2 recap copy (Overview / Topics / Q&A) sits as text over the purple constellation grid. Scripted meeting / transcript / copilot / Intelligence, fake data only. Not an mp4. Not coding terminals. Not Vibe Island strings. Each `DEMO_STAGE` is one beat: the current clip **plays by itself**. **No auto-advance**. Next changes beats; on the last beat (recap) Next leaves Act 2 the same as Set me up. No 1100ms timer that jumps stages. The 2D grid stays mounted on this act. One canvas context. No three.js.

**Demo clock.** Do not `setState` every rAF. Drive the synthetic cursor with a ref + DOM `transform`. Commit React state at beat boundaries, or at most ~10 Hz for transcript text. Prefetch Answer / Copilot (Markdown + shiki) during Act 1 so the first Next does not compile on the click.

The Goldberg Aria starts **the same moment** as the portal-open SFX: `bed.start()` / `audio.play()` is the **first** media call in that mount effect, with **no await** before it. Electron usually allows autoplay; if `play()` is rejected, retry on the next user gesture without changing the intended start. **Do not** wait for Next to start the bed. **Next** still `play()`s the hero video **first** in that click (user gesture), not on mount, then seek 0. Do not `play()` after seek, after `setState`, or after the click stack returns. Do not auto-skip beats. `prefers-reduced-motion` may drop the video; it must not hide the mute control and must not mute the piano. Construct the Audio once in `useEffect`, not during render. `autoplay` is false until `start()`. `start()` no-ops after `stop()`. When onboarding finishes (before `onDone`, and again if `onDone` throws), unmounts, or the window/app/renderer dies, `haltOnboardingAudio` / `stop()` ends the bed and leftover portal AudioContexts close. Pause-only is not enough. No Skip path as the only teardown.

Welcome byline: `Tony Walteur` is a real link to his LinkedIn (`https://www.linkedin.com/in/tonywalteur/`). It opens in the system browser. Do not make the whole stage a link.

Onboarding music: a bundled, hardware-decoded `<audio>` of J.S. Bach, Goldberg Variations BWV 988, Aria, performed by Kimiko Ishizaka (Open Goldberg Variations, 2012). Composition is public domain. Recording is CC0 1.0. No Web Audio choir pad, no `synthesizeOnboardingPad` on the production path, no synthesis on the click. File ≤ 4MB (ogg/m4a). Loop quietly with cosine fades. Default gain is present but not a concert (`ONBOARDING_MUSIC_GAIN` 0.255, which is 0.3 × 0.85). Portal / bar-land one-shots sit about +20% so the piano is quieter and the ticks are more present. The Aria starts with the portal-open SFX on mount (`bed.start()` / `audio.play()` first, no await). Mute control stays: mute zeros the bed and the portal SFX. Reduced-motion does **not** auto-mute. OS mute still applies (system output). LICENSE note: performer, piece, CC0, source URL. Never auto-send.

Wait language is Jakub Antalik's `thinking-orbs` (caption, then the sphere). Not lucide `Loader2`, not a CSS spinner. Nine kinds: thinking, working, listening, writing, searching, connecting, loading-model, loading, planning. See `docs/design/THINKING-ORB.md`. Do not restyle the constellation-grid bed to add a demo title.

User-facing onboarding copy never uses an em dash (U+2014). Use a comma, period, colon, or parentheses.

**Act 4 light.** Personalize gets a local lighter veil behind the content (soft white/lavender). The bright mass sits at the **top** of the stage (heading), not the floor. Veil core is `rgba(255, 255, 255, 0.48)` at `50% 12%`. Top-edge wash is `rgba(255, 255, 255, 0.36)` at `50% 0%`. Do not bleach the exclusive purple stage or the floor. Headings and body stay high contrast. The "Last one" eyebrow is readable, not an ink-3 whisper. Mode tiles are quiet readable glass, not near-invisible `bg-white/[0.03]`. Cards and copy are not restyled for brightness.

**Act 4 required pick.** "How should Métis show up?" is a required choice. Do not pre-select General (or any mode). Punchy helper under the heading, no em dash: **Pick one. Continue waits until you do.** Continue stays gated until a mode is selected (and the tell-the-room checkbox is still required). If the user already picked a mode earlier in the tour (demo chips), that pick counts. The selected card must be obvious at a glance: stronger Mantu purple border and glow, `is-selected`, a soft opacity pulse on the rim (not a harsh flash), and `GooeySurface` `variant="select"` so the choose morph uses liquid-gooey. Unselected cards stay quieter (weaker border, lower opacity). Overlay chrome untouched.

**Tell the room.** After the Act 4 mode cards, before Continue, on the personalize scene: the **primary window**. Wider (~520–560), brighter glass (background white ~0.22, backdrop-filter ≤ 12px), generous padding. Title, spoken quote, why-line, and an ~18px checkbox must be readable at a glance. Mode picks recede. Not a seventh act, not a red legal banner, not a TOS, not a GDPR logo. The required `recordingConsent` checkbox (CMO-QA #1) still gates Continue. Quiet echo on Act 6 Ready (keep the Listen line; add the sample quote under it). Do not add a second checkbox. There is no Skip card. Pin this copy:

- Title: Tell the room
- Lead: Métis captures the meeting so you can keep quality high and actually get things done. People on the call deserve to hear that first.
- Sample quote: I'm using Métis to capture this for notes, follow-ups, and quality.
- Why: Saying it out loud is how we stay transparent and aligned with GDPR.
- Checkbox: I'll tell everyone on the call before I record.

The required `recordingConsent` checkbox still gates Ready Get started. Do not add a second checkbox. There is no Skip card.

Act 3 shows on-device model **download/install progress** (weights already fetch via `ensureLocalModel` on app open). Never copy "not installed" as a dead state. If RAM-gated, say so honestly.

## Summaries

Each built-in mode (`BUILTIN_MODE_LABELS`: general, meeting, sales, interview, recruiting, negotiation, presentation, support, cold-call) has its **own** recap section layout via `recapPromptFor` / `MODE_RECAP_LAYOUTS`. Not one generic skeleton plus a footnote. Sales focuses on next steps and what a seller must know. Recruiting is an interview sheet. Meeting is decisions and owners. Ship layouts for all nine.

## Copy

Métis voice. Do not clone Vibe Island strings.
