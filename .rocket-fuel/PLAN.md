# PLAN — Local LLM ("Métis Local") in AskToto

Version: 6 (round-5 cap reached → Rule 3 tie-break: Integrator's final findings adopted
in full — combined single-artifact spike proof (--port 0 + --parallel 2 + id_slot, script
exit 0, stdout captured); v1 manifest narrowed to fully-pinned models only (0.8B + 2B);
typed llamaSlotOptions carrier replaces generic extraBody spread)
Author: Visionary (Claude Fable 5)
Date: 2026-07-10

## 1. Goal

Add an on-device LLM provider to Métis (Electron 39, TypeScript, mac arm64 + win x64) so
lightweight, latency-critical, privacy-sensitive tasks run locally and free, while heavy
tasks keep using cloud providers:

- **Local (new):** live `suggest` (what to say next), `summary` (mid-meeting summary),
  `vision` (screenshot understanding/OCR-ish reading) — user-toggleable per task.
- **Cloud (unchanged):** `recap` (post-meeting document), `answer` (brain-grounded Q&A),
  think/deep tiers, brain/graph ingest pipeline (Opus path), follow-up artifacts.

Success metric (testable): (a) routing unit tests prove that with local enabled+ready for
a task, the FIRST attempt for that task is provider `local` and no cloud attempt happens
when the local stream succeeds; (b) a failover test proves a killed sidecar falls through
to the existing cloud waterfall; (c) `node scripts/prove-local-ttft.mjs` measures suggest
first-token ≤ 1.5 s warm on this M-series Mac against the real sidecar with a 6k-char
transcript prefix.

## 2. Non-goals (v1)

- No local recap/deep-answer (quality demands cloud models).
- No change to brain/ingest.ts or graphify.ts (Opus graph pipeline reserved path).
- No Ollama/LM Studio dependency; no renderer-side inference (transformers.js/ONNX);
  no MTP/speculative decoding; no fine-tuning; no model marketplace.
- No new HTTP surface beyond loopback; the sidecar is never exposed off-device.

## 3. Research grounding (checked 2026-07-10; each claim carries its source)

- **Qwen3.5 small series** (0.8B/2B/4B/9B, released 2026-03-02): Apache 2.0, natively
  multimodal (text+image+video), 201 languages, 262k context, hybrid Gated-DeltaNet +
  sparse-MoE; needs recent llama.cpp for the new operators.
  Sources: https://www.marktechpost.com/2026/03/02/alibaba-just-released-qwen-3-5-small-models-a-family-of-0-8b-to-9b-parameters-built-for-on-device-applications/ ·
  https://huggingface.co/Qwen/Qwen3.5-0.8B (Owner-supplied; verified: exists, Apache 2.0,
  multimodal, 262k ctx) · https://unsloth.ai/docs/models/qwen3.5 ·
  https://enclaveai.app/blog/2026/03/08/qwen-3-5-complete-model-family-local-ai/
