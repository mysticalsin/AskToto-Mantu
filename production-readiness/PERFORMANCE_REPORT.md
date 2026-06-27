# AskToto — Performance Report

Date: 2026-06-27. AskToto is a **single-user local desktop overlay**. The meaningful performance axes are
**startup, streaming-render smoothness, transcription latency/throughput, bundle size, and memory** —
not requests-per-second. Server-style load/stress/soak and SLO/SLA targets are **N/A** (justified in §6).

## 1. Bundle size (measured — `npm run build`)

| Artifact | Size | Notes |
|----------|------|-------|
| `out/main/index.js` | 107.34 kB | main process |
| `out/preload/index.js` | 118.41 kB | bundles zod (sandboxed preload can't `require` externals) |
| renderer `index-*.js` | **3,730.85 kB** | first-paint critical chunk — large |
| `Settings-*.js` (lazy) | 222.60 kB | `React.lazy`, off critical path (App.tsx:8) |
| `Review-*.js` / `RecallView-*.js` (lazy) | 10.35 / 11.90 kB | lazy |
| `whisper.worker-*.js` | 2,001.74 kB | loaded only on first Listen |
| `ort-wasm-simd-threaded.jsep-*.wasm` | **21,596.02 kB** | onnxruntime-web; fetched into worker, not at boot |
| `index-*.css` | 58.28 kB | Tailwind v4 |
| fonts | 76.66 kB | inter + geist woff2 |

**Findings**
- **P-PERF-1 (MEDIUM):** the main renderer chunk is ~3.7 MB minified. Code-splitting exists for routes
  (Settings/Review/RecallView) but the core overlay + markdown/shiki/streamdown stack ships in one chunk.
  This is fine for a locally-installed desktop app (no network fetch) but inflates parse/compile on
  cold start. Opportunity: split shiki/streamdown (syntax highlighting is only needed when an answer
  contains code) behind the same lazy pattern.
- **P-PERF-2 (LOW/by-design):** the 21.6 MB ORT WASM and 2 MB worker load **lazily on first Listen**, so
  they don't tax startup. `optimizeDeps.exclude: ['@huggingface/transformers']` and `worker.format:'es'`
  (electron.vite.config.ts:39-40) keep them out of the pre-bundle.

## 2. Startup
- Window is `frame:false, transparent:true`, `backgroundThrottling:false`, sandboxed renderer. The bar is
  64 px and paints immediately; heavy routes are lazy. No synchronous network on boot.
- `loadDotEnv()` runs only when **not packaged** (index.ts:700) — no prod disk scan.
- Main-thread sync FS at startup is minimal (settings read). **Known mediums** (deferred): `recall.ts`
  list/search and `transcripts.ts` writes use synchronous `fs` on the main thread — see §4.

## 3. Streaming render (the hot path) — VERIFIED GOOD
`state.ts useAsk` batches streamed tokens to **one flush per animation frame** via `requestAnimationFrame`
(state.ts:75-90): deltas accumulate in `pendingRef`, a single rAF coalesces them, and `setAnswer` runs
once per frame. The inline comment states the intent — without this, every token re-renders the whole
markdown answer and Streamdown re-lexes the growing string → **O(n²)** on fast providers. `onDone`/`onError`
drain the buffer before settling. This is the correct, senior-grade fix and is the single most important
runtime-perf decision in the app. (Not yet covered by an automated test — see COVERAGE_REPORT §5.3.)

Auto-resize (`useAutoResize`, state.ts:28-46) is likewise rAF-debounced over a `ResizeObserver`, and uses
a **callback ref** so it re-attaches across the bar↔Settings unmount/remount (avoids a stuck observer).

## 4. Transcription latency / memory (Whisper worker)
- Model: `Xenova/whisper-tiny` multilingual, `dtype:'q8'` (whisper.worker.ts:19) — small/quantized for
  on-device, low-latency live transcription. Inference runs in a Web Worker, off the UI thread.
- **Bounded memory:** the capture queue is capped at `MAX_QUEUE = 24` (~2.4 min of 6 s windows);
  overflow drops oldest (listen.ts:6,136-138). The worklet posts Float32 windows transferred (zero-copy)
  via `postMessage([buffer])` (listen.ts:85). The worker emits exactly one terminal reply per job so the
  renderer queue can never wedge (whisper.worker.ts:33-35). On stop/unmount, channels close, tracks stop,
  AudioContexts close, worker terminates (listen.ts:235-271).
- **P-PERF-3 (MEDIUM, supply-chain + cold-start):** the ONNX model is fetched from the HF CDN on first
  Listen with **no subresource integrity** (env.allowLocalModels=false; no bundled model). First-Listen
  latency depends on network, and there's no integrity pin. (Tracked as a known security/reliability gap.)

## 5. Other measured-good micro-optimizations
- Vision screenshots capped at ≤1568 px longest edge + JPEG q88 before send (index.ts:466-474) to cut
  payload/latency — chosen for Claude vision limits.
- `max_tokens: 4096` cap on Anthropic/OpenAI streams (llm.ts) bounds output cost/latency.
- Meeting poller runs every 7 s with an in-flight overlap guard (`meetingDetecting`, index.ts:312-335) —
  no pile-up.

## 6. N/A axes (justified — local desktop, single user)
| Axis | Status | Justification |
|------|--------|---------------|
| Requests/sec, concurrency, RPS | **N/A** | No server/endpoint. The app calls the user's own LLM provider one stream at a time; prior stream is aborted before a new one starts (state.ts:123). |
| Load test | **N/A** | No multi-user surface to load. |
| Stress test | **N/A** | The only unbounded input (audio) is already bounded by MAX_QUEUE; transcript size is sliced (llm.ts userText `.slice(-6000..-16000)`). |
| Soak/endurance | **PARTIAL/N/A** | Long-session leak risk is mitigated by channel teardown + queue cap + worker terminate. No automated 8-hour soak run exists → recommend one manual long-Listen session before GA to confirm no AudioContext/worker leak. |
| SLO/SLA, latency percentiles | **N/A** | No service contract; latency is the upstream provider's + local model's. |
| Throughput/QPS targets | **N/A** | Same as above. |

## 7. Recommended performance actions
1. Lazy-split shiki/streamdown so the 3.7 MB chunk shrinks for the common no-code answer.
2. Bundle (or integrity-pin) the Whisper model to remove first-Listen network dependency + add SRI (P-PERF-3).
3. Move `recall.ts` list/search and `transcripts.ts` writes off the main thread (async fs / worker) — the
   known sync-fs mediums; matters as the transcript folder grows (see CAPACITY_PLAN.md).
4. Add one manual soak run (≥1 h continuous Listen) to confirm flat memory.
