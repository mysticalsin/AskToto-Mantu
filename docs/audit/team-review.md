# AskToto — 20-Person Team Review

**Date:** 2026-07-02 · **Branch:** `feat/ux-fixes-models-cli-integration` · **Compiled by:** panel PM
**Scope:** full product review across engineering, product, GTM, and QA. Visual design frozen — no findings touch layout/color/typography. Deliberate architecture decisions (Blob-URL worklet, discarded-video-track loopback, decoupled VAD caption endpoint, `userText` prompt-cache placement, `asr-model://` protocol) were excluded per brief.

**Reports received: 18 of 20.** The two missing reports' persona identities were not included in the hand-off. By coverage analysis, the panel lacks a dedicated **security engineer** and a **privacy/compliance specialist** (assumed) — security and privacy findings below arrive sideways from the staff engineer, build engineer, storage engineer, and QA lead, and should be treated as partial coverage of those domains.

---

## Scorecard

| # | Persona | Score /10 | One-line justification |
|---|---------|-----------|------------------------|
| 1 | Staff full-stack engineer (architecture) | 7 | Typed IPC bridge, zod boundaries, clean provider strategy — but a 1,736-line God `index.ts` whose inline, zero-test failover router has already drifted against itself. |
| 2 | Main-process performance engineer | 7 | Real perf discipline (mtime memoization, atomic async writes, prewarm) undermined by the one path that degrades with product success: recall re-decrypts every meeting per keystroke. |
| 3 | React performance engineer | 6 | Excellent micro-perf (RAF stream batching, debounced shiki) with zero macro memo boundaries: three root tickers, a one-line unstable prop defeating Streamdown's memo, paint-per-frame rings while idle. |
| 4 | Audio/DSP engineer | 6 | Happy path beautifully engineered; nothing detects a channel dying mid-meeting, and fixed VAD thresholds fall over silently outside a quiet room with wired audio. |
| 5 | ASR/ML engineer | 7 | Strong tiered pipeline with layered fallbacks, but the multilingual story doesn't match the ~99-language positioning and the default ships the weakest model even when the best one is bundled. |
| 6 | LLM/prompt engineer | 7 | Well-engineered provider layer with three verified defects: default deep tier 400s, recaps see only the last ~16k chars, CLI path ignores the latency budget the live pillar depends on. |
| 7 | Data/storage engineer | 7 | Excellent write path (atomic, envelope-encrypted, escrowed, crash-drafted); the read side re-decrypts the world per call and the crash-recovery net is unreachable by any real user. |
| 8 | Build/release engineer | 6 | Unusually complete pipeline for v0.1, riding 4.6% under GitHub's 2 GiB hard limit, publishing draft releases the updater can't see, on EOL Electron 33. |
| 9 | SRE / reliability engineer | 7 | Strong foundations (atomic writes, failover, backoff, drafts) — but the marquee meeting-copilot failure modes (sleep/wake, tray quit, ASR-crash restart) still lose or hide data. |
| 10 | Project manager (scope/delivery) | 7 | Pillars complete and verified; the status-documentation layer actively contradicts the code and the only real ship blockers (m8 signing + Azure) sit idle 5 weeks from deadline. |
| 11 | UX researcher (meeting workflows) | 6 | Strong during-meeting core; every JTBD phase has a real fumble — 4s/7s TTL erases typed answers, one 6-second opt-in window per meeting, failed recaps have no retry. |
| 12 | Interaction designer | 7 | Latency/streaming fundamentals excellent (sync first-token flush, Escape ladder); trust-eroding behavior mismatches remain — mid-stream auto-wipe, dead clicks, lying shortcut hints. |
| 13 | Accessibility specialist | 6 | Far above indie-Electron baseline (real buttons, focus rings, aria on Settings) — but core surfaces fail WCAG 2.2.1 and recording state changes are inaudible to screen readers. |
| 14 | Onboarding / first-run specialist | 6 | Real consent gate and live checklist, but the checklist is read-only theater: the two hardest macOS grants land as failures during the user's first real meeting. |
| 15 | CMO (positioning) | 6 | Substance 9, story 4: category-defining on-device moat while the README leads with Cluely's "invisible" framing and unsells the shipped offline ASR with stale claims. |
| 16 | Competitive analyst | 7 | Only product with all three pillars in one binary and it wins on privacy and price; loses on the knowledge pillar where the category moved (cross-meeting AI chat, diarization, egress). |
| 17 | Customer-success lead | 6 | Morning-after value chain leaks four ways: truncated recaps, encryption-vs-Dust-share conflict, permanent dead ends for recap-less meetings, keyword-only recall. |
| 18 | QA lead | 5 | The tests that exist are excellent craft, but coverage is inverted relative to risk: zero renderer test capability while 100% of recent defects are renderer, and the only e2e harness can never fail a build. |

**Average: 6.4 / 10** (116 ÷ 18)

---

## Persona sections

### 1. Staff full-stack engineer — architecture (7/10)

**Verdict:** Strong bones (typed preload bridge, channel registry with compile-time provider-parity guard at `shared/ipc.ts:24-32`, zod at most boundaries, layered settings with mtime memoization). Costs three points on concentration and drift: God modules, an inline zero-test failover router that has already diverged from itself, and duplicated/triplicated logic.

