# AskToto — Architecture & Current State

**Date:** 2026-07-02 · **Branch:** `feat/ux-fixes-models-cli-integration` (49 commits ahead of origin/main)
**Distilled from:** staff engineer, main-process perf, React perf, audio/DSP, ASR/ML, LLM, storage, build/release, SRE, and QA persona reports. All file:line claims come from those verified reports; items a reviewer could not verify are marked (assumed).

---

## 1. Process & data-flow overview

AskToto is a three-process Electron app (main / typed preload bridge / React renderer) built around two pipelines.

### Live pipeline: audio → ASR → turns → LLM → UI

```
 mic (getUserMedia, AEC+NS pinned)          system loopback (getDisplayMedia,
        │ 'you' channel                       discarded video track — deliberate)
        ▼                                            │ 'them' channel, 3.0x gain
   AudioWorklet (Blob-URL Whisper worklet — deliberate)
   · shared makeVad transplant (vad.ts → whisper-worklet-src.ts, unit-tested)
   · hysteresis ON=0.012 / OFF=0.006 RMS, 0.6s endpoint, 6s hard cap
   · whole-window EMIT_RMS=0.005 silence drop
        ▼  Float32 windows
   bounded queue (MAX_QUEUE=24, drop-oldest on backpressure — console.warn only)
        ▼
   ASR engine (per settings.asrEngine / asrQuality)
   ├─ Whisper worker (renderer Web Worker)
   │   · 'best' → WebGPU large-v3-turbo   · 'fast' → WASM whisper-base q8 (DEFAULT)
   │   · weights bundled, served via asr-model:// protocol (deliberate, zero download)
   └─ Parakeet (sherpa-onnx native addon, runs IN MAIN via IPC.parakeetFeed;
       layered fallback: timeout + failure streak + empty-run stall → Whisper)
        ▼  text
   transcript-filter (phantom/caption removal — English-only today)
   + user corrections regex (ASCII \b — broken for accented word edges)
        ▼
   commitLine → TranscriptLine {speaker: 'you'|'them', text, t: decode-time}
        ▼
   turn logic: 'them' runs coalesced, dangling-word hold-off, isQuestion (EN-only)
   — VAD caption endpoint deliberately decoupled from the auto-answer turn —
        ▼
   auto-answer → askStart(suggest tier) → streamed into Copilot
   (ALL suggest answers share a 4s TTL / 7s hard-kill lifecycle, incl. typed asks)
```

### Ask pipeline: request → routing/failover → provider → stream

- `IPC.askStart` (zod-validated) hits an **inline ~190-line routing/failover engine in `index.ts:1033-1225`** — tier resolution (`routing.ts`: fast/base/think/deep by keyword/length heuristics), provider priority (optional CLI-first), eligibility scan, pre-token failover, Dust auth-refresh replay. **Zero tests; one verified self-drift** (eligibility omits `providerModelsDeep`; codex-cli never failover-eligible).
- Provider strategies under `src/main/llm/`: `anthropic` (SDK), `openai` (openai-compat, also serves Gemini/OpenRouter/etc.), `dust` (conversation reuse per meeting), `cli` (spawns `claude -p` / `codex exec` via login-shell PATH; hard security invariants `--disallowedTools '*'` in the stream path, dropped in testCli). Per-tier idle watchdogs live in `llm/shared.ts:47`; the CLI path bypasses them with its own hardcoded 120s copy.
- Per-turn text goes to `userText`, not `buildSystem` (deliberate — prompt cache). Recap/summary inputs are sliced to the **last 16k/12k chars** (`llm/shared.ts:80,85`) — the single biggest fidelity defect in the product.
- Deltas relay through main → preload → renderer, where `state.ts` RAF-batches tokens with a synchronous first-token flush (excellent TTFT behavior).

### Knowledge pipeline: transcript → save → recall → share

