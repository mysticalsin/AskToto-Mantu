# Frontend Performance Report — AskToto

**Scope:** renderer bundle size & code-splitting, streaming render cost (rAF batching), shiki/highlight cost,
lazy/Suspense views, the whisper/ONNX worker, and packaging weight.
**Date:** 2026-06-27. Measured against the **current** build in `out/renderer/` (not the stale `release/`).

---

## Verdict (Gate 3 — Performance sub-area)

**PASS with a MEDIUM trim opportunity.** The streaming hot path is correctly optimized (one render per frame,
debounced re-highlight), heavy views and the 22 MB ONNX runtime are lazy/gated, and the shiki grammar set is
genuinely trimmed in the current build. The eager `index-*.js` is 3.6 MB (markdown+shiki ride along eagerly),
and the shipped `release/` artifacts are stale and bloated — both should be addressed before release.

---

## Measured bundle (current build)

`ls out/renderer/assets` → 16 files; `find … -name '*.js' | awk` → **6.31 MB across 10 JS files**;
`du -sh out/renderer/assets` → **27 MB** (dominated by the lazy ONNX wasm).

| Asset | Size | Load timing |
|---|---|---|
| `index-DnDNGlA-.js` (eager app bundle) | **3.6 MB** | startup |
| `whisper.worker-*.js` | 1.9 MB | lazy — first Listen only |
| `wasm-DDgzZJey.js` (shiki oniguruma engine) | 608 KB | lazy — first code block |
| `ort-wasm-simd-threaded.jsep-*.wasm` (ONNX) | **20.6 MB** | lazy — first Listen only |
| `Settings-*.js` | 217 KB | lazy — open Settings |
| `Review-*.js` / `RecallView-*.js` | 10 KB / 12 KB | lazy |
| `index-*.css` | 57 KB | startup |
| fonts (geist, inter woff2) | 28 KB / 47 KB | startup, `font-display: swap` |

### P1 — Eager `index.js` is 3.6 MB; markdown+shiki load before first answer (MEDIUM)
- **Evidence:** `CodeBlock.tsx` statically imports `shiki/core` + 25 grammars; it is pulled by
  `Markdown ← Answer ← App` (all eager in `App.tsx:2-4`), so React + streamdown + shiki-core + 25 langs +
  lucide all land in the startup bundle. The oniguruma **wasm** engine is correctly dynamic
  (`import('shiki/wasm')`, `CodeBlock.tsx:56`) → its 608 KB is split out.
- **Impact:** for an overlay meant to appear instantly, 3.6 MB of uncompressed JS is parsed/compiled at launch
  off local disk (no network, no gzip). Modest (~low-hundreds of ms) but avoidable, since markdown rendering
  is only needed *after* the first answer/suggestion.
- **Fix:** `lazy()` the `Answer`/`Markdown`/`CodeBlock` subtree (as already done for Settings/Review/Recall) so
  shiki+streamdown load on first answer rather than at startup.

### P2 — shiki grammar set IS trimmed in the current build (PASS)
- **Evidence:** `CodeBlock.tsx:4-60` uses `createHighlighterCore` with a curated 25-language list instead of
  shiki's full ~200-grammar bundle. The current `out/renderer/assets/` contains **no** per-language grammar
  chunks (only 16 files total; 4 are <10 KB). The trim is effective. (The full grammar set only appears in the
  **stale** packaged asar — see P5.)

### P3 — Streaming render is rAF-batched (PASS)
- **Evidence:** `state.ts:74-111` (`useAsk`) buffers stream deltas in `pendingRef` and flushes **once per
  `requestAnimationFrame`**, with an explicit drain on done/error. Comment documents the intent: without this,
  every token re-renders the whole markdown and Streamdown re-lexes the growing string → O(n²). This is the
  single most important perf decision in the renderer and it is implemented correctly.
- **Reinforced by:** `CodeBlock.tsx:68-81` debounces shiki re-highlight ~90 ms after the last token (avoids
  re-highlighting on every keystroke of a streaming code fence); `useAutoResize` rAF-throttles the
  ResizeObserver→`window.toto.resize` IPC (`state.ts:28-46`).

### P4 — ONNX/whisper worker is lazy and user-gated (PASS, one perceived-latency note)
- **Evidence:** the worker is created on demand via `new Worker(new URL('./whisper.worker.ts', …))` inside
  `ensureWorker` (`listen.ts:90-92`), and `optimizeDeps.exclude: ['@huggingface/transformers']` +
  `worker.format: 'es'` keep transformers out of the eager graph (`electron.vite.config.ts`). The 20.6 MB ONNX
  wasm and 1.9 MB worker therefore load only on the first Listen.
- **Note (MEDIUM, perceived):** on first Listen the model is also downloaded from the HF CDN; the UI shows
  "loading transcription model…" (`Copilot.tsx:160-163`) but there is no byte-progress, and the wasm/model are
  not pre-warmed. Acceptable, but a pre-fetch-on-idle or progress bar would improve first-use feel.

### P5 — Stale, bloated `release/` artifacts (MEDIUM, release hygiene)
- **Evidence:** `release/AskToto-Portable-0.1.0.exe` is 178 MB and the macOS `app.asar` is 52.8 MB; `asar list`
  shows it contains the **full ~200 shiki grammars** (`/out/renderer/assets/abap-*.js`, `ada-*.js`, …) plus
  third-party `.map` files — none of which the current source produces. The artifacts predate the shiki trim.
- **Fix:** rebuild `release/` from current source before shipping; broaden the electron-builder exclude to
  `'!**/*.map'` so dependency maps and any stray grammar chunks are dropped.

### P6 — `backgroundThrottling: false` (informational)
- **Evidence:** `index.ts:160`. Keeps the overlay/stream responsive when unfocused at a small idle-CPU/battery
  cost. Intentional for a live copilot; noted for completeness.

---

## N/A (justified)
- **Core Web Vitals (LCP/CLS/INP), HTTP caching, CDN, image optimization, code-splitting by route, lazy
  hydration** — N/A: not a web page; assets load from local disk via `file://`, there is no router and no
  network for first paint. The relevant analogues (startup parse cost, streaming render cost, lazy heavy
  modules) are assessed above.
- **Server response time / TTFB / SSR** — N/A: no server.

## Commands run
`ls out/renderer/assets | wc -l` · `find out/renderer/assets -name '*.js' -exec ls -l {} \; | awk` ·
`du -sh out/renderer/assets` · `asar list release/mac-arm64/AskToto.app/Contents/Resources/app.asar` ·
file reads of `state.ts`, `CodeBlock.tsx`, `electron.vite.config.ts`.
