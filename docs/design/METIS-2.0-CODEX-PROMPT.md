# Métis — Codex implementation prompt

**Audience:** Codex (Devon the Dev integration driver)  
**Owner / lock:** Tony Walteur — Ultron chat lock dated **20 Sep 2026** (America/Toronto)  
**Product:** Métis 2.0 — portal as control center  
**CoS:** Ultron  
**Drivers:** Claude Code on Totos-Mac; Codex on Totos-Mac + DESKTOP-IK7QQ0E  
**Companion lock:** `MISSION-LOCK.md` (same folder)

---

## Tony preamble (read first)

Métis 2.0 adds **portal-managed Jev** for **desktop actions** and **Mantu Intelligence**, plus an **optional right-edge notch**.

- The **TypeSafe / Jev API key stays server-side** in the portal encrypted vault.
- Desktop and Intelligence installations receive **service access** (capability + protocol), **not a copy of the API key**.
- Never ship, sync, or paste the raw Jev key onto client machines.
- This is an **incremental production update**: extend what already works; do not rebuild competing pipelines.

If any instruction below conflicts with renaming Métis, Mantu Intelligence, package/bundle/`asktoto` IDs, or with rebuilding the voice/actions stack from scratch — **the hard rules win**. Stop and report.

---

## 1. Mission and non-negotiable scope

### Mission

Ship an **incremental production update** to Métis that adds four capabilities without rewriting the product:

1. **Portal-managed Jev** — one admin-managed decision provider key in the portal vault; eligible fleet seats get **service access**, never the raw key.
2. **Desktop actions** — extend the **existing** voice → parser → policy → executor path so the video workflow works end-to-end (Notes / hello note, Arc, Google “Norbert Wiener”, X.com, Photo Booth + photo).
3. **Fast Mantu Intelligence** — evidence-based “Where do we stand?” using Jev for decision/scoring layers where useful — **not** a chatbot, **not** meeting-only chat.
4. **Right-edge notch** — CodeNotch-inspired Settings Appearance Placement; compact vertical pill on the right edge that expands left.

### Non-negotiable rules

- **Extend existing voice/actions** — do **not** rebuild the mic pipeline, ASR stack, or a competing action registry.
- Preserve product names: **Métis** and **Mantu Intelligence** (dashboard name).
- **No rename** of package name, bundle IDs, or `asktoto` identifiers.
- Jev is a **decision capability**, separate from chat / `VAULT_LLM_PROVIDERS`.
- OAuth work is **last**; no silent remote desktop control from the portal.
- Delivery must be **baseline + regression + reversible rollout** (feature flags, kill switch, documented rollback).

### Out of scope (explicit)

- Replacing Ask / Listen / meeting transcription with Jev.
- Client-side storage of the TypeSafe API key.
- Importing CodeNotch as a dependency that pulls credentials, auto-update, or telemetry.
- Arbitrary remote command execution from the portal or from Jev responses.
- Renaming the product, Intelligence surface, or shipping IDs.

---

## 2. Inspect actual project

### Source of truth

- Prefer **AskToto OneDrive checkout path** or workspace tree **`AskToto-Mantu-191`**.
- Work at **HEAD tip**. Do **not** `git reset` or force-checkout history.
- Historical anchor **`ffcbf911` is NOT a checkout target** — use it only as a narrative/reference anchor if docs mention it. Implement against current HEAD.

### Read before coding

1. `AGENTS.md` (if present) and repo `README.md` / `DESIGN.md`.
2. `git log -5 --oneline` and `git status` — confirm HEAD; no reset.
3. Portal / operator: vault, fleet, license, ask/key routes.
4. Desktop: voice / actions path, brain, Intelligence app.
5. Overlay: island geometry and Settings Appearance placement hooks.

### Locate (inventory — do not invent paths)

| Area | Starting files / areas (verify on disk) |
|------|----------------------------------------|
| Operator keys / vault / fleet / ask | `operator/src/vault.ts`, `operator/src/fleet.ts` (`seatAuthorizedForKeys`), `operator/src/ask.ts`, license-server / admin UI key surfaces |
| Main process entry | `src/main/index.ts` (or current entry) |
| Island / geometry | `src/main/island/geometry.ts` (+ tests) |
| IPC | main ↔ preload ↔ renderer IPC channels (validate allowlists) |
| Preload | `src/preload/*` |
| Brain | existing brain / connectors / action executor modules |
| Intelligence | `intelligence/` app (Mantu Intelligence UI + evidence pipeline) |

### Inventory deliverable

Before feature work, produce a short **inventory note** listing:

