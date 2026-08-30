# Overlay contract

This file is the gate. Do not add or restyle overlay / onboarding UI unless it matches this document.

## Island

The peek sits **fully below** the Mac hardware notch. It is not clipped.

- **Path A (chosen).** Electron `display.workArea.y` — first unobstructed row under the notch / menu bar. Never park at `display.bounds.y` (0). That is the hardware island and clips the capsule.
- **Path C.** Only when `workArea.y` is 0 (Electron reported no inset) on a notched display: apply a notch strut (`menuBarHeight`, or 37px). Do not push `y = 0` again.

Peek and revealed share that Y. Height changes; Y does not.

## Hover / leave

Hover or click expands **down** from the safe peek to the full bar (same top edge, taller height). Leave collapses to the peek (`pointer-leave` → grace → hide).

## Onboarding

Every act stays on one **exclusive fullscreen** until `onboardingDone`. Then destroy that stage and leave the small island. Do not shrink to a mid-flow card.
Stage API: `exclusiveOnboardingBounds(display.bounds, display.workArea)`; exit only on `onboardingDone`.

The stage is a **Mantu purple** brand wash (`#3A0B6B` / `#7F00DA` / `#9A2BF0`), animated, exclusive, rich — never a solid black void and never amber. CSS-only motion (existing constraint). `prefers-reduced-motion` stays purple (static wash) but still.

Primary CTAs (Get Started / Continue / Next) are **large** hit targets (min 52×220), high contrast, bottom-safe, and visible.

Act 2 is a scripted **Métis** demo on the real product: meeting / transcript / copilot / Intelligence, fake data only. Not coding terminals. Not Vibe Island strings. The recap uses the **chosen** built-in role's summary layout. **No auto-advance.** Each beat waits for a click (Next, or anywhere on the stage). Continue leaves the whole demo act.

Welcome byline: `Tony Walteur` is a real link to his LinkedIn (`https://www.linkedin.com/in/tonywalteur/`). It opens in the system browser. Do not make the whole stage a link.

Act 3 shows on-device model **download/install progress** (weights already fetch via `ensureLocalModel` on app open). Never copy "not installed" as a dead state. If RAM-gated, say so honestly.

## Summaries

Each built-in mode (`BUILTIN_MODE_LABELS`: general, meeting, sales, interview, recruiting, negotiation, presentation, support, cold-call) has its **own** recap section layout via `recapPromptFor` / `MODE_RECAP_LAYOUTS`. Not one generic skeleton plus a footnote. Sales focuses on next steps and what a seller must know. Recruiting is an interview sheet. Meeting is decisions and owners. Ship layouts for all nine.

## Copy

Métis voice. Do not clone Vibe Island strings.
