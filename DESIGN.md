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

The stage is a **Mantu purple** brand wash (`#3A0B6B` / `#7F00DA` / `#9A2BF0`), animated, exclusive, rich — never a solid black void and never amber. CSS-only motion (existing constraint). `prefers-reduced-motion` stays purple (static wash) but still.

Act 1 (welcome) plays a full-viewport muted looping video behind the Métis mark (`object-cover`, z-0; UI z-10). A purple Mantu tint sits on the video. Not a Bloom or Axon landing page. If the video fails or motion is reduced, the purple wash stays. Get Started, Skip, and the Tony Walteur byline use liquid glass (backdrop blur, inset highlight, gradient-border). Steal the technique, not Bloom copy.

Primary CTAs (Get Started / Continue / Next) are **large** hit targets (min 52×220), high contrast, bottom-safe, and visible.

Act 2 is a scripted **Métis** demo on the real product: meeting / transcript / copilot / Intelligence, fake data only. Not an mp4. Not coding terminals. Not Vibe Island strings. The recap uses the **chosen** built-in role's summary layout. Each `DEMO_STAGE` is one video: the current clip **plays by itself** (elapsedMs, synthetic cursor, chips, recap). **No auto-advance** to the next video. Next is the only way to change clips; it resets the rAF clock to 0 in the same click so the next clip plays immediately (it does not sit frozen at the previous hold). No 1100ms timer that jumps stages. Continue leaves the whole demo act.

Get Started and every Next / Continue that shows a video call `video.play()` **as the first media call in that click** (browser autoplay policy). Do not `play()` after seek, after `setState`, or after the click stack returns. Then restart the current clip from 0 so it actually starts. If the Act 1 atmosphere video stays mounted across acts, it keeps looping; if a new video mounts, `play()` it from the same click. Do not auto-skip beats. `prefers-reduced-motion` may drop the video and pad motion; it must not hide the mute control.

Welcome byline: `Tony Walteur` is a real link to his LinkedIn (`https://www.linkedin.com/in/tonywalteur/`). It opens in the system browser. Do not make the whole stage a link.

Onboarding music: a quiet original Web Audio choir / high-strings bed from Act 1 (A3 and above, slow attack, stacked fifths and octaves, odd-harmonic color, ~22s loop, gentle delay). No files, no fetch, no copyrighted recording, no quoted melody. Mute control on the stage. Honor OS mute (system output). `prefers-reduced-motion` lowers volume. Starts on welcome or Get Started, never before the window exists. Never auto-send.

Act 3 shows on-device model **download/install progress** (weights already fetch via `ensureLocalModel` on app open). Never copy "not installed" as a dead state. If RAM-gated, say so honestly.

## Summaries

Each built-in mode (`BUILTIN_MODE_LABELS`: general, meeting, sales, interview, recruiting, negotiation, presentation, support, cold-call) has its **own** recap section layout via `recapPromptFor` / `MODE_RECAP_LAYOUTS`. Not one generic skeleton plus a footnote. Sales focuses on next steps and what a seller must know. Recruiting is an interview sheet. Meeting is decisions and owners. Ship layouts for all nine.

## Copy

Métis voice. Do not clone Vibe Island strings.
