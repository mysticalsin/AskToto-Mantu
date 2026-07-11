# Métis Packaged Local AI Implementation Plan

> **For implementation:** execute this plan task by task with `superpowers:executing-plans`. For every behavior change, write and run the focused failing test before asking Claude Sonnet to write production code. Codex reviews every Sonnet patch, applies only the scoped diff, and reruns the focused and regression gates.

**Goal:** Ship Métis as a self-contained macOS Apple Silicon DMG/ZIP and Windows x64 NSIS application with bundled text, vision, ASR, and native runtime assets; low-latency local meeting assistance; and read-only, cited Mantu Intelligence analysis. Installed builds must never download model/runtime assets or silently upload local data after a local failure.

**Architecture:** Keep the existing cloud provider waterfall intact. Add a separate main-process local execution branch for base-tier text tasks, a serial resource-governed local runtime, append-only meeting sessions that reuse transcript state, and a renderer Web Worker for Florence vision. All local assets are provisioned only at build time from an immutable manifest and verified again in the packaged app. Mantu Intelligence gets one narrow `brain:analyze` read path with provenance, policy, citation, and read-only gates.

**Supported release targets:** macOS `darwin-arm64` and Windows `win32-x64`. Intel Mac, Windows ARM, Linux, MAS, AppX, and portable Windows are not part of this release gate.

**Primary stack:** Electron 39, TypeScript 5.6, Vitest 4, Zod 3, `node-llama-cpp` 3.19.0, Qwen3 GGUF, `@huggingface/transformers` 3.8.1, SmolVLM/Florence ONNX candidates, electron-builder 25.

**Non-negotiable invariants:**

- Keep `productName: Métis`, `appId: com.mantu.asktoto`, existing keychain/userData identity, and the `AskToto-Releases` update feed.
- No production URL, Hugging Face resolver, downloader, Ollama dependency, Python sidecar, or remote retry in the model execution path.
- Build-time downloads use immutable revisions, exact byte sizes, SHA-256, and reviewed license files.
- No silent local-to-cloud fallback. Cloud execution requires an already explicit cloud route or a user action.
- Local inference never records transcript, screenshot, OCR, prompt, or answer content in logs/metrics.
- Interview or unknown-provenance records never enter Intelligence analysis.
- No candidate/employee scoring, ranking, shortlisting, emotion inference, or employment recommendation.
- A Mac cross-build is not Windows proof.

---

## Task 1: Freeze shared contracts, provenance, and policy

**Files:**

- Create: `src/shared/local-ai.ts`
- Create: `src/shared/local-ai.test.ts`
- Create: `src/shared/brain-analyze.ts`
- Create: `src/shared/brain-analyze.test.ts`
- Modify: `src/main/brain/ingest.ts`
- Modify: `src/main/brain/brain.test.ts`
- Modify: `src/main/brain/e2e-proof.test.ts`
- Modify: `src/shared/brain.ts`
- Modify: `src/shared/ipc.ts`
- Modify: `src/shared/ipc.test.ts`
- Modify: `src/shared/providers.ts`
- Modify: `vitest.config.ts`

**Step 1: Write failing contract tests**

Cover these exact contracts:

```ts
type LocalTask = 'suggest' | 'summary' | 'answer' | 'title' | 'classify' | 'cleanup'
type LocalPriority = 'visible' | 'automatic' | 'speculative' | 'background'
type LocalAiUnavailableReason =
  | 'missing-model'
  | 'hash-mismatch'
  | 'native-addon'
  | 'load-failed'
  | 'unsupported-platform'

interface LocalAiStatus {
  ready: boolean
  model: string
  modelSha256: string
  backend?: 'metal' | 'vulkan' | 'cpu'
  reason?: LocalAiUnavailableReason
}
```

Add bounded Zod schemas for local session begin/append/full-resync/end, transcript revisions, local vision evidence, and local stream executor metadata. Exact IPC contracts are: UUID session and immutable line IDs; non-negative signed 32-bit revisions; begin at revision 0; append requires `revision = baseRevision + 1`, at most 64 lines and 64 KiB UTF-8 across the complete IPC payload; resync allows at most 20,000 lines and 2 MiB UTF-8 across the complete IPC payload; every line uses the existing speaker enum, a nonnegative integer timestamp, and 1-4,000 characters. A gap acknowledgment includes `expectedRevision` and changes no state; the renderer must resync before another append. Extend `AskStartSchema` with a UUID `localSessionId?` and a 64 KiB structured `visionEvidence?`. Vision evidence is allowed only with `mode: 'vision'` and is mutually exclusive with raw `image`.

Use these exact exports in `src/shared/local-ai.ts`: `LocalTranscriptLineSchema`, `LocalTranscriptBeginSchema`, `LocalTranscriptAppendSchema`, `LocalTranscriptResyncSchema`, `LocalTranscriptEndSchema`, `LocalTranscriptAckSchema`, `LocalVisionEvidenceSchema`, and `FutureStreamMetaSchema`. Every object/union branch is strict. Shared UTF-8 limits use `TextEncoder`, not Node `Buffer`. Begin accepts at most the append cap. Ack is `{ revision, resyncRequired, expectedRevision? }` and requires `expectedRevision` exactly when resync is true.

Vision evidence is a strict version-1 object with 1-128-character model ID, 64-hex model SHA-256, nonnegative integer capture timestamp, `wasm | webgpu` backend, 1-4 unique capabilities from `caption | text | ocr | regions`, caption capped at 8,000 characters, text capped at 32,000, and at most 200 `{ text, box:[x1,y1,x2,y2] }` regions. Region text is 1-1,000 characters; coordinates are normalized 0..1 with `x2 >= x1` and `y2 >= y1`. The complete JSON payload is at most 64 KiB UTF-8.

Define this future stream shape in `src/shared/local-ai.ts`, but do not replace the existing `StreamMetaSchema` in Task 1 because current renderer consumers require `provider`:

```ts
type StreamMeta =
  | { id: string; executor: 'local'; tier: 'base'; model: string }
  | { id: string; executor: 'provider'; tier: ModelTier; provider: ProviderId }
```

The actual StreamMeta migration and every consumer change happen atomically in Task 6.

Define `BrainAnalyzeRequestSchema` as a strict version-1 union discriminated by `task`: `briefing` requires `{kind:'brain'}`; `account-summary`, `deal-summary`, and `meeting-summary` require their matching `{kind,id}` scope with ID capped at 200; `question` accepts any typed scope and requires 1-500 characters. Every branch requires language `en | fr`.

Define `BrainAnalyzeResultSchema` with `ok | insufficient-evidence | blocked`, the exact disclosure `Local AI-generated analysis. Verify against cited meetings.`, a 4,000-character answer cap, at most 50 points, at most 100 evidence records, immutable `{id,sha256}` model identity, and nonnegative finite `{loadMs,prefillMs,generateMs,totalMs}`. Point text is 1-1,000 characters with 1-20 unique `evidenceIds`. Evidence/file IDs are lowercase 64-hex hashes/1-300-character paths. Transcript evidence requires positive line range with end >= start and a 1-1,000-character quote. Derived evidence requires null line range, empty quote, and a 1-1,000-character `derivedText`. Every point evidence ID must exist in the result evidence array; duplicate/dangling IDs fail.