**Findings**
- **CLI stream drops the per-tier idle budget** — `index.ts:1127-1138` computes idleMs (suggest 15s) but `llm/cli.ts:11-17` never forwards it; `cli.ts:26-42` hardcodes 120s. With `providerPriority='cli'`, a stalled CLI holds live suggestions 2 minutes before failover. *(high/small, bug-risk)*
- **Failover/routing engine (~190 lines) inline in an IPC closure, zero tests, already drifted** — eligibility check at `index.ts:1072` omits `providerModelsDeep` that `attempt()` uses at `index.ts:1094-1097`; failover can skip a provider attempt() would run. Extract `src/main/ask-router.ts` + unit tests. *(high/medium, test-gap)*
- **Every settingsSet re-registers all global shortcuts + re-applies content protection** — `index.ts:745-771`; opacity slider drag = dozens of unregister/re-register + AES cycles. Mirror the existing `'launchAtLogin' in p` gate. *(medium/small, perf)*
- **Sync confirm dialogs block the main loop** — `showMessageBoxSync` in recallDelete/recallDeleteAll (`index.ts:961, 987`) stalls Parakeet ASR + stream relay mid-meeting. `await dialog.showMessageBox` is identical UX. *(medium/small, reliability)*
- **`parakeetRelease()` is dead code** — ~487MB recognizer resident forever after the first Parakeet meeting (`parakeet.ts:199-206`); call it from the listeningState(off) branch (`index.ts:1407-1414`). *(medium/small, perf)*
- **Dust session import/refresh triplicated** — `index.ts:807-815`, `:1151-1161`, `:1699-1710`; copies already differ. Extract `importDustSession()` in dustcli.ts. *(medium/small, code-efficiency)*
- **IPC validation inconsistent** — cli*/recall*/window* handlers accept unvalidated payloads (`index.ts:826-857`) while neighbors use zod. Add `CliProviderSchema` + thin schemas. *(medium/small, security)*
- **Recall list/search re-reads + re-decrypts every file per call** — `recall.ts:62-69, 244-267`; O(all meetings × full decrypt) per History open/keystroke. *(medium/medium, perf)*
- **publicSettings round-trips the full contextDocs corpus** (25×120KB/mode) on every settings read/write — `index.ts:156-189`; split doc bodies out of the hot path. *(medium/medium, perf)*
- **index.ts is a 1,736-line God module** — window geometry, capture, pollers, protocol handler, ~60 IPC handlers; nothing unit-testable without booting Electron. Mechanical split. *(medium/large, code-efficiency)*
- **Settings.tsx is a 4,013-line monolith** — 53 useState hooks, 33 inner components; split per tab behind the existing lazy() boundary. *(medium/large, code-efficiency)*
- **cliConnected set true, never false** — dead CLI keeps winning priority; clear on not-found/failed test (`index.ts:836-839, 1214-1217`). *(medium/small, reliability)*
- **Calendar cache-fill duplicated** between shouldAutoStart and startMeetingNotifier (`index.ts:551-567, 619-631`) — consent-adjacent divergence risk. *(low/small, code-efficiency)*
- **Dead IPC params** — `windowMode(mode)` ignored by main (`index.ts:1433-1436`), `parakeetFeed.speaker` ignored (`index.ts:1012-1018`). *(low/small, code-efficiency)*

**Quick wins:** thread idleMs into runCliStream; gate registerShortcuts/setContentProtection on patch keys; async delete dialogs; parakeetRelease on stop; CliProviderSchema + cliConnected clearing; importDustSession() extraction; drop dead preload params.
**Strategic:** extract + unit-test the ask router; decompose index.ts into window/capture/schedulers/ipc groups; split Settings.tsx per tab and slim PublicSettings.

---

### 2. Main-process performance engineer (7/10)

**Findings**
- **Recall list/search: full readFile + synchronous keychain decrypt of every meeting per call** — `recall.ts:62-69, 244-267`; per-keystroke via RecallView (250ms debounce), on a OneDrive folder (Files-On-Demand hydration). Blocks the loop servicing parakeetFeed and stream deltas. Fix: `{sum,text}` cache keyed (file, mtimeMs, size). *(high/medium, perf)*
- **Per-patch shortcut storm + double AES cycle** — sliders/textareas patch per event (`Settings.tsx:701, 2439, 2487, 1601`) → unconditional registerShortcuts (`index.ts:769`) + decrypt/re-encrypt/parse per tick (`store.ts:279-315`). *(high/small, perf)*
- **Sync delete dialogs freeze the main process** — `index.ts:961, 987`. *(medium/small, perf)*
- **Meeting notifier: fresh Graph call every 30s all day** — TTL (30s, `index.ts:536`) equals the poll interval (`index.ts:614, 621`), so cache always expired; ~2,880 requests/day incl. per-call msal-cache decrypt. Separate ~5-min notifier TTL. *(medium/small, perf)*
- **graphify detectPython re-runs a multi-process probe chain (15s timeouts) per status call when not installed** — `graphify.ts:84-123, 163-192`; 4-6 child processes per History/Settings open. Cache negative result ~60s; cache parsed graph.json by mtime. *(medium/small, perf)*
- **requireAuth: ~5-8 uncached sync fs ops per call, including once per live ASR audio window** — `auth.ts:461-466, 95-114, 437-448` via `parakeetFeed` (`index.ts:1012-1018`). Memoize on managed-config mtimes. *(medium/medium, code-efficiency)*
- **readEvalMetrics sync-reads 5MB audit log + parses 10k lines on the loop** — `metrics.ts:86-105`; make async. *(low/small, perf)*
- **Draft autosave rewrites + re-encrypts the full transcript every 60s even when unchanged** — `transcripts.ts:527-561`; skip when line count/last timestamp unchanged. *(low/small, perf)*

**Quick wins:** gate registerShortcuts; async dialogs; notifier TTL; graphify negative-result cache; async metrics; skip unchanged autosave.
**Strategic:** persistent recall index (sidecar JSON keyed file+mtime+size); one mtime-cached managed-config/auth reader shared by store.ts/auth.ts/transcripts.ts; write-behind settings persistence (debounced commit, side effects once per logical change).

---

### 3. React performance engineer (6/10)

**Findings**
- **Unstable `shikiTheme` array defeats Streamdown's memo** — `Markdown.tsx:16` new array per render; verified comparator uses identity → whole markdown tree re-renders on every App render. Hoist to module const. One line. *(high/small, perf)*
- **`seconds` ticker at App root** — `App.tsx:107, 142-150`; 3,600 full-tree renders per hour meeting. Move into a leaf `<MeetingClock>` in Bar's fixed timer slot. *(high/medium, perf)*
- **Transcript rows unmemoized in Copilot** — `Copilot.tsx:145-161`; O(lines) reconciliation per render × up to 60 stream flushes/s. Extract `React.memo` TranscriptRow + useMemo the list. *(high/small, perf)*
- **Always-on `@property` conic-gradient ring animations repaint per frame — even fully idle** — `styles.css:468-576`; stealth ring defaults on (`App.tsx:1340`), 5+ concurrent paint-per-frame animations over backdrop-filter during meetings. Replace with compositor-only `transform: rotate()` pseudo-elements (visually identical) + extend prefers-reduced-motion. *(high/medium, perf)*
- **Review re-reconciles ~1,000 transcript rows per recap stream flush** — `Review.tsx:548-565`; same memo'd-row fix. *(medium/small, perf)*
- **useAsk returns a fresh object per render** — `state.ts:305`; poisons every `[ask]`-dep callback, blocks all memo-boundary work. Wrap in useMemo. *(medium/small, code-efficiency)*
- **useAutoResize MutationObserver: two full-tree selector queries + forced layout per frame during streaming** — `state.ts:59-74, 100-101`; track data-overlay/data-hug-width presence from mutation records instead. Mechanism is load-bearing — keep it. *(medium/medium, perf)*
- **useSettings/usePermissions always set fresh objects** — `state.ts:317-327, 434-446`; whole 4,000-line Settings tree re-renders every 2.5s while open. Structural-compare before setState. *(medium/small, perf)*
- **Ask-input state at App root = full-tree render per keystroke** — `App.tsx:96`; establish memo boundaries around body components once useAsk is stabilized. *(medium/medium, perf)*

