# Métis Packaged Local AI Design

Date: 2026-07-10

Status: **Superseded on 2026-07-13. Do not implement this document.** The shipped architecture keeps
the release branch's external llama.cpp `llama-server` sidecar and bundles one Qwen3.5 0.8B GGUF plus
multimodal projector. Current sources of truth are `src/main/llm/local-runtime.ts`,
`src/main/llm/local-models.ts`, `scripts/local-model-assets.mjs`, and `electron-builder.yml`.

The remainder is retained only as the historical design that proposed `node-llama-cpp` and separate
Transformers.js vision candidates. It is not an active release specification.

Historical scope: macOS Apple Silicon (`arm64`) DMG/ZIP and Windows (`x64`) NSIS installer

## Outcome

Métis gains a fully offline local inference tier for fast meeting work and screenshot understanding. The installed application must never fetch a model, tokenizer, runtime, or native binary. Build jobs may provision reviewed assets into `resources/`, but packaging fails if any required file or hash is missing.

The local tier handles:

- English and French cleanup, titles, labels, short summaries, suggestions, and simple grounded Q&A.
- Low-latency meeting suggestions over a growing transcript.
- Screenshot captioning and OCR-like extraction for UI, slides, and documents.
- Read-only, cited Mantu Intelligence drafts grounded in the existing brain store.

Cloud and Dust providers remain available for explicit think/deep requests. A local failure never silently uploads a transcript or screenshot.

## Research decision

### Rejected core: TheStageAI `edge-lm`

`edge-lm` is an early Python 3.10+/MLX loader for TheStageAI compressed Gemma 4 checkpoints. It has no Node binding or Windows backend, and its GGUF links are consumed by llama.cpp rather than `edge-lm`. It is unsuitable as the shared Métis runtime.

### Text model candidates: Qwen3-1.7B and Qwen3-0.6B

Qwen3-1.7B is the quality candidate because it has Apache 2.0 weights, first-party llama.cpp support, English/French coverage, and a more mature cross-platform path than Qwen3.5. The official Qwen GGUF repository publishes only a 1,834,426,016-byte Q8 file. The compact files are third-party Unsloth conversions pinned at revision `d7f544eead698dbd1f15126ef60b45a1e1933222`:

- `Qwen3-1.7B-Q4_K_M.gguf`: 1,107,409,472 bytes, SHA-256 `b139949c5bd74937ad8ed8c8cf3d9ffb1e99c866c823204dc42c0d91fa181897`.
- `Qwen3-1.7B-IQ4_XS.gguf`: 1,010,383,424 bytes, SHA-256 `a02e41d3208e97a7cb224297e8d3abb22e5bb8d664362c6be4f48948a3797eec`.

The conversion repository declares the Qwen base model and Apache 2.0 but does not document its exact upstream revision, llama.cpp revision, or conversion command. Either 1.7B compact file therefore requires a recorded provenance exception plus the frozen evaluation.

Qwen3-0.6B is the provenance/size challenger. Its official Q8 is 639,446,688 bytes at revision `23749fefcc72300e3a2ad315e1317431b06b590a`; smaller Q4/IQ4 conversions have the same provenance limitation as the 1.7B compact files. The selected artifact must beat the baseline, pass French/citation/Intelligence gates, and keep every installer below 1.9 GiB. Exactly one text model ships.

### Vision model candidates: SmolVLM and Florence-2

`HuggingFaceTB/SmolVLM-256M-Instruct` Q8 is the size/provenance candidate. It is an upstream Apache 2.0 model with a Transformers.js v3 example and a 263,451,342-byte model/metadata/license payload before the existing ORT sidecars. It produces captions, visual answers, and semantic text transcription, but not Florence-style regions or boxes; its published language metadata is English, so French screenshots are a blocking test rather than an assumed capability.

Florence-2-base-ft is the structured-OCR candidate because it supports captioning, OCR, region OCR, and grounding. A single all-Q4 set is 333,249,173 bytes before metadata/ORT, but correct, fast operation across both WebGPU and WASM is unverified. The proven WebGPU-q4f16 plus WASM-q8 combination is about 523 MB including metadata, license, and ORT, which puts the installer gate at high risk.

The vision worker returns the selected model's bounded structured evidence. Qwen receives that evidence as untrusted data and answers the user's question. SmolVLM Q8 and Florence Q4 run against the same fixed EN/FR screenshot set on native macOS and Windows. Exactly one vision model ships; unsupported capabilities are not simulated.

### Runtime split

