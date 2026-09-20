# Métis 2.0 Inventory — HEAD tip `7e54a08`

**Written:** 20 Sep 2026 ~12:55pm ET (America/Toronto)  
**Machine context:** box seed `/workspace/AskToto-Mantu-191` (Totos-Mac `e41efcf0-…` Shell routing **not exposed** to this executor; paths mirrored under `/workspace/Users/tony/agent-tools/metis-191/proof/`)  
**Branch:** `metis-2.0-inventory` @ `origin/release/1.9.1`  
**Tip SHA:** `7e54a08adc402bed7428517a5d4ca7091319ab98`  
**Tip subject:** `fix(types): widen CloudSttLiveStartOpts profile for role/title`  
**HARD:** tip is **NOT** `ffcbf911` (that commit is ancestor-only; do not checkout).  
**Integration owner:** Devon  
**CoS:** Ultron  
**RF HOLD:** contracts until this inventory lands. **No implement** after this packet except Devon greenlight.  
**CODEX prompt:** `docs/design/METIS-2.0-CODEX-PROMPT.md` (436 lines, full Ultron lock) + proof `CODEX-PROMPT.md`  
**Mission lock:** `proof/METIS-2.0-MISSION-LOCK.md` / `/workspace/metis-2.0/MISSION-LOCK.md`  
**Video ref:** `/Users/tony/Downloads/igexport-DaO-_ASB9lX.mp4` (also seek `igexport-Ddevf2hNeHc.mp4` on Totos-Mac Downloads)  
**Parked under 2.0 baton:** 1.9.1 Bob FR (FITO-185 / tip prove). No Latest. No merge. OAuth LAST.

---

## Cap 1 — Portal-managed Jev (TypeSafe) — one vault key; fleet gets access NOT the key

### Actual owners on HEAD

| Role | Path | Notes |
|------|------|-------|
| Vault allowlist / last4 / encode | `operator/src/vault.ts` | `VAULT_LLM_PROVIDERS`, `FORBIDDEN_VAULT_PROVIDERS`, `CF_ACCOUNT_PROVIDER`, `last4OfSecret`, `encodeVaultPlaintext` / `decodeVaultPlaintext` |
| Encrypt / decrypt | `operator/src/crypto.ts` | Existing encrypted vault patterns — **reuse** for Jev |
| Admin key CRUD | `operator/src/keys.ts` | `writeVaultKey`, `listKeysJson`, `publicVaultMeta`; uses `seatAuthorizedForKeys` |
| Keys UI (SPA) | `operator/src/render/pages/keys.ts` (+ `keys.test.ts`) | Portal Keys page |
| Fleet seat gate | `operator/src/fleet.ts` | **`seatAuthorizedForKeys`** (L151+), approval/license helpers |
| Ask / funded providers | `operator/src/ask.ts` | Chat/completion path — **separate** from Jev |
| Store types | `operator/src/store.ts` (VaultKeyMeta / VaultKeyRow) | Meta only to clients |

### Entrypoints

- Admin paste/test/save/rotate/revoke → `keys.ts` + vault crypto  
- Seat entitlement → `fleet.seatAuthorizedForKeys`  
- Heartbeat / seat capability advertisement → extend fleet/seat payloads (**gap**: no `decisionProviders` / `jev` flag yet)

### Tests that exist

- `operator/src/keys.test.ts` — admin keys write / rotate / revoke  
- `operator/src/fleet.test.ts` — seat auth  
- `operator/src/privacy-boundary.test.ts`, `operator/src/security-harden.test.ts` — boundary patterns  
- Related: `operator/src/desktop-license-handshake.test.ts`, `operator/src/device-auth.test.ts`

### Gaps vs 2.0 (DO NOT rebuild — extend)

- **No Jev / TypeSafe / decision-provider** vault provider id (must stay **out of** `VAULT_LLM_PROVIDERS`)  
- No `/v1/decide` portal mediation  
- No fleet capability flag `jev` / `decisionProviders` on heartbeat  
- No admin UX section for TypeSafe Test/Save/Rotate independent of chat LLM picker  
- No client protocol for decide (desktop + Intelligence)  
- **DO NOT rebuild:** vault crypto, seatAuthorizedForKeys, Keys list masking

### DO NOT rebuild list

- `operator/src/vault.ts` allowlist machinery (add parallel decision-provider store, do not fold Jev into LLM list)  
- `operator/src/crypto.ts` encrypt/decrypt  
- `operator/src/fleet.ts` seatAuthorizedForKeys  
- `operator/src/keys.ts` publicVaultMeta / last4 UI contract

---

## Cap 2 — Desktop actions via EXISTING voice/actions (video sequence)

### Actual owners on HEAD