**Quick wins:** shikiTheme const (5 min); TranscriptRow memo in Copilot + Review; useAsk useMemo; structural-compare in the two poll hooks.
**Strategic:** render-isolation pass (target: idle mid-meeting = 0 full-tree renders/s, measured with React Profiler); compositor-only ring stack; perf-regression gate in the Playwright harness (synthetic 10-min meeting, assert CPU/commit budgets).

---

### 4. Audio/DSP engineer (6/10)

**Findings**
- **No mid-session capture-death detection** — no `track.onended`, no `devicechange` listener anywhere (`listen.ts:418-484, 586-649`); 'them' watchdog is one-shot (`:448-455, 472-481`). AirPods disconnect or SCStream death = silent one-sided transcript for the rest of the meeting. *(high/medium, reliability)*
- **Fixed absolute VAD thresholds** — ON=0.012/OFF=0.006 (`vad.ts:20-21`); steady noise above OFF → endpoint never fires → 6s hard-cap cuts; quiet talkers below ON vanish entirely (whole-window EMIT_RMS drop, `whisper-worklet-src.ts:24,46`). Add rolling-min noise floor inside makeVad. *(high/medium, bug-risk)*
- **'Not hearing the other side' watchdog false-positives on a merely-quiet far side** — `listen.ts:22, 472-481`; add a one-time worklet {alive} ping to distinguish no-signal from no-speech. *(medium/small, ux-behavior)*
- **6s hard-cap cut splits words mid-syllable, no overlap carry-over** — `whisper-worklet-src.ts:23,65`; garbled boundaries every 6s in monologues. Cut at last below-OFF quantum or retain ~0.4s overlap. *(medium/medium, knowledge-pipeline)*
- **Timestamps are decode-completion time, not capture time** — `listen.ts:189`; with a legit 2.4-min backlog (MAX_QUEUE=24) order/timestamps drift. Thread capturedAt from pushAudio. *(medium/medium, knowledge-pipeline)*
- **Backpressure drops audio with only console.warn** — `listen.ts:406-412`; surface a sticky note on first drop. *(medium/small, reliability)*
- **App's own 'ready' cue leaks into the boosted 'them' channel as pseudo-speech** — `App.tsx:348`, `sound.ts:68-78`, 3.0x gain (`listen.ts:440`). Gate cues while a them channel is open. *(low/small, bug-risk)*
- **Stereo loopback not downmixed** — `channelCount:1` ignored under default `channelCountMode 'max'` (`listen.ts:431-435`); right channel discarded. Add `channelCountMode:'explicit'`. *(medium/small, bug-risk)*
- **Speaker-mode echo bleed mislabels far side as 'you'** — `listen.ts:590-592`; also clears themRunRef (`listen.ts:206`), suppressing auto-answer. Mitigate with near-duplicate drop in commitLine. *(medium/medium, bug-risk)*
- **autoGainControl left to Chromium default** while VAD calibration depends on it — pin explicitly (`listen.ts:591`). *(low/small, device-compat)*
- **Worklet buffering paths (hard cap, EMIT_RMS gate, flush) zero test coverage** — vm-eval the worklet string with stub AudioWorkletProcessor. *(medium/medium, test-gap)*

**Quick wins:** channelCountMode explicit; backpressure sticky note; gate cues during loopback; pin autoGainControl; worklet alive-ping for the watchdog.
**Strategic:** mid-session capture lifecycle (onended + devicechange + epoch re-acquire); windowing quality package (adaptive floor VAD + overlap-aligned cap cuts); capture-time fidelity (capturedAt threading).

---

### 5. ASR/ML engineer (7/10)

**Findings**
- **Corrections regex never matches words starting/ending with accented letters (verified)** — ASCII `\b` (`listen.ts:170`); `/\bcafé\b/` fails. Use Unicode lookarounds + `u` flag. *(medium/small, bug-risk)*
- **Hallucination phantom list is English-only** — `transcript-filter.ts:13`; FR/DE/JA/ES/PT Whisper silence hallucinations ('Sous-titrage Société Radio-Canada', ZDF, Amara.org) sail into transcripts and recaps. *(high/small, knowledge-pipeline)*
- **No real-time-factor guard on WebGPU large model** — `whisper.worker.ts:29-38` only checks adapter existence; slow GPUs → queue growth → MAX_QUEUE drop-oldest silently deletes audio. Add RTF measurement + fallback to WASM base via existing onEngineFallback. *(high/medium, reliability)*
- **Fixed-threshold VAD degrades to 6s hard cuts in noisy rooms** — `vad.ts:20-21` (corroborates audio engineer). *(high/medium, reliability)*
- **6s hard cap cuts mid-word without overlap** — `whisper-worklet-src.ts:65` (corroborates). *(medium/medium, knowledge-pipeline)*
- **Phantom filter deletes genuine 'Okay'/'Thank you' turns** — `transcript-filter.ts:18-24`; commitments vanish. Thread window RMS and only filter near-silence windows. *(medium/medium, knowledge-pipeline)*
- **Default 'fast' tier ships whisper-base even when large-v3-turbo is bundled on disk** — `ipc.ts:370/504`, `whisper.worker.ts:21,59`; resolve 'fast'→'best' when bundled + WebGPU. *(high/small, positioning)*
- **Auto-answer question detection is English-only** — QWORDS/DANGLING (`listen.ts:70-83`); pillar 2 mostly dark in FR/DE/ES meetings. *(medium/medium, ux-behavior)*
- **Per-window language auto-detect can flip languages mid-meeting** — `whisper.worker.ts:123-129`; majority-vote lock + optional spoken-language setting. *(medium/medium, knowledge-pipeline)*
- **Prewarm always loads 'fast'** — `listen.ts:852-867`; 'best' users pay the full large-model load at meeting start; Parakeet users get a useless Whisper worker. *(medium/small, perf)*
- **Remote-model path unpinned to moving 'main'** — `whisper.worker.ts:15` (+ `fetch-models.mjs`). *(low/small, security)*
- **Zero multilingual test coverage** — no non-English phantom/question/correction cases; would have caught the verified `\b` bug. *(medium/small, test-gap)*

**Quick wins:** Unicode corrections regex; multilingual phantom list; prewarm configured quality; pin model revisions; multilingual test fixtures.
**Strategic:** adaptive endpointing (noise floor + smarter cap cuts); self-tuning model tier (RTF-based fallback, then default 'best' on bundled builds); make multilingual real (language lock, localized question lists, hallucination corpus, Unicode corrections).

---

### 6. LLM/prompt engineer (7/10)

