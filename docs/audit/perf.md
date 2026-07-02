# Performance baseline — 2026-07-02

Measured on the built app (`npm run build`, `out/main/index.js`) via the Playwright `_electron`
harness, fresh `--user-data-dir` per run, 3 cold runs on the dev machine (Apple Silicon).

## Cold start (3 runs)

| Metric | Run 1 | Run 2 | Run 3 | Median |
|---|---|---|---|---|
| Launch → first window | 803 ms | 591 ms | 744 ms | **744 ms** |
| Launch → DOM ready | 818 ms | 603 ms | 749 ms | **749 ms** |
| Launch → interactive (first control visible) | 1015 ms | 754 ms | 895 ms | **895 ms** |

## Memory (idle, onboarding screen)

| Metric | Value |
|---|---|
| Working set, all processes | ~426–432 MB |
| Process count | 6 (main, gpu, renderer, utility ×3) |

## Bundle (out/renderer/assets, 26 MB total)

| Asset | Size | Note |
|---|---|---|
| ort-wasm-simd-threaded (onnxruntime) | 20.6 MB | ASR runtime — the price of zero-download offline transcription; loaded lazily by the whisper worker, not on boot |
| whisper.worker.js | 1.9 MB | Lazy (worker) |
| mermaid | 1.1 MB | Lazy chunk (recap rendering) |
| index.js (eager boot chunk) | **529 KB** | Was 1,714 KB at the start of this session — Settings/Review/Recall/Agenda/Answer/Copilot/BrainView are now lazy |
| Settings.js | 185 KB | Lazy |

## Improvements landed this session (before → after)

1. **Recall list/search I/O** — every call re-read AND re-decrypted every meeting file (search runs
   per keystroke; linear degradation with library size). Now a stat-validated cache: unchanged files
   cost one `stat()` — bytes read on a warm call drop to ~0 (`3f30658`).
2. **Eager boot chunk** — 1,714 KB → 529 KB (-69%) via lazy view chunks (Workstream D + BrainView
   following the same pattern).
3. **Render storms** — the 1 Hz meeting timer re-rendered the whole tree every second; now an
   isolated `<ElapsedClock>`. Bar/Answer/Copilot/QuickActions/Review memoized; transcript rows keyed
   stably (`64b4347`).
4. **useAutoResize** — `querySelectorAll('[data-overlay]')` ran per MutationObserver firing
   (~every frame while streaming); now gated behind a cheap existence check (`64b4347`).

## Watchlist (not yet optimized)

- Working set ~430 MB idle is Electron-typical but worth a pass (utility process audit) for the
  any-device goal.
- The 20.6 MB ort wasm is fetched from disk per worker spawn; worker is kept warm across sessions
  (idle-release timer) — no action needed unless memory pressure says otherwise.
- Whisper 'best' tier (WebGPU large-v3-turbo) unmeasured here; 'fast' (WASM base) is the default.
