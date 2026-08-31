# Overlay contract

This file is the gate. Do not add or restyle overlay / onboarding UI unless it matches this document.

## Chrome

Three modes in Settings (persist, no reinstall). Default on a fresh install is **hide**.

1. **hide** (default). Fully hidden until the pointer is on the hardware camera / Dynamic Island square (top-center, on top of the camera housing), then reveal down. Leave that island hides. Windows: top-center of the display, **no fake notch**.
2. **island**. The always-visible peek capsule (may sit in the island / notch). Hover the same camera square expands down. Leave that island returns to the peek. Island must never minimize to a second disk.
3. **bar**. Classic bar. Always visible. Idle rest is the **full bar plus the thinking-orb circle** (fixed 64×64, never a lozenge / pill / flattened disc). The only layout that can collapse to that same circle. Hide and Island must never grow a minimize-to-circle control, and any minimize call while those layouts are active is a no-op (do not jump Hide → Bar). The circle is invisible whenever the bar is invisible. Contract: `docs/design/BAR-PILL.md`.

### Bar sphere (64 thinking-orb, Bar only)

The Bar control is Jakub Antalik's thinking-orb on Métis dark glass, not a WebGL marble and not a status blob. Tony drags it while using apps.

- **Size.** `64×64` always (package avatar preset). Aspect 1. Same box on idle, listen, think, fact-check, connecting, hover, and minimize. Never a 44-tall pill. Never flatten. Do not invent a third size.
- **Idle.** `breathing` (calm ring, always-on). Theme `dark`: light dots on dark glass. Not Fit Studio magenta. Not Jarvis `#4CA8E8`.
- **Materials.** Real `thinking-orbs` 2D canvas. Monochrome. No WebGL glitter. No Fit Studio glow core / bloom / specular kiss on this control. No invented particle constellation.
- **Moods.** Idle `breathing`. Listen `listening` (waveform; no second red disc on this circle). Think `working`. Fact-check `searching`. Connecting `connecting`. Priority: connecting > listening > fact-check > think > idle.
- **Same circle.** Minimize (Bar only) is this circle, not a second disc. Windows: same circle, top-center, no Mac-only look.
- **Out of scope.** Island/Hide hit geometry (`src/main/island/geometry.ts`) is frozen. Hide stays 8×2. Island wakes only on the camera square.

Do/don'ts and tests: `docs/design/BAR-PILL.md`. Quality hats: `docs/design/QUALITY.md`.

Settings shows these as **cards with a tiny desktop diagram**, not three text radios. Hide: empty top-middle, faint hover hint, caption "Hidden until you move to the top." Island: small capsule at the top-middle, caption "A small island stays visible. Hover opens it." Bar: full bar at the top **plus a circle**, caption "The bar stays on screen." Selected card is obvious. Changes apply immediately. Closing Settings after picking Island or Hide must park the live overlay (`shouldForceParkOnBecameIdle` + `collapse-now` + `parkAfterHide`) so the user sees the notch rest, not a leftover full bar. No reinstall. Original Métis copy. No em dash. No Vibe Island trademark strings.

## Island Y

Hide and island **rest at** `display.bounds.y` so the hardware camera island can hit the watch rect. The watch rect is the camera square, not the menu bar.