```
 meeting end (endReview) ──► recap ask (mode 'recap', tail-sliced!) ──► Review UI
        │                                                                  │
        ▼                                                                  ▼
 saveMeeting (transcripts.ts)                              follow-up draft (Dust-gated)
 · markdown + YAML frontmatter (type, title, date, tags,   mailto draft (1,500 chars)
   participants: [You, Them], status: ready-for-followup)  BidStack MCP push (review-first)
 · AES-256-GCM envelope (safeStorage-wrapped content key,
   org escrow via managed config) — DEFAULT ON
 · atomic tmp+rename; OneDrive-synced meetings folder
 · index.md append-only (rows SKIPPED while encrypted)
 · folder README instructs Dust agents to read the files
   (contradiction: default encryption makes them unreadable)
        │
        ▼
 recall (recall.ts): listMeetings/searchMeetings = full-folder read + decrypt
 PER CALL (no cache) → RecallView keyword search (substring-count scoring)
 · retention sweep by filename timestamp (misses .autosave-draft-* orphans)
 · graphify knowledge graph: optional python + graphify + claude-CLI chain
        │
        └── crash net: 60s autosave → hidden .autosave-draft-*.md dotfiles
            (write-only: no UI surfaces them, sweep never deletes them)
```

Side channels: screenshot capture + cache in main; calendar (MS Graph via MSAL, dormant until Azure provisioning) feeding a meeting-detect poller (osascript/System Events on macOS) → 6-second opt-in toast; tray with agenda; auto-updater (autoDownload + install-on-quit, pointed at a repo publishing **draft** releases).

---

## 2. Per-subsystem state

### Main process (`src/main`) — solid patterns, dangerous concentration
Strengths: single typed preload bridge over a channel registry with a compile-time provider-parity guard (`shared/ipc.ts:24-32`); zod at most IPC boundaries; layered managed/user/default settings with mtime-keyed memoization and atomic encrypted writes (`store.ts`); deny-by-default permissions; single-instance lock; redacted crash dumps; power-save blocker during meetings.
Weaknesses: `index.ts` is a 1,736-line God module (geometry, capture, pollers, protocol handler, ~60 IPC handlers, shared mutable state) — the only untested logic in the app lives here, including the failover router. Event-loop hazards: sync delete dialogs, sync keychain decrypts in recall, `requireAuth`'s 5-8 sync fs ops per call (including once per Parakeet audio window), sync 5MB metrics reads. Every settings patch re-registers all global shortcuts. Dust session import is triplicated; calendar cache-fill duplicated.

### Audio capture (`listen.ts`, worklet) — excellent happy path, no session robustness
Strengths: unit-tested VAD single-sourced into the worklet; zero-alloc windowing; flush-then-drain stop preserving the final sentence; independent mic/loopback failure isolation with precise permission errors; gain compensation; pause keeps the fragile SCStream warm (deliberate).
Weaknesses: **nothing detects a channel dying mid-meeting** (no `track.onended`, no `devicechange`, no `powerMonitor` — verified zero hits); the 'them' watchdog is one-shot and false-positives on a quiet far side; fixed absolute VAD thresholds break in noisy rooms and drop quiet talkers; the 6s hard cap cuts mid-word with no overlap; stereo loopback drops the right channel (`channelCountMode` default); timestamps are decode-time under backlog; backpressure drops are console-only.

### ASR (`whisper.worker.ts`, `parakeet.ts`) — tiered and fallback-rich, English-centric
Strengths: three engines (WebGPU large-v3-turbo / WASM base / native Parakeet-25) with bundled weights over `asr-model://`; Parakeet has three layered failure detectors falling back to Whisper; prewarm + idle release.
Weaknesses: the Whisper path has **no real-time-factor guard** (slow GPUs silently lose windows) and no per-window-error fallback counter; default tier is 'fast' (whisper-base) even when the best model is already bundled; phantom-hallucination filter and question detection are English-only; per-window language auto-detect can flip languages; corrections regex has a verified Unicode bug; prewarm ignores the configured quality/engine; dev model path unpinned to HF `main`.

