# Métis latency, quality, and enterprise audit — 2026-09-02

Five read-only code scans (live transcript, recap and Ask, Intelligence dashboard, brain and connectors,
startup and enterprise readiness) on `overlay-68-show` at 811fed9, ranked by impact over risk, then
implemented where a test could pin the change. Every row names the file, what was done or is proposed,
and who has to confirm it on a real device. Nothing below claims a measured number that was not measured;
"order of" is an honest estimate from the code, to be replaced by a Mac and a Windows run.

Status legend: **Done** landed on `claude/fix-access-assets-302-gynmr5` with a test. **Proposed** is code-
ready but needs a device check or a product decision first. **Devon** marks the check that needs a real Mac
or Windows seat.

## 1. Live transcript

| # | Finding | Where | Status | Expected impact | Risk / Devon check |
|---|---|---|---|---|---|
| T1 | Parakeet and Apple committed the 1.2 s streaming partial as a **final** line, so on the default engine most utterances appeared twice: prefix line, then full line, in the panel, the saved transcript, and the recap prompt. | `src/renderer/src/lib/listen.ts` Parakeet and Apple `commitLine` calls | **Done** (`listen.test.ts`) | Roughly halves duplicated lines on a normal call; recap sees each sentence once. | Low. Devon: one Parakeet meeting, confirm the faded interim caption then a single committed line. |
| T2 | The cross-line repeat guard counted provisional lines, so a partial plus its final spent the duplicate budget twice and a repeated short reply ("Yes." ... "Yes.") was dropped. | `listen.ts` `commitLine` | **Done** | Removes silent data loss in the saved transcript. | Very low. |
| T3 | `pump()` decoded a queued partial even when a later window from the same speaker already waited behind it; its output was discarded on arrival. | `listen.ts` `pump` | **Done** | One wasted decode per turn under load. | Low. |
| T4 | The worklet re-scored a rejected partial on every 128-sample quantum (O(fill) energy pass plus a sort and allocations) on the realtime audio thread for the whole idle life of the loopback channel. | `whisper-worklet-src.ts` | **Done** (`vad.test.ts` drives the real worklet) | Removes steady-state audio-thread CPU during silence; fewer render-quantum overruns (lost words). | Low. |
| T5 | ONNX Runtime WASM runs on **one thread** in every build: the renderer is not cross-origin isolated, so ORT clamps `numThreads` to 1, while the bundled blob is the threaded build. | `whisper.worker.ts:234`, `src/main/index.ts` Chromium switches | **Proposed** | 1.5 to 3x faster Whisper decode per window on 4+ core machines (the universal fallback path). | Medium. Needs `SharedArrayBuffer` enabled for the renderer and a try/catch fallback to 1 thread. **Devon**: Mac and Windows, confirm pthread session creation does not throw on a locked-down host; re-run `security-audit-10.contract.test.ts` and `check-built-offline.mjs`. |
| T6 | `start()` awaits `setListeningState`, `parakeetStatus`, `parakeetEnsure`, and `getAsrBundled` before `getUserMedia`, so the first seconds of a meeting are lost on a cold path. PR 99 fixes this on `main` (MQA-285) but is not on this base and its Parakeet hunk does not apply here. | `listen.ts:1660-1753` | **Proposed** | Hundreds of ms warm; 2 to 5 s on a cold Parakeet start. | Medium. Land PR 99 rebased onto `overlay-68-show`, rewriting its `parakeet.ts` hunk around `ensureParakeetAssets`. **Devon**: the two `liveRef` teardown branches after an aborted start. |
| T7 | The default engine has no prewarm at all and `parakeetRelease()` frees the ~600 MB recognizer after every meeting (with a forced V8 GC), so every meeting pays a multi-second synchronous model build on the main process at its first caption. | `listen.ts:2116`, `src/main/parakeet.ts:127`, `src/main/index.ts` `setListeningState(false)` | **Proposed** | Removes a multi-second first-caption stall and a main-process freeze from every meeting start. | Medium: RAM. Keep the recognizer warm behind a 10 min idle timer instead of freeing at every stop. Pinned by `speaker-id.test.ts` (MQA-042) and `ram-efficiency.contract.test.ts`; both need a deliberate update. **Devon**: memory on an 8 GB Mac across three back-to-back meetings. |
| T8 | WebGPU is disabled in every packaged build (`allowWebGpu = !bundled`), so "Best" is always `whisper-base` even after the user downloads the high tier that Settings promises will restore Best. | `whisper.worker.ts:254`, `Settings.tsx:5952` | **Proposed** | Largest live accuracy jump for users with a GPU and the 1.6 GB download, especially non-English. | Medium: WebGPU on old drivers can hang rather than throw; needs a timeout around the attempt. **Devon**: one Apple Silicon Mac and one Windows dGPU laptop. |
| T9 | One serial decode queue for both channels, backlog tolerance of 32 windows (~3 min) before the user is told captions are behind. | `listen.ts:27` | **Proposed** | Turns a silent 3 min drift into an early honest warning. | Product decision: `MAX_QUEUE` 8 drops audio sooner under load. Not changed. |
| T10 | Speaker-embedding compute sits inside the Parakeet caption round trip (synchronous, main process); Whisper already does it after commit. | `src/main/index.ts` `parakeet:feed` handler, `speaker-id.ts:305` | **Proposed** | Up to ~80 ms per window plus a one-time extractor load off the caption path. | Medium: echo defense currently suppresses text before it shows; deferring means a flash then retraction, as Whisper already does. Three source-shape tests pin the current handler. |
| T11 | On a Whisper session with language auto, the first five windows load the full Parakeet model into the main process only to vote on language. | `listen.ts:787`, `src/main/index.ts:4662` | **Proposed** | Removes a multi-second main-process stall from the opening minute of auto-language Whisper meetings. | Low if done as a prewarm at app-ready; higher if the probe model is swapped. |
| T12 | Main-side refusals (`requireAuth`, rate limit, shape, length) return `''`, indistinguishable from silence, so five in a row silently downgrade the session to Whisper. Latent today. | `src/main/index.ts:4664-4671`, `listen.ts:875` | **Proposed** | Prevents an unexplained engine downgrade once partial rates rise. | Low. Return a `refused` reason and exclude it from the empty-run counter, as `echo` already is. |