- **Hide/island watch rect.** `y = display.bounds.y` (0 on the built-in Retina). Width is the real `notchWidth` (typically ~180–250, **not** 560). Height is the notch / camera housing only (`HOVER_ISLAND_HEIGHT_MAX_PX`, typically ≤32) — not a 44px full-width menu bar, not `HOVER_HIT_BAND_MAX_PX` 44, not an 80–120px pad. Left and right menu-bar items miss. Teams mute / camera / share sit **under** the island (Y≈40 and `TEAMS_MEETING_CHROME_Y` 48) and must not hit. Cursor watch (`hoverWatchRestRect`) hit-tests this camera square. The parked **hide window** is not this square. The idle Island peek stays the small top-center rest (`OVERLAY_ISLAND_PEEK` 132×15). Hide rest paint stays 8×2.
- **Hide park (invisible).** 1–8px fully transparent hairline (or click-through). Not a 44px tint, not a 103px stub, not a 560-wide glass chip. Apple Hide is gone until the pointer enters the island. `clampHeight` / `BAR_MIN_HEIGHT` 44 must not grow this rest after a display move — stay 8×2 on every display.
- **Display move (required).** `registerScreenListeners` must re-park hide/island with `parkOverlayAfterHideSpring` / `parkedHoverReanchor`. Do not treat a hide rest at `bounds.y` as off-screen against `workArea.y` (~39) and slide it. Do not `clampHeight` a parked hide. Window `minWidth`/`minHeight` is 1 so darwin does not report 8×44.
- **Path A.** Electron `display.workArea.y` is the first unobstructed row under the notch / menu bar — used by **bar** chrome (`workArea.y + margin`) and as `islandSafeTop` for revealed hide/island chrome. It is **not** the hover hit height (that was the 37–44 slab). Do not park hide/island *below* the island at `workArea.y` (Tony live: Y=39 pad never intersects the island).
- **Path C.** When `workArea.y` is 0 on a notched display, hide/island still rest at `bounds.y`. Revealed chrome uses a strut (`menuBarHeight`, or 37px) so content clears the notch. The hover hit stays the camera square, not a strut-tall strip. Bar still floats; never a fake notch on Windows.

Hide/island **rest** stays at `bounds.y` (the camera island). Revealed chrome sits at `islandSafeTop` / `workArea.y` (~39) so content is fully below the notch — macOS clamps there anyway. Cursor watch **stays** open if the pointer is in the camera island **or** the already-revealed Métis bar. Do not fight the OS with `setBounds(y=0)` on the full bar (that hide/reveal loop is the live stutter). Windows: top-center of the display, **no fake notch**.

## Hover / leave

Hide and island: hover or click expands **down** from the camera island to the full bar at `islandSafeTop` (below the notch). Reveal only when the cursor is on that hardware square (notch center, Y≈8–12). Same Y over the left or right menu bar misses. Center X at Y=40 (under the island, typical Teams) misses. Center X at `TEAMS_MEETING_CHROME_Y` 48 misses. Leaving the island hides again. No sticky reveal from a mid-window hover — a leftover Settings-tall, 560-wide, or 44-tall window must not keep or trigger Métis. Teams meeting chrome must never reveal Métis. Leave collapses (`pointer-leave` → grace → hide or peek). Bar does not auto-collapse. Pushing the pointer **up** into the Dynamic Island must keep the bar open (smooth, no flicker).

**Hide (default).** Fully gone until the pointer enters the island. The parked window is a **1–8px fully transparent** rest (`ignoreMouseEvents` click-through). `.overlay-hide-target` must not paint a visible rectangle (`background: transparent`). Cursor watch (`getCursorScreenPoint` vs `hoverWatchRestRect`) is the sensor — the window is not a 560×44 hittable slab. Do not park a 44px/103px card. Do not hug hide to 120px.

**Cursor watch (required).** macOS menu bar / Dynamic Island often does **not** deliver `mouseenter` to an Electron window, even at Y=0. Renderer `onMouseEnter` is not enough. Main polls `screen.getCursorScreenPoint()` every ~16-32ms on darwin and Windows top-edge while hide/island is resting and `onboardingDone`: cursor inside the hide/island rest rect (the camera island square, never a 560×44 slab or 80–120 hit pad) → reveal; cursor in that island **or** the already-revealed Métis bar (+ small grace) → stay (never `setBounds` on a stay tick); cursor in neither → hide. A mid-window hover is not a stay. No Accessibility / CGEvent tap required. Do not animate window y every frame.