| Role | Path | Notes |
|------|------|-------|
| Quick-action kinds (Ask chips) | `src/shared/quick-actions.ts` | `factcheck` / `whatnext` / `explain` / `summarize` — **LLM ask routing**, not OS automation |
| Quick-action UI | `src/renderer/src/components/QuickActions.tsx` | |
| Mode skills (speech style) | `src/main/mode-skills.ts`, `src/shared/mode-skills.ts`, `skills/modes/*` | Meeting/sales/etc. coaching — **not** desktop app launch |
| MCP outbound actions | `src/main/mcp/pushQueue.ts` | `create_task` / `update_deal` / `log_note` — CRM/MCP, not Notes/Arc |
| Main IPC / ask | `src/main/index.ts` | Massive entry; voice→ask/listen lives here |
| ASR / voice | `src/main/apple-speech.ts`, `src/main/cloud-stt/*`, `src/shared/vad.ts` | Mic/ASR — **extend, do not rebuild** |
| Native intents | `native-app/MetisKit/.../MeetingIntents.swift` | Meeting-focused; `openAppWhenRun: false` |

### Entrypoints

- Voice → transcript → (today) Ask / quick-actions / mode skills  
- **No dedicated desktop automation registry** for Notes / Arc / Google / X.com / Photo Booth found on tip

### Tests that exist

- `src/shared/quick-actions.test.ts`  
- ASR/speech suite under `src/main/*asr*`, `src/main/apple-speech.test.ts`, cloud-stt tests  
- Mode skills: `src/main/mode-skills.test.ts`

### Gaps vs 2.0 (video: Notes+hello, Arc, Google Norbert Wiener, X.com, Photo Booth+photo)

- **Missing:** action adapters for open Notes / create note titled `hello` / open Arc / Google search / open x.com / Photo Booth capture  
- **Missing:** parser composition for chained desktop intents (must reuse existing command composition — none found for OS apps)  
- **Missing:** Windows equivalents disclosure  
- Camera permission path exists generically (Settings permissions) but **no Photo Booth capture adapter**; hard rule: never upload photo to Jev  
- **DO NOT rebuild:** mic pipeline, ASR, competing action registry — **extend** whatever executor path Devon confirms; if none, add thin adapters beside existing voice→policy path without new mic stack

### Video inventory

| File | Location | Status |
|------|----------|--------|
| `igexport-DaO-_ASB9lX.mp4` | `/Users/tony/Downloads/` (Totos-Mac) | Primary per Ultron steer |
| `igexport-Ddevf2hNeHc.mp4` | Totos-Mac Downloads (seek) | Secondary / original lock name |

### DO NOT rebuild list

- `src/main/apple-speech.ts` / cloud-stt / vad  
- `src/shared/quick-actions.ts` kinds (different product surface; do not replace with OS automation)  
- Mic / ASR protocol

---

## Cap 3 — Fast Mantu Intelligence — Jev classifies evidence for “Where do we stand?”

### Actual owners on HEAD

| Role | Path | Notes |
|------|------|-------|
| Design / name lock | `docs/design/MANTU-INTELLIGENCE.md` | Name **Mantu Intelligence** only |
| Update cadence | `docs/design/INTELLIGENCE-UPDATE.md` | |
| Dashboard app | `intelligence/` | Vite dashboard |
| Brain → UI adapter | `intelligence/src/lib/brainAdapter.ts` (+ `.test.ts`) | Deals bands, velocity, evidence |
| Types / evidence fields | `intelligence/src/types/data.ts` | `band_evidence`, velocity.evidence, grounding |
| Insight cards | `intelligence/src/components/InsightCard.tsx` | Grounding tiers |
| Main-process brain | `src/main/brain/*` | ingest, intelligence-pass, intelligence-index, publish, store |
| Shared brain schema | `src/shared/brain.ts` | Entity schemas / provenance |
| Intelligence work | `src/main/brain/intelligence-pass.ts`, `intelligence-work.ts`, `intelligence-index.ts` | |

### Entrypoints

- Update Intelligence / brain ingest → `.brain` + wiki  
- Dashboard reads via `brainAdapter` / `useDashboardData`  
- “Where do we stand?” = evidence-backed status (deterministic layer exists; **Jev assist layer absent**)

### Tests that exist

- `intelligence/src/lib/brainAdapter.test.ts`  
- `intelligence/src/lib/dashboard-state.contract.test.ts`  
- `intelligence/src/lib/intelligence-update.test.ts` + `.contract.test.ts`  
- `src/main/brain/intelligence-pass.test.ts`, `intelligence-work.test.ts`, `intelligence-index.test.ts`, `brain.test.ts`, many ingest_* tests

### Gaps vs 2.0

- No Jev decide/ranking/score assist over evidence snapshots  
- No explicit three-layer labeling (deterministic / Jev / explanation) in UI  
- Suggested-action **preview** gate not tied to portal Jev  
- Freshness / insufficient-evidence paths exist in spirit (null bands, grounding) — extend, don’t invent rival question set  
- **DO NOT rebuild:** brain ingest, Mantu Intelligence name, dashboard shell, brainAdapter contracts

### DO NOT rebuild list

- `intelligence/` app shell + `brainAdapter`  
- `src/main/brain/ingest.ts` / store / publish  
- Product name Mantu Intelligence

---

## Cap 4 — Right-edge notch (CodeNotch MIT inspiration) in Settings → Appearance