## 2. Recap and Ask

| # | Finding | Where | Status | Expected impact | Risk / Devon check |
|---|---|---|---|---|---|
| R1 | Live suggest shipped the **entire** transcript over IPC every 8 s; main zod-parsed it and ran ~20 redaction regex passes over it, then kept the last 6 000 chars. | `App.tsx` suggest runs, `src/main/index.ts` redact site | **Done** (`ask-transcript-tail.contract.test.ts`) | Removes a per-tick main-thread stall that grew with meeting length (order 10 to 100 ms at hour+ meetings). | Low. Recap and summary keep the full transcript. |
| R2 | `buildBrainContext` NFKD-normalized the whole transcript and ran one `includes()` per entity key per kind before any provider was dispatched. | `src/main/index.ts` brain-context site, `brain/context.ts:194` | **Done** | Order 50 to 300 ms of pre-dispatch stall on a real corpus. | Low, but a behavior change: entities named more than ~4 000 chars ago no longer pull their record into an unrelated question. |
| R3 | `openai.ts` set `prompt_cache_key` a second time outside the `includePromptCache` gate, so the drop-on-400 ladder never dropped it; a strict endpoint burned three round trips and still failed. | `src/main/llm/openai.ts` | **Done** (`cache-contract.test.ts`) | Two wasted round trips to zero on strict OpenAI-compatible endpoints; import recap succeeds instead of failing over. | Nil. |
| R4 | Import recap started a cold on-device model only after the last ASR window; on a default profile local is the only candidate. | `import-jobs.ts`, `src/main/index.ts` `prewarmImportRecap` | **Done** (`import-jobs.test.ts`) | 5 to 20 s off the tail of every default-profile import. | Gated on the MQA-270 free-RAM floor. **Devon**: an 8 GB Windows laptop importing a 1 h file. |
| R5 | Live Stop: the recap waits out the drain (up to 6 s) then starts cold. | `App.tsx` `endReview`, `localPrewarm` handler | **Done** (`app-stop-prewarm.contract.test.ts`) | Hides the drain behind the model warm on the local path. | Never warms for a cloud recap. |
| R6 | Import recap never streamed to the card: up to three serial 120 s attempts behind a 99% bar. | `import-recap.ts`, `import-jobs.ts`, `ImportQueue.tsx` | **Done** | First token in the card in seconds instead of a blank for minutes. | Partial text never reaches the checkpoint. |
| R7 | Language vote decodes short imports twice (every window through Parakeet, then Whisper) and re-runs the whole vote on every resume. | `import-jobs.ts:526-545` | **Proposed** | Roughly halves short-import wall time; free on resume. | Medium: the every-window widening is the MQA-238 fix. Persist `votedLanguage`; seed lines from the probe only when probe and transcribe engines are the same. |
| R8 | `localBaseReady` does four synchronous stats and is called 10 to 20 times per ask. | `llm/local-routing.ts:67` | **Proposed** | Tens of ms per ask on Defender-scanned Windows profiles. | Very low with invalidation on settings change and runtime state. |
| R9 | Import recap's "cached" system prefix is ~400 tokens, under Anthropic's cache floor; `systemCacheTtl` is accepted but never read. | `import-recap.ts:32`, `anthropic.ts:117` | **Proposed** | Small latency; real honesty gain for the Operator cache badge. | Very low. |
| R10 | `skillLockHashForMode` re-reads and parses the overlay lock on every ask. | `mode-skills.ts:195` | **Proposed** | Sub-ms on Mac, a few ms on Windows. | Very low; invalidation seams exist. |
| R11 | One IPC message per token from main; only the renderer coalesces. | `src/main/index.ts:5361` | **Proposed** | Small; matters against a warm local model at 200+ tok/s. | Must flush before `streamDone`; touches MQA-151 and hedge ordering. |
| R12 | Opening Review cold-decrypts the whole corpus to show 20 rows, concurrently with the recap stream. | `recall.ts:215`, `Review.tsx:455` | **Proposed** | Hundreds of ms on a large encrypted library. | Low; sort by filename timestamp, decrypt the top 20. |

