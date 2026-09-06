# Ultron Mac show — R01–R03

**Gate tonight:** local Quality on this tip + this show. Do not wait on GitHub Actions.
**Target:** ~11:30pm ET on Totos-Mac (America/Toronto). If the show slips toward 12:15am ET, say so before 11:30.
**Draft only.** READY TO MERGE no. No merge. No Latest.
**This agent does not pack.** Live `/Applications/Metis.app` 1.8.3 does not contain this branch. A later pack is required before the show can PASS on the installed app. Do not publish Latest.

## Local proof (run on Totos-Mac, this tip)

```bash
git rev-parse --short HEAD
npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json
npx vitest run \
  src/shared/overlay-chrome.test.ts \
  src/shared/settings-bounds.test.ts \
  src/main/settings-surface.contract.test.ts \
  src/main/island/mac-hide-island.proof.test.ts \
  src/main/island/hover-hit-band.test.ts \
  src/main/island/geometry.test.ts
npm test
```

Pass means: typecheck clean, those six files green, `npm test` green. That is the R01–R03 local gate. GH CI is not the gate.

## Show (only after a later pack of this tip)

Display: built-in Retina, notch. `workArea.y` ≈ 39. Start from Overlay chrome **Hide**.

### R01 — Overlay law

1. Hide idle: park is 8×2 at `bounds.y` (0), not 8×44 at Y=39.
2. Hover the camera / Dynamic Island square only. Left menu-bar items miss. Teams mute at Y≈40 misses.
3. Island peek is 132×15 at the same Y. No second circle. No minimize control.
4. Bar is the only chrome that may minimize to a circle.

**FAIL if** an 880×133 leftover sits at Y=39 (`isFatHoverTrigger`).

### R02 — Settings never crushed

Hard repro on 1.8.3: Cmd+, or Bar Settings while Hide/Island left `x=460 y=39 width=880 height=325`.

On this tip the same path must open **880×560** at `islandSafeTop` (~39), background `#120022`. Tray, dock, hotkey, and IPC all use `applySettingsSurface`.

**FAIL if** height is 325, 8, or 15. **FAIL if** the panel is a leftover bar sliver.

### Settings from M (Tony live 2026-09-05)

1. Overlay chrome **Hide**. Click the menu-bar **M** (tray logo) or Cmd+,.
2. Window is **880×560** at `islandSafeTop` (~39). Background `#120022`. No white or `#000` flash. No spring / scale glitch.
3. Scroll every Settings tab, including the last one, to the last row. The bottom of the last card is reachable. `main.cl-content` is `flex-1 min-h-0 overflow-y-auto` (no `max-h-[480px]` clip).
4. Bounds stay at least 880×560. No crush to 325.

**FAIL if** the surface glitches on open, or the last Settings row is clipped and cannot be scrolled into view.

Close Settings. Hide/Island must park again at `bounds.y`.

### R03 — No flash

Open and close Settings from Hide. Launch from dock after onboarding.

**FAIL if** the window paints `#fff`, `#ffffff`, `#000`, or `#000000`. Settings glass is `#120022`. Rest is `#00000000`.

## Honest 1.8.3

If Ultron is still on `/Applications/Metis.app` 1.8.3, R02 will FAIL the crush. Record that as "live build, not this tip." Do not stamp Latest. Do not pack from this runbook.