**Findings**
- **Deep-tier Anthropic requests 400: temperature sent to claude-opus-4-8** — `anthropic.ts:36` + `providers.ts:53`; Opus 4.7/4.8 reject temperature (verified). Fact-check and thinkingMode='always' broken on the DEFAULT provider; Anthropic-only users see raw 400s mid-meeting. *(high/small, bug-risk)*
- **Recap sees only the last ~16k chars** — `llm/shared.ts:85` (summary −12k at :80); a 60-min meeting's recap covers the final ~20 minutes; derived title/tags/actions inherit the truncation. Raise to ~60-80k chars (safe across the whole PROVIDERS table); chunk for 2h+. *(high/small, knowledge-pipeline)*
- **CLI providers ignore the per-tier idle budget** — corroborates staff engineer; `RunCliStreamOpts` (`cli.ts:174-184`) has no idleMs field. *(high/small, reliability)*
- **codex-cli can never be picked by failover; deep overrides invisible to eligibility** — `index.ts:1072` vs `providers.ts:256-269` (all-empty models) and missing `providerModelsDeep`. *(medium/small, bug-risk)*
- **Dust resends the full system preamble (~65k chars) on every message of a reused conversation** — `dust.ts:126, 168`; send only on createConversation or when the hash changes. *(medium/small, perf)*
- **Anthropic prompt cache is a silent no-op for default configs** — system block below the 2-4k-token cacheable minimum; no history breakpoint; no cache telemetry (`anthropic.ts:37-39`). *(medium/small, perf)*
- **Fact-check presents closed-book guesses as authoritative** — no web access but a hard VERDICT format (`quick-actions.ts:23-34`, `Answer.tsx:241`); also `c || transcript` can embed the whole unsliced transcript as the claim (`App.tsx:565-570`). *(medium/small, positioning)*
- **isHardQuestion over-escalates everyday business vocabulary to Opus** — single keywords like api/sql/deploy (`routing.ts:31`), >600 chars → deep (`routing.ts:27`); require two signals. *(medium/small, perf)*
- **Stale/retired model defaults** — openrouter 'anthropic/claude-3.5-sonnet' retired Oct 2025 (verified, `providers.ts:157`); think/fast tiers could move to sonnet-5/haiku alias. *(medium/small, ux-behavior)*
- **testCli drops the `--disallowedTools '*'` security invariant its own header declares** — `cli.ts:360` vs `cli.ts:5-6, 119-122`; also no throwaway cwd. *(low/small, security)*

**Quick wins:** omit temperature for Opus-4.x; raise recap cap; fix failover eligibility; fact-check honesty line + claim slicing; restore testCli invariant; refresh model catalog.
**Strategic:** chunked map-reduce recap; persistent CLI sessions (resume/session-id; Codex delta events) to cut cold-start TTFT; web-grounded fact-check via Anthropic server-side web_search or Dust retrieval.

---

### 7. Data/storage engineer (7/10)

**Findings**
- **Recall read side: full re-read + re-decrypt per call** — corroborates; on OneDrive, dataless-file hydration storms from opening History. *(high/medium, perf)*
- **Orphaned crash drafts never swept by retention** — `.autosave-draft-*` names fail `FILENAME_TIMESTAMP` (`recall.ts:217, 232-233`; `transcripts.ts:512`); third-party speech persists forever, invisibly. *(high/small, privacy)*
- **Crash drafts unreachable by users** — hidden dotfile, excluded from listMeetings, no recovery UX (`transcripts.ts:524-526`). Launch-time "Recover interrupted meeting?" prompt. *(high/medium, reliability)*
- **Title round-trip lossy (verified repro)** — write escapes `"`/`\` (`transcripts.ts:407-408`), read never unescapes (`recall.ts:17`); `Budget "Q3" review` renders as `Budget \"Q3\" review`. *(medium/small, bug-risk)*
- **Fixed `${file}.tmp` + unserialized autosave: partial-write rename and draft-resurrection races** — `transcripts.ts:226`, `App.tsx:179-181`, `index.ts:1246`. Randomize tmp suffix; skip overlapping writes. *(medium/small, reliability)*
- **Encrypted transcripts synced to a second device silently vanish from History** — decodeSaved returns '' → row never renders (`recall.ts:39-42`); the helpful UNDECRYPTABLE_MSG is unreachable. *(medium/medium, ux-behavior)*
- **Frontmatter parser breaks on CRLF; type guard admits typeless files** — `recall.ts:13, 42, 106`; the folder README explicitly invites agent rewrites (`transcripts.ts:311-315`). `\r?\n` everywhere. *(medium/small, knowledge-pipeline)*
- **No encryption lifecycle migration** — toggling strands old files both directions; index.md rows skipped while encrypted (`transcripts.ts:438-443, 501-505`). Batch migrate + index rebuild on toggle. *(medium/medium, security)*
- **index.md has no rebuild path** — append-only with best-effort delete (`transcripts.ts:339-348`, `recall.ts:169-182`); agents told to trust a drifting index. *(medium/small, knowledge-pipeline)*
- **Search snippets can expose raw YAML frontmatter** — `recall.ts:261-263`; strip frontmatter before snippet. *(low/small, ux-behavior)*

**Quick wins:** sweep drafts; unescape titles + round-trip test; randomized tmp suffix; CRLF tolerance; frontmatter-stripped snippets.
**Strategic:** mtime/size-keyed read cache or sidecar index; end-to-end crash-recovery loop ("AskToto never loses a meeting"); encryption lifecycle management (migrate, locked-row surfacing, index rebuild).

---

### 8. Build/release engineer (6/10)

**Findings**
- **Release artifacts 4.6% under GitHub's 2 GiB hard asset limit, no size gate** — dmg = 2,048,103,604 bytes (`release/latest-mac.yml`); ~95-128 MB headroom. Any growth breaks release upload after a 40-min build. *(high/small, reliability)*
- **GitHub publish defaults to draft releaseType — auto-update likely never fires** — `electron-builder.yml:105-107`; electron-updater can't see drafts. Add `releaseType: release`. *(high/small, bug-risk)*
- **No packaged-artifact content verification — a modelless Windows build already shipped silently** — `release/AskToto-Setup-0.1.0.exe` is 178.5 MB with no models/asr/ort/asar-unpacked (verified). Add verify-artifact gate. *(high/small, test-gap)*
- **>2GB Windows NSIS installer never installed on real hardware** — NSIS ~2GB internal limits; build ≠ install. *(high/small, device-compat)*
- **CI packages 2.2 GB of models and uploads 14.2 GB of artifacts on every push to every branch** — `build.yml:8, 81-88, 102-109`; no cache, 27m50s vs 30m timeout. *(high/small, perf)*
- **fetch-models pins nothing, verifies nothing** — mutable `main` revision, no hash/Content-Length check (`fetch-models.mjs:36-38, 88-120`). *(medium/small, security)*
- **Electron 33.4.11 is past end-of-support** — packaged Chromium missing ~a year of CVE fixes; biggest single security lever. *(high/medium, security)*
- **Cross-building Windows from macOS silently drops the sherpa-onnx native addon** — only darwin-arm64 in node_modules; no win-arm64 binary exists at all. *(medium/small, device-compat)*
- **macOS builds arm64-only; update manifest has no x64 entry** — `electron-builder.yml:41-43`; Intel users get nothing. Make it a decision, not an accident. *(medium/medium, device-compat)*
- **Every release forces up to a 1.9 GiB background download per user; differential path unproven** — `updater.ts:26-27` autoDownload+autoInstallOnAppQuit. *(medium/medium, reliability)*
- **Main eagerly loads all LLM SDKs at boot** — dynamic-import at first ask; measure before investing. *(low/medium, perf)*
- **21 MB ORT wasm ships twice** (asar + resources/ort) — deliberate safety net for the modelless-build failure; keep or exclude consciously. *(low/small, code-efficiency)*
- **Build outputs + 2.26 GB of weights churn through OneDrive sync** — point output at a non-synced path. *(low/small, reliability)*

