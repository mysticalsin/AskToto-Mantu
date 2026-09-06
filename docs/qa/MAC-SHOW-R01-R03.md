# Ultron Mac show — R01–R03

**Gate tonight:** local Quality on this tip + this show. Do not wait on GitHub Actions.
**Target:** ~11:30pm ET on Totos-Mac (America/Toronto). If the show slips toward 12:15am ET, say so before 11:30.
**Draft only.** READY TO MERGE no. No merge. No Latest.
**This agent does not pack.** Live `/Applications/Metis.app` 1.8.3 does not contain this branch. A later pack is required before the show can PASS on the installed app. Do not publish Latest.

## Show relaunch (Totos-Mac)

Do not relaunch `/Applications/Metis.app`. That binary is not this tip.

Show relaunch is **Electron from this tree** with an isolated `ASKTOTO_USERDATA`:

```bash
# Kill the previous Ultron / Electron pid by number. Do not pkill -f.
ASKTOTO_USERDATA="$HOME/Library/Application Support/Metis-show-tip" \
  npm run dev
```

`npm run dev` is `electron-vite dev` on this checkout. `src/main/index.ts` honors `ASKTOTO_USERDATA` before `app.ready`. A packed Latest or `/Applications/Metis.app` relaunch is the wrong tree.

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
  src/main/island/geometry.test.ts \
  scripts/ensure-intelligence-bundle.contract.test.ts
npm run build:intelligence
npm test
```

Pass means: typecheck clean, those seven files green, `npm run build:intelligence` writes `intelligence/dist/index.html`, `npm test` green. That is the R01–R03 local gate. GH CI is not the gate.

Do not relaunch the Mac show until this tip includes the Intelligence JSX fix (`ReactElement` + `tsconfig.app.json` types `react`). An older show tree failed `tsc -b` on Totos-Mac.

## Show (only after a later pack of this tip)

Display: built-in Retina, notch. `workArea.y` ≈ 39. Start from Overlay chrome **Hide**.

### R01 — Overlay law

1. Hide idle: park is 8×2 at `bounds.y` (0), not 8×44 at Y=39.
2. Hover / approach the **top edge** (left menu bar, camera, or right, including the first work-area row ≈39). Métis reveals. Do not hunt tray Show/Hide. Teams mute at Y≈40 still misses.
3. Island peek is 132×15 at the same Y. No second circle. No minimize control.
4. Bar is the only chrome that may minimize to a circle.

**FAIL if** an 880×133 leftover sits at Y=39 (`isFatHoverTrigger`).

### R02 — Settings never crushed

Hard repro on 1.8.3: Cmd+, or Bar Settings while Hide/Island left `x=460 y=39 width=880 height=325`.

On this tip the same path must open **880×800** at `islandSafeTop` (~39), background `#120022`. Tray, dock, hotkey, and IPC all use `applySettingsSurface`.

**FAIL if** height is 325, 8, or 15. **FAIL if** the panel is a leftover bar sliver.

### Settings from M (Tony live 2026-09-05)

1. Overlay chrome **Hide**. Click the menu-bar **M** (tray logo) or Cmd+,.
2. Window is **880×800** at `islandSafeTop` (~39). Background `#120022`. No white or `#000` flash. No spring / scale glitch.
3. Personalize: scroll to **Custom instructions**. The full textarea and the last row are reachable. `main.cl-content` is `flex-1 min-h-0 overflow-y-auto` (no `max-h-[480px]` clip).
4. Bounds stay at least 880×800. No crush to 325 or 560.

**FAIL if** the surface glitches on open, Custom instructions is clipped, or the last Settings row cannot be scrolled into view.

### Top-edge reveal (Tony live 2026-09-05)

1. Overlay chrome **Hide**. Do not use tray Show/Hide.
2. Move the mouse to the top of the display (left of the notch, the camera, or the right), including the menu-bar edge / first desktop row (`workArea.y` ≈ 39). Métis must reveal the **full Ask/Settings bar** (880, Ask field).
3. Teams mute at Y≈40 must not reveal.
4. Mid-session: Ask a question, move the mouse away (auto-hide, no Escape, park 8×2 within 1–2s), move back to the top. Same answer is still there. A new Ask replaces it.

**Relaunch (required).** Kill the previous Ultron pid. Start from Hide park **8×2**, no Settings window open. Do not start from a leftover 880×120 Ask bar.

**FAIL if** hover opens **120×44 Show Métis** or **880×44 buttons=[Show Métis] hasAsk=false** (Ultron `a40a22f`). PASS is 880×120+ with the Ask field. **FAIL if** after ~1–2s at ~(900, 600) the Ask bar is still 880×120 (Ultron `c74e389` AUTO-HIDE FAIL). **FAIL if** the overlay stays gone until the menu-bar Show Métis / Show/Hide click.

Close Settings. Hide/Island must park again at `bounds.y`.

### R03 — No flash

Open and close Settings from Hide. Launch from dock after onboarding.

**FAIL if** the window paints `#fff`, `#ffffff`, `#000`, or `#000000`. Settings glass is `#120022`. Rest is `#00000000`.

### Intelligence dashboard (Tony live + Totos-Mac show tree 2026-09-06)

Tony live `/Applications/Metis.app` 1.8.3: Settings / Intelligence shows the red banner `Intelligence dashboard bundle not found — run \`npm run build:intelligence\`, then restart.` That installed app does not contain this branch.

Totos-Mac show tree, exact fail:

```
npm run build:intelligence
src/components/IntelligenceUpdateButton.tsx(12,5): error TS2503: Cannot find namespace 'JSX'
```

Cause: the button returned `JSX.Element`. `intelligence/tsconfig.app.json` had `"types": ["vite/client"]` only, which hid `@types/react`. React 19 + TypeScript 6 has no global `JSX` namespace unless React types load. Failed `tsc -b` left no `intelligence/dist/index.html`, so the live banner stays.

This tip before relaunch:

1. `IntelligenceUpdateButton` returns `ReactElement`, never `JSX.Element` (MQA-290).
2. `tsconfig.app.json` types are `vite/client`, `react`, `react-dom`.
3. `intelligence/src/vite-env.d.ts` triple-slash loads those same React types.
4. `npm run build` / `npm run dev` run `scripts/ensure-intelligence-bundle.mjs` (plain Node, no TypeScript annotations).

**FAIL if** `npm run build:intelligence` still reports `TS2503`. **FAIL if** Settings / Intelligence still shows the red banner after this tip's `npm run build` (or `npm run dev`) and a restart of that tree.

## Honest 1.8.3

If Ultron is still on `/Applications/Metis.app` 1.8.3, R02 will FAIL the crush and Intelligence will still show the red bundle-not-found banner. Record that as "live build, not this tip." Do not stamp Latest. Do not pack from this runbook.
