# Nightly cleanup 2026-10-03 — proof

Base: `main` `fd38fd09` (milestone #429). Head: this branch.
Does not restack #374 / #156 / draft #276. Dig / Pack / Latest HOLD.

## What changed

- Deleted unused helpers: `isWhisperLanguageName`, `confirmNavigation`, `personaVibe`, `agentStatusFor`, `createJarvisObsidianOrb`, `ONBOARDING_STAGE_BACKGROUND`.
- Unexported internals with zero external importers: `HUMAN_STYLE`, `UNKNOWN_SPEAKER_PREFIX`, `SECOND_BRAIN_MIN_PER_OPPORTUNITY`, `SECOND_BRAIN_CAP_MIN`, `OPERATOR_HOSTED_PROVIDER_IDS`.
- Deleted unused Act 1 `.island-capsule` CSS + keyframes from the eager onboarding stylesheet.

## Commands

| Claim | Command | exit_code | Output |
|---|---|---|---|
| Type-check node | `npx tsc --noEmit -p tsconfig.node.json` | 0 | `/opt/cursor/artifacts/tsc-node.log` |
| Type-check web | `npx tsc --noEmit -p tsconfig.web.json` | 0 | `/opt/cursor/artifacts/tsc-web.log` |
| Architecture ratchet | `npm run check:architecture` | 0 | `/opt/cursor/artifacts/architecture-check.log` |
| Targeted Vitest (10 files) | `npx vitest run` persona-vibe, agent-status, navigation-guard, lang-id, settings-bounds, speaker-names, time-saved-events, ask-routing, prompts, jarvis-orb | 0 | `/opt/cursor/artifacts/targeted-tests.log` — **81 passed** |
| Source CSS bytes | `git show fd38fd09:src/renderer/src/styles/onboarding-stage.css \| wc -c` vs `wc -c <` head | 0 | `/opt/cursor/artifacts/css-bytes.log` — **9063 → 5502 (−3561)** |
| Baseline electron-vite build (`fd38fd09`) | `npm run build` in `/tmp/main-baseline` | 0 | `/opt/cursor/artifacts/baseline-build.log` — eager JS `index-CphFDWo2.js` **503429**; eager CSS `index-5FkwmDUi.css` **126127** |
| After-change electron-vite build | `npm run build` | 0 | `/opt/cursor/artifacts/after-build.log` — eager JS `index-laRuUQqn.js` **503429 (0)**; eager CSS `index-C1MYuvH8.css` **124267 (−1860, −1.47%)** |
| Dead-name grep in `src/` | `rg` isWhisperLanguageName / confirmNavigation / createJarvisObsidianOrb / ONBOARDING_STAGE_BACKGROUND / personaVibe fn / agentStatusFor fn / island-capsule | 1 (0 matches) | `/opt/cursor/artifacts/dead-name-grep.log` |
| Dead-name grep in `out/` | same names after after-change build | 1 (0 matches) | `/opt/cursor/artifacts/after-build-sizes.log` |

Not run: full `npm test` (D-28, CI only); no pack / Latest / Metis.app.