Add model-independent provenance fields to `MeetingExtractionSchema`: `source_mode: string` and `source_use: 'eligible' | 'employment' | 'unknown'`, defaulting legacy data to empty/unknown. Export `classifyMeetingSourceUse(mode: string)`: only built-in `interview` maps to employment; only the built-in business-mode allowlist (`general`, `meeting`, `sales`, `negotiation`, `presentation`, `support`) maps to eligible; every custom/unclassified value maps to unknown. At the trusted ingest boundary, overwrite any model-supplied provenance using only a bounded mode from the leading meeting frontmatter. Missing or malformed provenance becomes empty/unknown. Content never determines provenance.

Expand Vitest includes to `scripts/**/*.{test,spec}.{ts,tsx}` and `eval/**/*.{test,spec}.{ts,tsx}` so later test commands are executable.

**Step 2: Prove RED**

Run:

```bash
npx vitest run src/shared/local-ai.test.ts src/shared/brain-analyze.test.ts src/shared/ipc.test.ts
```

Expected: failures because the new schemas/channels/types and `source_mode` do not exist.

**Step 3: Ask Claude Sonnet for the minimal contract implementation**

Require Sonnet to touch only the files listed in this task, preserve existing provider schema parity, and avoid production behavior.

Add these IPC channel constants:

```ts
localAiStatus: 'local-ai:status'
localTranscriptBegin: 'local-ai:transcript:begin'
localTranscriptAppend: 'local-ai:transcript:append'
localTranscriptResync: 'local-ai:transcript:resync'
localTranscriptEnd: 'local-ai:transcript:end'
brainAnalyze: 'brain:analyze'
```

**Step 4: Prove GREEN and regressions**

Run the focused command, then:

```bash
npm run typecheck
npx vitest run src/shared
```

Expected: all shared tests and typechecks pass.

**Review record (2026-07-11):** RED was observed for missing contracts and again for model-supplied provenance surviving ingest. GREEN proof: 62 test files / 669 tests, Node and web typechecks, production Electron build, and clean independent re-review after both findings were fixed.

---

## Task 2: Build an immutable local-asset supply chain

**Files:**

- Create: `resources/local-ai/candidates.json`
- Create: `resources/local-ai/licenses/Qwen3-1.7B-Apache-2.0.txt`
- Create: `resources/local-ai/licenses/Qwen3-0.6B-Apache-2.0.txt`
- Create: `resources/local-ai/licenses/Florence-2-MIT.txt`
- Create: `resources/local-ai/licenses/SmolVLM-Apache-2.0.txt`
- Create: `resources/local-ai/licenses/model-conversion-notices.md`
- Create: `scripts/local-ai-manifest.mjs`
- Create: `scripts/local-ai-manifest.test.ts`
- Create: `scripts/fetch-local-ai.mjs`
- Create: `scripts/check-local-ai.mjs`
- Create: `scripts/stage-local-ai.mjs`
- Modify: `.gitignore`
- Modify: `.gitattributes`
- Modify: `THIRD_PARTY_NOTICES.md`
- Modify: `package.json`

**Step 1: Write failing manifest tests**

The candidate catalog schema must require a top-level selection, exact variant/component membership, and separately hashed licenses:

```ts
interface LocalAiCatalog {
  schemaVersion: 1
  selected: { textVariant: string; visionVariant: string; approval: 'evaluation' | 'release' }
  variants: Array<{
    id: string
    role: 'text' | 'vision'
    model: 'qwen3-1.7b' | 'qwen3-0.6b' | 'smolvlm-256m-instruct' | 'florence-2-base-ft'
    precision: string
    runtime: 'node-llama-cpp' | 'transformers.js'
    componentIds: string[]
    provenance: {
      status: 'complete' | 'review-required'
      noticeIds: string[]
    }
  }>
  assets: LocalAsset[]
  licenses: Array<{ id: string; path: string; bytes: number; sha256: string }>
  notices: Array<{
    id: string
    kind: 'provenance' | 'release-exception'
    path: string
    bytes: number
    sha256: string
  }>
}

interface LocalAsset {
  id: string
  variantId: string
  component: string
  source: {
    repo: string
    commit: string
    path: string
    bytes: number
    sha256: string
    licenseId: string
  }
  conversion?: {
    tool: string
    version: string
    commit: string
    recipe: string
    licenseId: string
  }
  destination: string
  platforms: Array<'darwin-arm64' | 'win32-x64' | 'all'>
}
```

Freeze the generated `resources/local-ai/payload/manifest.json` as a deterministic version-1 object with no timestamp: target platform, raw catalog SHA-256, approval, exactly one selected text and one selected vision variant (ID/model/precision/runtime), sorted selected asset records (ID/variant/component/destination/bytes/SHA-256), and only their referenced license/notice records (ID/kind where applicable/destination/bytes/SHA-256). It contains no cache path, download URL, branch/ref, or remote resolver input. The exact staged file set is the manifest plus those recorded assets, licenses, and notices. Two identical stages must produce byte-identical manifests.

Compact third-party conversions use `provenance.status: 'review-required'` and a hashed provenance notice because their conversion recipe is not known. Evaluation may include them. A release selection containing any `review-required` variant fails unless that variant references a separately hashed `release-exception` notice approved in review; a provenance disclosure alone is not an approval.

Tests must reject schema drift/unknown keys, duplicate IDs/components/destinations (including case-fold collisions), `main` or branch-like revisions, non-40-hex commits, path traversal, POSIX/Windows absolute or backslash destinations, unsafe/reserved path segments, unknown license/notice/variant references, incomplete component membership, invalid role/model/runtime combinations, missing conversion notices, empty/duplicate platform arrays, `all` mixed with a target, zero/unsafe sizes, malformed SHA-256, missing/symlinked/zero-byte assets or records, size mismatch, and hash mismatch. They must also reject wrong-role selections, unmanifested staged files, `.part` files, manifest/catalog/platform/approval mismatches, wrong-platform assets, and a selected bundle containing any unselected candidate. A valid synthetic fixture passes without network access, stages byte-identically twice, and fails after any one-byte mutation.

**Step 2: Prove RED**

```bash
npx vitest run scripts/local-ai-manifest.test.ts
```

Expected: module and manifest are absent.

**Step 3: Ask Claude Sonnet for manifest tooling**

Implement pure exported validation functions in `scripts/local-ai-manifest.mjs`; keep CLI entry points thin. `fetch-local-ai.mjs` stores downloads under `resources/local-ai/cache/<asset-id>/`, downloads to `.part`, supports HTTP range resume, verifies byte count and SHA-256, then atomically renames. Existing files are rehashed. Its default fetches only the selected bundle; `--all-candidates` is explicit for evaluation.

`stage-local-ai.mjs --platform <target>` stages the catalog selection. The optional `--evaluation --text-variant <id> --vision-variant <id>` form is allowed only for candidate evaluation and writes `approval: evaluation` into the runtime manifest. The script builds and validates a temporary sibling, copies (never hardlinks) only the chosen variants' components plus referenced license/provenance records, writes the selected-only `manifest.json`, and swaps it into `resources/local-ai/payload/` with rollback. `check-local-ai.mjs --platform <target>` validates catalog plus selected-only payload and license/provenance records without network access; it never fetches. `--require-release` rejects evaluation and any unresolved review-required provenance. Target native-package validation and electron-builder payload mapping begin in Task 3, once those packages and build changes exist.