## 3. Enterprise readiness

| # | Finding | Status | Note |
|---|---|---|---|
| E1 | The IT deployment doc said "no telemetry" while the Operator channel shipped Ask-text sending **on** by default and was absent from the Article 30 record. | **Done** | `sendAskText` defaults off and is lockable; docs and the compliance record describe the channel; the enterprise managed-config example locks `operatorUrl`, `operatorIngestSecret`, `sendAskText`. |
| E2 | The fleet-shared Operator HMAC secret reached the renderer through `publicSettings` and was rendered in Settings. | **Done** | Main blanks it and reports `operatorIngestSecretSet`; the field is write-only. Per-device keys at activation remain the longer-term fix. |
| E3 | The support diagnostics bundle exported every rotated audit generation (up to ~100 MB of actor emails and meeting-title basenames) while its manifest said otherwise. | **Done** | Main logs plus the current `audit.log` only; the manifest names what that file carries. |
| E4 | Pre-sign-in import recovery polled `requireAuth()` at 1 Hz, re-running a 0.5 to 1.9 s synchronous PowerShell ACL probe every 5 s on managed Windows fleets. | **Done** | Exponential backoff capped at 30 s. Routing `auth.ts`, `updater.ts`, `transcripts.ts` through the 60 s cached admin-policy accessor is still open. |
| E5 | The enterprise example pinned Dust to `dust.tt` against the compliance docs' open residency item. | **Done** | Pinned and locked to `https://eu.dust.tt`; tenant checklist item 5 updated. |
| E6 | Windows builds are signed with a self-signed root that IT must trust machine-wide. | Open | Azure Trusted Signing or an OV/EV cert before fleet rollout; `docs/SIGNING.md` documents the swap. |
| E7 | No macOS launch gate; a DOA DMG can ship (MQA-207, accepted). | Open | Startup marker plus a darwin branch of `check-packaged-launch.mjs`. Needs a Mac to author. |
| E8 | Seat licensing is compiled off; contracts sold on "N seats, revocable" have no enforcement. | Open | Decide, then flip both constants together and re-verify activation, cap, revocation. |
| E9 | The update feed lives on a personal GitHub account behind a mirror that deleted release tags once. | Open | Move under an org with tag protection, or make the internal `updateFeedUrl` the default recommendation. |
| E10 | Operator ask and rating events are dropped on any network failure; heartbeats have no jitter. | Open | Bounded JSONL spool drained on the next heartbeat; ±10% jitter. |
| E11 | No lint gate; `no-floating-promises` would catch the unhandled-rejection class the ledger keeps fixing by hand. | Open | typescript-eslint with a ratchet baseline, plus `check:skips` in CI. |
| E12 | MQA-234: the Whisper import engine silently runs Parakeet in packaged Windows builds. | Open | Transformers stack in a `utilityProcess`, per the ledger. |
| E13 | The license server is a single JSON file with no HA. | Open | Only matters once E8 flips. SQLite WAL or Postgres first. |
| E14 | The 60 s brain reconcile does a synchronous `statSync` sweep of the OneDrive meetings folder and every team folder on the main process. | Open | `fs.promises` with a concurrency cap, back off when nothing drifted. Preserve "unreadable is null, never deleted". |
| E15 | `time-saved.jsonl` never prunes; two extra ORT wasm copies ship in the asar. | Open | Per-day compaction; runtime-resolution proof before excluding the wasm trees. |

## 4. Already solid, do not spend time here

The VAD and its hysteresis, `isSpeechLikeWindow`, loopback AEC/NS/AGC handling, session-epoch guards on
every async ASR path, memoized transcript rows, compile-once regexes, process isolation between
transformers and sherpa, the renderer's first-token-unbatched delta coalescing, the hedge race with
first-visible-token-wins, per-tier idle budgets with the retry cap, the circuit breaker, `Retry-After` as a
decision rather than a sleep, polish moved after recap, the decode slot released before ASR, brain
context caching, bounded answer-first buffering, the hash-chained audit log, Windows machine-policy trust,
the updater channel logic, the CI supply-chain gates, the bug-ledger discipline, and the MQA-270 memory
work.

## 5. Verification run

- Client suites pinning every Done row: green (see the per-commit test lists on the branch).
- Operator Worker suite, proxy suite, skill lock: green.
- `tsc` node and web projects: clean on this branch (two pre-existing base errors were fixed in 47b9945).
- Base debt still red on `overlay-68-show` and therefore on CI: the test-file type ratchet (33 vs 30) and
  two failing tests (`Onboarding.helpers` first-run fetch, `BrainView.intelligence-pass` button).
