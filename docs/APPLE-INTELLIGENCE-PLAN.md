# Métis × Apple Intelligence — Dual-Platform Integration Plan

**Date:** 2026-07-16 · **Status:** Phase 1 IMPLEMENTED (see §0); live E2E pending Apple Intelligence enablement on the dev machine

---

## 0. Implementation status (2026-07-16)

**Shipped in working tree — Apple engine behind the `local` provider:**
- `src/main/llm/fm-runtime.ts` — lifecycle manager for Apple's preinstalled `fm serve` (macOS 27+): free-port spawn, /health poll, 15-min idle-stop, crash budget (2/10min → session fallback), TTL-cached `fm available` probe. `fm serve` verified REAL on this machine (OpenAI-compatible `/v1/chat/completions`, `/v1/models`, `/health`; models `system` + `pcc`) — the plan's §7 "unverified" flag on `fm serve` is resolved.
- `src/main/llm/local.ts` — engine dispatch: text modes (suggest/summary) auto-route to the Apple engine when live; vision stays on llama-server mmproj until fm image input is E2E-proven; every failure path (wrong OS, no binary, Apple Intelligence off, crash budget, `METIS_DISABLE_APPLE_FM=1`, fm start failure) falls back losslessly to llama-server. Windows/macOS-26 behavior byte-identical.
- `src/main/index.ts` — engine-aware prewarm + `fm serve` teardown on will-quit.
- Tests: `fm-runtime.test.ts` (incl. self-skipping real-binary integration test that activates once Apple Intelligence is on) + `local.engine.test.ts` (dispatch contract). Full suite 1434/1434 green; `tsc` clean both configs.
- No UI, no settings schema, no packaging changes; zero new shipped bytes. Routing/privacy/allowlist contracts untouched.

**Blocked on user action:** Apple Intelligence toggle (System Settings → Apple Intelligence & Siri). `fm available` currently reports `appleIntelligenceNotEnabled`. Once enabled: the fm-runtime integration test runs live, and the Phase-0 bench script (scratchpad `bench-fm-vs-llama.mjs`) measures TTFT/total vs llama-server on Métis-shaped suggest/summary prompts.

**Phase 2 shipped in working tree — Vision OCR + native mac frontmost watcher (no toggle needed, macOS 26+):**
- `native/mac-helper/main.swift` → `metis-mac-helper` Swift sidecar (105 KB, zero dependencies), two commands, both live-verified on this machine:
  - `watch-frontmost` — NSWorkspace app-activation events as the SAME `windowId\tpid\ttitle` TSV the Windows PowerShell watcher emits (verified: Métis → Finder → System Settings events). App-level granularity by design (no Accessibility permission); intra-app changes stay covered by the 6s content re-check.
  - `ocr -` — Vision `VNRecognizeTextRequest` (accurate) over stdin image → JSON lines with confidence + boxes (verified: 191 lines off a real 3600×2338 screenshot).
- `src/main/mac-helper.ts` — spawn wrappers + pure `buildOcrContext` (reading-order sort, confidence filter, 1.5k cap, text-poor → null).
- `src/main/foreground-watcher.ts` — darwin producer via the helper; parsing/dedupe/restart-budget shared with the Windows path. Helper missing → inert handle (pre-helper behavior).
- `src/main/screen-preprocess.ts` — OCR-first hybrid on mac: Vision extract (no model inference, no llama spin-up) when the screen has text; VLM caption fallback otherwise. Windows path byte-identical.
- Packaging: `scripts/build-mac-helper.mjs` (incremental swiftc) + `scripts/check-mac-helper.mjs` guard wired into predist/dist:local/release:build:mac/release:mas; `resources/mac-helper` in mac extraResources (mas inherits); binary gitignored; contract test locks all of it.
- Suite: 1454/1455 (one unrelated brain-test temp-dir flake, passes in isolation), tsc clean.

**mac screen-context now:** event-driven trigger (was: none — 6s timer only) + structured OCR context (was: VLM caption only). Latency: OCR replaces a ~360-550ms VLM describe with a sub-second no-inference extract and frees llama-server entirely on text screens.
**Scope rule:** one source tree. macOS gains the Apple AI stack; Windows (Cahê edition) keeps the existing llama-server + Parakeet stack unchanged. Every capability below lists both platform paths.

Research provenance: two adversarially-verified deep-research runs (201 agents, 3-vote refutation per claim, Apple primary sources) + full codebase map. Claims are marked **verified** (survived verification against Apple docs/WWDC sessions), **assumed** (sound inference, not Apple-stated), or **unknown**.

---

## 1. Executive summary

Apple now gives third-party developers four AI surfaces relevant to Métis:

