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

Primary CTAs (Get Started / Continue / Next) are **large** hit targets (min 52×220), high contrast, bottom-safe, and visible.

Act 2 is a scripted **Métis** demo on the real product: meeting / transcript / copilot / Intelligence, fake data only. Not an mp4. Not coding terminals. Not Vibe Island strings. The recap uses the **chosen** built-in role's summary layout. Each `DEMO_STAGE` is one video: the current clip **plays by itself** (elapsedMs, synthetic cursor, chips, recap). **No auto-advance** to the next video. Next is the only way to change clips; it resets the clock so the next clip plays from its start. No 1100ms timer that jumps stages. Continue leaves the whole demo act.

Welcome byline: `Tony Walteur` is a real link to his LinkedIn (`https://www.linkedin.com/in/tonywalteur/`). It opens in the system browser. Do not make the whole stage a link.

Onboarding music: a quiet original Web Audio bed (no copyrighted recording) from Act 1. Loops softly. Mute control on the stage. Honor OS mute (system output). `prefers-reduced-motion` lowers volume. Starts on welcome or Get Started, never before the window exists. Never auto-send.

Act 3 shows on-device model **download/install progress** (weights already fetch via `ensureLocalModel` on app open). Never copy "not installed" as a dead state. If RAM-gated, say so honestly.

## Summaries

Each built-in mode (`BUILTIN_MODE_LABELS`: general, meeting, sales, interview, recruiting, negotiation, presentation, support, cold-call) has its **own** recap section layout via `recapPromptFor` / `MODE_RECAP_LAYOUTS`. Not one generic skeleton plus a footnote. Sales focuses on next steps and what a seller must know. Recruiting is an interview sheet. Meeting is decisions and owners. Ship layouts for all nine.

## Copy

Métis voice. Do not clone Vibe Island strings.