The tracked catalog includes the pinned Qwen3-1.7B compact candidates, the official Qwen3-0.6B Q8 provenance candidate, SmolVLM Q8, and Florence Q4, using the exact record in `docs/research/2026-07-10-local-ai-model-assets.md`. The initial evaluation selection is official Qwen3-0.6B Q8 plus SmolVLM Q8. Task 12 updates it to `approval: release` only after model selection. The compact Unsloth Qwen assets have an unresolved conversion recipe/upstream revision; they may enter evaluation only with a reviewed exception record and may not be selected for release until that record is complete. Pin every entry to an immutable 40-hex repository commit and LFS SHA-256. No placeholder value is accepted by the schema.

Ignore binary payloads under `resources/local-ai/cache/**`, generated `resources/local-ai/payload/**`, and temporary/rollback staging siblings; keep candidate metadata, licenses, and notices tracked. Add path-scoped `.gitattributes` rules that mark exact upstream license bytes `-text` (their pinned hashes include original LF or CRLF endings) while forcing LF for the Métis-authored catalog and provenance notices. Windows checkout settings must not change either class. Package filters added in Task 3 must independently exclude `.part`, unselected model IDs, CUDA, wrong-architecture, and non-target native packages.

Add scripts:

```json
"fetch:local-ai": "node scripts/fetch-local-ai.mjs",
"stage:local-ai": "node scripts/stage-local-ai.mjs",
"check:local-ai": "node scripts/check-local-ai.mjs"
```

**Step 4: Prove GREEN and provision assets**

```bash
npx vitest run scripts/local-ai-manifest.test.ts
npm run fetch:local-ai
npm run stage:local-ai -- --platform darwin-arm64
npm run check:local-ai -- --platform darwin-arm64
```

Expected: exact hashes pass and all selected assets/licenses exist. Start provisioning as a resumable background process if the download is long; continue independent test-first tasks while it runs.

---

## Task 3: Prove the packaged ESM text worker survives the real Electron build

**Files:**