1. **Foundation Models framework** (macOS 26 GA) — free on-device ~3B model ("AFM 3 Core"), Swift API, streaming, structured output, tool calling. **WWDC 26 added image input** (Attachment API, macOS 27 beta). Zero bundled weights, zero API cost, OS-managed model updates.
2. **Private Cloud Compute for developers** (macOS/iOS 27 beta) — Apple's server model (`PrivateCloudComputeLanguageModel`), 32k context, reasoning levels, **free but heavily gated** (see §3 — the gate excludes our direct-download Electron build).
3. **Vision framework `RecognizeDocumentsRequest`** (macOS 26 GA) — structured on-device document/screen understanding (paragraphs, tables, lists) on arbitrary images. Usable **today**.
4. **`fm` CLI** (preinstalled on macOS 27) — command-line access to on-device + PCC models, structured output, image input. Spawnable from Electron via `child_process` with **zero native code** — our fastest prototype path.

**Immediate wins for Métis on macOS:** delete the 760 MB bundled Qwen weights + 8 GB RAM floor from the mac build, replace llama-server captions with native OCR+VLM screen understanding, fix the missing macOS frontmost-window trigger, and add semantic recall. Windows behavior unchanged.

**PCC "free for everyone" verdict:** real, but production use is **App-Store-distributed apps only** — the direct-download Electron build cannot use it. Path exists via our MAS target or a future native app (§3).

---

## 2. What Apple shipped — verified matrix (July 2026)

| Surface | Min OS | Status | Cost | Gating |
|---|---|---|---|---|
| Foundation Models framework (on-device text, `SystemLanguageModel`) | macOS 26.0 | GA | Free | None beyond Apple Intelligence-capable device |
| On-device **image input** (Attachment API: NSImage/CGImage/CVPixelBuffer/file URLs; Vision OCR tools callable by model) | macOS 27.0 | **Beta** (GA ~fall 2026) | Free | Hardware reqs unpublished (**unknown**) |
| `PrivateCloudComputeLanguageModel` (32k ctx, reasoning .light/.moderate/.deep) | macOS 27.0 | **Beta** | Free to dev; per-user daily quota via user's iCloud (iCloud+ raises it); `model.quotaUsage` API | Managed entitlement + Small Business Program + <2M downloads + **App Store distribution** |
| `LanguageModel` provider protocol (Claude/Gemini Swift packages announced) | macOS 27.0 | Beta; packages "**coming soon**" — may not have shipped | Per-token (provider-billed) | Developer's own keys |
| Vision `RecognizeDocumentsRequest` (structured OCR: text/tables/lists/barcodes) | macOS 26.0 | **GA** | Free | None |
| `fm` CLI (on-device + `--model pcc`, schemas, images, pipeable) | macOS 27.0 | Beta, preinstalled | Free | PCC quota attribution when spawned by us: **unknown** |
| Python SDK (`apple-fm-sdk`, on-device only) | macOS 26.0 | Shipped | Free | Dev tooling (Xcode 26+) |
| Visual Intelligence on Mac | macOS 27.0 | Beta | — | **Not a screen-reading API** — inbound App Intents integration only; apps surface their own content |
| AFM 3 model family (2026-06-08, built with Google): on-device Core (3B) + Core Advanced (20B sparse); PCC Cloud / Cloud (Image) / Cloud Pro (NVIDIA on Google Cloud) | — | Announced | — | Which model backs the dev-facing PCC API: **unknown** |

**Refuted by verification (do not build on these):** on-device audio multimodality; a REST/API-key surface for PCC; tvOS support. **No direct "new Siri LLM" API exists** — only Siri-adjacent surfaces (App Intents, View Annotations, Visual Intelligence).

---

## 3. PCC verdict for Métis

**Verified:** production PCC use is restricted to **App Store-distributed apps** (TestFlight/ad-hoc for testing only), Swift-only surface, entitlement `com.apple.developer.private-cloud-compute` granted by application (developer.apple.com/private-cloud-compute/), Small Business Program enrollment, <2M lifetime first-time downloads, forced 6-month migration if you outgrow eligibility, no paid tier.