- Confirmed paths for vault, fleet auth, voice parser, action executor, Intelligence evidence, island geometry.
- Existing feature flags / settings keys relevant to Jev, actions, notch placement.
- Whether a **“no dynamic imports”** ban (or similar bundler rule) exists — if it does, **honor it**; do not introduce banned patterns.
- Gaps vs this prompt (missing adapters, missing Settings keys, missing tests).

Do not start broad refactors during inventory.

---

## 3. Decision capability — not a chatbot

### Pipeline (desktop)

```
voice / transcript
  → parser (existing)
  → Jev when useful (choice / noul / score)
  → policy (allowlist, seats, settings)
  → executor (existing action adapters)
```

### Pipeline (Intelligence)

```
facts / evidence snapshot
  → Jev (decision / ranking / confidence assist)
  → view (Mantu Intelligence UI)
```

### Jev boundaries

Jev is **not**:

- Speech recognition
- Vision / camera processing
- A database
- An OS automation layer

Jev speaks **text + structured state only**. It does not hold permissions or credentials.

### Separation from LLM vault

- Jev / decision provider configuration is **separate from** `VAULT_LLM_PROVIDERS` and chat/completion providers.
- Do not fold Jev keys into the chat provider picker.
- Do not route Ask/chat completions through the Jev decide endpoint by default.
- Jev must **never** be given OS permissions, OAuth tokens, camera frames, or photo binaries as “context.”

### Confidence ≠ authorization

Model confidence scores are **not** auth. Seat approval, license, feature toggles, and allowlists remain authoritative.

---

## 4. One portal key — fleet access

### Admin UX (portal / TypeSafe / Jev)

In the portal admin UI (TypeSafe / Jev decision-provider section):

- **Paste** key
- **Test** connectivity
- **Save** (encrypted vault)
- **Rotate**
- **Revoke**
- **Enable / disable** fleet capability

Independent toggles:

- Enable Jev for **desktop actions**
- Enable Jev for **Mantu Intelligence**

### Metadata & vault

- Store **masked metadata** only in UI (last4, created/rotated timestamps, status) — never display full key after save.
- **Reuse the existing encrypted vault** patterns (`operator/src/vault.ts` and related).
- **Never send the API key to desktops** — not in config sync, not in heartbeat payloads, not in license blobs.

### Fleet authorization

- Gate with existing **`seatAuthorizedForKeys`** (and approval/license rules).
- Heartbeat / seat view should advertise **decisionProviders / capabilities** (e.g. `jev: true` when enabled and seat eligible) — **capability flags**, not secrets.
- Older clients: document an **update path** (capability ignored until client version supports `/v1/decide` client protocol). Do not break older clients that do not understand the new fields.

### Failure modes

- Missing/revoked key → desktop + Intelligence fall back to deterministic paths; no crash loops.
- Unauthorized seat → clear “not approved / not entitled” behavior; no key leakage in errors.

---

## 5. Narrow typed Jev service

### External verify (admin Test)

Confirm against TypeSafe SystemOne:

- `POST https://api.typesafe.ai/v1/systemone`
- `Authorization: Bearer <portal vault key>`
- Contract shapes for **choice / noul / score** as documented by TypeSafe after verify.

**Pin `jev-1.13.0` (or the verified equivalent tag) only after live verify succeeds.** Do not pin from memory if the live API disagrees — record the verified version in the acceptance report.

### Internal protocol

- Expose an internal **`/v1/decide`** (portal-mediated) used by eligible clients.
- Clients call the **portal**, not TypeSafe directly.
- Request/response must be **narrow and typed** (templates + bounds).
- Templates: only approved decision templates (action disambiguation, Intelligence ranking, etc.).
- Bounds: max tokens / payload size / timeout / rate limits.
- Again: **confidence ≠ auth**.

### Client rules

- No client-chosen vendor URL.
- No embedding of Bearer tokens in desktop builds.
- Timeouts and typed error codes so voice/actions can proceed deterministically on outage.

---

## 6. Fair scheduling, outages, cost

### Fleet limits & fairness

- Enforce fleet-wide and per-seat limits for `/v1/decide`.
- Fair scheduling across seats (no single seat starves the fleet).
- **Coalesce transcripts** — do not fire Jev on every interim ASR chunk.
- **Cancel superseded** in-flight decide calls when a newer final transcript replaces them.
- **No Jev every chunk** — only on finals / settled phrases / explicit Intelligence refresh.
- Honor **deadlines** so the UI never waits unbounded.
- **Meter estimated cost** (tokens/calls) for admin visibility; do not block UX on perfect billing.

### Outage behavior

When Jev is down, slow, or disabled:

- **Preserve voice** and **deterministic action execution**.
- Intelligence shows deterministic layer + clear “decision assist unavailable” — do **not** invent scores.
- No cascading retries that DOS the portal.

---

## 7. Every video action