- Create: `src/main/local-ai/resource-path.ts`
- Create: `src/main/local-ai/resource-path.test.ts`
- Create: `src/main/local-ai/worker-controller.ts`
- Create: `src/main/local-ai/worker-controller.test.ts`
- Create: `src/local-ai-worker/index.mts`
- Create: `src/local-ai-worker/native-runtime.mts`
- Create: `src/local-ai-worker/native-runtime.test.ts`
- Create: `src/main/local-ai/packaged-selftest.ts`
- Create: `src/main/local-ai/packaged-selftest.test.ts`
- Create: `tsconfig.local-ai-worker.json`
- Create: `scripts/smoke-packaged-local-ai.mjs`
- Create: `scripts/check-node-llama-package.mjs`
- Create: `scripts/check-electron-fuses.mjs`
- Modify: `src/main/index.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `electron.vite.config.ts`
- Modify: `electron-builder.yml`
- Modify: `scripts/after-pack.mjs`

**Step 1: Write failing path and native-smoke tests**

Test that packaged paths resolve only below `process.resourcesPath/local-ai`, development paths resolve only below the generated payload, and traversal is rejected. `tsconfig.local-ai-worker.json` compiles `.mts` sources to ESM `.mjs` under `out/local-ai-worker/` without bundling dependencies.

The bytecode main never imports node-llama. `worker-controller.ts` forks the unpacked worker entry with `execPath: process.execPath`, `ELECTRON_RUN_AS_NODE=1`, empty `execArgv`, an IPC stdio channel, a random handshake nonce, parent PID, bounded typed messages, and no listening socket. The worker exits on parent disconnect and writes no content logs. Add an app self-test dispatch using `METIS_SELFTEST_KIND=local-ai-native` and absolute `METIS_SELFTEST_OUTPUT`. After `app.whenReady()`, it calls the real controller; the worker loads the selected GGUF from the passed verified absolute path, creates a bounded context, generates five tokens, is force-killed mid-generation, respawns once, generates again, disposes, and exits before the overlay is created.

`scripts/smoke-packaged-local-ai.mjs --app <absolute-executable> --result <absolute-json>` launches the unpacked/installed Electron executable with those environment variables and isolated `ASKTOTO_USERDATA`; host Node never imports node-llama. It waits with a hard timeout, validates result/model/backend/resources path, and verifies clean exit. The self-test installs a test-only network-deny shim before engine initialization and fails if model code calls `fetch`, `http`, `https`, Electron `net`, or a remote model resolver.

**Step 2: Prove RED before dependency/config changes**

```bash
npx vitest run src/main/local-ai/resource-path.test.ts src/main/local-ai/worker-controller.test.ts src/local-ai-worker/native-runtime.test.ts src/main/local-ai/packaged-selftest.test.ts
npm run build
METIS_ALLOW_EVALUATION_PAYLOAD=1 npm run dist:unpacked:mac
node scripts/smoke-packaged-local-ai.mjs --app release/mac-arm64/Métis.app/Contents/MacOS/Métis --result release/local-ai-self-test.json
```

Expected: missing module/path implementation, followed by a missing `node-llama-cpp` dependency or packaged native load failure.

**Step 3: Ask Claude Sonnet for the smallest build-safe spike**

- Pin `node-llama-cpp` exactly to `3.19.0` in runtime dependencies.
- Pin `@electron/fuses` exactly to `2.1.3` in dev dependencies and use its API in the packaged fuse check.
- Use a static top-level import in `src/local-ai-worker/native-runtime.mts`. Do not import node-llama from `src/main`, bundle it, or weaken `scripts/check-no-dynamic-import.mjs`.
- Compile the worker as ESM and keep `node-llama-cpp` and `lifecycle-utils` external. Unpack the worker, its ESM dependencies, and selected native packages so normal ESM resolution occurs entirely under `app.asar.unpacked`.
- Initialize exactly with `build: 'never'`, `skipDownload: true`, `usePrebuiltBinaries: true`, disabled progress logs, Metal on Darwin, and `{ type: 'auto', exclude: ['cuda'] }` on Windows.
- Package `@node-llama-cpp/mac-arm64-metal@3.19.0` on Mac; package both `@node-llama-cpp/win-x64@3.19.0` and `@node-llama-cpp/win-x64-vulkan@3.19.0` on Windows. Exclude `win-x64-cuda`, `win-x64-cuda-ext`, `win-arm64`, `mac-x64`, Linux, source/build trees, and wrong architecture. Unpack native bins/localBuilds from ASAR and fail after-pack on any forbidden path.
- Add only `resources/local-ai/payload` to `extraResources`, mapped to packaged `local-ai/`.
- Verify the Electron `runAsNode` fuse remains enabled. The worker is a normal packaged Node process, not a renderer or undocumented utility process. A development-only result is insufficient.
- Scan the unpacked worker for prompts, credentials, provider configuration, or secrets imports; it contains only runtime/IPC glue. MAS builds are explicitly local-tier-disabled because App Sandbox/run-as-Node support is outside this release.
- Add after-pack checks that the selected GGUF, selected vision files, manifest, licenses, and target native addon exist in the packaged resources directory.

**Step 4: Run the hard spike gate**

```bash
npm run check:main-imports
npm run typecheck
npm run build
METIS_ALLOW_EVALUATION_PAYLOAD=1 npm run dist:unpacked:mac
node scripts/check-node-llama-package.mjs --platform darwin-arm64 --app release/mac-arm64/Métis.app
node scripts/check-electron-fuses.mjs --app release/mac-arm64/Métis.app --require-run-as-node
node scripts/smoke-packaged-local-ai.mjs --app release/mac-arm64/Métis.app/Contents/MacOS/Métis --result release/local-ai-self-test.json
```

Add `build:local-ai-worker` as `tsc -p tsconfig.local-ai-worker.json` and run it before the Electron build. Add `dist:unpacked:mac` as `electron-builder --mac --arm64 --dir --publish never` after normal build/stage gates and a symmetric native Windows command. A passing native Mac spike unblocks the remaining source tasks. The symmetric Windows spike is mandatory before release but does not deadlock source work while GitHub Actions is unavailable. If the packaged worker fails on either native target, execute the documented fallback for the shared architecture: remove main bytecode, convert main output to ESM, and rerun both native spikes; never move inference to a renderer/utility process.

---

## Task 4: Implement the serial scheduler and append-only meeting context

**Files:**

- Create: `src/main/local-ai/types.ts`
- Create: `src/main/local-ai/scheduler.ts`
- Create: `src/main/local-ai/scheduler.test.ts`
- Create: `src/main/local-ai/transcript-context.ts`
- Create: `src/main/local-ai/transcript-context.test.ts`

**Step 1: Write failing scheduler tests**

Prove:

- visible work preempts and cancels speculative/background work;
- only one generation mutates model state at a time;
- cancel-before-start prevents generation;
- abort-during-generation emits neither done nor error for a user cancel;
- ASR backlog, event-loop lag over 50 ms, memory cap, inactive listening, and battery policy pause proactive work;
- dispose rejects new jobs and releases queued/active resources.

**Step 2: Write failing transcript-context tests**

Prove:

- canonical full text is retokenized, the unchanged BPE-token prefix is preserved, and only the missing token tail is evaluated;
- repeated `(sessionId, baseRevision, lines)` deltas are idempotent;
- a revision gap returns `{ resyncRequired: true, expectedRevision }` without mutation;
- a full sync atomically replaces the session at the declared revision and rejects payloads above the line/text caps;
- generated output never enters the base transcript sequence;
- a new/end session clears prior state;
- context-cap rebuilding is deterministic and retains a bounded verbatim tail plus cited running summary;
- English, French, and mixed transcripts preserve speaker/time metadata.

**Step 3: Prove RED**

```bash
npx vitest run src/main/local-ai/scheduler.test.ts src/main/local-ai/transcript-context.test.ts
```

**Step 4: Ask Claude Sonnet for minimal pure implementations**

Inject runtime/tokenizer/clock/resource probes behind narrow interfaces so tests use fakes. Do not import Electron or the real model in these units. The transcript state owns canonical formatted text plus `baseTokens`: every accepted append retokenizes the full text because BPE tokens can change at the join, preserves the common prefix, and asks the worker to evaluate only the missing tail. Generation records the exact base tokens, streams, then restores that array after cancellation/error; compaction rebuilds a deterministic base from cited running summary plus verbatim tail. Defaults: 1.2-second stability debounce, 32-token append threshold, 8-second maximum append delay, one generation, 4,096-token live target, visible > automatic > speculative > background.

**Step 5: Prove GREEN**

```bash
npx vitest run src/main/local-ai/scheduler.test.ts src/main/local-ai/transcript-context.test.ts
npm run typecheck
```

---

## Task 5: Implement the local text engine and stream-compatible service

**Files:**

- Create: `src/main/local-ai/manifest.ts`
- Create: `src/main/local-ai/manifest.test.ts`
- Create: `src/main/local-ai/worker-client.ts`
- Create: `src/main/local-ai/worker-client.test.ts`
- Modify: `src/local-ai-worker/native-runtime.mts`
- Create: `src/local-ai-worker/session-runtime.mts`
- Create: `src/local-ai-worker/session-runtime.test.ts`
- Create: `src/local-ai-worker/session-runtime.integration.test.ts`
- Create: `src/main/local-ai/prompts.ts`
- Create: `src/main/local-ai/service.ts`
- Create: `src/main/local-ai/service.test.ts`
- Modify: `src/main/metrics.ts`
- Modify: `src/main/logger.ts`

**Step 1: Write failing tests**

Test session-level hash verification, stable actionable status reasons, a single lazy worker/model/context, bounded context/batch/GPU configuration, warm reuse, bounded child IPC, async token streaming, exact reuse of existing `StreamHandlers`/`StreamHandle`, cancellation, worker crash/restart-once behavior, deterministic cleanup, parent-death cleanup, and no network call. Prompt tests must wrap transcripts/screenshots/brain evidence as untrusted data and produce versioned EN/FR task prompts.

The opt-in real-model integration test (`METIS_LOCAL_AI_INTEGRATION=1`) syncs a known transcript prefix, records base tokens/KV counters, generates suggest then summary then answer, cancels one generation, and proves after every path that the sequence is restored to the exact base token array. A second sync retokenizes the canonical full formatted transcript, preserves the common BPE-token prefix with `adaptStateToTokens(target, false)`, and evaluates only the missing tail via `evaluateWithoutGeneratingNewTokens`; separately tokenizing the latest text is not BPE-safe. The packaged self-test repeats this state-reuse sequence so fake adapters are not the only evidence.

Audit/metric tests must allow only model hash/version, task, backend, timing, token counts, RSS, cancellation, and error class. They must reject transcript, prompt, screenshot, OCR, and output content.

**Step 2: Prove RED**

```bash
npx vitest run src/main/local-ai/manifest.test.ts src/main/local-ai/worker-client.test.ts src/local-ai-worker/session-runtime.test.ts src/main/local-ai/service.test.ts
```

**Step 3: Ask Claude Sonnet for production code**

Implement one `LocalAiService`:

```ts
interface LocalAiService {
  status(): Promise<LocalAiStatus>
  beginSession(sessionId: string): Promise<void>
  appendTranscript(delta: TranscriptDelta): Promise<{ revision: number; resyncRequired: boolean; expectedRevision?: number }>
  resyncTranscript(snapshot: TranscriptSnapshot): Promise<{ revision: number }>
  stream(request: LocalStreamRequest, handlers: StreamHandlers): StreamHandle
  endSession(sessionId: string): Promise<void>
  dispose(): Promise<void>
}
```

Worker initialization uses `getLlama({ build: 'never', skipDownload: true, usePrebuiltBinaries: true, progressLogs: false })`, absolute verified paths, Metal on Mac, Windows auto excluding CUDA, `gpuLayers: 'auto'`, one sequence, context min 4,096/max 8,192, batch 512, flash attention auto, and performance tracking. Use one retry only for a recoverable worker crash. Never download or invoke an external daemon.

For growing context, keep canonical `baseTokens`. Retokenize the full formatted transcript, call `adaptStateToTokens`, evaluate only the missing tail, and use checkpoints when `sequence.needsCheckpoints`. Before generation copy `sequence.contextTokens`; disable context shift; in `finally`, return the generator and restore that exact base through the same sync helper. Assert byte-for-byte token equality after success, cancellation, and error. Cancellation uses the high-level signal/`stopOnAbortSignal` path and is documented as stopping between native token evaluations, not in the middle of one decode.

Qwen3 uses `QwenChatWrapper({ variation: '3', thoughts: 'discourage' })`; a render test proves the empty thought block and output validation rejects visible `<think>` content. If the GGUF Jinja template is used instead, it must pass `enable_thinking: false` with fallback disabled and the same render test. Generation budgets are fixed per task: classify 16, title 32, suggest 96, cleanup 256, answer 384, summary 512, with pinned temperature/top-p/top-k/repeat penalty/EOS/task stops. Tests fail if any task omits max tokens, context-shift disablement, or stop behavior.

**Step 4: Prove GREEN and built smoke**

```bash
npx vitest run src/main/local-ai/manifest.test.ts src/main/local-ai/worker-client.test.ts src/local-ai-worker/session-runtime.test.ts src/main/local-ai/service.test.ts
METIS_LOCAL_AI_INTEGRATION=1 npx vitest run src/local-ai-worker/session-runtime.integration.test.ts
npm run typecheck
npm run build
METIS_ALLOW_EVALUATION_PAYLOAD=1 npm run dist:unpacked:mac
node scripts/smoke-packaged-local-ai.mjs --app release/mac-arm64/Métis.app/Contents/MacOS/Métis --result release/local-ai-self-test.json
```

---

## Task 6: Route eligible asks locally without changing cloud semantics

**Files:**

- Modify: `src/shared/routing.ts`
- Create: `src/shared/local-routing.test.ts`
- Create: `src/main/local-ai/ask-orchestrator.ts`
- Create: `src/main/local-ai/ask-orchestrator.test.ts`
- Modify: `src/main/index.ts`
- Modify: `src/shared/ipc.ts`
- Modify: `src/preload/index.ts`
- Create: `src/preload/index.test.ts`
- Modify: `src/renderer/src/state.ts`
- Modify: `src/renderer/src/state.test.ts`
- Modify: `src/renderer/src/components/Answer.tsx`

**Step 1: Write failing pure routing tests**

Add:

```ts
type ExecutionTarget = 'local' | 'provider'
```

`routeExecution()` returns local only when runtime is ready, tier is base, and the mode is suggest/summary/ordinary answer. It returns provider for fact-check, recap, think/deep, provider override, agent override, deeper requests, and raw image requests. For a local screenshot ask, the renderer first processes the captured image through the packaged vision worker, then sends bounded `visionEvidence` without `image`; that prepared request is local only when both runtimes are ready. A raw image is never passed to the local text engine.

**Step 2: Write failing orchestration/security tests**

Prove through the extracted `ask-orchestrator.ts` seam, leaving `index.ts` as thin registration:

- local sees the raw local request, while cloud receives the existing redacted clone;
- local streams use the existing stream map and cancellation path;
- visible local requests cancel speculative work;
- local failure emits an actionable error and never enters the provider waterfall;
- explicit cloud requests keep current retry/failover behavior;
- `will-quit` aborts streams, ends sessions, and disposes local AI;
- IPC sender guards and payload schemas protect every new local channel.

**Step 3: Prove RED**

```bash
npx vitest run src/shared/local-routing.test.ts src/main/local-ai/ask-orchestrator.test.ts src/preload/index.test.ts
```

**Step 4: Ask Claude Sonnet for the minimal integration**

Insert the local branch before the provider waterfall. Do not add `local` to `ProviderId`. Derive `localAiReady`, keep `providerReady`, and expose `assistantReady = localAiReady || providerReady`. In this same task, migrate `StreamMetaSchema` to the local/provider discriminated union and update `state.ts`, `Answer.tsx`, preload types, all senders, and tests atomically; no intermediate typecheck is expected. Stream metadata shows `Métis on-device`. Never silently fall through from local to cloud.

**Step 5: Prove GREEN**

```bash
npx vitest run src/shared/local-routing.test.ts src/main/local-ai/ask-orchestrator.test.ts src/preload/index.test.ts
npm run typecheck
npm test
```

---

## Task 7: Send stable transcript deltas and expose explicit local/cloud state

**Files:**

- Create: `src/renderer/src/lib/localMeetingSession.ts`
- Create: `src/renderer/src/lib/localMeetingSession.test.ts`
- Modify: `src/renderer/src/App.tsx`
- Modify: the existing provider/setup nudge and quick-action components selected by `rg "providerReady|requireProvider|QuickActions" src/renderer/src`

**Step 1: Write failing pure renderer tests**

Prove begin/append/resync/end boundaries, committed-line-only deltas, acknowledged revision tracking, reset/new meeting/logout/quit cleanup, and visible-request cancellation of speculative work. Test UI derivation for local-only ready, cloud-only ready, neither ready, and explicit local unavailable reasons.

**Step 2: Prove RED**

```bash
npx vitest run src/renderer/src/lib/localMeetingSession.test.ts src/renderer/src/state.test.ts
```

**Step 3: Ask Claude Sonnet for renderer integration**

Begin a UUID session at the existing meeting-start boundary, assign immutable UUIDs to committed lines, append only newly committed lines, and end it at every meeting/session teardown. On `{ resyncRequired: true, expectedRevision }`, pause appends and send all bounded committed lines through `local-ai:transcript:resync`; resume only after its acknowledged revision. Pass `localSessionId` on eligible asks. Use `assistantReady` for base assistant affordances and `providerReady` only for cloud setup/operations. Show executor, model identity, and freshness; offer an explicit `Try cloud` action after local failure.

**Step 4: Prove GREEN**

```bash
npx vitest run src/renderer/src/lib/localMeetingSession.test.ts src/renderer/src/state.test.ts
npm run typecheck
npm run build
```

---

## Task 8: Make all packaged ASR paths strictly offline

**Files:**

- Modify: `src/main/parakeet.ts`
- Create: `src/main/parakeet.test.ts`
- Modify: `src/main/asr-manifest.ts`
- Modify: `src/main/asr-manifest.test.ts`
- Modify: `src/renderer/src/lib/whisper.worker.ts`
- Create: `src/renderer/src/lib/whisper.worker.test.ts`
- Modify: `src/renderer/src/lib/listen.ts`
- Modify: `src/renderer/index.html`
- Create: `resources/asr-manifest.json`
- Modify: `scripts/fetch-models.mjs`
- Modify: `scripts/check-sherpa-platform.mjs`
- Create: `scripts/check-runtime-assets.mjs`

**Step 1: Write failing offline tests**

Prove packaged Parakeet fails with a local missing/corrupt-assets status instead of downloading to userData; packaged Whisper never switches to Hugging Face/jsDelivr; the complete hash/size manifest covers Parakeet, Whisper, and ORT; missing, changed, unlisted, and zero-byte files fail preflight. Development remote behavior is also disabled for parity unless an explicit benchmark-only flag is set outside packaged builds.

**Step 2: Prove RED**

```bash
npx vitest run src/main/parakeet.test.ts src/main/asr-manifest.test.ts src/renderer/src/lib/whisper.worker.test.ts
```

**Step 3: Ask Claude Sonnet to remove the runtime fallback paths**

Replace non-empty checks in `fetch-models.mjs` and `asrManifestComplete()` with the tracked pinned revision/size/SHA-256 manifest. `check-runtime-assets.mjs` composes no-network checks for local text/vision, Whisper, Parakeet, ORT, FFmpeg, and the target node-llama native runtime; no non-empty-only release gate remains. Remove model CDNs from the production CSP after verifying no renderer path needs them. Keep the app updater; this task prohibits model/runtime downloads, not signed application updates.

**Step 4: Prove GREEN and scan**

```bash
npx vitest run src/main/parakeet.test.ts src/main/asr-manifest.test.ts src/renderer/src/lib/whisper.worker.test.ts
node scripts/check-runtime-assets.mjs --platform darwin-arm64
rg -n "huggingface|hf\.co|jsdelivr|resolveModelFile|download" src/main src/renderer/src
npm run build
```

Expected: any remaining matches are build tooling, comments/tests, or explicit cloud-provider code, not packaged model resolution.

---

## Task 9: Add packaged local screenshot evidence

**Files:**

- Create: `src/renderer/src/lib/vision.worker.ts`
- Create: `src/renderer/src/lib/vision.worker.test.ts`
- Create: `src/renderer/src/lib/localVision.ts`
- Create: `src/renderer/src/lib/localVision.test.ts`
- Create: `src/main/resource-protocol.ts`
- Create: `src/main/resource-protocol.test.ts`
- Create: `scripts/smoke-local-ai-vision.mjs`
- Modify: `src/main/index.ts`
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/index.html`
- Modify: `electron-builder.yml`