- Text: `node-llama-cpp` runs in a lifecycle-owned packaged Node worker launched with the same signed Electron executable and `ELECTRON_RUN_AS_NODE=1`. This is not a renderer, utility process, daemon, or HTTP server. It resolves only bundled resources and communicates with the bytecode-protected main process through typed child-process IPC. The split is necessary because electron-vite bytecode supports CommonJS only while node-llama-cpp 3.19 is external ESM and must not be bundled. Calls use a serial scheduler, RAM/VRAM caps, parent-death cleanup, and process-tree monitoring.
- Vision: Transformers.js in a dedicated renderer Web Worker, using only backends verified for the selected model and the single `metis-resource://` protocol with a hashed allowlist.
- The Node-worker path is a hard packaged spike on both target systems. If it fails, the explicit fallback is to remove main bytecode and convert the main bundle to ESM before loading node-llama there. An undocumented Electron utility process is not a fallback.

## Supported platform matrix

| Target | Required runtime | Required proof |
|---|---|---|
| macOS Apple Silicon arm64 | node-llama-cpp Metal package, Transformers.js WebGPU/WASM | Native macOS package, hash verification, text and screenshot smoke, signed/notarized release proof |
| Windows x64 | node-llama-cpp CPU plus Vulkan packages, Transformers.js WebGPU/WASM | Native Windows package, CPU fallback smoke, Vulkan smoke when present, signed NSIS proof |

Intel Mac, Windows ARM, Linux, MAS distribution, and portable Windows packaging are outside the initial target matrix. They require separate native builds and performance evidence. The NSIS setup EXE is the supported Windows application package.

## Architecture

### 1. Packaged asset supply chain

`resources/local-ai/candidates.json` is the reviewed catalog for new text/vision candidates. Staging writes a selected-only runtime `manifest.json`; existing ASR/ORT and FFmpeg keep complete hashed manifests that the aggregate release gate checks together. Each asset entry contains:

- logical model and component name;
- immutable source repository and revision;
- relative destination path;
- exact byte size and SHA-256;
- upstream and conversion license;
- runtime and precision;
- platform scope.

`scripts/fetch-local-ai.mjs` performs resumable build-time provisioning into `.part` files, validates size and SHA-256 before rename, and never accepts `main` as an unpinned revision. Existing files are rehashed rather than accepted because they are non-empty.

`scripts/stage-local-ai.mjs` recreates a selected-only payload containing exactly one text and one vision variant plus licenses/provenance. Candidate downloads and `.part` files stay outside this payload. Electron-builder packages only the staged payload.

`scripts/check-local-ai.mjs` is a no-network packaging gate. It validates the complete manifest, selected-only payload, platform-native node-llama packages, license notices, and selected quant. An aggregate asset gate also verifies the hashed ASR, ORT, FFmpeg, and native runtime manifests. `predist`, `predist:win`, release builds, and CI call it before electron-builder.

Packaged runtime paths are absolute paths below `process.resourcesPath`. Production code never calls `resolveModelFile()` with an `hf:` URI. `getLlama()` uses build/download disabled behavior. Transformers.js sets `allowRemoteModels=false`, `allowLocalModels=true`, and local WASM/model paths before loading the selected vision model. There is no packaged-mode retry to a remote model.

### 2. Local text service

Create a focused `src/main/local-ai/` boundary:

- `manifest.ts`: parse and resolve the packaged manifest.
- `worker-controller.ts` and `worker-client.ts`: lifecycle, typed child IPC, cancellation, crash recovery, and cleanup.
- `scheduler.ts`: priority queue and resource governor.
- `transcript-context.ts`: append/resync revisions, deterministic formatting/compaction, and cached candidates.
- `prompts.ts`: versioned local task prompts and employment-safety rules.
- `service.ts`: adapts local generation to the existing `StreamOptions -> StreamHandle` contract.
- `types.ts`: typed status, metrics, task, citation, and error contracts.

`src/local-ai-worker/` contains the ESM-only node-llama native runtime and warm sequence. It has no renderer/Electron APIs, network listener, settings access, or independent persistence.

Local execution is a separate branch before the existing provider waterfall. It is not added as a `ProviderId`: that abstraction assumes credentials, managed allowlists, cloud model IDs, and provider settings. Local is eligible only for base-tier `suggest`, `summary`, and ordinary `answer` requests when the manifest and runtime are ready. Fact-check, recap, think/deep, and explicit provider/agent overrides remain on their existing paths. A local screenshot ask is first converted by the packaged vision worker into bounded evidence; the renderer then sends that evidence without the raw image to the local text branch. Raw image requests remain provider-only.

The renderer uses `assistantReady = localAiReady || providerReady` for base assistant availability and keeps `providerReady` for cloud-only operations. Stream metadata carries `executor: 'local' | 'provider'`, so the interface can display `Métis on-device` without pretending a local model is the selected cloud provider.