**Quick wins:** releaseType: release; artifact size/content assertions in check-release; CI caching + gating + slim artifacts; pin HF downloads; move build output off OneDrive.
**Strategic:** cut the artifact under ~1 GB (q4f16 large model or in-app 'accurate' download, parakeet.ts already has the pattern); prove the update loop end-to-end once (draft visibility, differential size, real Windows install, Intel-Mac story); Electron currency policy with the Playwright harness as regression net.

---

### 9. SRE / reliability engineer (7/10)

**Findings**
- **Silent capture death: no track 'ended' handling, no powerMonitor, one-shot them-watchdog** — zero powerMonitor usage in src/main (verified); lid-close/sleep or Bluetooth death → UI says Listening while nothing is transcribed. *(high/medium, reliability)*
- **Restarting Listen after an ASR worker crash destroys the unsaved transcript** — `startListen` unconditionally `listen.clear()` (`App.tsx:686`); first 40 minutes vanish. Mirror newMeeting's save-first (`App.tsx:760-763`). *(high/small, bug-risk)*
- **Crash-recovery drafts are write-only** — never surfaced, never promoted, never swept (`transcripts.ts:512-526`, `recall.ts:42, 217`). Startup scan + promote + sweep. *(high/medium, reliability)*
- **Tray 'Quit AskToto' bypasses the live-meeting flush** — `index.ts:694` calls app.quit() directly vs the in-app path (`App.tsx:768-777`). Renderer-flush handshake with 3s fallback. *(medium/small, reliability)*
- **No render-process-gone/child-process-gone handler** — renderer/GPU crash leaves a dead always-on-top overlay; must force-quit. *(medium/small, reliability)*
- **No local fallback when the meetings folder is unwritable** — final save AND drafts share the failing OneDrive disk (`transcripts.ts:333, 379-383`; `App.tsx:256-273`); fall back to userData/recovery. *(high/medium, reliability)*
- **Recap covers only the last ~16k chars** — corroborates LLM engineer; silent knowledge loss on the shared artifact. *(medium/large for full fix, knowledge-pipeline)*
- **60s autosave window + 100% silent draft-write failures** — `App.tsx:174-181`, `transcripts.ts:558-560`; drop to 15s, audit-log persistent failures. *(medium/small, reliability)*
- **Whisper per-window decode errors never self-heal** — no WASM-fallback counter like Parakeet's (`listen.ts:287-295` vs `:20-21, 241-247`); WebGPU device-lost = broken until manual restart. *(medium/medium, bug-risk)*

**Quick wins:** save-before-clear in startListen; tray quit flush handshake; render-process-gone reload handler; 15s autosave + failure telemetry.
**Strategic:** crash-recovery pipeline (promote drafts, local-fallback writes); capture-health watchdog (onended + powerMonitor + periodic silence detection); long-meeting recap fidelity.

---

### 10. Project manager — scope/delivery (7/10)

**Findings**
- **README makes three false claims** — "not a git repository yet" (`README.md:126`), "~40 MB Whisper download on first Listen" (`:125` — actually ~1.3GB bundled offline), "14 providers" (`:10, :81` — 17 registered). First document Mantu IT reads for the m8 approval. *(high/small, knowledge-pipeline)*
- **production-readiness/ presents a stale NOT READY verdict as current** — dated 2026-06-27, cites "repo not git-initialised", "59 tests" (now 287); linked as authoritative from README.md:119. Re-run or stamp as snapshot. *(high/medium, knowledge-pipeline)*
- **REMAINING.md lists shipped work as open** — Parakeet checklist unchecked under a DONE header (`:30, :48-54`); flush-on-stop listed as missing but shipped. *(medium/small, knowledge-pipeline)*
- **Agenda 'Connect Outlook calendar' is a dead-end CTA for every user today** — Azure unprovisioned; check `authStatus().configured` on mount (`AgendaView.tsx:73-87, 131-146`). *(medium/small, ux-behavior)*
- **Tray quit / window close silently loses an in-flight meeting** — accepted residual worth un-accepting (`asktoto-hardening-backlog.md:55`); corroborates SRE. *(medium/medium, reliability)*
- **iOS companion is an unowned fourth surface** — drifted provider counts (14 vs 12 vs 17), no note sync, no CI. Freeze labeled experimental until desktop v1.0 (recommended). *(medium/medium, positioning)*
- **Hardening backlog tracks a deleted feature** — Google sign-in items reference files removed in 3b74951. *(low/small, knowledge-pipeline)*
- **Windows headlined as supported but never run on Windows hardware** — loopback trick is macOS-specific; verify once or soften to "macOS-first". *(medium/medium, device-compat)*
- **Knowledge-graph pillar depends on python+graphify+claude-CLI the target user won't have** — document prerequisites or expect-unavailable in the m9 script (`graphify.ts:71-118`). *(medium/small, onboarding)*
- **bidstackClient.test.ts hard-fails in network-restricted environments** — wrap in ctx.skip(). *(low/small, test-gap)*
- **49 commits ahead of origin/main, 5 weeks to the 2026-08-09 goal, no merge cadence** — entire product delta in one working tree on OneDrive-synced git. *(medium/small, reliability)*

**Quick wins:** fix README claims; prune REMAINING.md; AgendaView configured-check; annotate Google backlog items; iOS README labels; bidstack skip; merge to main.
**Strategic:** unblock the only real ship gate (send MANTU-IT-REQUEST this week; m8 then m9); one source of truth for project state; explicit cut/freeze decisions on iOS and Windows.

---

### 11. UX researcher — meeting-heavy users (6/10)