**Step 1: Write failing worker/controller tests**

Test local-only environment configuration (`allowRemoteModels=false`, `allowLocalModels=true`), strict model/WASM paths, selected-backend fallback, bounded JPEG input, capture timestamp propagation, capability-aware caption/text/region schema validation, memory-only image-hash cache, cancellation, Private View denial, and zero network calls. Protocol tests require GET, allow only hosts `asr`, `ort`, and `local-ai`, resolve the real path below the matching resource root, and serve only exact files in its hashed manifest.

**Step 2: Prove RED**

```bash
npx vitest run src/renderer/src/lib/vision.worker.test.ts src/renderer/src/lib/localVision.test.ts src/main/resource-protocol.test.ts
```

**Step 3: Ask Claude Sonnet for the worker and controller**

Register one privileged `metis-resource://` scheme before app ready. Map `metis-resource://asr/...`, `metis-resource://ort/...`, and `metis-resource://local-ai/...` through `resource-protocol.ts`; replace the old ASR protocol and do not expose direct filesystem URLs. CSP allows this scheme and removes Hugging Face/jsDelivr model CDNs.

Use the existing main-owned 1,280-pixel JPEG capture. The worker returns bounded structured evidence only and declares whether the selected model supports semantic text, OCR, or regions. Treat evidence as untrusted data in the text prompt. Do not persist screenshots/text, put them in telemetry, or add them to the brain store. Raw images never enter the local text engine; only validated `visionEvidence` does. An explicit `Try cloud` action may reuse the in-memory image only after the user chooses it.