**Motion (Apple-grade).** Live Dynamic Island feel. Transform and opacity only. `--ease-spring: cubic-bezier(0.22, 1, 0.36, 1)`. The bar is **one surface** (no peek/bar React unmount pop).
- **Reveal:** 320–380ms, `transform-origin: top center`, from `scale(0.92) translateY(-8px)` opacity 0.85 → full. One `setBounds` to the below-notch full bar (`islandSafeTop`) **before** the spring plays.
- **Hide:** 280–340ms reverse spring, **then** park the rest rect. `overlayParkAfterHide` from the renderer on `transitionend` / `animationend`, with a **400ms** timeout fallback so a missed event cannot leave a stuck full bar. Do not `setBounds(park)` on the same tick as hide.
- **Blur:** `backdrop-filter` only when the bar is **settled**, not during the spring.
- **Reduced-motion:** skip the spring, instant size change, still no 24ms fight.
- Leave grace stays ~500ms (`AUTO_HIDE_GRACE_MS`). Island hover may skip dwell (`pointer-enter` + `dwell-elapsed`).

**Leave pill / Settings → Hide or Island.** Pill mode may stay on screen. Putting chrome back on Hide must **disappear** (park the invisible 1–8px rest). Putting chrome on Island must park the 132×15 peek, not leave the full bar. Do not `restoreBarWidth` / `setMinimizedWidth(false)` into a ~100px stub or a 560×44 slab at `islandSafeTop`. Closing Settings after picking Hide or Island, or closing Settings back to the idle overlay, **always** parks (`shouldForceParkOnBecameIdle`) even if the pointer is still over where the tall Settings window was — that mid-window hover must not stick. OverlayIdle + Hide + pointer not in the top band is nothing visible. Island may keep the visible 132×15 peek. Bar keeps the full bar plus the circle.

**Island.** Always-visible peek capsule. May sit in the island / notch (same Y). Hover expands down. Leave returns to the peek. Hug-width is OK on the visible capsule only.

**Bar.** Always the bar. No hide.

`createWindow` when `onboardingDone` + hide/island parks this rest rect immediately (same as exclusive exit). Never boot at 880×84 and hope hug wins. Never rest as 880×816. Never hug hide down to 120px.

## After exclusive exit

When `onboardingDone` flips true, `exitExclusiveOnboardingStage` leaves exclusive fullscreen and parks the default **hide** rest (or island / bar if Settings already chose one). Never an **880×816** mid-flow card. Never a 120×50 pill for hide. Re-apply `setAlwaysOnTop(true, 'screen-saver')` (the level exclusive used). Hide parks a 1–8px transparent rest; `hoverWatchRestRect` still covers the camera island (`y = display.bounds.y`, width = `notchWidth` ~180–250, height = camera housing only). Island is the peek capsule at the same Y. Bar keeps `workArea.y + margin`. Auto-resize must not grow hide into a 44px/103px slab or 880×816. Then destroy the exclusive stage. Do not leave layer 0. Start the cursor watch when layout is hide/island.

## Onboarding

Every act stays on one **exclusive fullscreen** until `onboardingDone`. Then destroy that stage and leave the small island. Do not shrink to a mid-flow card.
Stage API: `exclusiveOnboardingBounds(display.bounds, display.workArea)`; exit only on `onboardingDone`.

**Portal.** First paint of the exclusive stage is a **pill** at the notch / top-center (island-shaped, about 120×36) that expands into the full stage. Slow: 1.1–1.4s each way, not a 620ms pop. Soft edge via `mask-image` / a radial veil. Never a razor `clip-path: circle(...)` on `.onboard-stage`. Open easing `cubic-bezier(0.22, 1, 0.36, 1)`. Close easing `cubic-bezier(0.4, 0, 0.2, 1)`. Stage content (stripes, hero) is already composited behind the mask and fades + translates 8px (`opacity` + `transform` only) with the portal. Compositor-only. No `filter: blur`. No layout animation. Reduced-motion: no portal (instant stage); do not mute sound unless the OS or the onboarding mute chip is muted.

