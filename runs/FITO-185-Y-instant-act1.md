# FITO-185-Y — instant Act1 first paint (never black)

**Branch:** `release/1.9.1`  
**Ticket:** FITO-185-Y  
**Date:** 2026-09-15 (America/Toronto)

## Root cause

`createWindow` used `show: true` plus an immediate `showForExclusiveOnboarding(win)` **before** `loadURL`. The first on-screen frame was the opaque BrowserWindow hold `#05010A` (reads as solid black).

Proven on `Metis-622258e-qa.app`:

| Mark | What Tony saw |
|------|----------------|
| t≈0.5s | Window 1800×1169, solid black (`proof/instant-tight-t0p5.png`) |
| t≈1.0s | Act1 (lady+planet + Métis + Next) |
| audit | `app.started` → `renderer.ready` ~273ms; `renderer.ready` → `app.act1.dom` ~1964ms |

React already fail-opened Act1 (`isOnboardingBoot`, `?exclusiveOnboarding=1`) and the end state was healthy (`videoReadyState=4`, Next present). The failure was **first paint**, not forever Loading.

Contributing stalls:

1. `#boot-bed-img` used `decoding="async"` and no CSS `background-image`, so the bed stayed `#05010A` until the JPEG decoded.
2. Hero mp4 is 8.9MB unpacked; mounting `<video preload="auto">` on first React paint contended with poster/UI.
3. `html, body { background: transparent }` means anything shown before the poster is the native hold color.

## Fix

1. Exclusive ctor is `show: !onboardingLive` — hidden until Act1 chrome is painted.
2. No ctor-time exclusive `show()`. Reveal via 16ms poll for `act1-first-paint` / poster+wordmark+Next, plus `ready-to-show` / `did-finish-load` polls, plus the existing 2s hard reveal.
3. `index.html` no-JS shell: preload + CSS background + `decoding="sync"` poster, static **Métis** wordmark + **Next**. `act1-boot.js` marks first paint and queues Next (React consumes `act1-boot-next`).
4. Hero `<video>` deferred 480ms. UI never waits on video decode.

## Tests

```
npx vitest run \
  src/main/island/first-paint-exclusive.contract.test.ts \
  src/renderer/src/lib/onboarding-boot.test.ts \
  src/renderer/src/lib/onboarding-hero-video.test.ts \
  src/main/no-show-steals-focus.contract.test.ts
```

PASS (50). Broader related suite: 198 passed.

## Constraint

No Latest. No merge. Off Aria. Leave Tony's running Metis until the new QA is swapped in.
