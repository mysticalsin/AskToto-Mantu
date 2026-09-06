---
project: Métis
type: product-frame
name: Native Apple Private Cloud Compute
letter: L
status: FRAME
ready-to-merge: no
audience: Tony Walteur · Ultron · Devon · RocketFuel
date: 2026-09-06
---

# Métis Native PCC — FRAME (L)

**DESIGN only. No PCC implementation in the change that lands this file.**  
**READY TO MERGE: no. No pack / EXE / DMG / Native / Latest from this letter.**  
**Off Aria. No live D1.**

Ultron L: PCC DESIGN while pack waits on Tony material and Lite (K/R23) stays last after this gate.

This file is the single FRAME for Apple **Private Cloud Compute** on Métis. It consolidates (does not replace) `METIS-PLATFORM-NORTH-STAR.md` §7, `APPLE-INTELLIGENCE-PLAN.md` §3, and `native-app/README.md`.

---

## 1. Intent

Native Métis Asks should eventually cost **~zero API dollars** on Apple silicon by using:

1. **On-device Foundation Models** (AFM / `SystemLanguageModel`) for everyday suggest / short summary.
2. **Private Cloud Compute** (`PrivateCloudComputeLanguageModel`, 27 SDK) for heavier summarize / deep-reason when on-device is too small.

PCC is why Native exists as a plane. Electron stays the Windows + cross-platform path and must **never** claim PCC.

Tony lock (memory + K/R23): **Native PCC is the final step** after stability, Operator keys/approval, CLI, and QA-stamped EXE/DMG/Native. **Métis Lite eng is LAST after PCC.**

---

## 2. Hard channel law

| Channel | PCC? | Why |
| --- | --- | --- |
| Notarized direct-download DMG / ZIP (Electron) | **No** | Production PCC requires App Store distribution + Swift surface + entitlement. |
| Electron MAS target | **Maybe** | App Store–distributed; Swift via N-API addon possible; entitlement grant to Electron MAS is **unknown — apply, do not assume**. |
| Native SwiftUI App Store app (`native-app/`) | **Yes (strategic)** | Clean eligibility; same FM API on iOS/iPadOS/macOS/visionOS. |
| Companion App Store app proxying into DMG | **Forbidden** | Quota / ToS risk. Off-limits. |

Entitlement: `com.apple.developer.private-cloud-compute` via [developer.apple.com/private-cloud-compute/](https://developer.apple.com/private-cloud-compute/). Small Business Program, <2M first-time downloads, no paid PCC tier.

Privacy copy: Apple states PCC user data is not stored or shared (stateless). Flag AFM Cloud Pro / Google Cloud NVIDIA path in any client confidentiality statement (secondary sources — do not overclaim).

---

## 3. The seam (design now)

One interface both products already almost share:

```
MeetingIntelligence
  availability: available | unavailable(reason)
  suggestStream / summarize / nextSteps
```

| Surface today | Path |
| --- | --- |
| Electron | `createStream` → `wrapEnterpriseStream`; Mac local via `fm serve` (`fm-runtime.ts`) → llama-server fallback |
| Native | `MetisKit` `FoundationModelsIntelligence` + `HeuristicIntelligence` (`Intelligence.swift`) |

### Named provider `apple-pcc` (native App Store only)

- Exists **only** in the native App Store target (or proven Electron MAS + entitlement — separate decision).
- Compiled behind `#if canImport` + entitlement.
- Routes heavier summarize / deep-reason (32k, reasoning levels) when on-device AFM is too small.
- Surfaces quota via `model.quotaUsage` as an **honest chip**, never fake `$0` / "unlimited".
- **Never** appears in the Electron renderer as a toggle that does nothing.

Electron Mac: keep `fm serve` / llama. Windows: llama + Parakeet. Do not promise PCC on the DMG.

---

## 4. Cost story

| Path | Who pays |
| --- | --- |
| Claude / Codex CLI | User subscription |
| Operator vault / CF proxy | Tony after APPROVAL |
| Métis Local / on-device AFM | Electricity |
| Native PCC | ~zero API cost, Apple quota |

Goal of L: Metis Asks on Apple devices need **no paid API keys** when FM/PCC availability is real.

---

## 5. Sequencing (HARD)

```
Enterprise harden (J + PR154 gates) …
Tony pubkey.json + I signing …
QA-stamped EXE / DMG / Native …
        │
        ▼
   L PCC implementation (Native App Store + entitlement)
        │
        ▼
   K Métis Lite eng (R23 LAST after PCC)
```

| Now (this FRAME) | Not now |
| --- | --- |
| Docs only; Ultron ACK | Implementing `PrivateCloudComputeLanguageModel` |
| Entitlement application (Tony / ops — free, non-binding) | Electron Settings "PCC" row |
| Keep `Intelligence.swift` comment as the stub | Proxy companion app into DMG |
| | Pack / Latest from this letter |

---

## 6. QUALITY hats

| Hat | Ships only if | Rejects |
| --- | --- | --- |
| Product | Native Ask works on-device first; PCC is the heavy tier | Requiring paid cloud keys on Apple when FM is available |
| Trust | Honest availability + quota chip | Silent cloud spend; fake Connected |
| Scope | Native tree (+ proven MAS path only if entitlement lands) | Electron DMG claiming PCC |
| Evidence | Native Mac/iOS show: FM summarize; PCC path compiled behind 27 SDK gate with entitlement | Screenshot of Electron toggle labeled PCC |

---

## 7. Acceptance (Ultron FRAME ACK)

1. This file at `docs/design/METIS-PCC.md` + DESIGN.md pointer.
2. Channel law explicit: no PCC on notarized Electron DMG; no companion proxy.
3. Seam `apple-pcc` defined; no UI/code in this land.
4. Sequencing: after QA-stamped Native; **before** Métis Lite eng (R23).
5. No pack / merge / Latest.

---

## 8. Implementation order (only after Ultron ACK + prior gates)

1. Docs-only land of this FRAME.
2. Tony: confirm/submit PCC entitlement if not already filed.
3. Native: on-device FM path solid (already sketched in MetisKit).
4. Native 27 SDK: `apple-pcc` behind entitlement; quota chip; tests.
5. Optional: Electron MAS experiment only if entitlement formally allows it — separate packet.
6. Then and only then: K Métis Lite eng.

Until then the comment in `Intelligence.swift` **is** the implementation.

---

## 9. Related

- `docs/design/METIS-PLATFORM-NORTH-STAR.md` §7 (R21 seam)
- `docs/APPLE-INTELLIGENCE-PLAN.md` §3
- `native-app/README.md` + `MetisKit/.../Intelligence.swift`
- `docs/PROVIDER-ROUTING-POLICY.md`
- `docs/design/METIS-LITE.md` (K — LAST after this gate)