- **Speed refs:** 0.8B ≈ 55 tok/s decode M2 Air, ≈ 80 tok/s M2 Max
  (https://llmcheck.net/benchmarks); 4B ≈ 2.5 GB at Q4
  (https://willitrunai.com/blog/qwen-3-gpu-requirements). Windows-laptop tok/s: UNVERIFIED
  — no credible source found; treated as unknown, not assumed.
- **GGUF availability:** family GGUFs exist (e.g.
  https://huggingface.co/AaryanK/Qwen3.5-0.8B-GGUF, unsloth/Qwen3.5-*-GGUF collections);
  Qwen3.5 GGUFs do not work in Ollama (separate mmproj), llama.cpp-compatible backends
  required (https://unsloth.ai/docs/models/qwen3.5).
- **edge-lm (TheStageAI): rejected.** Python+MLX, Apple-Silicon-only, Gemma-4-only — no
  Windows, no Node embedding (https://github.com/TheStageAI/edge-lm).
- **node-llama-cpp: rejected as runtime, documented fallback.** v3.19.0 (2026-06-30,
  https://github.com/withcatai/node-llama-cpp/releases) has first-class Electron support
  but no vision/multimodal input in its documented feature set
  (https://node-llama-cpp.withcat.ai/guide/); sequences don't share KV; Vulkan
  multi-context flaky (https://node-llama-cpp.withcat.ai/guide/Vulkan).
- **Chosen runtime: `llama-server` (llama.cpp) sidecar.** OpenAI-compatible
  `/v1/chat/completions` incl. `image_url` with `--mmproj`; `--api-key`; `--parallel`.
  KV/prompt caching — the load-bearing mechanism is per-slot prompt caching
  (`--cache-prompt`/`--no-cache-prompt`, request field `cache_prompt` default true), NOT
  `--cache-reuse`: the live spike log (llama-spike/server3.log) prints
  "cache_reuse is not supported by multimodal, it will be disabled" after mmproj load, so
  `--cache-reuse` is omitted from spawn args entirely. The warm-prefix win is still real
  and live-proven WITH mmproj loaded (cold 453 ms → warm 222 ms, §4.4) via slot prompt
  caching; to make the hit deterministic under `--parallel 2`, prewarm + suggest requests
  pin `id_slot: 0` and summary pins `id_slot: 1` (README-documented request field).
  Slot save/restore endpoints also exist (`/slots/{id}?action=save|restore`) as a later
  option. Documented caveat: cache reuse "can cause nondeterministic results" —
  acceptable for generative suggest/summary/vision turns.
  Multimodal: https://github.com/ggml-org/llama.cpp/blob/master/docs/multimodal.md.
- **PINS (verified 2026-07-10 23:20 EDT):**
  - llama.cpp release **b9957** (published 2026-07-10; post-dates the 2026-05-16 Qwen3.5
    MTP merge, so Qwen3.5 support included): assets
    `llama-b9957-bin-macos-arm64.tar.gz` (10,737,291 B),
    `llama-b9957-bin-win-cpu-x64.zip` (18,210,179 B),
    `llama-b9957-bin-win-vulkan-x64.zip` (32,897,089 B) at
    https://github.com/ggml-org/llama.cpp/releases/download/b9957/<asset>.
    sha256 for each computed and hard-coded when fetch-llama-server.mjs is authored (R1);
    R1 also live-verifies the tag actually loads a Qwen3.5 GGUF on this mac before the
    pin is accepted.
  - GGUF repos (verified to exist via HF API): `unsloth/Qwen3.5-0.8B-GGUF`,
    `unsloth/Qwen3.5-2B-GGUF`, `unsloth/Qwen3.5-4B-GGUF` (fallback mirrors:
    bartowski/Qwen_Qwen3.5-*, lmstudio-community/*). Vision projector ships in-repo as
    `mmproj-F16.gguf` per https://unsloth.ai/docs/models/qwen3.5. Quant: UD-Q4_K_XL
    (unsloth-recommended) with Q4_K_M fallback. Per-model pin status (honest):
    **0.8B FULLY PINNED + LIVE-PROVEN** — `Qwen3.5-0.8B-UD-Q4_K_XL.gguf` 558,772,480 B
    sha256 3177ebd67afe4438374da19e690bc1b98756f7e0fea9240e1be404336156a7b5 +
    `mmproj-F16.gguf` 204,987,232 B sha256
    56e4c6cfe73b0c82e3e82bc518d7591997e61d81f723fc41a586f4fa69ea2453 (spike §4.4).
    **2B FULLY PINNED** — `Qwen3.5-2B-UD-Q4_K_XL.gguf` 1,339,752,704 B sha256
    0af96165ea615bea39a04118d63f0b6d35908aea850ee4a51aa6151d851b8b35 + `mmproj-F16.gguf`
    668,227,264 B sha256
    7035e9cb8d7c6a9681d07eef9a364783e86ea4cd73faab2eabb4f43a101830c7 (real downloads,
    llama-spike/Qwen3.5-2B-UD-Q4_K_XL.gguf + mmproj-2B-F16.gguf).
    **4B** — filenames+sizes HF-API-verified (`Qwen3.5-4B-UD-Q4_K_XL.gguf` 2,912,109,728 B,
    `mmproj-F16.gguf` 672,423,616 B); sha256 NOT YET PINNED — an explicit R2 step via the
    same real-download procedure. No other pins remain open.
  - Sampling defaults for the local strategy (unsloth-documented, non-thinking):
    temperature 0.7, top_p 0.8, top_k 20, min_p 0 — thinking mode stays disabled.
  - Memory guidance (unsloth table, total memory incl. context at 4-bit): 0.8B/2B ≈
    3.5 GB, 4B ≈ 5.5 GB → manifest minTotalRamGB: 8 (0.8B), 8 (2B), 16 (4B).
  - STILL OPEN: per-file sha256 pins (R1/R2 author-time); 0.8B-vs-2B screenshot
    spot-check before finalizing the default (R2).

## 4. Architecture

### 4.1 Shape

```
Electron main process
├── src/main/llm/local-runtime.ts   NEW — sidecar lifecycle + per-session api key
├── src/main/llm/local-models.ts    NEW — model manifest + download/verify/delete
├── src/main/llm/local.ts           NEW — provider strategy (thin shim over streamOpenAI)
├── src/main/llm.ts                 EDIT — case 'local' in createStream
├── src/main/index.ts               EDIT — eligibility, key injection, local-first routing,
│                                          localReady in settings snapshot, prewarm handler
├── src/main/store.ts               EDIT — ENV_VAR gains `local: ''`; localLlm settings defaults
src/shared/providers.ts             EDIT — ProviderId 'local', ProviderKind 'local', PROVIDERS entry
src/shared/ipc.ts                   EDIT — ProviderIdSchema gains 'local' (parity guard
                                          ipc.ts:23-31 forces this); new channels: local:prewarm,
                                          localModels:list/download/cancel/delete + progress event
src/preload/index.ts                EDIT — expose the new local IPC (metadata only)
src/renderer/src/components/Settings.tsx  EDIT — "Local AI" card
src/renderer/src/App.tsx            EDIT — proactive gates include localReady; summary Dust-cascade
                                          conditioned; prewarm sender in the instant-suggestions effect
src/renderer/src/state.ts           EDIT — settings snapshot type additions
scripts/fetch-llama-server.mjs      NEW — pinned runtime download (mac arm64 + win x64 assets)
scripts/check-llama-sidecar.mjs     NEW — packaging guard (fails hard when target-platform binary missing)
scripts/build-installers.mjs        EDIT — run the guard for EVERY target it builds
.github/workflows/release.yml       EDIT — guard step on both platform jobs
electron-builder.yml                EDIT — extraResources ships resources/llama/<platform>/;
                                          mac signing covers the binary (Gatekeeper-safe)
```

### 4.2 Why sidecar (vs node-llama-cpp addon / renderer ONNX)

1. Vision day-1 via `--mmproj` through the OpenAI-compatible endpoint —
   src/main/llm/openai.ts already sends screenshots as data-URI `image_url`
   (openai.ts:10-17) and already retries without `stream_options` for endpoints that
   reject it (openai.ts:28-33, 110-119). The local strategy is a config shim, not a new
   streaming client.
2. Growing-transcript latency: server-side per-slot prompt caching (cache_prompt,
   default on) + id_slot pinning reuses the transcript-prefix KV across requests — no
   custom KV engineering.
3. Process isolation: a 1-3 GB inference runtime cannot take down the app.
4. Packaging: explicit pinned binaries via fetch script + hard guard = the repo's
   existing ffmpeg-sidecar pattern; avoids the npm optional-natives cross-build trap
   already documented for sherpa-onnx.

### 4.3 Provider integration (every seam, file:line)

- **Types:** `ProviderId` + `ProviderKind` gain `'local'` (src/shared/providers.ts:1-18);
  `ProviderIdSchema` z.enum gains `'local'` (src/shared/ipc.ts:4-21) — the compile-time
  parity guard (ipc.ts:23-31) enforces both sides move together.
- **Registry:** PROVIDERS entry `local` — label "Métis Local · on-device",
  `tier: 'featured'`, `kind: 'local'`, `vision: true`, `models` = manifest ids,
  `defaultModel: 'qwen3.5-2b'`, `fastModel: 'qwen3.5-0.8b'`, keyHint/keyPattern/keyUrl ''.
- **Key plumbing:** src/main/store.ts ENV_VAR (store.ts:26-43) gains `local: ''`.
  getApiKey('local') stays '' — attempt()'s key resolution (index.ts:2018) branches:
  `provider === 'local' ? localRuntime.sessionKey() : getApiKey(provider)`. The
  per-session sidecar key lives only in local-runtime.ts memory.
- **StreamOptions extension (one optional, NARROW field):** shared.ts StreamOptions
  gains `llamaSlotOptions?: { id_slot?: number; cache_prompt?: boolean }` and openai.ts
  copies EXACTLY those two keys into the request params when present
  (`if (opts.llamaSlotOptions) { params.id_slot = …; params.cache_prompt = … }`) — never
  a generic spread, so no caller can ever override messages/model/stream through it.
  Only streamLocal sets it (suggest/prewarm → {id_slot: 0, cache_prompt: true}; summary →
  {id_slot: 1, cache_prompt: true}); every other provider leaves it undefined and their
  request bodies are byte-identical to today's.
- **Eligibility (mode-scoped, enforced at BOTH gates):** `local` is eligible iff
  `settings.localLlm.enabled` AND runtime binary present AND selected model downloaded
  AND allowlist-ok AND **the request is in-scope: `req.mode` ∈ {suggest, summary, vision}
  AND matching `localLlm.useFor.*` on AND tier === 'base'**. The mode-scope check lives in
  a single `localEligibleFor(req, s, tier)` helper called by attempt()'s ineligibility
  chain (index.ts:2039-2051) AND pickFailover's candidate filter (index.ts:1977-1991) —
  so neither failover nor a `providerOverride: 'local'` can route answer/recap/think/deep
  to the local model; an out-of-scope override surfaces the standard ineligible
  streamError message ("Métis Local handles live suggestions, summaries and screenshots —
  this request type uses your cloud provider."). Replaces the API-key/model checks for
  this provider (mirrors the kind==='cli' exemptions at index.ts:1982-1989, 2039-2046).
- **Routing precedence (explicit):** index.ts:2177 becomes
  `attempt(req.providerOverride ?? localPrimary ?? cliPrimary ?? s.provider, [])` where
  `localPrimary = 'local'` iff local is eligible AND `req.mode` ∈ {suggest, summary,
  vision} AND the matching `localLlm.useFor.*` toggle is on AND tier === 'base'
  (routeTier unchanged). providerOverride keeps absolute priority (Spotlight-Ref/cascades).
  think/deep tiers and answer/recap never resolve localPrimary in v1.
  **Org allowlist gate:** localPrimary AND localReady both require
  `!allowed || allowed.includes('local')` (same getAllowedProviders() source attempt()
  enforces at index.ts:2008-2016) — so an org that excludes 'local' never gets a blocked
  first attempt with no failover (the attempted.length === 0 streamError branch), and
  pickFailover's existing allowlist check keeps it out of the waterfall too.
- **Renderer summary cascade fix:** App.tsx (~1568) currently forces
  `providerOverride: 'dust'` when Dust is ready; becomes conditional:
  `dustReady && !settings?.localSummaryReady` — so the user's local-summary choice wins,
  and Dust cascade remains the default otherwise.
- **Public readiness (every consumer enumerated):** settings snapshot (index.ts:613-630)
  gains `localReady: boolean` (enabled + runtime + model + allowlist) and per-task
  `localSuggestReady/localSummaryReady/localVisionReady`. Renderer call-sites updated:
  (a) proactive gates `providerReady` → `providerReady || localSuggestReady` at
  auto-answer-on-question (App.tsx ~557), no-decision honk (~583), instant-suggestions
  effect (~866); (b) **user-initiated gates** — the providerReady requirement in the
  ready-check helper region (App.tsx ~607-611) and its callers answerNow (~858-863) and
  askScreen (~620-625) become `providerReady || <task-matching local*Ready>`, so a
  local-only setup answers instead of bouncing to Settings; (c) main's `visionReady`
  export ORs localVisionReady, AND **`visionAvailable`** ("some provider can read
  images") ORs localVisionReady too — covering quick-action capture routing
  (App.tsx ~814, ~893, ~1548) and the Bar prewarm (~1999). **SettingsPatch hygiene:** all derived local* readiness fields join
  the existing derived-field omit list in the SettingsPatch schema (src/shared/ipc.ts
  ~641-654), same as providerReady/hasKeys — a renderer patch can never carry them and
  main never persists them.
- **providerVisionOk('local')** = static true (mmproj ships with every manifest model).
- **Idle budget:** suggest keeps its 15 s budget (index.ts:2071-2082) — warm local TTFT
  target ≤ 1.5 s sits far inside it.
- **Privacy:** `redactSecrets` (index.ts:1943) keeps running for local too in v1 (zero
  behavior divergence; relaxation is a possible later phase).
- **Audit:** existing auditLog('provider.request', …) path works unchanged for 'local';
  new events: local.runtime.start/stop/crash/restart, local.model.download/verify/delete.

### 4.4 Sidecar contract

Spawn (mac): `llama-server -m <model.gguf> --mmproj <mmproj.gguf> --host 127.0.0.1
--port 0 --api-key <32-byte hex, per session> -c 8192 --parallel 2 -ngl 99 --no-ui
--jinja --reasoning off`
`--port 0` ephemeral bind LIVE-PROVEN (llama-spike/server-port0.log:
"listening on http://127.0.0.1:60310") — local-runtime.ts parses the bound port from
that exact log line, then health-polls it. `--reasoning off` is the current flag (the
spike logs print: "Setting 'enable_thinking' via --chat-template-kwargs is deprecated.
Use --reasoning on / --reasoning off instead."); `--no-ui` replaces deprecated
--no-webui. `--cache-reuse` deliberately absent (disabled for multimodal — §3).
Windows: same; GPU offload only when the Vulkan build initializes, else CPU build.
**LIVE-PROVEN (spike, this mac, 2026-07-10 23:33 EDT — /Users/tony/AI-Brain-build/llama-spike):**
b9957 (tar sha256 7a43fd3c4ddd…056f) + unsloth Qwen3.5-0.8B-UD-Q4_K_XL.gguf (sha256
3177ebd67afe4438374da19e690bc1b98756f7e0fea9240e1be404336156a7b5) + mmproj-F16.gguf
(sha256 56e4c6cfe73b0c82e3e82bc518d7591997e61d81f723fc41a586f4fa69ea2453):
health after ~9 s model load; text turn 174 ms (French output verified); vision turn
239 ms via data-URI image_url; prefill 419 tok/s, decode 140 tok/s. Screenshot
spot-check (0.8B, synthetic slide, 5 embedded facts): 5/5 extracted, structured, 1584 ms
(llama-spike/ocr-spike.py).
**COMBINED SINGLE-ARTIFACT PROOF (llama-spike/server-combined.log +
spike2-combined.out, 2026-07-11 — script exit 0):** the planned spawn line VERBATIM
including `--port 0` and `--parallel 2` → log prints `n_slots = 2` and
`listening on http://127.0.0.1:60657` (port parsed from that line, exactly as
local-runtime.ts will); spike2.py run against the parsed port with explicit `id_slot` +
`cache_prompt: true` on every request: slot-0 cold 464 ms (prompt_n=1385, cache_n=0) →
slot-0 warm 188 ms (cache_n=869 prefix tokens reused) → slot-1 unrelated request
isolated (cache_n=0) → slot-0 grown-transcript delta 245 ms (cache_n=869). The script's
own assertion (cache_n>0 AND warm<0.8×cold AND ≤1.5 s) prints PROVEN and exits 0; stdout
captured at llama-spike/spike2-combined.out. Honest reading: slot-pinned reuse is REAL
but PARTIAL (869/1385 tokens — mtmd chunking boundary suspected); the latency contract
is met with ~6× margin; the plan claims the measured numbers, not full-prefix
determinism. Discovery folded in: without reasoning disabled, Qwen3.5 emits into
`reasoning_content` and `content` comes back empty — `--reasoning off` is mandatory (the
spike logs name the deprecated kwargs alternative), and the strategy tolerates
`reasoning_content` anyway (openai.ts:98 already pings the watchdog on it).
- Port: OS-assigned ephemeral; api-key: generated per app session, main-memory only,
  never logged/persisted/sent to renderer.
- Lifecycle: start on first local request OR meeting start (pre-warm) when a local task
  is enabled; idle-stop after 15 min without meeting/request; kill on app quit
  (before-quit). One automatic restart per 10-minute window, then local marked
  unavailable for the session (audit-logged) and the waterfall covers.
- Health: poll `GET /health` until 200 — budget 30 s mac / 60 s win (Defender first-run).
- **Pre-warm path (new IPC):** channel `local:prewarm` (shared/ipc.ts + preload). The
  renderer's instant-suggestions effect region (App.tsx ~866, listen.lines watcher)
  additionally sends a debounced (~5 s) transcript tail over local:prewarm while a
  meeting is live and localSuggestReady; main handler forwards to
  localRuntime.prewarm(text) → POST /v1/chat/completions with max_tokens=1, id_slot: 0,
  and the same system+transcript prefix a real suggest would use (suggest also pins
  id_slot: 0), so per-slot cache_prompt keeps the KV hot and the click-time request pays
  only the delta.
  Renderer never learns port/key; payload is transcript text that never leaves the device.

### 4.5 Model manifest + runtime provisioning

- `LOCAL_MODELS` manifest (local-models.ts): id, label, gguf {url, sha256, bytes},
  mmproj {url, sha256, bytes}, minTotalRamGB, blurb. **Manifest law: a model may enter
  the manifest ONLY with a real-download-verified sha256 — no placeholder or
  promised-later pins.** v1 ships exactly the two fully-pinned models:
  `qwen3.5-0.8b` (lite — Owner's pick) and `qwen3.5-2b` (default), UD-Q4_K_XL quants +
  mmproj-F16 (§3 pins). `qwen3.5-4b` (quality tier, ≥ 16 GB) is a documented follow-up
  that enters the manifest only once its sha256 is pinned the same way — it is NOT in
  the v1 manifest.
- Download: HTTPS huggingface.co, Range-resume, IPC progress events, streamed sha256,
  reject+delete on mismatch. Storage: `app.getPath('userData')/local-llm/models/`.
- Runtime: `scripts/fetch-llama-server.mjs` downloads PINNED llama.cpp release assets
  (tag + sha256 constants in-script) for the REQUESTED target platform(s) into
  `resources/llama/<platform>/`; `scripts/check-llama-sidecar.mjs <platform>` fails hard
  when the target platform's binary is missing. **Wiring — every path that runs
  electron-builder, mirroring the existing check-ffmpeg-sidecar pattern exactly:**
  package.json chains `predist` (covers `dist`), `predist:win` (covers `dist:win` — npm
  runs pre-hooks for colon-named scripts too), `dist:local`, `dist:win:appx`, `release`,
  `release:win`, `release:mas`, `release:win:store` each gain
  `node scripts/fetch-llama-server.mjs <plat> && node scripts/check-llama-sidecar.mjs <plat>`
  alongside their existing ffmpeg/sherpa checks; scripts/build-installers.mjs adds the
  same per-target; .github/workflows/build.yml adds `resources/llama` to the cache paths
  (key extended with hashFiles of fetch-llama-server.mjs) on BOTH platform jobs
  (~lines 125-133 mac, ~198-206 win); release.yml gets the same guard step per platform.
  electron-builder.yml ships `resources/llama/<platform>/` via extraResources; macOS
  signing covers the binary (bundle-and-sign, never download-at-first-run → Gatekeeper).
- App size cost: ≈ 5-40 MB per platform. Accepted.

### 4.6 Settings UI (renderer)

"Local AI" card in src/renderer/src/components/Settings.tsx (following existing provider
card patterns), backed by new IPC (shared/ipc.ts channels, preload/index.ts exposure,
state.ts snapshot types): enable toggle; model picker with size/RAM guidance; download
progress + cancel; delete model; three use-for checkboxes (Live suggestions, Summaries,
Screenshots); status line (runtime state, model loaded). Renderer receives ONLY metadata
(states, progress %) — never paths, port, or api-key.
**Generic provider UI exclusion:** the generic provider/key surfaces in Settings.tsx
(provider tiles + key entry/save/test flows, ~96-100 and ~643-657) explicitly skip
`kind === 'local'` — Métis Local renders ONLY through its dedicated card; no key row, no
testApiKey path, no add-key CTA for a keyless provider.

## 5. Error matrix

| Failure | Signal | Handling |
|---|---|---|
| Sidecar binary missing/corrupt | spawn ENOENT / sha mismatch | local ineligible; Settings: "runtime missing — reinstall"; audit local.runtime.missing |
| Port bind race | server exits non-zero at start | retry once, fresh ephemeral port |
| Model checksum mismatch (download) | streamed sha256 ≠ manifest | delete file; "download corrupted — retry"; audit local.model.checksum_fail |
| Model corrupt on load | server exits during load | mark bad, prompt redownload (no silent delete) |
| OOM / insufficient RAM | load fail / os.totalmem gate | RAM gate blocks download+load; suggest smaller model |
| Sidecar crash mid-stream | stream aborts | onError → existing waterfall failover; ≤ 1 auto-restart / 10 min |
| Health timeout | no 200 in budget (30 s mac / 60 s win) | treat as crash path |
| First token > idleMs | idleWatchdog (shared.ts:53) | unchanged — failover fires |
| App quit | before-quit | kill sidecar, clean temp |

## 6. Standards

- Repo conventions: TS strict; colocated `*.test.ts` (vitest); comments explain
  constraints, not mechanics; `npm run typecheck` (both tsconfigs) + `npm test` green.
- Security: renderer sandbox/contextIsolation untouched; loopback-only sidecar +
  per-session api-key; HTTPS + sha256-pinned downloads; VISION_GUARD retained on local
  vision; no paths/port/key over IPC; audit events as §4.3.
- No placeholders, no TODO-stubs; every rock lands with its tests.

## 7. Risks

1. Qwen3.5 GGUF/mmproj naming or availability differs → R2 verification-first; fall back
   official→unsloth; if 2B mmproj missing, default flips to 0.8B (Owner-suggested via the
   huggingface.co/Qwen/Qwen3.5-0.8B link; quality still validated by R2's screenshot +
   suggest spot-check, not assumed).
2. Pinned llama.cpp release regression → R1 verifies the tag loads Qwen3.5 on mac before
   pinning; upgrade = one-line change in fetch script.
3. Windows Defender slow first spawn → 60 s health budget + status UI; live win smoke is
   an explicit G6 residual (no win hardware in this engagement — CI guard + parameterized
   tests cover what's coverable).
4. 0.8B suggest quality disappoints → default 2B; per-task toggles keep any task on cloud.
5. OneDrive checkout quirks → all work in the local-disk worktree.

## 8. Draft rocks (proof commands lock at approval)

## Rock 1: Provision and manage the llama-server sidecar runtime
Owner: Integrator (built by Sonnet executor under Visionary review)
Due: engagement day 1
Done means: pinned llama-server fetch+verify for mac arm64 AND win x64 assets, spawn/health/idle/kill lifecycle proven on mac arm64 (port parsed from the --port 0 "listening on" log line), guard script fails hard on missing target binary, guard wired into EVERY electron-builder path: predist, predist:win, dist:local, dist:win:appx, release, release:win, release:mas, release:win:store, build-installers.mjs, and build.yml both platform jobs — with a wiring-assertion unit test that greps package.json scripts and .github/workflows/build.yml for the guard invocations, so missing wiring fails the suite mechanically.
Proof: `npm test -- local-runtime` → exit 0 (real fetched mac binary spawn→health 200→kill; win asset fetch + guard failure cases platform-parameterized; wiring-assertion test green)
Status: NOT STARTED

## Rock 2: Model manifest, download, verify, delete
Owner: Integrator (Sonnet executor)
Due: engagement day 1
Done means: manifest containing EXACTLY the fully-pinned v1 models (qwen3.5-0.8b + qwen3.5-2b, URLs/sha256/bytes from §3 pins; a manifest-shape test asserts every entry carries a 64-hex sha256 for both gguf and mmproj, so an unpinned entry can never ship), Range-resume download with IPC progress, streamed sha256 rejection, RAM gating, delete.
Proof: `npm test -- local-models` → exit 0 (checksum-reject + manifest-shape/pin-enforcement + RAM-gate cases green)
Status: NOT STARTED

## Rock 3: `local` provider strategy + routing integration
Owner: Integrator (Sonnet executor)
Due: engagement day 2
Done means: ProviderId/ProviderKind/ProviderIdSchema 'local' (parity guard green) + ENV_VAR entry + PROVIDERS entry + streamLocal shim; eligibility, session-key injection, localPrimary precedence (override > local > cliPrimary > s.provider), localReady/per-task readiness in settings snapshot, renderer gate + summary-cascade conditioning; failover on local failure proven; think/deep/recap/answer never local.
Proof: `npm run typecheck && npm test -- local-routing` → exit 0
Status: NOT STARTED

## Rock 4: Settings "Local AI" card + IPC surface
Owner: Integrator (Sonnet executor)
Due: engagement day 2
Done means: Settings.tsx card (toggle, model picker + RAM guidance, download progress/cancel, delete, use-for checkboxes, status), new channels in shared/ipc.ts, preload exposure, state.ts types; metadata-only IPC.
Proof: `npm run typecheck && npm test` → exit 0 (full suite incl. new tests)
Status: NOT STARTED

## Rock 5: Warm-cache pre-warm + end-to-end latency proof
Owner: Integrator (Sonnet executor); e2e proof run by Visionary
Due: engagement day 3
Done means: local:prewarm IPC (renderer debounce ~5 s in the instant-suggestions effect region) → main → 1-token prefix POST keeping sidecar KV hot; e2e script downloads the lite model, spawns runtime, prefills 6k-char transcript, measures warm suggest TTFT.
Proof: `node scripts/prove-local-ttft.mjs` → prints `warm TTFT: <n> ms` with n ≤ 1500 on this M-series Mac, exit 0
Status: NOT STARTED

## 9. Estimate (Owner-facing, pre-build)

Tokens 600k-1.2M · wall-clock 1.5-3 h autonomous · cost ≈ $25-50 (Sonnet execution +
Fable planning/review; Codex on subscription). Hard stop + honest report if exceeded.