### Provider/LLM layer (`src/main/llm`, `shared/prompts.ts`) — well-designed, three verified defects
Strengths: clean strategy dispatch; per-tier idle budgets + pre-token failover; Dust OAuth self-heal; injection guards lead the system prompt; mode prompts are unusually good; grounding rail enforces source tags.
Defects: default deep tier **400s** (temperature sent to claude-opus-4-8); recap/summary **tail-slicing**; CLI path ignores the idle budget (120s stalls); Dust resends the full preamble per message; Anthropic prompt-cache marker is a no-op at default prompt sizes with no telemetry; deep-tier routing over-escalates on single business keywords; catalog contains a retired OpenRouter default.

### Renderer (`src/renderer`) — great streaming feel, no macro render architecture
Strengths: RAF-batched streaming with sync first-token flush; lazy code-split heavy views; debounced shiki; documented five-level Escape ladder; skeletons/spinners everywhere; actionable error coaching; capture prewarm on input focus.
Weaknesses: zero `React.memo`/JSX-`useMemo` in the entire tree (verified); three root-level tickers; one-line unstable `shikiTheme` prop verifiably defeats Streamdown's memo; transcript lists (Copilot + Review) reconcile O(lines) per render; paint-per-frame conic-gradient rings run even fully idle (stealth defaults on); `useAsk` returns unstable objects blocking any memo work; `App.tsx` (1,416 lines) and `Settings.tsx` (4,013 lines) are monoliths. Answer lifecycle conflates ambient auto-suggestions with deliberate user asks (shared 4s/7s TTL, mid-stream kill).

### Storage & recall (`transcripts.ts`, `recall.ts`) — excellent writes, weak reads
Strengths: atomic tmp+rename everywhere; fail-closed envelope encryption (AES-256-GCM content key, safeStorage wrap, org escrow); filename-based retention that survives OneDrive mtime churn; traversal guards; 60s crash drafts keyed per meeting; strong write-path tests (38 in transcripts.test.ts).
Weaknesses: list/search re-read + re-decrypt the entire folder per call (the one path that degrades with success, on OneDrive dataless files); crash drafts are write-only (invisible, unswept — a privacy issue: third-party speech outliving retention); title round-trip lossy (verified); CRLF-fragile frontmatter parsing despite the agent-edit invitation; no encryption lifecycle migration; index.md append-only with no rebuild; default encryption silently defeats the advertised Dust folder share.

### Calendar / meeting detection — dormant by design, leaky at the edges
Outlook agenda built but gated on unprovisioned Azure (deliberate); meeting-detect poller works via System Events with an unexplained first TCC prompt; the notifier's cache TTL equals its poll interval (a Graph call every 30s when enabled, default off); the opt-in toast lives 6 seconds once per meeting; the Agenda CTA dead-ends for all users today.

### Build & release — complete pipeline riding several cliffs
CI: typecheck/tests/audit/SBOM/secret-scan + a check:release feed gate — genuinely unusual for v0.1. Cliffs: dmg at 2,048,103,604 bytes vs GitHub's 2,147,483,648 hard limit; publish defaults to **draft** releases the updater can't see; a modelless Windows build already shipped with no gate catching it; the >2GB NSIS installer has never been installed on real hardware; Electron 33 is past EOL; CI re-downloads 2.1 GB of unpinned, unverified model weights and uploads 14.2 GB of artifacts per push; macOS builds are arm64-only; every release forces up to a 1.9 GiB user download (differential unproven); repo + build outputs live inside OneDrive sync.

### Test & QA — inverted coverage
287 vitest tests (verified: 270 pass, 17 environment-skipped), fast and low-flake, with excellent nets around storage, VAD, and recall regressions. But coverage is inverted relative to risk: no renderer test capability (env 'node', no jsdom) while the last five commits are all renderer bug fixes; the failover router, them-turn coalescing, and asr-model:// guard are untested; the only e2e harness (deep-qa-test.mjs) is gitignored, always exits 0, and structurally cannot complete a run; CI never runs tests on macOS; coverage config excludes the renderer entirely.

