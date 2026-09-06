---
project: Métis
type: product-frame
name: Métis Lite
letter: K
status: FRAME
ready-to-merge: no
audience: Tony Walteur · Ultron · Devon · RocketFuel
date: 2026-09-06
---

# Métis Lite — FRAME (K)

**DESIGN only. No UI code in the change that lands this file.**  
**READY TO MERGE: no. No pack / EXE / DMG / Native / Latest.**  
**No live D1 ALTER** until Ultron relays Tony OK (same hold as question_type).

Ultron K: Métis Lite FRAME while pack is blocked on Tony material (prod `pubkey.json` + I signing). Implement **last after PCC** (Tony lock R23). Enterprise harden + signing are prerequisites; they are not the start gun for Lite eng. Off Aria.

---

## 1. Intent

Métis Lite is the **smallest honest product loop** a Mantu consultant can run on day one without Operator fleet chrome:

1. **Listen** a meeting (mic + system audio, tell the room).
2. **End** → a durable **summary** (recap) lands without a skeleton UI.
3. That meeting **enriches Mantu Intelligence** (connected OneDrive / second-brain wiki).
4. **Optional API** — a cloud Ask/summary provider may be connected; it is never required for the Listen→save path when local / already-configured providers can finish the recap.

Full Métis (overlay modes, Operator Mission Control, licenses, CRM, skills) stays the enterprise product. Lite is not a second codebase. It is a **scoped path and defaults story** inside AskToto-Mantu, sequenced **last after PCC** (R23) so Lite never ships ahead of the native/PCC cost path or as an unsigned / DEV-key escape hatch.

Name in copy: **Métis Lite**. Never "Mountain Lite". Intelligence surface remains **Mantu Intelligence** only.

---

## 2. Core loop (must feel inevitable)

```
Join / open meeting
        │
        ▼
   Listen (ASR)
        │  tell the room · rec-dot / listening orb
        ▼
   Stop / end
        │
        ▼
   Save transcript (encrypted when encryptTranscripts)
        │
        ▼
   End summary (recap)  ── optional API tier if no local path
        │
        ▼
   Enrich Mantu Intelligence  (.brain + wiki pages)
        │
        ▼
   Today / Connections / People show a real row or fail loud
```