**Findings**
- **Typed mid-meeting questions auto-wiped by the assist TTL — even mid-stream** — 4s TTL / 7s hard kill applies to ALL suggest answers (`App.tsx:320-336, 495-505`); deliberate asks and 'What to say next' erased. Tag user-initiated runs; TTL only for ambient. *(high/medium, ux-behavior)*
- **One 6-second opt-in window per meeting** — toast auto-dismisses (`MeetingDetectedToast.tsx:4, 50-53`), main latches meetingActive and never re-prompts (`index.ts:582-591`). Keep the toast until acted on / persistent chip. *(high/small, ux-behavior)*
- **Escape from Review after a failed recap silently discards the whole meeting** — Escape review branch never saves (`App.tsx:926-934`) unlike reset/newMeeting/quit; breaks the codebase's own "a started meeting is always kept" rule. *(high/small, bug-risk)*
- **A failed recap has no Retry** — plain red text (`Review.tsx:351-352`); ask.retry() exists and replays the recap — pass it in as "Regenerate summary". *(high/small, reliability)*
- **Auto-suggest yanks the user out of an answer they're reading** — view switch at `App.tsx:382-386` clobbers fact-check verdicts mid-read. *(medium/small, ux-behavior)*
- **Minimized pill shows a pulsing red rec-dot while paused** — `ControlPill.tsx:63-64` vs Bar's correct grey (`Bar.tsx:370-378`); consent-sensitive indicator lies. *(medium/small, privacy)*
- **History 'Open ↵' hint is dead** — zero key handlers in RecallView (verified); Enter does nothing. *(medium/small, ux-behavior)*
- **Opening a past meeting requires an undiscoverable double-click** — `RecallView.tsx:454-458`. *(medium/small, ux-behavior)*
- **'Ask or search anything' placeholder promises Q&A the box can't do** — keyword scoring only (`recall.ts:243-264`). *(medium/small, ux-behavior)*
- **No path to past-meeting notes during a live meeting** — Bar swaps History away while listening (`Bar.tsx:419-449`); recruiter can't reach prior-round notes mid-interview. *(medium/small, ux-behavior)*
- **'New meeting' means three different things in three places** — `Bar.tsx:424-429` vs `Review.tsx:297` vs past-meeting path. *(medium/small, ux-behavior)*
- **Crash drafts never surfaced in UI** — corroborates storage/SRE. *(medium/medium, reliability)*
- **In-meeting 'Transcript' button has no visible effect outside copilot view** — `App.tsx:845-847`; also setView('copilot'). *(low/small, ux-behavior)*
- **Review always reports '2 participants'** — speaker labels are only you/them (`Review.tsx:148`); wrong metadata in frontmatter. *(low/small, ux-behavior)*
- **Upcoming events omit the Join link the data carries** — `RecallView.tsx:213-231` vs `AgendaView.tsx:33-42`. *(low/small, ux-behavior)*

**Quick wins:** persistent meeting toast; Escape-save; Review retry chip; truthful pill dot; Enter-to-open + single-click open; honest search placeholder; relabel Review chip; transcript-button view switch; participants relabel; Join link.
**Strategic:** split the answer lifecycle (ambient vs deliberate); build the before-meeting third (per-event Prep briefs from related past meetings); conversational + resilient recall (ask-over-notes, recoverable drafts).

---

### 12. Interaction designer (7/10)

**Findings**
- **User-initiated copilot answers auto-wiped by the ambient TTL, including mid-stream** — corroborates UX researcher with the full path list (`App.tsx:322-338, 456-508, 583-616, 1013-1016`); mid-stream clear also discards remaining paid tokens. *(high/medium, ux-behavior)*
- **Opening a past meeting is a silent dead click on failure** — `if (!r.ok) return` (`App.tsx:852-865`) throws away real error messages (`recall.ts:76-87`); OneDrive hydration can hang with zero acknowledgment. *(high/small, bug-risk)*
- **Ending a meeting is one unconfirmed click/keypress with no direct resume** — ⌘⇧L toggle ends instantly; Resume exists only for History-reopened meetings (`App.tsx:1178, 870-881`). *(high/medium, ux-behavior)*
- **Review's 'New meeting' doesn't start a meeting** — `Review.tsx:296-299` → reset/back-to-history vs Bar's save-and-start. *(medium/small, ux-behavior)*
- **History footer advertises wrong/unwired shortcuts** — '⌘R' vs actual ⌘⇧R (`ipc.ts:550`); 'Open ↵' unwired. *(medium/small, ux-behavior)*
- **Screen-capture failure silently degrades to a blind text ask** — `App.tsx:441-448`; add a one-line notice, keep the fallback. *(medium/small, ux-behavior)*
- **Hard filesystem delete despite a free OS undo path** — use `shell.trashItem` in recallDelete/DeleteAll (`index.ts:947-995`). *(medium/small, ux-behavior)*
- **Inconsistent click semantics between the two meeting lists** — RecallView double-click vs Review single-click (`RecallView.tsx:454-458`, `Review.tsx:583-599`). *(medium/small, ux-behavior)*
- **'What to say next' has no keyboard shortcut** — fact-check has ⌘⇧F; the flagship mid-conversation action is mouse-only. *(medium/medium, ux-behavior)*
- **Copilot empty state names a Mic icon that isn't in the toolbar** — `Copilot.tsx:112-116` vs AudioLines (`Bar.tsx:380`). *(low/small, ux-behavior)*
- **Shortcut hints hardcoded; lie after rebinding** — Keybinds editor exists (`Settings.tsx:3873-3938`) but hints are string literals. resolveDisplayShortcut helper. *(low/medium, ux-behavior)*

**Quick wins:** surface openPastMeeting failures; fix footer hints + Enter; relabel/wire Review chips; capture-failure notice; AudioLines glyph; trashItem deletes; single-click open.
**Strategic:** answer-lifecycle model (origin/ephemeral on AskRequest); recoverability pass on every irreversible action (live Resume, confirm-or-undo on ⌘⇧L/⌘⇧R, trash-not-delete); shortcut coherence system (one resolver, full quick-action coverage).

---

### 13. Accessibility specialist (6/10)

**Findings**
- **Suggestions auto-dismiss in 4s with no pause/extend (WCAG 2.2.1)** — `App.tsx:47-50, 322-338`; suspend timers on hover/focus-within. *(high/medium, accessibility)*
- **Meeting toast: 6s to act, countdown never pauses on hover/focus** — `MeetingDetectedToast.tsx:4, 38-56`. *(high/small, accessibility)*
- **Recording start/stop/pause and meeting-saved never announced to screen readers** — chime + pixel changes only; add one aria-live=polite status region in App root. *(high/medium, accessibility)*
- **Bar toggles expose no pressed state** — IconTool omits aria-pressed (`Bar.tsx:113-137`); ControlPill already does it right (`ControlPill.tsx:54`). *(medium/small, accessibility)*
- **Mode popover: Escape collapses the whole overlay; trigger lacks aria-haspopup/expanded** — `Bar.tsx:153-166, 336-342` vs the Escape ladder (`App.tsx:911-951`). *(medium/small, accessibility)*
- **Copilot live region streams token-by-token without aria-busy** — `Copilot.tsx:60-62`; mirror `Answer.tsx:263`. *(medium/small, accessibility)*
- **Settings tablist: no arrow-key navigation or roving tabindex** — `Settings.tsx:2379-2408`. *(medium/small, accessibility)*
- **RecallView: advertised Enter doesn't exist; selection invisible to AT; rows not a list** — `RecallView.tsx:404-411, 443-458, 551-554`. *(medium/medium, accessibility)*
- **Tooltips hover-only** — add group-focus-within to IconTool + FieldHint (`Bar.tsx:133-135`, `ui.tsx:126-135`). *(medium/small, accessibility)*
- **Onboarding consent error and step changes silent** — role="alert" on the error div; announce step changes (`Onboarding.tsx:79-90, 297`). *(medium/small, accessibility)*
- **UpdateReadyToast role="alert" + aria-live="polite" contradiction** — use role="status" (`UpdateReadyToast.tsx:14`). *(low/small, accessibility)*
- **Missing state attributes** — Review Show-Transcript aria-expanded (`Review.tsx:512-531`); Answer thumbs aria-pressed (`Answer.tsx:175-202`). *(low/small, accessibility)*

