# Nightly cleanup 2026-10-05 — unused eager onboarding CSS leftovers

Starting ref: `d68d8e5fe2f9537b0453f415f510a3b71c972b07` (milestone #460).
Branch: `cursor/nightly-cleanup-unused-onboard-css-636c`.
Proof recorded from this Linux cloud workspace. Full `npm test` skipped locally (owner decision D-28: tests in CI only).

## Target

Delete leftover eager CSS with no production `className`:

- `.onboard-pop-in` + `@keyframes onboard-pop-in` + `.onboard-stage .onboard-pop-in` override
- `.onboard-skip-chip` + `:hover`
- `.onboard-starfield` + canvas (starfield host is FF-03 unused; live bed is kinetic grid)
- stale `.overlay-orb-diagram__jarvis--live` selector fragment

Held for prior nightlies: `.island-capsule` (#459), `.onboard-skip-screen` / `.aw-menu` / `.cl-sidebar` / `.cl-navitem-active` (#497).

## Commands

| Check | Command | working path | exit_code |
|---|---|---|---|
| Type-check node | `npx tsc --noEmit -p tsconfig.node.json` | `/workspace` | 0 |
| Type-check web | `npx tsc --noEmit -p tsconfig.web.json` | `/workspace` | 0 |
| Architecture ratchet | `npm run check:architecture` | `/workspace` | 0 |
| Color-literal ratchet | `node scripts/check-color-literals.mjs` | `/workspace` | 0 |
| Source CSS bytes | `stat -c '%n %s'` four stylesheets vs `d68d8e5` | `/workspace` | 0 |
| Baseline electron-vite build | `npm run build` | `/tmp/main-baseline` (worktree at `d68d8e5`) | 0 |
| After-change electron-vite build | `npm run build` | `/workspace` | 0 |
| After-build leftover names | `rg` in `out/renderer/assets/index-Ce5mYU6n.css` | `/workspace` | 0 |
| Targeted Vitest | `npx vitest run` quality-bar, close-audio-cta, kinetic-grid, starfield-spec, jarvis-orb, portal, hero-video | `/workspace` | 0 — 7 files / **64 passed** |
| Dead-name grep (`src/` styles) | leftover selectors absent; held names present | `/workspace` | 0 |
| Full `npm test` | — | — | skipped (D-28, CI only) |

Logs: `/opt/cursor/artifacts/tsc-node.log`, `tsc-web.log`, `architecture-check.log`, `color-literals.log`, `baseline-build.log`, `after-build.log`, `targeted-tests.log`, `dead-name-grep.log`.

## Bundle sizes

| Measure | Baseline (`d68d8e5`) | After | Delta |
|---|---|---|---|
| Eager JS `index-*.js` | `index-CEtCrWmK.js` **504277** | `index-c4D6oedU.js` **504277** | 0 |
| Eager CSS `index-*.css` | `index-D4URquwh.css` **127073** | `index-Ce5mYU6n.css` **126416** | **−657 (−0.52%)** |
| Source CSS (4 files) | 30163 | 29252 | **−911** |

Source CSS bytes:

| File | Before | After |
|---|---|---|
| `onboarding-stage.css` | 9063 | 8823 |
| `onboarding-scenes.css` | 12762 | 12388 |
| `orb.css` | 3185 | 2955 |
| `overlay-chrome.css` | 5153 | 5086 |

Color-literal hex counts unchanged (deleted rules used no hex, or only rgba / motion). Architecture baseline unchanged.

## After-build leftover names

| Name | After eager CSS |
|---|---|
| `onboard-pop-in` | absent |
| `onboard-skip-chip` | absent |
| `onboard-starfield` | absent |
| `overlay-orb-diagram__jarvis--live` | absent |
| `island-capsule` | present (held for #459) |
| `onboard-skip-screen` | present (held for #497) |
| `aw-menu` | present (held for #497) |
| `cl-sidebar` | present (held for #497) |
| `cl-navitem-active` | present (held for #497) |

## Left alone

- #497 unused helpers/modules and those four CSS classes
- #459 unused exports; `.island-capsule` remains
- #374 native/overlay leftover deletes and SignInWall/LicenseGate lazy
- Live `m2/*` tip `90c671ec` and open m2 restore/hotfix PRs
- #156, draft #276, Operator Worker PRs
- Aria / Polo / Fly / Vercel aliases / secrets
- Dig / Pack / Latest, Metis.app, signing

Evidence levels: DESIGNED, LOCALLY_TESTED, MEASURED.

READY TO MERGE = no