| Step | Law | Fail loud |
| --- | --- | --- |
| Listen | Existing Listen + ASR pins (HIGH#4). Auto-start Join is Settings opt-in (`AUTO-START-MEETINGS.md`), not Lite-required. | No silent empty "them" channel; Screen Recording note when needed. |
| End summary | Same family as `INTELLIGENCE-UPDATE.md` recap: one background summary/base-tier call after save; bounded retries; keep trailing stream ≥200 chars. | Honest error if no provider and local cannot recap. Never a green empty Notes body. |
| Mantu Intelligence | Reuse `MANTU-INTELLIGENCE.md`: connect existing brain, meetings enrich, concrete Connections. | Empty shells rejected. No "Mountain Intelligence". |
| Optional API | Cloudflare / Operator-funded Ask path remains available. Lite happy path does not force Operator URL or fleet HMAC. | "Connected" means live session only. last4 only in UI. |

---

## 3. What Lite includes (FRAME)

| In | Out (enterprise / later / other slices) |
| --- | --- |
| Listen → Stop → save → end summary | Operator densify, Shoey PORT, license generate UI |
| Mantu Intelligence connect + enrich + Today/Connections read | CRM auto-send, Dust publish without consent |
| Optional API provider in Settings → AI (existing connect patterns) | Fat PR151 browser-connect scope creep; inventing a second CF login |
| Honest empty / error copy (no em dashes; never "as an AI") | Pack / Latest / notarized ship (blocked on Tony signing + pubkey.json) |
| Design-faithful overlay defaults (Hide) for the Listen session | Redesigning Hide/Island/Bar geometry in this letter |

---

## 4. Sequencing (HARD) — Tony lock R23

**Métis Lite stays LAST after Apple Private Cloud Compute (PCC).**  
Board R23: Native → PCC is the final step after stability, Operator keys/approval, CLI, and QA-stamped EXE/DMG/Native. Lite eng/UI/build must not start until that PCC gate is done.

```
Enterprise harden stamps (J + PR154 gates) …
Tony: pubkey.json + I signing / notarization …
QA-stamped EXE/DMG/Native …
Native Apple PCC seam live …
        │
        ▼
   K Métis Lite implementation (ONLY after PCC + this FRAME ACK)
```

- **Now:** this FRAME (DESIGN) only. Ultron ACK on path.
- **Not now / not until after PCC:** UI, eng build, new routes, pack, live D1, Aria.
- **Hold as design (from J):** unsigned macOS file keystore; license `sub:*` air-gap opt-in docs already under `docs/security/`.

---

## 5. Defaults (Lite-facing)

| Default | Value | Why |
| --- | --- | --- |
| Overlay chrome | Hide | Recedes until Listen intent. |
| End summary | On after save | Lite without a recap is a dictation app. |
| Intelligence enrich | On when a brain is connected | Meetings must feed Mantu Intelligence. |
| API | Optional | Local / already-configured provider preferred; API is power path. |
| Operator URL | empty until Tony points seats | No phone-home. |
| `encryptTranscripts` | true | Bank bar. |

---

## 6. Optional API (precise)

"Optional API" means:

1. User may connect a cloud provider (Cloudflare Worker proxy key path preferred; account-token shape forbidden — CRITICAL#1).
2. End summary **may** use that provider when local weights / CLI are unavailable.
3. Lite onboarding must not wall the user behind Operator Access or license generate.
4. If no provider can recap: fail loud with Settings → AI next action. Never invent a summary.

Non-goals: shipping plaintext Cahê keys (CLOSED on `8386d9d`); unpinned `cloudflareBaseUrl` (CLOSED on `8386d9d`).

---

## 7. QUALITY hats

| Hat | Ships only if | Rejects |
| --- | --- | --- |
| Product | Listen → end summary → Intelligence enrich is one obvious path | Requiring Operator Mission Control to finish a meeting |
| Craft | Summary and Intelligence rows look finished, Mantu-personalized | Skeleton cards, demo fixtures in production Intelligence |
| Trust | Save encrypted; enrich only into the connected brain; no silent CRM/Dust | Silent phone-home; fake "Connected" |
| Scope | Overlay Listen/Review/Brain + Settings AI only | Operator Worker redesign, pack, Aria |
| Evidence | Mac show: Listen 2 min → Stop → Notes body ≥ real summary → Intelligence Today/Connections updates | Screenshot of empty Notes + green check |

---

## 8. Acceptance (Ultron FRAME ACK)

1. This file exists at `docs/design/METIS-LITE.md` and Ultron ACKs FRAME.
2. No UI / product code in the docs-only land.
3. Explicit sequencing: implement **last after PCC** (R23); enterprise harden + signing are earlier gates only.
4. Loop locked: Listen → end summary → Mantu Intelligence + optional API.
5. No pack / merge / Latest / live D1 in K FRAME.

---

## 9. Implementation order (only after Ultron ACK + PCC / R23)

1. Docs-only commit of this FRAME (and a one-line pointer from `docs/design/DESIGN.md` Related).
2. Wire Lite happy-path checklist as QA evidence (no new chrome).
3. Tighten end-summary fail-loud + Intelligence enrich on save if gaps remain vs this FRAME.
4. Optional API copy/Settings affordance pass (no new OAuth product).
5. Mac show packet. READY TO MERGE no. No pack until Tony material + Ultron.

---

## 10. Related

- `docs/design/MANTU-INTELLIGENCE.md`
- `docs/design/INTELLIGENCE-UPDATE.md`
- `docs/design/METIS-PLATFORM-NORTH-STAR.md`
- `docs/design/AUTO-START-MEETINGS.md`
- `docs/design/DESIGN-SPEC.md` (Listen / Suggestions)
- `.rocket-fuel/METIS-BANK-GRADE-J-REVIEW.md` (J inventory; eng HIGH residuals closed on `8386d9d`)
- `docs/security/UNSIGNED-KEYSTORE-HOLD.md`
- `docs/security/SITE-LICENSE-SUB-WILDCARD.md`