**Step 4: Prove GREEN and smoke**

```bash
npx vitest run src/renderer/src/lib/vision.worker.test.ts src/renderer/src/lib/localVision.test.ts src/main/resource-protocol.test.ts
npm run typecheck
npm run build
node scripts/smoke-local-ai-vision.mjs --app release/mac-arm64/Métis.app/Contents/MacOS/Métis --backend wasm
node scripts/smoke-local-ai-vision.mjs --app release/mac-arm64/Métis.app/Contents/MacOS/Métis --backend webgpu
```

The packaged executable dispatches `METIS_SELFTEST_KIND=vision`. The smoke uses redistributable EN and FR fixtures, reports model/capabilities/backend/timing, and fails on any model-network request. Forced WASM must pass for every selected vision variant. Forced WebGPU must pass before the manifest may advertise WebGPU; a WASM-only selected model remains honest rather than simulating acceleration.

---

## Task 10: Add read-only, cited Mantu Intelligence analysis

**Files:**

- Create: `src/main/brain/analyze-policy.ts`
- Create: `src/main/brain/analyze-policy.test.ts`
- Create: `src/main/brain/analyze-context.ts`
- Create: `src/main/brain/analyze-context.test.ts`
- Create: `src/main/brain/analyze.ts`
- Create: `src/main/brain/analyze.test.ts`
- Create: `src/main/brain/analyze-readonly.test.ts`
- Modify: `src/main/brain/ingest.ts`
- Modify: `src/main/brain/ingest-backfill.test.ts`
- Modify: `src/main/index.ts`
- Modify: `src/main/intelligence.ts`
- Create: `src/main/intelligence.test.ts`
- Modify: `src/preload/intelligence.ts`
- Create: `src/preload/intelligence.test.ts`
- Modify: `intelligence/src/lib/brainAdapter.ts`

**Step 1: Write policy/provenance tests**

Stamp `source_mode` and deterministic `source_use` from transcript frontmatter during ingest. Analyze only `eligible`; exclude employment, custom/unclassified, and legacy unknown records. Block English/French requests for candidate/applicant/employee scoring, ranking, shortlisting, hiring/firing, promotion, performance evaluation, and emotion inference before model status/load/generation is touched. Reject prohibited generated output shapes as defense in depth.

**Step 2: Write grounding/read-only tests**

Main may use brain entities only to locate source files. Factual evidence comes from decrypted original transcripts through the existing safe reader; each excerpt carries file plus line/offset, and every quote is normalized-substring-validated against that source. Evidence IDs hash file/offset/content. Derived extraction claims are labelled `grounding: 'derived'` and never presented as verbatim; verified excerpts use `grounding: 'transcript'`. Generated evidence IDs must be a subset of the allowlist or the result abstains.

Use packaged local AI only and return `insufficient-evidence` on missing support. Snapshot all brain/transcript files before/after success, blocked, invalid, cancelled, and failed calls; byte hashes must be identical. Import graph tests must prove `analyze.ts` has no writer/backfill/ingest-generation imports.

**Step 3: Write IPC tests and prove RED**

```bash
npx vitest run src/main/brain/analyze-policy.test.ts src/main/brain/analyze-context.test.ts src/main/brain/analyze.test.ts src/main/brain/analyze-readonly.test.ts src/main/intelligence.test.ts src/preload/intelligence.test.ts
```

**Step 4: Ask Claude Sonnet for the narrow backend**

Remove `backfill()` from the Intelligence preload and its global declaration. Restrict the existing `brain:backfill` handler to the main overlay sender; rebuilding remains available there, not in Intelligence. Add authenticated/sender-guarded `brain:analyze` as the only new Intelligence capability. The renderer supplies intent/scope only; main supplies facts. Log metadata only. Do not reuse `brain:backfill` or `src/main/brain/ingest.ts` generation because those paths write data and may use cloud/CLI providers.

**Step 5: Prove GREEN and preserve legacy exclusion**

```bash
npx vitest run src/main/brain/analyze-policy.test.ts src/main/brain/analyze-context.test.ts src/main/brain/analyze.test.ts src/main/brain/analyze-readonly.test.ts src/main/intelligence.test.ts src/preload/intelligence.test.ts
npm run typecheck
```

Legacy `unknown` records remain excluded until a deliberate rebuild stamps provenance. Never infer provenance from extracted content.

---

## Task 11: Add Intelligence disclosure, citations, and safe interaction states

**Files:**

- Create: `intelligence/src/components/AnalyzePanel.tsx`
- Create: `intelligence/src/lib/useLocalAnalyze.ts`
- Create: `intelligence/src/lib/localAnalyzeState.test.ts`
- Modify: `intelligence/src/App.tsx`
- Modify: `intelligence/src/views/BriefingView.tsx`
- Modify: `intelligence/src/components/InsightCard.tsx`
- Modify: `intelligence/src/index.css`

**Step 1: Write failing state tests**

Cover idle/loading/streaming/success/insufficient-evidence/blocked/unavailable/cancelled/error, scope changes, stale-response suppression, citation expansion, EN/FR disclosure, and no automatic retry to cloud.

**Step 2: Prove RED**

```bash
npx vitest run intelligence/src/lib/localAnalyzeState.test.ts
```

**Step 3: Ask Claude Sonnet for the UI**

Display `Local AI-generated analysis. Verify against cited meetings.` within two seconds of output, the exact local model identity, expandable evidence, explicit abstention, and blocked-policy reasons. Keep deterministic dashboard numbers unchanged. Do not add write controls.