### Actual owners on HEAD

| Role | Path | Notes |
|------|------|-------|
| Pure geometry | `src/main/island/geometry.ts` | Clamp, top-edge strip, slide, parked hover — **extend here** |
| Geometry tests | `src/main/island/geometry.test.ts` | |
| Notch metrics | `src/main/island/metrics.ts` (+ `metrics.test.ts`) | Physical Mac notch (top), not right-edge UI |
| Overlay placement contract | `src/main/overlay-placement.contract.test.ts` | |
| Overlay chrome / layout | `src/shared/overlay-chrome.ts`, `src/shared/overlay-orb.ts` | |
| Settings bounds | `src/shared/settings-bounds.ts` | |
| Settings Appearance UI | `src/renderer/src/components/Settings.tsx` ~L6349 `Section title="Appearance"` | Today: transparency / see-through — **no Placement / right-edge** |
| Onboarding appearance | `src/renderer/src/components/OnboardingAppearance.tsx`, `src/renderer/src/lib/onboarding-appearance.ts` | |
| Operator overlay poll | `src/main/operator-overlay.ts` | Unrelated fleet overlay |

### Entrypoints

- Settings → Appearance → (gap) Placement → right-edge  
- Geometry consumers in `src/main/index.ts` (setBounds / display metrics) — keep single geometry source

### Tests that exist

- `src/main/island/geometry.test.ts`  
- `src/main/island/hover-hit-band.test.ts`, `mac-hide-island.proof.test.ts`, `cursor-watch.test.ts`  
- `src/main/overlay-placement.contract.test.ts`  
- `src/main/overlay-cursor-stability.test.ts`  
- Settings: `src/renderer/src/components/Settings.contract.test.ts`

### Gaps vs 2.0

- No right-edge vertical pill / expand-left  
- Appearance section has no Placement control  
- Existing “notch” code = **Mac hardware top notch**, not CodeNotch-style right-edge UI — do not confuse  
- Ref only: https://github.com/vinzdg/codenotch — **do not import** package with credentials/auto-update/telemetry  
- **DO NOT rebuild:** `geometry.ts`, parallel geometry system, invisible full-screen hit sinks

### DO NOT rebuild list

- `src/main/island/geometry.ts` (extend)  
- Top-edge island / hide-park behavior  
- Settings Appearance transparency controls (add Placement beside, don’t rip out)

---

## Cross-cutting

| Item | Status on tip |
|------|----------------|
| Package / bundle / `asktoto` IDs | Preserve — no rename |
| Feature flags / kill switch for Jev | **Gap** |
| OAuth | LAST — do not start |
| Bob FR 1.9.1 | Parked under 2.0 baton |
| Latest / merge | HOLD |
| TypeSafe skill | Use when building AI judgments (post-inventory) |

---

## Baseline vitest (C)

| Command | Exit | Path / notes |
|---------|------|--------------|
| `npm ci && npx vitest run operator/src/keys.test.ts operator/src/fleet.test.ts src/main/island/geometry.test.ts src/shared/quick-actions.test.ts intelligence/src/lib/brainAdapter.test.ts` | **BLOCKED** | `node_modules` absent on box seed at inventory write; install interrupted by steer. Re-run on Totos-Mac or after `npm ci` on box. |
| Suggested Mac (Totos-Mac AskToto tree @ 7e54a08) | pending | Same slice once deps present |

Record when unblocked:

```
cd <AskToto> && git rev-parse HEAD   # expect 7e54a08a…
npx vitest run operator/src/keys.test.ts operator/src/fleet.test.ts \
  src/main/island/geometry.test.ts src/shared/quick-actions.test.ts \
  intelligence/src/lib/brainAdapter.test.ts
# capture: exit_code=… 
```

---

## Implementation sequence (from CODEX §18) — STOP after inventory for Devon RF

1. ~~Baseline / inventory~~ → **THIS DOC**  
2. Vault + `/v1/decide` + seat capability — **NEXT after Devon contracts packet**  
3. Video action adapters  
4. Intelligence evidence + Jev layer  
5. Right-edge notch geometry + Settings Placement  
6. Validate / rollout  

**RF HOLD on contracts until inventory.** This inventory is complete for Devon’s contracts packet. **No feature implement in this turn.**

---

## Report for Devon

- **Tip SHA:** `7e54a08adc402bed7428517a5d4ca7091319ab98`  
- **Inventory path:** `/workspace/Users/tony/agent-tools/metis-191/proof/METIS-2.0-INVENTORY.md` (mirror of Totos-Mac `/Users/tony/agent-tools/metis-191/proof/METIS-2.0-INVENTORY.md`)  
- **CODEX prompt:** `AskToto docs/design/METIS-2.0-CODEX-PROMPT.md` (436 lines)  
- **Repo worktree:** `/workspace/AskToto-Mantu-191` on branch `metis-2.0-inventory`  
- **Blocker note:** executor has no Totos-Mac Shell `machineId` routing; work done on box seed at same tip SHA.