Extend **existing** action adapters so this **video sequence** works (voice or chained phrases):

| Step | Intent (Mac reference) | Notes |
|------|------------------------|-------|
| 1 | **Open Notes** | Launch / focus Notes |
| 2 | **Create note titled `hello`** | Title exactly `hello` (or locale-documented equivalent with disclosure) |
| 3 | **Open Arc** | Launch / focus Arc browser |
| 4 | **Google Norbert Wiener** | Search Google for “Norbert Wiener” |
| 5 | **Open X.com** | Navigate / open x.com |
| 6 | **Photo Booth — take picture** | Open Photo Booth and capture a photo |

### Chained phrases

Support natural chained utterances that map to the sequence (and partial subsequences). Parser should reuse existing command composition — do not invent a second grammar engine.

### Windows equivalents

- Disclose **Windows equivalents** in docs/tests (e.g. Notepad/Sticky Notes analogue, Edge/Chrome if Arc absent, Camera app analogue).
- **No silent substitute** — if the preferred app is missing, tell the user / fail visibly; do not quietly swap to a different app without disclosure.

### Camera

- Camera capture is **permission-gated**.
- **Never upload a photo to Jev** (or to the portal decide endpoint). Photos stay local unless an existing, unrelated user-driven export path applies — that path is out of this prompt’s Jev scope.

---

## 8. Command lifecycle

- **Meeting channel ≠ command channel** — meeting transcription must not auto-fire desktop actions.
- **Interim negation** — partial ASR (“don’t open…”) must not execute early positives; wait for settled intent.
- **Revalidate targets** before execute (app still allowed, window still valid, seat still entitled).
- **Stop / Escape** are **local** and immediate — cancel pending actions without waiting on Jev.
- **Idempotency** — repeated “open Notes” should not spawn unbounded windows; follow existing idempotent patterns.
- Outcomes: **`verified`** vs **`unknown`** — do not claim success without verification hooks you actually have.
- **No remote arbitrary command** — portal and Jev cannot inject shell or unbounded AppleScript/PowerShell.

---

## 9. Mantu Intelligence — “Where do we stand?”

### Required posture

Mantu Intelligence answers **“Where do we stand?”** with evidence — not open-ended chat.

Maintain / implement support for the **required questions list** already associated with Intelligence (status, risks, blockers, next actions, coverage gaps — use the project’s canonical list in `intelligence/` / `docs/design/MANTU-INTELLIGENCE.md`; do not invent a rival question set without documenting the merge).

### Three layers

1. **Deterministic** — facts from connectors, licenses, seats, local snapshots.
2. **Jev** — optional decision/ranking/score assist over those facts.
3. **Explanation** — human-readable synthesis that **cites** the deterministic evidence (and labels Jev-assisted bits).

### Scope & permissions

- Respect connector / seat / license **permissions**.
- Do not fetch or display data the seat cannot access.
- **Suggested actions** require an explicit **preview** before execution (no silent auto-run from Intelligence cards).

---

## 10. Evidence freshness — incremental

- Prefer **snapshots** with timestamps over ad-hoc live scraping for the default “Where do we stand?” view.
- **Invalidate** snapshots when relevant **permission / connector / seat** changes occur.
- **Insufficient evidence ≠ invented evidence** — if data is missing, say so.
- **Preserve stale disclosures** — if showing older data, label freshness clearly; do not hide staleness to look “smart.”

---

## 11. CodeNotch right-edge

### Placement

- Settings → **Appearance** → **Placement**: add / wire **right-edge** (CodeNotch-inspired).
- Compact **vertical pill** on the right edge; **expands left** on interaction.
- Reference (MIT): https://github.com/vinzdg/codenotch

### Hard constraints

- **Do not import** CodeNotch as a package that brings **credentials, auto-update, or vendor telemetry**.
- Inspiration / geometry / UX only — reimplement against Métis island/overlay primitives.
- **Hover** on the notch must **not** auto-enable mic, camera, or fire actions.

---

## 12. Geometry

- **Extend** `src/main/island/geometry.ts` (and tests) — do not fork a parallel geometry system.
- Use Electron **DIP coordinates** correctly across displays.
- **Multi-display**: place on the relevant display; survive display connect/disconnect.
- **Clamp** to visible work area; never park off-screen permanently.
- **No invisible blockers** — hit regions must not create invisible full-screen click sinks.

---

## 13. Settings platform

- Surfaces that are portal-controlled show **“Managed by portal”** (or existing equivalent copy) and remain consistent with fleet policy.
- Desktop vs Intelligence Jev toggles remain **independent** where product policy allows; portal can force-disable.
- Support **Electron Mac + Windows**, and **SwiftUI** native path **if that target is still active** in HEAD — do not break either.
- Maintain a **capability matrix** (Mac / Win / native) in docs or settings for: Jev desktop, Jev Intelligence, right-edge notch, camera action, Notes/Arc analogues.

