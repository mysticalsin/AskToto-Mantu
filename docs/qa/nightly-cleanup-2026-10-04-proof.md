# Nightly cleanup 2026-10-04 — proof

Off `main` at `d68d8e5fe2f9537b0453f415f510a3b71c972b07` (milestone #460).
Does not restack #459 / #374 / #156 / #276, live `m2/*`, Operator, Aria/Polo, or pack/Latest.

## What was deleted

Unused eager CSS (no TSX `className`): `.aw-menu`, `.cl-sidebar`, `.cl-navitem-active`, `.onboard-skip-screen`.
Not `#459`'s `.island-capsule` / unused exports. Not `#374`'s ControlBar / Logo / worklet leftovers.

Dead unused production helpers and unreachable modules:

- `readManagedLicenseFile` (`src/main/license/airgap.ts`)
- `peekLastFailoverNotice` (`src/main/index.ts`)
- `expectedSkillIds` (`src/shared/mode-skills.ts`)
- `isAskCavemanLevel` (`src/shared/caveman-ask.ts`)
- `src/renderer/src/lib/scramble.ts` (Act 1 wordmark scramble; live hero is static)
- `src/renderer/src/lib/bar-toolbar-layout.ts` (never imported by production Bar)

Unexported internals with no external importers: `dispatchStream`, `intelligencePassLocalReady`, `provenantFieldSchema`.

Architecture ratchet lowered: FF-03 orphans −2, FF-04 `index.ts` 9933→9930, FF-05a `airgap.ts` 3→1.

## Evidence

| Check | Command | Exit | Path |
|---|---|---|---|
| Type-check node | `npx tsc --noEmit -p tsconfig.node.json` | 0 | `/opt/cursor/artifacts/tsc-node.log` |
| Type-check web | `npx tsc --noEmit -p tsconfig.web.json` | 0 | `/opt/cursor/artifacts/tsc-web.log` |
| Architecture ratchet | `npm run check:architecture` | 0 | `/opt/cursor/artifacts/architecture-check.log` |
| Color-literal ratchet | `node scripts/check-color-literals.mjs` | 0 | `/opt/cursor/artifacts/color-literals.log` — hex counts unchanged |
| Source CSS bytes | `stat` on the three edited stylesheets vs `d68d8e5` | 0 | `/opt/cursor/artifacts/css-bytes-before.log`, `css-bytes-after.log` — **30572 → 30055 (−517)** |
| Baseline electron-vite build (`d68d8e5`) | `npm run build` in `/tmp/main-baseline` | 0 | `/opt/cursor/artifacts/baseline-build.log` — eager JS `index-CEtCrWmK.js` **504277**; eager CSS `index-D4URquwh.css` **127073** |
| After-change electron-vite build | `npm run build` | 0 | `/opt/cursor/artifacts/after-build.log` — eager JS `index-DklP72NG.js` **504277 (0)**; eager CSS `index-O3FY8EI9.css` **126655 (−418, −0.33%)** |
| After-build class names | `rg` in `out/renderer/assets/index-O3FY8EI9.css` | 0 | `/opt/cursor/artifacts/after-build-sizes.log` — `aw-menu` / `cl-sidebar` / `cl-navitem-active` / `onboard-skip-screen` absent; `island-capsule` left in place |
| Targeted Vitest | `npx vitest run` bar-toolbar.layout, caveman-ask, ask-routing, onboarding-hero-video, onboarding-kinetic-grid, llm | 0 | `/opt/cursor/artifacts/targeted-tests.log` — **6 files / 54 passed** |
| Dead-name grep | `rg` of deleted symbols under `src/` / `scripts/` | 0 | `/opt/cursor/artifacts/dead-name-grep.log` — remaining hits are negative assertions only |

Full `npm test` is CI-only (D-28). No pack / Latest / Metis.app.

Eager JS is unchanged because the deleted TypeScript modules were already FF-03 unreachable and never entered the renderer graph. The measured win is the eager CSS chunk.