### Security & privacy posture (partial coverage — no dedicated security/privacy persona reported)
Present and good: envelope encryption + escrow, retention sweep + GDPR wipe, consent gate + recording reminder, IPC validation on major surfaces, asr-model:// traversal guard, CLI tool-lockdown invariants, audit log, content protection default-on. Open: Electron EOL (P0-11), unpinned model supply chain, unvalidated cli* IPC handlers, testCli invariant drop, orphan drafts escaping retention, encryption lifecycle one-way doors, paused-state rec-dot honesty. A dedicated security review is still owed (assumed missing panel seat).

---

## 3. Cross-cutting risks

1. **Untested concentration.** The three megafiles (`index.ts` 1,736 · `App.tsx` 1,416 · `Settings.tsx` 4,013, plus `listen.ts` 870) hold the highest-risk logic — routing/failover, meeting lifecycle, turn coalescing — and none of it is reachable by vitest. The failover engine has already drifted against itself with no net to catch it. Every recent defect shipped from exactly this untested mass.
2. **The main event loop is a contended shared resource.** Live ASR (parakeetFeed), stream-delta relay, and window management share one loop with sync dialogs, sync keychain decrypts (recall), sync fs (requireAuth per audio window), and sync 5MB log reads. Any of these stalls transcription mid-meeting.
3. **Data-loss seams at meeting-lifecycle boundaries.** Escape-after-failed-recap, restart-after-ASR-crash, tray quit, renderer crash, sleep/wake, unwritable folder — each boundary has a path where a captured meeting is destroyed or becomes invisible. The crash-draft safety net exists but no user can reach it, and retention never cleans it (privacy inversion).
4. **Silent degradation as house style.** Backpressure drops, draft-write failures, recap truncation, screen-capture fallback, mic-only degradation, second-device undecryptable files — the app's failure mode is almost always "keep going, tell no one." Individually defensible; collectively they erode the exact trust a meeting-record product sells.
5. **Scale-with-success anti-patterns.** Recall O(N × decrypt) per keystroke, publicSettings shipping the contextDocs corpus per toggle, per-render costs growing with transcript length, per-release 1.9 GiB downloads — the costs grow with exactly the usage the product hopes for.
6. **OneDrive as substrate.** Meetings folder, git repo, build outputs, QA userdata all live in sync: hydration storms on recall, known git flakiness, packaging file-lock risk, 2.26 GB of weights churning.
7. **Supply-chain and currency debt.** EOL Electron, unpinned HF model fetches with no hash verification, a release train 4.6% under a hard external limit, draft releases the updater can't see. The next routine bump can break the build or the update channel.
8. **Docs contradict the code at the worst possible audience.** README and the production-readiness package assert the opposite of the product's strongest facts (bundled offline ASR, CI, test count) — and these are the documents gating the only real ship blocker (Mantu IT approval for signing + Azure).
9. **English-first reality under a multilingual claim.** Phantom filter, question detection, corrections, and language stability all assume English; the ~99-language positioning currently holds only for the happy path.
10. **Single-maintainer bus factor on delivery.** All product delta on one unmerged branch; two stale remote branches; an unowned iOS surface; Windows headlined but never executed on real hardware. Scope statements exceed verified reality in several places.

---

## 4. What is genuinely strong (keep and protect)

- The typed IPC bridge + channel registry + compile-time provider-parity guard — best-practice Electron surface design.
- The storage write path: atomic, envelope-encrypted, escrowed, collision-safe, well-tested.
- The streaming UX core: sync first-token flush + RAF batching + failover + idle watchdogs (where honored).
- The ASR engineering: bundled zero-download weights, tiered engines, Parakeet's layered fallback, the tested VAD transplant.
- The consent-forward product design: consent gate, recording reminder, retention sweep, GDPR wipe, review-first CRM push — a real (and currently untold) differentiator.
- The test craft that exists: transcripts/recall/vad suites are regression nets around real bugs, written with intent comments.
