# Métis 2.0 Cap 2 — Wake + desktop adapters (Devon)
**When:** 20 Sep 2026 ~1:12pm ET (America/Toronto)  
**Branch:** `metis-2.0-inventory`  
**Base tip:** `9568d21ce7ab277d05a6ab34e79b76fc57713a2e` (Ultron Cap1 STAMP)  
**Cap2 tip:** `bec8f20f85eb6ea57743c737bf73b02c57f1abe6` (`bec8f20`)  
**Push:** box has no gh auth — bundle `/workspace/metis-20-cap2.bundle` (requires `9568d21`) for Mac `gh`/`git push`  
**Pack:** HOLD · **OAuth:** LAST · **Cap3 notch:** NOT started

## What landed

Wake-word command session + video adapter allowlist on the **existing** voice/ASR path (cloud STT finals/interims feed the runtime). No new mic/ASR. `quick-actions.ts` untouched (Ask chips, not OS automation).

### Adapter IDs (locked)
| ID | Mac | Win disclosure |
|----|-----|----------------|
| `desktop.open_notes` | Notes | Sticky Notes / Notepad (disclosed) |
| `desktop.create_note` `{ title: "hello" }` | Notes note | Notepad disclosed |
| `desktop.open_arc` | Arc (no silent swap) | Arc or fail visible |
| `desktop.google_search` `{ q: "Norbert Wiener" }` | Arc/default Google | default https |
| `desktop.open_x` | x.com | x.com |
| `desktop.photo_booth_capture` | Photo Booth shutter | Camera app; **never** to Jev/`/v1/decide` |

### Wake / pill UX
1. Spoken **Métis** → command session (meeting audio **without** wake does not execute)
2. Single chime + top-center translucent pill (`CommandListeningPill`) — `Hi Métis` → `Hi Métis, I'm listening...` + live transcript
3. Mid-sentence commits as keywords finalize (deterministic parser)
4. Thank you / Esc → double chime + pill dismiss (Stop local; no wait on `/v1/decide`)

### Jev-off deterministic path
- `parseMetisCommandTranscript` commits adapters from keywords alone (`confidence: 'deterministic'`).
- Runtime `jevEnabled` defaults **false**; `/v1/decide` `action_disambiguate` is optional assist only (timeout ≤1.2s, ignored on outage).
- Photo adapter is excluded from decide candidates (`desktopActionMayReachDecide`).

## Files
- `src/shared/desktop-actions.ts` (+ test)
- `src/shared/metis-wake.ts` (+ test)
- `src/shared/metis-command-parse.ts` (+ test)
- `src/shared/metis-command-session.ts` (+ test)
- `src/main/desktop-adapters.ts` (+ contract test)
- `src/main/metis-decide-client.ts` (+ test)
- `src/main/metis-command-runtime.ts` (+ test)
- `src/main/metis-command-register.ts`
- `src/renderer/src/components/CommandListeningPill.tsx` (+ contract test)
- Wired: `src/shared/ipc.ts`, `src/preload/index.ts`, `src/main/index.ts`, `src/renderer/src/App.tsx`

## Tests
```
npx vitest run src/shared/desktop-actions.test.ts src/shared/metis-wake.test.ts \
  src/shared/metis-command-parse.test.ts src/shared/metis-command-session.test.ts \
  src/main/desktop-adapters.contract.test.ts src/main/metis-decide-client.test.ts \
  src/main/metis-command-runtime.test.ts \
  src/renderer/src/components/CommandListeningPill.contract.test.ts
# 8 files / 34 tests passed
```

## Cap1 Keys deploy wire (Tony fuse — same Worker, no second portal)
- Worker name: `metis-operator` (`operator/wrangler.jsonc`)
- Production URL: `https://metis-operator.tony-walteur.workers.dev` (`operator/scripts/deploy.mjs`)
- Keys UI TypeSafe/Jev section: `operator/src/render/pages/keys.ts` (on tip `9568d21`)
- **Live Worker still:** `version=2b26efa` (built 2026-09-14) — Cap1 Keys **not** live until deploy
- Deploy (Totos-Mac / CF-authed): `node operator/scripts/deploy.mjs --env production`
- Dry-run on box: targets same URL, would stamp `OPERATOR_VERSION:9568d21c` — **no second Worker**

## Mac feel E2E blockers (~4pm ET screen recording)
- Mic + Accessibility (Photo Booth UI scripting / System Events) + Camera permissions
- Arc / Notes / Photo Booth installed on Totos-Mac `e41efcf0-…`
- Operator Cap1 deploy so Jev assist path can be toggled; deterministic path works without it
- Content-protection / overlay visibility while recording
- Screen recording path for Ultron feel later

## Out of scope this tip
- Cap3 right-edge notch
- Pack / release
- OAuth