---

## 14. Security

- Keep **sandbox** assumptions intact (Electron sandbox / native entitlements as already designed).
- **IPC validation** — allowlisted channels and payloads; reject unknown invoke names.
- Treat transcripts as **untrusted** input (prompt injection / command injection hygiene in parser + Jev templates).
- **Allowlisted apps** only for automation targets.
- **No client-chosen vendor URL** for Jev/TypeSafe.
- Never log raw API keys, full Bearer tokens, or photo binaries to crash reports.

---

## 15. Baseline, migrations, rollout

- Changes are **additive** (new vault fields, new capability flags, new settings keys, new adapters).
- Gate with **feature flags** / portal enable bits.
- Deploy **server (portal) before clients**.
- Provide a **kill switch** (portal revoke / disable decision provider) that instantly stops new Jev calls.
- Document **rollback**: disable flags, clients continue deterministic voice/actions + Intelligence without Jev.
- Migrations must be reverse-friendly (do not destroy vault ciphertext on rollback).

---

## 16. Tests

Minimum coverage (automated where practical + manual proof checklist):

1. **Portal shared key** — save / mask / test / rotate / revoke; desktops never receive raw key.
2. **Voice / actions video sequence** — full Notes → hello → Arc → Google Norbert Wiener → X.com → Photo Booth path; **multilingual** smoke where existing i18n exists.
3. **Camera** — permission deny / grant; photo never uploaded to Jev.
4. **Intelligence** — three-layer “Where do we stand?”; insufficient evidence path; suggested action preview.
5. **Notch** — right-edge placement, expand-left, no hover mic/camera/actions; multi-display clamp.
6. **Regression** — Ask, Listen, meeting flows, existing bar/pill, license/seat auth, vault LLM providers unchanged in behavior when Jev disabled.

Record proofs under the run/proof convention already used by Métis 191.

---

## 17. Performance gates

Measure and report stage timings (parse, decide, policy, execute, Intelligence snapshot):

| Stage / scenario | Suggested benchmark (not a promise) |
|------------------|-------------------------------------|
| Warm local path (no Jev or cached) | **~200ms** |
| Simple desktop action (p95) | **~2s** |
| Intelligence refresh with Jev assist (p95) | **~3s** |

These are **benchmarks for gating discussion**, not SLAs or user-facing promises. If HEAD cannot meet them, document actuals and bottlenecks — do not fake pass.

---

## 18. Implementation sequence

Execute in order; do not skip acceptance:

1. **Baseline** — inventory (§2), HEAD confirmed, no reset, regression green on critical paths.
2. **Vault** — portal Jev key lifecycle + `seatAuthorizedForKeys` + capability heartbeat + `/v1/decide` mediation (§4–§6).
3. **Actions** — video sequence adapters + lifecycle rules (§7–§8).
4. **Intel** — evidence freshness + three layers + previews (§9–§10).
5. **Notch** — Settings placement + geometry extend (§11–§12).
6. **Validate** — settings/security/rollout/tests/perf (§13–§17).

### Acceptance report (required)

Produce an acceptance report that includes:

- Inventory paths and HEAD commit.
- Verified TypeSafe endpoint + pinned Jev version (after live verify).
- Flags / kill switch / rollback steps.
- Test results (pass/fail with evidence links).
- Perf measurements vs §17 benchmarks.
- Explicit **non-claims**: anything not proven must be marked unknown — **no false claims**.

### Done means

One centrally managed Jev capability enhancing Métis: real voice desktop actions (video sequence), grounded Mantu Intelligence, optional right-edge notch — **E2E proven on Mac + Windows**, reversible, and safe by default when Jev is off.

---

## Appendix A — Quick hard-rule checklist

- [ ] Extending voice/actions — not rebuilding
- [ ] Key server-side only
- [ ] Names preserved (Métis, Mantu Intelligence)
- [ ] No package/bundle/`asktoto` renames
- [ ] Jev ≠ chat / ≠ `VAULT_LLM_PROVIDERS`
- [ ] No photo upload to Jev
- [ ] No CodeNotch credential/update import
- [ ] No invisible geometry blockers
- [ ] Server before clients; kill switch ready
- [ ] Acceptance report without false claims

## Appendix B — Reference links

- CodeNotch (MIT inspiration only): https://github.com/vinzdg/codenotch
- TypeSafe SystemOne verify: `POST https://api.typesafe.ai/v1/systemone`
- Companion lock: `./MISSION-LOCK.md`
- Ultron / Tony chat lock date: **20 Sep 2026**

---

*End of Métis — Codex implementation prompt. Implement exactly; report honestly.*