**Step 4: Prove GREEN and visual behavior**

```bash
npx vitest run intelligence/src/lib/localAnalyzeState.test.ts
npm run build:intelligence
```

Open the built Intelligence window and verify keyboard use, loading, citation expansion, narrow layout, and the current supported theme behavior.

---

## Task 12: Create the frozen local-AI evaluation and model-selection gate

**Files:**

- Create: `eval/local-ai/test-set.v1.jsonl`
- Create: `eval/local-ai/fixtures/`
- Create: `eval/local-ai/baseline.mjs`
- Create: `eval/local-ai/harness.mjs`
- Create: `eval/local-ai/harness.test.ts`
- Create: `eval/local-ai/budget.json`
- Create: `eval/local-ai/README.md`
- Create: `eval/local-ai/results/.gitkeep`
- Create: `scripts/measure-process-tree.mjs`
- Modify: `package.json`

**Step 1: Write failing harness tests**

Validate the exact 100-case mix: 40 happy path, 30 edge, 20 historical failure, 10 adversarial; at least 40 French/mixed cases; only synthetic/redistributable screenshots; no PII/client transcript content. Verify deterministic schema, citation, policy, latency, RSS, event-loop, ASR regression, installer-size, offline, and previous-run-diff calculations.

**Step 2: Prove RED**

```bash
npx vitest run eval/local-ai/harness.test.ts
```

**Step 3: Ask Claude Sonnet for baseline/harness implementation**

The baseline is deterministic: extractive summary, first-line title, lexical classification/retrieval, and OCR passthrough. Cache model outputs by model hash + prompt hash + test-set hash. Blocking v1 metrics use deterministic checks and human labels, not a cloud judge.

`measure-process-tree.mjs` samples once per second and recursively totals the whole app tree, using macOS `footprint` physical footprint and Windows `WorkingSetSize`/`PrivatePageCount`. Main `process.memoryUsage()` is not accepted as total Métis RSS. Local-job event-loop delay uses `perf_hooks.monitorEventLoopDelay()` with an immediately preceding idle baseline, and records p99/max plus ASR queued-audio milliseconds.

Add:

```json
"test:local-ai": "vitest run src/main/local-ai src/shared/local-ai.test.ts src/shared/local-routing.test.ts eval/local-ai/harness.test.ts",
"eval:local-ai:quick": "node eval/local-ai/harness.mjs --suite quick",
"eval:local-ai:full": "node eval/local-ai/harness.mjs --suite full",
"eval:local-ai:soak": "node eval/local-ai/harness.mjs --suite soak",
"smoke:local-ai": "node scripts/smoke-local-ai.mjs"
```

Quick is fixed at 20 text and 6 image fixtures plus a short accelerated transcript. Full runs all 100 text and 50 image fixtures. Soak replays a workload-equivalent 60-minute transcript 20 times with ASR concurrency and service reset, without sleeping for 20 wall-clock hours.

**Step 4: Run the text candidates**

Run Qwen3-1.7B IQ4_XS and Q4_K_M, plus official Qwen3-0.6B Q8 as the provenance/size fallback, with identical prompts on native target hardware. Record source/provenance, model/prompt/test-set hashes, output cache, TTFT, decode, RSS, event-loop, and ASR measurements. Select exactly one only if it passes:

- quality at least 85% and above baseline;
- zero fabricated citation IDs;
- at least 99% schema-valid after bounded repair;
- text TTFT <= 1.5 s p50 and <= 3 s p95;
- decode >= 15 tokens/s;
- total RSS <= 4 GB in the 60-minute simulation;
- no local-attributable event-loop stall over 50 ms;
- ASR regression under 10%;
- final artifacts under 1.9 GiB.

Prefer Qwen3-1.7B IQ4_XS if it passes quality and package gates. Ship a 0.6B candidate only if it independently passes French, citations, Intelligence, and summary gates. If no candidate passes, do not claim the text tier is releasable.

Run SmolVLM-256M-Instruct Q8 and Florence-2-base-ft Q4 against the same 50-image native Mac/Windows gate: at least 90% usable EN/FR extraction and <= 4 s p95. SmolVLM is preferred if semantic caption/text meets the product cases because its upstream provenance and package margin are stronger. Florence ships only if its all-Q4 WebGPU/WASM paths pass natively and structured OCR/regions materially improve the fixed set. Exactly one vision model ships. If neither passes both operating systems, do not ship local vision.

After both native results agree, update `candidates.json.selected` to those exact variants with `approval: release`, stage each platform without `--evaluation`, and record the decision, hashes, and deltas in `eval/local-ai/results/selection.json`. Release packaging refuses any evaluation-approved payload.

Performance reference machines are fixed: MacBook Air M1 (2020), 8 GB, macOS 14.6+ arm64; Windows 11 23H2 x64 on Ryzen 5 5600U (6C/12T AVX2) or a slower/equivalent published CPU benchmark, 16 GB RAM. Windows CPU/WASM must pass; Vulkan is an additional physical Radeon-iGPU gate and is not claimed from `windows-latest`. Every result records OS build, CPU, RAM, GPU/backend, power state, commit, model hash, and harness version. Do not silently change reference hardware to pass a budget.

---

## Task 13: Make native packaging and CI fail before upload

**Files:**

- Modify: `electron-builder.yml`
- Modify: `package.json`
- Modify: `scripts/build-installers.mjs`
- Modify: `scripts/check-release.mjs`
- Create: `scripts/check-release.test.ts`
- Create: `scripts/check-packaged-local-ai.mjs`
- Create: `scripts/smoke-local-ai.mjs`
- Create: `scripts/smoke-intelligence-analyze.mjs`
- Create: `scripts/smoke-installed-mac.mjs`
- Create: `scripts/smoke-installed-win.mjs`
- Create: `scripts/write-artifact-manifest.mjs`
- Create: `scripts/verify-artifact-manifests.mjs`
- Create: `scripts/check-soak-proof.mjs`
- Modify: `.github/workflows/build.yml`
- Modify: `.github/workflows/release.yml`
- Create: `.github/workflows/local-ai-soak.yml`
- Modify: `docs/INSTALL.md`
- Modify: `docs/SIGNING.md`

**Step 1: Write failing release-gate tests**

Extract size/asset validators into importable pure functions. Test target matrix, exact asset names, installer limit, missing model/native/license, wrong architecture, one-byte mutation, and portable/AppX/MAS exclusion.

**Step 2: Prove RED**

```bash
npx vitest run scripts/local-ai-manifest.test.ts scripts/check-release.test.ts
```

**Step 3: Ask Claude Sonnet for packaging/release integration**