**Quick wins:** toast pause; aria-pressed batch; popover Escape layering; Copilot aria-busy; focus-visible tooltips; onboarding alert roles; UpdateReadyToast role; disclosure/thumbs states; tablist arrows.
**Strategic:** timing-adjustable policy for every ephemeral surface (+ 'hold until dismissed' setting); single app-level SR announcer; keyboard-navigation regression suite on the Playwright harness.

---

### 14. Onboarding / first-run specialist (6/10)

**Findings**
- **Screen Recording cannot be granted from onboarding — first real meeting degrades to mic-only** — passive CheckRow (`Onboarding.tsx:246`); no TCC registration or System Settings deep-link anywhere (verified); first attempt fails mid-meeting (`listen.ts:651-676`). *(high/medium, onboarding)*
- **Mic prompt not triggered during onboarding** — row can never turn green in-flow (`Onboarding.tsx:245`); one getUserMedia + stop tracks fixes it. *(high/small, onboarding)*
- **Managed users sign in with Microsoft twice back-to-back** — SignInWall then slide 1's SSO button unconditionally re-runs interactive signIn (`App.tsx:1088-1094`, `Onboarding.tsx:163-169, 301-311`, `auth.ts:468+`). *(high/small, onboarding)*
- **Unexplained 'control System Events' Automation prompt ~7s after onboarding** — meeting poller (`index.ts:571-605`, default autoStart true); deny = permanently degraded detection with no recovery UI. Pre-frame or defer. *(medium/small, onboarding)*
- **Step-5 provider hint is a dead end** — Settings unreachable until onboarding finishes (`App.tsx:1097-1105`); wire an 'Add key' action. *(medium/small, onboarding)*
- **Slide-1 copy false for Screen Recording** — `Onboarding.tsx:324`; soften until the enable-action ships. *(medium/small, ux-behavior)*
- **'restart Listen' advice likely loops users** — TCC screen-capture grants generally need app relaunch (assumed); offer relaunch (`listen.ts:675, 697`). *(medium/small, reliability)*
- **Settings → Permissions is status-only** — no action per row; reuse the deep-link IPC (`Settings.tsx:3652-3702`). *(medium/small, onboarding)*
- **Windows: checklist rows can never turn green** — platform-perms returns 'unknown' (`platform-perms.ts:28-37`); hide or make informational. *(low/small, device-compat)*
- **CLI setup dead-ends non-technical users at 'npm not found'** — say upfront it's a developer path (`cli.ts:595`, `Settings.tsx:899-902`). *(low/small, onboarding)*

**Quick wins:** mic enable action; single sign-in; provider-row wiring; honest slide-1 copy; relaunch advice; Windows row gating; Automation pre-framing.
**Strategic:** turn step 5 into a permission wizard (TCC registration + deep-links); 60-second dry run after Get Started (self-test with the pre-warmed model); one composite readiness beacon with one-click fixes.

---

### 15. CMO — positioning (6/10)

**Findings**
- **README hero says "The invisible AI copilot" — the exact opposite of the consent-forward truth** — `README.md:5, 19`; the product's own onboarding says "Everyone on the call knows it's there". Winning position is the inverse of Cluely. *(high/small, positioning)*
- **'Known gaps' actively unsells the shipped offline-ASR moat** — stale ~40MB-download and not-a-git-repo claims (`README.md:125-126`); bundled models never appear in the features list. *(high/small, positioning)*
- **Onboarding never tells pillar 3** — no mention of recap/recall/graph/Dust follow-up in the tour (`Onboarding.tsx:208-251`). *(high/small, onboarding)*
- **Privacy moat claimed once at onboarding, then invisible** — zero on-device mentions in any meeting surface (grep verified); add "Transcribed on this Mac." to the toast subtitle. *(medium/small, positioning)*
- **Missing demo-defining capability: cross-meeting Q&A with cited answers** — all pieces exist (searchMeetings, readMeeting, useAsk, GROUNDING_RAIL source tags at `prompts.ts:98-104`). *(high/medium, positioning)*
- **The Dust follow-up workflow — the best enterprise story — is untold** — `Review.tsx:266-270, 366-380`; absent from README and onboarding. *(medium/small, positioning)*
- **Zero-marginal-AI-cost angle (CLI subscription reuse) stated nowhere** — a settings sub-caption only (`Settings.tsx:901-902`). *(medium/small, positioning)*
- **Usage panel proves engineering health, not business value** — add meetings captured / hours transcribed / answers delivered counters from data already on disk. *(medium/medium, positioning)*
- **Live fact-check demo gold buried as the third chip** — `quick-actions.ts:17-34, 107-111`. *(low/small, positioning)*
- **Onboarding tagline "Your on-device AI copilot" overclaims** — answers are cloud; tighten to "Transcription on your Mac. Answers from your AI." (`Onboarding.tsx:309`). *(medium/small, positioning)*

**Quick wins:** rewrite the hero + kill 'invisible'; fix Known gaps + add the bundled-models bullet; pillar-3 onboarding line; toast privacy tagline; Dust + $0 README bullets; precise tagline.
**Strategic:** build 'Ask your meetings'; claim the anti-Cluely category ("consent-forward meeting copilot") across all surfaces; productize the agent-knowledge exhaust (frontmatter schema + MCP push) as the platform story.

---

### 16. Competitive analyst (7/10)