**Portal sound.** Original, copyright-free, precomputed at module load. Never synthesize on the click. OPEN and CLOSE are different sounds (not one whoosh played twice, not a 160ms noise burst). OPEN: slow rising sci-fi entry (clean shimmer / rising air-tone), ~1.1–1.4s, quiet. CLOSE: different falling sci-fi close (darker, descending), ~1.1–1.4s. OS mute and the onboarding mute chip zero both. This is not the Goldberg Aria gain.

**Portal close.** When `onboardingDone` is about to flip (Ready or Skip Get started): reverse the same soft pill into the top-center island (1.1–1.4s), play the CLOSE tone with the collapse, then exit exclusive fullscreen and park path A (`Y >= 25`). Do not snap to a 120×50 hole while the stage is still full-bleed. Do not call `setSimpleFullScreen(false)` before the close has been seen (or reduced-motion skip). Renderer plays close, then persists `onboardingDone` so main can `exitExclusiveOnboardingStage`. Do not leave a 1800×1169 hole or a `y=0` peek.

**Skip the tour.** Skip leaves the six-act narrative but stays on the exclusive Métis stage. It is one screen: the Tell the room glass card (same copy, required checkbox) plus Get started. Same portal close. `recordingConsent` still required (CMO-QA #1). Do not mount the legacy `Onboarding.tsx` slides for Skip. Hero Skip is a quiet secondary glass chip, never louder than **Next**.

The stage is a **Mantu purple** brand wash (`#3A0B6B` / `#7F00DA` / `#9A2BF0`), exclusive, rich — never a solid black void and never amber. Depth is the purple radial wash plus two oversized GPU stripe layers (repeating linear-gradient bands in that palette, plus a thin light sheen). The layers rotate opposite directions with `transform: rotate` only (~40s and ~70s linear infinite), `mix-blend-mode` screen/overlay, opacity ~0.28–0.4, `will-change: transform`, `pointer-events: none`. They cover the full stage after Act 1 unmounts the hero video. No `filter: blur` drifting orbs. `prefers-reduced-motion` freezes rotation at 0deg and **keeps the stripe pattern** (still not a flat fill).

**Motion budget (60fps-class).** Compositor-only: `transform` and `opacity`. Never animate `filter`, `backdrop-filter`, blur, box-shadow, or layout. Scene enter is opacity + translate only, ~300ms ease-out — no scale-down, no `develop-in` filter blur on onboarding. Hover on large surfaces does not scale; CTA hover is brightness or `scale(1.02)` max. Liquid glass (backdrop-filter ≤ 12px) is on small CTAs / chips only — no full-viewport glass, no 50px blur over video.

Act 1 (welcome) plays a full-viewport muted looping video behind the Métis mark (`object-cover`, `object-position: center`, z-0; UI z-10). Clip: CloudFront `hf_20260319_055001_8e16d972` (March 19). Not the July 14 clip. Not the April 11 clip. No CSS `filter` on the `<video>`. A purple Mantu tint sits on the video. A very slight loop-safe Ken Burns (`transform: scale` only) may run on the video. Wordmark, Next, and the Tony Walteur chip ease in (`opacity` / `transform`) and sit on the **darker sky**, not on the bright vortex. Not a Bloom or Axon landing page. If the video fails or motion is reduced, the purple wash stays (drop the video). **Leave Act 1: pause and unmount/hide the hero video** so it is not compositing after welcome. **Métis** (mark + wordmark) lands and **stays**. The wordmark is static. **No scramble.** The tagline may fade in once. **Next**, Skip, and the Tony Walteur byline use liquid glass (capped blur, inset highlight, gradient-border). Steal the technique, not Bloom copy.

Primary CTAs (Next / Continue / Get started) are **large** hit targets (min 52×220), high contrast, bottom-safe, and visible. They must not hitch. Hero primary is **Next**. That click starts the six-act tour (problem scene). Skip finish and Ready still say Get started.

Act 2 is a scripted **Métis** demo on the real product: meeting / transcript / copilot / Intelligence, fake data only. Not an mp4. Not coding terminals. Not Vibe Island strings. The recap uses the **chosen** built-in role's summary layout. Each `DEMO_STAGE` is one video: the current clip **plays by itself**. **No auto-advance** to the next video. Next is the only way to change clips; it resets the rAF clock to 0 in the same click so the next clip plays immediately (it does not sit frozen at the previous hold). No 1100ms timer that jumps stages. Continue leaves the whole demo act.

**Demo clock.** Do not `setState` every rAF. Drive the synthetic cursor with a ref + DOM `transform`. Commit React state at beat boundaries, or at most ~10 Hz for transcript text. Prefetch Answer / Copilot (Markdown + shiki) during Act 1 so the first Next does not compile on the click.

The Goldberg Aria starts **the same moment** as the portal-open SFX: `bed.start()` / `audio.play()` is the **first** media call in that mount effect, with **no await** before it. Electron usually allows autoplay; if `play()` is rejected, retry on the next user gesture without changing the intended start. **Do not** wait for Next to start the bed. **Next** still `play()`s the hero video **first** in that click (user gesture), not on mount, then seek 0. Do not `play()` after seek, after `setState`, or after the click stack returns. Do not auto-skip beats. `prefers-reduced-motion` may drop the video; it must not hide the mute control and must not mute the piano.

Welcome byline: `Tony Walteur` is a real link to his LinkedIn (`https://www.linkedin.com/in/tonywalteur/`). It opens in the system browser. Do not make the whole stage a link.

Onboarding music: a bundled, hardware-decoded `<audio>` of J.S. Bach, Goldberg Variations BWV 988, Aria, performed by Kimiko Ishizaka (Open Goldberg Variations, 2012). Composition is public domain. Recording is CC0 1.0. No Web Audio choir pad, no `synthesizeOnboardingPad` on the production path, no synthesis on the click. File ≤ 4MB (ogg/m4a). Loop quietly with cosine fades. Default gain is present but not a concert (`ONBOARDING_MUSIC_GAIN` ~0.30). The Aria starts with the portal-open SFX on mount (`bed.start()` / `audio.play()` first, no await). Mute control stays: mute zeros the bed and the portal SFX. Reduced-motion does **not** auto-mute. OS mute still applies (system output). LICENSE note: performer, piece, CC0, source URL. Never auto-send.

User-facing onboarding copy never uses an em dash (U+2014). Use a comma, period, colon, or parentheses.

**Act 4 light.** Personalize (and Skip, which reuses the consent card) gets a local lighter veil behind the content (soft white/lavender). The bright mass sits at the **top** of the stage (heading), not the floor. Veil core is `rgba(255, 255, 255, 0.48)` at `50% 12%`. Top-edge wash is `rgba(255, 255, 255, 0.36)` at `50% 0%`. Do not bleach the exclusive purple stage or the floor. Headings and body stay high contrast. The "Last one" eyebrow is readable, not an ink-3 whisper. Mode tiles are quiet readable glass, not near-invisible `bg-white/[0.03]`. Cards and copy are not restyled for brightness.

**Tell the room.** After the Act 4 mode cards, before Continue, on the personalize scene: the **primary window**. Wider (~520–560), brighter glass (background white ~0.22, backdrop-filter ≤ 12px), generous padding. Title, spoken quote, why-line, and an ~18px checkbox must be readable at a glance. Mode picks recede. Not a seventh act, not a red legal banner, not a TOS, not a GDPR logo. The required `recordingConsent` checkbox (CMO-QA #1) still gates Continue. Quiet echo on Act 6 Ready (keep the Listen line; add the sample quote under it). Skip uses this same brighter card plus Get started (not legacy slides). Do not add a second checkbox. Pin this copy:

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
