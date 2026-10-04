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
| Source CSS bytes | `stat` on the three edited stylesheets vs `d68d8e5` | 0 | `/opt/cursor/artifacts/css-bytes-before.log`, `css-bytes-after.log` — **30572 → 30055 (−517)** |
| Dead-name grep | `rg` of deleted symbols under `src/` / `scripts/` | 0 | `/opt/cursor/artifacts/dead-name-grep.log` — remaining hits are negative assertions only |

Targeted Vitest and `npm run build` measurements are recorded after the first push.
Full `npm test` is CI-only (D-28). No pack / Latest / Metis.app.