### 3. Continuous transcript inference

Each active meeting owns one warm text sequence. Only stable transcript-line deltas are accepted. The worker retokenizes the canonical full formatted prefix, preserves the common BPE-token prefix, and evaluates only the missing token tail; it never assumes separately tokenizing the latest text is join-safe. The initial defaults, which remain benchmark-gated, are:

- debounce after 1.2 seconds of stable speech;
- append after at least 32 new tokens or a maximum 8-second wait;
- one generation job at a time;
- cancel a generation when a newer transcript revision supersedes it;
- 4,096-token live context target;
- compact older content into a cited running summary while keeping a verbatim recent tail;
- precompute `suggest` and `summary` sequentially from one base revision, and warm the shared answer prefix without inventing a question;
- cache by model hash, prompt version, transcript revision, task, and image hash;
- return the newest valid candidate immediately with a visible freshness label, then refresh in the background.

The scheduler pauses or cancels background generation when ASR lag exceeds its threshold, the main event loop stalls, the app is not actively listening, or memory caps are approached. Proactive work is off on battery by default unless the user opts in.

### 4. Screenshot pipeline

The existing main-owned screenshot capture remains authoritative. It already downsizes to a 1,280-pixel edge and records capture freshness.

The local vision path is:

1. Main captures the JPEG and supplies `capturedAt`.
2. The local vision worker validates the payload and runs the selected model's supported caption/text tasks.
3. The worker returns bounded structured evidence, not free-form commands.
4. The local text service receives the evidence with the existing screenshot-untrusted guard.
5. The renderer shows the capture freshness, local model identity, and whether OCR/caption evidence was used.

Screenshots and OCR output are transient by default. They are not added to telemetry or the brain store. Cache entries are memory-only and keyed by image hash.

### 5. Mantu Intelligence

Mantu Intelligence remains a sandboxed BrowserWindow and becomes actually read-only: its current mutating `backfill()` preload capability is removed, while backfill stays available only from the main overlay. Analysis adds no write capability and no second data store.

A narrow `brain:analyze` IPC accepts only a validated intent and identifiers:

- `briefing`
- `account-summary`
- `deal-summary`
- `meeting-summary`
- `question`

The request carries only a versioned task, a typed brain/account/deal/meeting scope, an optional 500-character question, and `en` or `fr`. Main loads the authoritative brain data, retrieves a bounded evidence set, and returns a versioned status, disclosure, bounded answer, evidence-linked points, an allowlisted evidence table, immutable model identity, and timing. The renderer cannot submit replacement brain facts. Deterministic dashboard calculations remain deterministic; the model may draft prose and questions but may not invent money, win probability, performance scores, or deal outcomes.

Brain entities may locate candidate meetings, but factual evidence is re-read from decrypted original transcripts. Every quote is normalized-substring-validated against a file/line range, and evidence IDs hash the file, offset, and content. Derived extraction claims are labelled derived rather than verbatim. Every factual paragraph includes allowlisted source meeting identifiers. Missing evidence produces an explicit "not found in your meeting record" result.

Meeting ingestion preserves non-model `source_mode` and `source_use` fields. Only the allowlisted built-in business modes are eligible; interview is employment, and every custom/unrecognized/legacy mode is unknown until explicitly classified. Employment and unknown records are ineligible for Intelligence analysis. A deterministic preflight blocks employment scoring, ranking, shortlisting, hiring/firing, promotion, performance evaluation, and emotion inference in English and French before model loading. A post-generation validator rejects prohibited output shapes as a second barrier.

### 6. Security and privacy

- No runtime model downloads or external daemon.
- No raw transcript, screenshot, OCR, prompt, or answer telemetry.
- Audit events contain model hash/version, task, latency, token counts, memory, backend, cancellation, and error class only.
- Local model files are verified before first use in each app session.
- Requests and IPC payloads use Zod size limits and enums.
- Only one local generation runs at once.
- Repeated runtime crashes open a visible local-AI unavailable state. The UI may offer an explicit cloud action, but it never switches providers by itself.
- Private View blocks screenshot inference as it blocks capture today.
- Prompt injection text from transcripts, screenshots, and brain records is always treated as data.

## AI Act and human oversight record

This is an engineering classification input, not a legal verdict.

- Assumed Mantu role: provider and internal deployer. Legal must confirm.
- Provisional class for meeting assistance: Limited Risk, with Article 50 user disclosure.
- Employment trigger: interview use can become Annex III employment high-risk if the system evaluates, scores, ranks, recommends, or materially influences candidate decisions.
- Product restriction: no candidate scoring, ranking, emotion inference, hire/no-hire recommendation, performance evaluation, or automated decision.
- Human oversight: every output is an editable draft and never writes a decision field.
- Deployment near hiring remains blocked until Legal, DPO, and AI Compliance confirm the intended-purpose classification.
- UI disclosure: "Local AI draft" is visible with the answer within two seconds.