- Mac commands use explicit `--arm64`; Windows uses explicit `--x64`.
- Windows target is NSIS only for this release. Remove portable from the first-release config and installer help.
- All `predist`, `dist`, `release`, and installer wrappers call local-AI and ASR checks before electron-builder.
- CI caches immutable asset directories keyed by catalog/selection hash, then stages selected-only payloads and runs no-network checks.
- PR build jobs run typecheck, unit tests, quick eval, unpacked/package smoke, package inspection, offline smoke, mutation failure, and artifact-size checks.
- `local-ai-soak.yml` runs full/soak evaluation with 240-minute timeouts on labeled reference runners (`self-hosted,metis-reference,macos,m1-8gb` and `self-hosted,metis-reference,windows,ryzen-5600u-16gb`) and uploads a signed result manifest tied to commit, model hash, measured hardware, OS, backend, and power state. If reference runners are unavailable, separately attested native results from the same commit/model are accepted only when they contain the same measurements. `check-soak-proof.mjs` validates the hardware policy and signatures, not just commit/model strings. Hosted runners prove compatibility only, never the performance budget. Soak does not run inside the short package jobs.
- Native release build jobs use `--publish never`, sign/notarize, verify, perform clean installed-package smokes, and upload workflow artifacts plus `{name,size,sha256,signature,modelHash}` manifests.
- A single `publish-release` job needs both native jobs, downloads their exact artifacts, rehashes/validates the expected set, creates an invisible draft in `mysticalsin/AskToto-Releases`, uploads DMG/ZIP/EXE/blockmaps/latest YAML without rebuilding, verifies completeness, then runs `gh release edit "$GITHUB_REF_NAME" --repo mysticalsin/AskToto-Releases --draft=false`. Any failure leaves only a draft. No platform job publishes independently.
- Native macOS and Windows runners each load text and vision, run one EN and one FR fixture, cancel generation, run Parakeet concurrently, analyze a synthetic brain fixture read-only, and close cleanly with network access blocked for model requests.
- Installed Mac smoke mounts the DMG, copies Métis to a temporary Applications directory, verifies `codesign`, `spctl`, and stapling, runs all packaged self-tests, checks the updater ZIP, and unmounts. Installed Windows smoke silently installs NSIS into a fresh temp profile, verifies Authenticode, display name and shortcut, runs all self-tests, silently uninstalls, and verifies cleanup.

**Step 4: Prove local Mac packaging**

```bash
npm ci
npm run typecheck
npm test
npm run test:local-ai
npm run eval:local-ai:quick
npm run installers:mac
node scripts/check-packaged-local-ai.mjs --platform darwin-arm64 --artifacts release
node scripts/smoke-local-ai.mjs --platform darwin-arm64 --artifacts release --offline
node scripts/smoke-local-ai-vision.mjs --platform darwin-arm64 --artifacts release --offline
node scripts/smoke-intelligence-analyze.mjs --platform darwin-arm64 --artifacts release --offline
npm run check:release -- --artifacts release
```

Expected user-visible artifacts: `Metis-1.0.0.dmg` and `Metis-1.0.0.zip`; installed app name/shortcut is `Métis`; internal identity remains `com.mantu.asktoto`.

**Step 5: Prove Windows natively**

Run the same compatibility/package gates on `windows-latest` or a real Windows x64 machine, substituting `npm run installers:win` and `--platform win32-x64`, then `npm run check:release -- --artifacts release`. Final release proof additionally runs `scripts/smoke-installed-win.mjs` against a signed NSIS build. Only the named Ryzen-reference or validated slower-equivalent attested machine can satisfy latency/RSS/soak budgets; `windows-latest` cannot. Expected artifact: `Metis-Setup-1.0.0.exe`, signed and below 1.9 GiB.

GitHub Actions currently cannot start jobs because of the account Actions budget. Continue all source and native Mac work. Record Windows as externally blocked until the budget is restored or a real Windows x64 builder is available; do not substitute a Mac cross-build.

---

## Task 14: Final review, compliance record, and release handoff

**Files:**

- Modify: `docs/design/2026-07-10-packaged-local-ai-design.md`
- Modify: this plan's `Review record`
- Create: `docs/compliance/local-ai-intended-purpose.md`
- Create: `docs/compliance/local-ai-model-card.md`
- Create: `docs/release/local-ai-verification.md`
- Modify: `README.md`

**Step 1: Run independent code review**

Review local execution, native lifecycle, offline guarantees, supply chain, IPC boundaries, read-only invariance, employment policy, cancellation, privacy logging, and release ordering. Apply findings test-first.

**Step 2: Run the complete verification matrix**

Record exact command, commit, platform, architecture, artifact path, SHA-256, size, signing/notarization result, model hash, backend, quality metrics, latency, memory, offline proof, and skipped/failed external gates. Separate local green evidence from owner-controlled release actions.

**Step 3: Complete the intended-purpose record**

Document the provisional Article 50 disclosure path and the blocked employment functionality. Mark Legal, DPO, and AI Compliance confirmation as an external deployment approval, not a source-code test. A hiring-decision use case stops release and requires Annex III assessment.

**Step 4: Self-critique and closure gate**

Before any done claim, verify:

```bash
git diff --check
git status --short
npm run typecheck
npm test
npm run build
npm run check:release -- --artifacts release
```

Also rerun both native packaged smoke matrices, scan the packaged app for forbidden remote model URLs, and compare app/installer identity against the attached Métis icon checksum. Do not touch the unrelated `Mantu.jpeg` file.

## Review record

- Baseline on commit `e5441112c7aab8d835f038b04d590c84a214d37b`: `npm run typecheck` passed.
- Initial `npm test` exposed a pre-existing integration-test defect: `src/main/dustcli.test.ts` bound to the real `dust-cli` Keychain service because its environment override ran after module import. Claude Sonnet wrote an explicit service-injection patch; Codex applied it and updated the stale missing-session assertion.
- Post-fix evidence: `npx vitest run src/main/dustcli.test.ts src/main/dust-secret-store.test.ts` passed 7/7; `npm test` passed 633/633 across 60 files; `npm run typecheck` passed.
- Runtime architecture evidence: Electron 39.8.10 launched a temporary `.mjs` successfully with `ELECTRON_RUN_AS_NODE=1` under Node 22.22.1. This proves the local development binary supports the required execution mode; the signed packaged Mac and Windows executables still require the Task 3 fuse/native smoke.
- Plan audit: two independent passes found and then cleared the test-path, StreamMeta sequencing, selected-only staging, ESM/bytecode, KV/BPE, resource-protocol, Intelligence read-only, atomic-release, Windows-blocker, and reference-hardware contradictions. No P0 plan blocker remains.
- Security follow-up outside source control: rotate the Dust OAuth session whose token appeared in the original local failure output. Do not place that token in this plan, logs, commits, or messages.
- Task 1 closed in commit `e5cbc65`: the shared local-AI, analyze, IPC, session-reuse, source-provenance, and employment-policy contracts are frozen. Evidence at close: 62 test files / 669 tests, both TypeScript projects, production build, and independent contract review passed.
- Task 2 supply-chain implementation is complete pending its dedicated commit. The tracked catalog contains five immutable variants / 21 assets; exact upstream license bytes and the conversion-provenance notice are hash-pinned. Build-time fetch is the only network-capable path; staging is selected-only, copy-only, atomic, deterministic, and checked offline for both target platforms.
- Task 2 final evidence on the uncommitted tree: focused supply-chain tests 51/51; full suite 63 files / 720 tests; both TypeScript projects; production build; current-catalog Windows stage/check; restored Darwin stage/check; and independent re-review all passed. The restored Darwin evaluation payload contains 13 files / 902,913,735 bytes and selects `qwen3-0.6b-q8-0` plus `smolvlm-256m-instruct-q8`. Catalog SHA-256 is `5ba9258faa1188245ead70824394de655566de7e2c0bb650aabd83785f8738b9`; deterministic runtime-manifest SHA-256 is `bd1ebd7b19adbc5fdb054296f09cb88ebef807db0043f7be79a8418c72809ed8`.
- Tasks 3-14 remain. Add packaged artifact hashes/sizes, native platform evidence, failures, and owner-controlled gates as each later task closes.
