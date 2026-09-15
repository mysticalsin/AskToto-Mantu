# FITO-185-Z — show Act1 shell immediately (≤300ms from process start)

**Branch:** `release/1.9.1`  
**Ticket:** FITO-185-Z  
**Date:** 2026-09-15 (America/Toronto)

## Root cause (Ultron reject of 83902a4 / FITO-185-Y)

185-Y hid exclusive until Act1 paint (`show: !onboardingLive` + poll for poster/`act1-first-paint`).
Prove reported `WINDOW_AT=5.015s` from process start — Tony experiences that as forever Loading.
Stamp bar gate is **Act1 visible ≤300ms from PROCESS START**, not from first show.

## Fix

1. Exclusive ctor `show: true` + ctor-time `showForExclusiveOnboarding(win)`.
2. Reassert on `ready-to-show` / `dom-ready` / `did-finish-load` — never gate on `img.complete`.
3. `act1-boot.js` marks `act1-first-paint` immediately (shell chrome already in HTML).
4. Hero mp4 still deferred 480ms (185-Y); UI never waits on video.

## Constraint

No Latest. No merge. Leave final QA open for Tony.


## Landed tip
`d2aa49a6a3b95d109674da84f526f8842672fe21` (`d2aa49a`) on `origin/release/1.9.1`.

## Mac prove (2026-09-15 ~5:47pm ET)
QA: `/Users/tony/Applications/Metis-d2aa49a-qa.app` left open.
Best WINDOW_AT from process start: **0.744s** (83902a4 was 5.015s).
Shots Act1 not black: `proof/instant-d2aa49a-t{0p0,0p3,0p5,1p0}.png`.
See `/Users/tony/agent-tools/metis-191/proof/fito-185-z-landed.md`.