**Findings**
- **No cross-meeting AI chat — the one table-stakes knowledge feature every competitor ships** — AskFred/Otter Chat/Granola folder query vs keyword scoring (`recall.ts:244-267`). RAG-lite is implementable with existing pieces. *(high/medium, knowledge-pipeline)*
- **"Ask or search anything" placeholder over-promises** — `RecallView.tsx:407`. *(medium/small, ux-behavior)*
- **README undersells the privacy moat with two factually wrong claims** — corroborates PM/CMO; the doc enterprise evaluators read first claims the opposite of the differentiator. *(medium/small, positioning)*
- **Speaker identity stops at you/them** — `ipc.ts:182`; Fireflies diarizes 50, Otter names speakers; sherpa-onnx (already shipped for Parakeet) has on-device diarization models. *(high/large, knowledge-pipeline)*
- **Structured recap export parsed but never leaves the app** — RecapExport typed (`ipc.ts:207-219`) yet the only egress is a 1,500-char mailto (`index.ts:1485-1496`); add clipboard/Jira-markdown copy. *(medium/small, knowledge-pipeline)*
- **$0 / unlimited-minutes story is nowhere user-facing** — vs Otter 300 free min/mo, Cluely $20-75/mo, Granola $14-35/user/mo. *(medium/small, positioning)*
- **Content-protection parity with Cluely's $75/mo tier unstated and unverified per release** — `index.ts:230`; state it + add a harness capture-black check. *(low/small, positioning)*
- **Calendar context dormant** — when Azure lands, match detected meetings to calendarToday events for titles/attendees. *(medium/medium, knowledge-pipeline)*

**Quick wins:** honest search placeholder; README fixes; $0 story line; clipboard recap export.
**Strategic:** cross-meeting Ask (RAG-lite); on-device diarization via sherpa-onnx + calendar attendee matching; package the un-copyable wedge (unlimited on-device minutes, zero cloud transcripts, escrowed encryption, runs on the subscription you already pay for).

---

### 17. Customer-success lead (6/10)

**Findings**
- **Recap silently sees only the last ~16,000 chars** — corroborates LLM/SRE; RECAP_PROMPT promises "every important question" while a 60-min interview keeps ~20 minutes. *(high/medium, knowledge-pipeline)*
- **Default at-rest encryption breaks the advertised Dust-agent folder share** — encryptTranscripts defaults true (`ipc.ts:320, 473`); files are ATKENC2 binaries and index.md rows are skipped (`transcripts.ts:438, 501`) while the folder README tells agents to read them (`transcripts.ts:311-313`). Fix copy now; explicit share action strategically. *(high/small copy fix, knowledge-pipeline)*
- **Past meeting without a recap shows an infinite 'writing detailed notes…' spinner** — display chain falls through to a perpetual spinner (`Review.tsx:351-363`, `App.tsx:1172`). *(high/small, bug-risk)*
- **Recap-less meetings are permanent dead ends** — no notes, no follow-up, no CRM push ever (`Review.tsx:366, 416`); add 'Generate notes' from pm.lines (pattern exists at `App.tsx:719`). *(high/medium, knowledge-pipeline)*
- **Follow-up email hard-gated on Dust** — `App.tsx:654-658` refuses every other configured provider; mirror endReview's cascade. *(high/small, ux-behavior)*
- **Recall search: substring-count scoring, no stopwords, YAML snippets** — `recall.ts:246-263`. *(medium/small, knowledge-pipeline)*
- **Abandoned meetings get junk titles** — first 50 chars of the other person's first utterance (`App.tsx:182, 206-207, 745`); fall back to '<mode> meeting — <date>'. *(medium/small, ux-behavior)*
- **Crash drafts invisible everywhere** — corroborates. *(medium/medium, reliability)*
- **Saved notes (Save-as-note) are write-only** — type:note excluded from list/search (`recall.ts:42`). *(medium/small, knowledge-pipeline)*
- **'status: ready-for-followup' never updated by AskToto itself** — duplicate-outreach risk for folder-sweeping agents (`transcripts.ts:426, 489, 312`). *(low/small, knowledge-pipeline)*

**Quick wins:** honest empty state for recap-less meetings; follow-up provider fallback; search fixes; title fallback; correct encryption messaging.
**Strategic:** chunked map-reduce recap; meeting identity from the calendar (real participants, subject titles, prefilled follow-up recipients); explicit per-meeting 'Share to Dust' with visible shared/not-shared state.

---

### 18. QA lead (5/10)

**Findings**
- **Renderer has zero test capability while 100% of recent bugs are renderer bugs** — vitest env 'node', no jsdom/@testing-library (`vitest.config.ts:8`); the last 5 commits are all renderer fixes with zero test files touched. *(high/medium, test-gap)*
- **The only e2e harness is untracked and can never fail a build** — deep-qa-test.mjs is gitignored, in no npm script, and never sets process.exitCode (`deep-qa-test.mjs:684-691`). *(high/small, reliability)*
- **phase() crash-isolation wrapper defined but never called** — first locator timeout kills all 20 phases (`deep-qa-test.mjs:38-45`). *(high/small, bug-risk)*
- **'them'-turn coalescing invariant has no direct regression net** — the load-bearing fix for the 0.6s endpoint lives untested inside the 870-line useListen hook; extract coalesceThemRun() + pin. *(high/medium, test-gap)*
- **Phase 19 hard-navigates the built app to localhost:5173** — guaranteed aborted run (`deep-qa-test.mjs:615-655`; demo params dev-only per `index.ts:270`). *(medium/small, bug-risk)*
- **Console-error collection starts after all interactions are done** — listener attached in Phase 20 (`deep-qa-test.mjs:662-664`). *(medium/small, bug-risk)*
- **asr-model:// path-traversal/symlink guard unpinned by any test** — extract resolveAsrModelPath() from `index.ts:1651-1673` + pin traversal/403/404 cases. *(medium/small, security)*
- **CI never runs the test suite on macOS — the primary platform** — quality job is ubuntu-only; the darwin keychain suite runs in no automated gate. *(medium/small, reliability)*
- **Harness state pollution** — persistent `.temp-qa-userdata` inside the OneDrive repo (onboarding self-skips on rerun); screenshots to a hardcoded foreign-agent dir. mkdtemp both. *(medium/small, reliability)*
- **selftest.ts real-runtime net exists but nothing runs it automatically** — wire ASKTOTO_SELFTEST into the macOS CI job (`selftest.ts:20`, `index.ts:1536`). *(medium/medium, test-gap)*
- **Coverage config silently excludes the renderer; coverage never runs in CI** — `vitest.config.ts:13`. *(low/small, test-gap)*
- **Headline '287 tests' overstates the enforced net** — verified 270 pass + 17 environment-skipped; make skips loud in CI. *(low/small, test-gap)*

**Quick wins:** commit + exit-code the harness; use phase(); gate Phase 19; move the console listener; mkdtemp state; macOS CI test step; extract + pin the asr-model guard; coverage script + renderer include.
**Strategic:** renderer test foundation (jsdom + @testing-library, aimed at the exact surfaces of the last five bug fixes); promote the harness into a versioned CI smoke gate on macos-latest; extraction program against the three untestable megafiles (index.ts 1,755 / App.tsx 1,416 / listen.ts 870).
