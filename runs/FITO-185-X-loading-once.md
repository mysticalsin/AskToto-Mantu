# FITO-185-X — Loading once-and-for-all (2026-09-15 16:55 ET)

## Symptom
Tony 16:53 ET: "Back to the loading issues with Métis fix this once and for all."
Coincides with `profile-5552b13-installer-prove` boot: audit stops at `app.renderer.ready`, **no** `app.act1.dom` / `act1-dom.json`. Métis then ZERO live.

## Live classify (which Loading)
| Candidate | Evidence | Verdict |
|-----------|----------|---------|
| Exclusive Act1 "Starting Métis…" | A-installer-window/desktop + 04-act1-window show Act1 wordmark + **Next** + Mantu·Tony; CGWindow 1800×1169 | **NOT stuck here** (Act1 painted) |
| Settings null gate blocking Act1 | `isOnboardingBoot(null)` already true; onboarding gate FIRST in App.tsx | Already fixed FITO-185-I/N |
| Post-onboarding auth/license Loading strip | Gate still reachable after exclusive exit recreate (no `?exclusiveOnboarding=1`); licenseGate fetch has **no timeout**; strip can show "Loading" with no Retry until 15s bootError | **REAL residual hole** |
| Renderer never ready | `app.renderer.ready` fired 254ms after start | Not this |
| Probe miss (no act1.dom) | LAUNCH_GATE on (ready fired) but no act1-dom.json; process lived ≥8s | **Probe never armed/wrote** — diagnostic gap, not the Tony UX itself |

Screenshots prove Act1 exclusive on DMG install path. Missing act1.dom ≠ forever Loading; Tony FAIL is the **durable post-boot strip / IPC race** class that FITO-185 partially fixed.

## vs prior FITO-185
- SFS / contentProtection / asar video / animation:none — not regressing (video unpacked present on Metis-5552b13.app).
- New/residual: (1) `registerIpc` still **after** `createWindow`→`loadURL` (renderer can invoke before handlers); (2) Loading strip has no mid-wait Retry; (3) `licenseGate()` promise has no timeout; (4) act1 probe silent-miss.

## Three paths (FIGURE-IT-OUT)
1. **Code path (ship):** registerIpc before createWindow; Loading strip soft Retry @5s + hard Reload @bootError; licenseGate timeout; act1 probe miss artifact.
2. **Pack path:** Metis-5552b13.app already has asarUnpack mp4 + exclusive stage visually; AskTotoGitShaShort missing on Info.plist (pack metadata only). Re-pack QA **after** tip push — not another opacity hack.
3. **Feel path:** Fresh `--user-data-dir` + LAUNCH_GATE + prove Act1 not forever Loading (act1.dom + no Loading caption) then post-Next not stranded on strip.

## Design
docs/design/DESIGN.md glass strip + AgentStatus `loading` caption "Loading" (Tony still calls it Starting Métis). ONBOARDING-FLOW: never block Act1 on settings/auth.