## Required LLM engineering artifacts

The production feature ships with four versioned artifacts under `eval/local-ai/`:

1. `test-set.v1.jsonl`: 100 frozen examples, 40 happy path, 30 edge, 20 historical-failure, and 10 adversarial. At least 40 examples are French or mixed EN/FR. Screenshot cases contain synthetic or redistributable fixtures only.
2. `baseline.mjs`: deterministic extractive summary, keyword classification, first-line title, lexical brain retrieval, and OCR passthrough.
3. `harness.mjs`: per-example and aggregate scoring with cached model output, prompt/model/test-set hashes, latency, memory, format, faithfulness, citation validity, and prior-run diff.
4. `budget.json`: local cost $0 per call; model payload, installer, TTFT, decode, vision, RSS, ASR regression, and event-loop budgets.

No LLM judge is required for the blocking v1 metrics. Deterministic checks and human-labelled rubrics prevent a cloud dependency in the offline gate. A calibrated judge may be added as a non-blocking secondary score.

## Ship gates

All gates apply to packaged applications, not development mode:

- Text quality: at least 85% rubric pass and a positive delta over baseline.
- Citation safety: zero fabricated citation identifiers.
- Structured output: at least 99% schema-valid outputs after bounded repair.
- Warm text latency on the named reference hardware: TTFT <= 1.5 seconds p50 and <= 3 seconds p95; decode >= 15 tokens/second.
- Vision: at least 90% usable extraction on 50 EN/FR screenshots; <= 4 seconds p95.
- Resource use: whole Electron process-tree physical memory <= 4 GB during a workload-equivalent 60-minute meeting; zero OOMs in 20 isolated runs.
- Responsiveness: no main event-loop stall over 50 ms attributable to local generation.
- ASR: under 10% latency regression and no sustained transcript backlog.
- Installer: each DMG, ZIP, and EXE below 1.9 GiB.
- Offline: packaged smoke proves zero model-network access.
- Integrity: a one-byte model mutation makes the packaged smoke fail before inference.
- Platform: macOS arm64 and Windows x64 native runners both load models, run fixed text/vision fixtures, and close cleanly.
- Identity: product remains Métis while `com.mantu.asktoto` and keychain/userData paths remain unchanged; release continuity uses the active `AskToto-Mantu` GitHub Releases feed.

Reference hardware is fixed for reproducibility: MacBook Air M1 (2020), 8 GB, macOS 14.6+ arm64; Windows 11 23H2 x64 on Ryzen 5 5600U (6C/12T AVX2) or a slower/equivalent published CPU benchmark, 16 GB RAM. Windows CPU/WASM is mandatory. Vulkan is a separate physical Radeon-iGPU gate and is not inferred from a hosted Windows runner. Whole-app memory is sampled from the OS process tree; main-process `process.memoryUsage()` alone is not evidence.

Release publication is atomic. Native Mac and Windows jobs build with `--publish never`, sign, inspect, install-smoke, hash, and upload workflow artifacts. One final job downloads both verified sets, creates an invisible draft in `AskToto-Mantu`, uploads without rebuilding, verifies the complete DMG/ZIP/EXE/update-metadata set, then publishes the draft. A failure never exposes a one-platform release.

## Failure and rollback

- Missing or corrupt asset: local tier unavailable with a precise local error; no remote retry.
- Unsupported GPU: fall back to packaged CPU/WASM backend.
- Local runtime crash: dispose, retry once with backoff, then disable for the session.
- Performance gate miss: local remains opt-in beta or is removed from the release; cloud behavior remains unchanged.
- Artifact over 1.9 GiB: try the size candidate only if it passes the frozen eval. Never split the required model into a post-install download.
- Release regression: revert the local execution branch and packaged assets while preserving identity/update continuity.

## External release dependency

GitHub Actions currently rejects jobs before step 1 because an Actions budget prevents use. Source work and native Mac proof can proceed locally. Final Windows evidence requires restored Actions budget or access to a real Windows x64 builder. A Mac cross-build is not Windows proof.

## Out of scope

- Replacing think/deep cloud agents.
- Training, fine-tuning, or user-specific model weights.
- Persisting screenshots or vision output in Mantu Intelligence.
- Automated employment decisions or people scoring.
- Linux, Intel Mac, Windows ARM, MAS, and portable EXE support in the first release.
- A local HTTP server, Ollama daemon, or Python sidecar.