**Consequence (assumed, entailed by Apple's channel enumeration):** the notarized direct-download Métis dmg/zip **cannot ship PCC**. Three viable paths, in order of realism:

1. **MAS build + in-process native addon.** `electron-builder.yml` already has a `mas` target. A MAS-distributed Electron app *is* App Store-distributed; the Swift surface can be satisfied by an N-API addon linking FoundationModels (sandbox forbids spawned sidecars, allows linked frameworks). Whether Apple grants the entitlement to an Electron MAS app: **unknown — apply and find out; the form is live today.**
2. **Native Apple app (the "app on all Apple devices" goal).** Foundation Models is the same API on iOS/iPadOS/macOS/visionOS. A SwiftUI Métis client gets on-device + PCC everywhere, cleanly eligible (App Store distribution is mandatory on iOS anyway). This is the strategic path if the product goal is every Apple device.
3. **Do not** proxy PCC through a companion App Store app into the non-App-Store build — quota attribution and ToS risk; treat as off-limits.

**Enterprise privacy posture (verified):** Apple states PCC user data "is never stored or shared with anyone, including Apple" (stateless computation). Note AFM 3 Cloud Pro runs on NVIDIA GPUs in Google Cloud under extended PCC guarantees (secondary sources) — flag in any client-facing confidentiality statement.

**Action now:** submit the entitlement request (free, non-binding) so the approval clock runs while we build Phase 1.

---

## 4. Target architecture — one source tree

New provider kind `apple` + one Swift helper, gated behind `process.platform === 'darwin'`. Windows code paths untouched.

```
src/main/llm.ts                 + case 'apple' → streamApple()
src/main/llm/apple.ts           new strategy (mirrors local.ts shim)
src/main/apple/afm-runtime.ts   lifecycle for Swift helper (mirrors local-runtime.ts)
native/metis-apple-ai/          Swift package → single sidecar binary:
                                  /v1/chat/completions  (FoundationModels, text now, +image on 27)
                                  /ocr                  (Vision RecognizeDocumentsRequest)
                                  /frontmost            (SSE: NSWorkspace app-activation events)
resources → mac-only extraResources (like resources/llama/mac today)
MAS build → same Swift code compiled as N-API addon (in-process; sandbox-safe)
```

- **Direct build (dmg/zip):** sidecar over loopback HTTP — drops into the exact `local-runtime.ts` pattern (ephemeral port, env-injected session key, health poll, idle-stop). Auto-signed by hardenedRuntime like llama-server today.
- **Availability contract:** `local-ai.ts` already anticipates this (`backend: 'metal'`, `unavailableReason: 'unsupported-platform'`). Runtime reports unavailable on win32 and on macOS < 26; routing falls back per platform in `pickPrimaryProvider` — zero renderer changes.
- **Runtime catalog:** add an `"apple-foundation-models"` entry to `resources/local-ai/payload/manifest.json` (the `runtime` field was designed for this).
- **Org policy:** add `'apple'` to `ProviderId` and thread through `getAllowedProviders()`.

---

## 5. Capability-by-capability plan (both platforms, same source)

### 5.1 Local LLM — suggest / summary / private answers
| | macOS (new) | Windows (unchanged) |
|---|---|---|
| Engine | Apple on-device AFM 3 Core via `apple` provider (Swift helper) | llama-server sidecar, Qwen3.5-0.8B GGUF |
| Weights shipped | **0 MB** (OS-managed) | 763 MB (gguf + mmproj) |
| RAM floor | OS-managed | 8 GB |
| Context | 4k (macOS 26) / 8k (macOS 27, newer hw) | 2×32k slots |
| Quality | 3B-class, better instruction-following + tool calling (WWDC 26 rebuild) | Qwen3.5-0.8B |
| Fallback | macOS < 26 or non-Apple-Intelligence hw → existing llama-server path stays in mac build as fallback | — |

Note the context-window trade-off: 4k/8k on-device vs llama-server's 32k slots. `LOCAL_OUTPUT_TOKEN_BUDGETS` (96/512/384) and screen-context blocks fit comfortably; long-transcript summary may still need the cloud tier or chunking — measure in Phase 1.

### 5.2 Screen understanding (`screen-preprocess.ts`)
| | macOS (new) | Windows (unchanged) |
|---|---|---|
| Trigger | **Fix the gap:** native `NSWorkspace.didActivateApplication` via helper `/frontmost` SSE (today mac has no trigger — 6 s timer only) | PowerShell `GetForegroundWindow` watcher |
| Understanding | Two-stage: Vision `RecognizeDocumentsRequest` structured OCR (macOS 26, GA, fast) → AFM caption/reasoning; single multimodal call on macOS 27 (Attachment API) | JPEG → llama-server mmproj caption |
| Consumers | Same `currentFreshContext()` cache + `ask:start` injection — no renderer change | Same |

Biggest mac latency/quality win in the plan: event-driven triggers + structured OCR beats a 2-4-sentence VLM caption for "what's on screen".

### 5.3 Vision ask (`mode:'vision'`, screenshot Q&A)
| | macOS (new) | Windows (unchanged) |
|---|---|---|
| Private path | AFM image input (macOS 27) through the already-scaffolded `visionEvidence` contract — its `capabilities: ['caption','text','ocr','regions']` and `regions[].box` map 1:1 onto Vision/AFM output | Qwen mmproj (local) |
| Non-private path | Cloud providers (unchanged) | Cloud providers (unchanged) |

### 5.4 Recall / semantic memory (`recall.ts` — today keyword-only, both platforms)
| | macOS | Windows |
|---|---|---|
| Recommended | **One cross-platform ONNX embedder** (small int8 model via already-bundled `resources/ort`) so the vector index format is identical on both platforms | Same |
| Apple-native option | `NLContextualEmbedding` (zero shipped weights) — but produces mac-only vectors → per-platform index; take only if ONNX footprint unacceptable | n/a |

This is greenfield (no embeddings exist anywhere in the codebase) and platform-symmetric — treat as its own workstream.

### 5.5 ASR
| | macOS (optional, later) | Windows (unchanged) |
|---|---|---|
| Engine | Add `'apple'` to `asrEngine` enum; `apple-speech.ts` mirroring `parakeet.ts` (SFSpeechRecognizer/Speech framework) — saves ~200 MB bundled ONNX on mac | Parakeet (sherpa-onnx) default, Whisper fallback |

Low priority — Parakeet works well. Structural cost is small because the engine seam exists.

### 5.6 Big-model tier (PCC)
| | macOS | Windows |
|---|---|---|
| Today | Cloud providers (Kimi/Claude/GPT/Dust) | Same |
| Future | PCC 32k + reasoning via MAS build or native app (§3), pending entitlement | Cloud providers remain the equivalent tier |

---

## 6. Phased roadmap

**Phase 0 — prototype this week (zero native code).** On this machine (macOS 27 beta): spawn `fm` CLI from a scratch script; benchmark suggest/summary/vision prompts vs llama-server on real Métis workloads (latency, quality, context limits). Submit the PCC entitlement request in parallel. *Exit: measured numbers, go/no-go on quality.*

**Phase 1 — `apple` text provider (macOS 26+ users).** Swift helper `/v1/chat/completions` (on-device text) + `apple.ts` strategy + routing/availability gates + mac extraResources packaging. llama-server stays as mac fallback. *Exit: suggest/summary served by AFM on mac; Windows build byte-identical behavior; full test suite green on both.*

**Phase 2 — screen understanding (macOS 26+).** `/ocr` (RecognizeDocumentsRequest) + `/frontmost` (NSWorkspace) endpoints; rewire `describeOnce` and `foreground-watcher` mac path. *Exit: event-driven mac screen context, measured describe latency < current.*

**Phase 3 — multimodal (macOS 27).** Attachment-API image input for vision mode + single-call screen understanding; fill the `visionEvidence` scaffold. Ship when macOS 27 GA lands (~fall 2026).

**Phase 4 — semantic recall (both platforms).** ONNX embedder + vector index over saved meeting markdown; upgrade `searchMeetings` + Receipt-Mode grounding.

**Phase 5 — PCC / all-Apple-devices (strategic).** If entitlement granted for MAS build → PCC tier in MAS Métis. Decision point for native SwiftUI client (iPhone/iPad/Vision Pro) — separate product plan.

---

## 7. Risks & open questions

- **macOS 27 is beta** — Attachment API, PCC, `fm` CLI, provider protocol could change before fall GA. Phase 1–2 rest only on macOS 26 GA APIs; safe.
- **PCC entitlement for Electron/MAS: unknown.** Apply early; assume "no" in planning.
- **On-device image-input hardware requirements: unpublished.** Secondary sources hint at higher-end-device gating. Runtime capability probe + fallback required.
- **`fm serve` OpenAI-compatible server: unverified** (secondary blogs only). Do not architect around it; our own Swift helper provides that surface.
- **Anthropic/Google Swift packages: announced, may not have shipped.** Irrelevant to Métis near-term (we call those APIs directly).
- **4k/8k on-device context** vs 32k llama slots — measure real prompt sizes in Phase 0; keep llama fallback until proven.
- **No audio multimodality on-device** (claim refuted) — transcription stays Parakeet/Whisper/Apple Speech.
- **Numeric PCC quotas: unpublished.** `quotaUsage` API exists; design UX around limit-reached states.

## 8. Sources (primary)

- WWDC26 session 241 — What's new in the Foundation Models framework
- WWDC26 session 319 — Build with the new Apple Foundation Model on Private Cloud Compute
- WWDC26 session 339 — Bring an LLM provider to the Foundation Models framework
- developer.apple.com/documentation/FoundationModels (incl. "Adding server-side intelligence with Private Cloud Compute")
- developer.apple.com/private-cloud-compute/ · developer.apple.com/wwdc26/guides/apple-intelligence/
- Apple Newsroom 2026-06-08 — third-generation Apple Foundation Models (AFM 3)
- Vision framework: RecognizeDocumentsRequest (macOS 26 GA)
