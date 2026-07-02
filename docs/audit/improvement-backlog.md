# AskToto — Improvement Backlog (deduplicated)

**Date:** 2026-07-02 · **Source:** 18 persona reports (see `team-review.md`) · **Ordering:** within each category, impact descending, then effort ascending.
**Dedup notes:** findings reported by multiple personas are merged into one entry; reporters are tagged (Arch = staff engineer, MainPerf, ReactPerf, Audio, ASR, LLM, Storage, Build, SRE, PM, UXR, IxD, A11y, Onb, CMO, Comp, CS, QA). Frozen visual design untouched; deliberate decisions per brief excluded.

---

## P0 — Top 12 (do these first)

| # | Item | Category | Anchor | Why P0 |
|---|------|----------|--------|--------|
| P0-1 | **Recap sees only the last ~16k chars of the transcript** — raise the slice cap now, chunked map-reduce later | knowledge-pipeline | `src/main/llm/shared.ts:85` | One line silently corrupts pillar 3 (recap, title, tags, actions, Dust follow-up, CRM push) for every meeting over ~20 minutes — exactly the meetings that matter. (LLM, SRE, CS) |
| P0-2 | **Default deep-tier Anthropic requests 400** — temperature sent to claude-opus-4-8 | bug-risk | `src/main/llm/anthropic.ts:36` | Fact-check, coding questions, and thinkingMode='always' are broken on the DEFAULT provider config; Anthropic-only users see raw 400s mid-meeting. Verified. (LLM) |
| P0-3 | **CLI providers ignore the per-tier idle budget** — live suggest waits 120s instead of 15s | reliability | `src/main/cli.ts:26`, `src/main/llm/cli.ts:11-17` | With `providerPriority='cli'` (a headline feature), one hung CLI blocks the live copilot for 2 minutes before failover can fire. (Arch, LLM) |
| P0-4 | **User-initiated answers auto-wiped by the ambient-suggestion TTL — including mid-stream** | ux-behavior | `src/renderer/src/App.tsx:322-338` | Typed follow-ups, Explain, and 'What to say next' vanish in 4-7s (WCAG 2.2.1 failure too); tag runs `ephemeral` and scope the TTL to ambient auto-suggest only. (UXR, IxD, A11y) |
| P0-5 | **Silent mid-meeting capture death** — no track.onended, no devicechange, no powerMonitor, one-shot watchdog | reliability | `src/renderer/src/lib/listen.ts:418-484` | Bluetooth disconnect or lid-close sleep leaves the UI saying "Listening" while a whole side of the meeting is silently lost — the most common field failure for the core pillar. (Audio, SRE) |
| P0-6 | **"Never lose a meeting" gap** — one-keypress loss exits (Escape after failed recap, startListen after ASR crash, tray quit) + crash drafts invisible and never swept | bug-risk / privacy | `src/renderer/src/App.tsx:686, 926-934`, `src/main/index.ts:694`, `src/main/recall.ts:217`, `src/main/transcripts.ts:512` | Multiple verified paths where a captured meeting is destroyed or unrecoverable, and orphaned drafts of third-party speech outlive retention forever. Trust-defining for a recording product. (SRE, UXR, Storage, CS, PM) |
| P0-7 | **Recall list/search re-reads + re-decrypts every meeting file on every call** | perf | `src/main/recall.ts:62-69, 244-267` | The one path that degrades linearly with product success — per keystroke, with sync keychain decrypts on the main loop, on a OneDrive folder (hydration storms). (Arch, MainPerf, Storage) |
| P0-8 | **Release/auto-update pipeline** — draft releaseType the updater can't see (since fixed: `releaseType: release` set + enforced by the check:release preflight gate), 4.6% headroom under GitHub's 2 GiB hard limit, no artifact content verification (a modelless Windows build already shipped) | reliability | `electron-builder.yml`, `scripts/check-release.mjs` | Remaining: size headroom + artifact content gates; one model or Electron bump breaks release upload after a 40-min build. (Build) |
| P0-9 | **Fixed-threshold energy VAD** — noisy rooms degrade to 6s hard cuts; quiet talkers silently vanish | reliability | `src/renderer/src/lib/vad.ts:20-21` | The two dominant real-world transcript-quality failure modes; the pipeline works in a quiet room with wired audio and falls over silently outside it. (Audio, ASR) |
| P0-10 | **One 6-second opt-in window per meeting — RESOLVED: timeout dismissals now re-offer every 60s (max 3) while the meeting is live; explicit X/Escape declines are respected** | ux-behavior | `src/renderer/src/components/MeetingDetectedToast.tsx`, `src/renderer/src/App.tsx` | Was the entry point to the entire product; a glance away no longer costs the meeting. (UXR, A11y) |
| P0-11 | **Electron 33.4.11 was past end-of-support — RESOLVED: bumped to Electron 39 (Chromium 142 / Node 22, min macOS 12)** | security | `package.json` | Was the single biggest security lever for an app that joins meetings and renders LLM/web content; keep a quarterly currency policy. (Build) |
| P0-12 | **Status docs actively contradict the code — RESOLVED (2026-07-02 docs sweep): README's false claims corrected, production-readiness/ labeled a superseded snapshot, REMAINING.md de-duplicated** | knowledge-pipeline / positioning | `README.md`, `production-readiness/` | These are the first documents Mantu IT reads for the m8 signing/Azure approval; they now match the code. (PM, CMO, Comp) |

---

## Fast lane — quick wins (small effort, immediate payoff)

Grouped for batching; each is independently shippable.

### Provider / LLM
- Thread `opts.idleMs` into runCliStream; delete the duplicate watchdog in cli.ts (`src/main/cli.ts:26-42`) — part of P0-3.
- Omit temperature for Opus-4.x models (`src/main/llm/anthropic.ts:36`) — part of P0-2.
- Raise the recap/summary slice caps to ~60-80k chars (`src/main/llm/shared.ts:80,85`) — part of P0-1.
- Failover eligibility: treat kind==='cli' as model-eligible when connected; pass `providerModelsDeep` (`src/main/index.ts:1072`).
- Clear `cliConnected[p]` on failed test / not-found spawn (`src/main/index.ts:836-839`).
- Fact-check: add the "no web access → UNVERIFIABLE" prompt line + slice the transcript-as-claim (`src/shared/quick-actions.ts:23-34`, `App.tsx:565-570`).
- Restore `--disallowedTools '*'` in testCli + throwaway cwd (`src/main/cli.ts:360`).
- Refresh stale model defaults (retired openrouter suggestion at `src/shared/providers.ts:157`; bump think/fast tiers).
- Extract `importDustSession()` and use it at all three call sites (`src/main/index.ts:807, 1151, 1699`).
- Send the Dust preamble only on createConversation / on system-hash change (`src/main/llm/dust.ts:126,168`).

### Main process / performance
- Gate `registerShortcuts()` on `'shortcuts' in p` and `setContentProtection` on `'contentProtection' in p` (`src/main/index.ts:745-771`).
- Replace `showMessageBoxSync` with `await dialog.showMessageBox` in recallDelete/recallDeleteAll (`src/main/index.ts:961, 987`).
- Call `parakeetRelease()` on listeningState(off) (`src/main/index.ts:1407-1414`).
- Separate ~5-min calendar TTL for the notifier path (`src/main/index.ts:621`).
- Cache detectPython's negative result (~60s) and parsed graph.json by mtime (`src/main/graphify.ts:84-123, 170-177, 340-348`).
- Make readEvalMetrics async (`src/main/metrics.ts:86-105`).
- Skip the 60s draft autosave write when nothing changed (`src/main/transcripts.ts:527-561`); drop AUTOSAVE_MS to 15s (`App.tsx:174`).
- Add `CliProviderSchema` (z.enum) + thin zod schemas to the unvalidated cli*/recall* handlers (`src/main/index.ts:826-857`).
- Drop the dead `windowMode` param and ignored `parakeetFeed.speaker` (`src/preload/index.ts:89-90, 128-129`).

### Renderer / React performance
- Hoist the shikiTheme array to a module const (`src/renderer/src/components/Markdown.tsx:16`) — 5 minutes, biggest wasted-render multiplier.
- React.memo TranscriptRow + useMemo the list in Copilot (`Copilot.tsx:145-161`) and Review (`Review.tsx:548-565`).
- Wrap useAsk's return in useMemo (`src/renderer/src/state.ts:305`).
- Structural-compare before setState in useSettings/usePermissions refresh (`state.ts:317-327, 434-446`).

### Audio / ASR
- `channelCountMode: 'explicit'` on the worklet node so stereo loopback downmixes (`src/renderer/src/lib/listen.ts:431-435`).
- Sticky note on first backpressure drop (`listen.ts:406-412`).
- Gate playCue/playClick while a 'them' channel is open (`App.tsx:342-353`).
- Pin `autoGainControl: true` (`listen.ts:591`).
- Worklet one-time {alive} ping to fix the 20s watchdog false positive (`listen.ts:472-481`).
- Unicode-safe corrections regex (lookarounds + `u` flag) (`listen.ts:170`).
- Multilingual phantom list + amara/sous-titrage/untertitel substring rules (`src/renderer/src/lib/transcript-filter.ts:13`).
- Prewarm the configured quality/engine; skip Whisper prewarm for Parakeet users (`listen.ts:852-867`).
- Pin HF model revisions in worker + fetch script (`whisper.worker.ts:15`, `scripts/fetch-models.mjs:118-120`).
- Resolve 'fast'→'best' when models are bundled and WebGPU exists (`whisper.worker.ts:59`, `ipc.ts:370`).

### Storage / recall
- Sweep orphaned `.autosave-draft-*.md` in sweepExpiredMeetings (`src/main/recall.ts:217`) — part of P0-6.
- Unescape titles in frontmatter() + round-trip test (`recall.ts:17`).
- Randomize writeSaved's tmp suffix; guard overlapping draft writes (`transcripts.ts:226`).
- CRLF-tolerant frontmatter/section regexes (`recall.ts:13, 106, 116`).
- Strip frontmatter before search snippets; word-boundary counting + stopwords; de-markdown snippets (`recall.ts:246-263`).
- Include type:note files in list/search — or stop implying recall covers them (`recall.ts:42`).
- Title fallback '<mode> meeting — <date>' for recap-less saves (`App.tsx:182, 206-207, 745`).
- Update `status:` after AskToto generates a follow-up (`transcripts.ts:426,489`).
- Correct the encryption messaging (Settings toggle desc + folder README: folder-reading agents cannot read encrypted transcripts) (`Settings.tsx:2754`, `transcripts.ts:311-313`).

### UX flows
- Keep the meeting-detected toast until acted on while a meeting is active and not listening — part of P0-10.
- Add saveMeetingNow to the Escape review-exit branch (`App.tsx:926-934`) — part of P0-6.
- Save un-persisted lines in startListen before listen.clear() (`App.tsx:686`) — part of P0-6.
- Route tray Quit through the renderer flush with a 3s fallback (`src/main/index.ts:694`) — part of P0-6.
- Add a render-process-gone handler (audit-log + webContents.reload) in createWindow.
- Pass retryAnswer into Review as "Regenerate summary" (`Review.tsx:351-352`).
- Honest "No notes were generated" state for past meetings with empty recap (`Review.tsx:351-363`).
- Follow-up: fall back to the active provider when Dust isn't ready (`App.tsx:654-658`).
- Surface recallRead failures + row-level "opening…" state (`App.tsx:852-865`).
- Wire Enter to openSelected(); fix the '⌘R' hint to ⌘⇧R; single-click opens rows (`RecallView.tsx:404-411, 454-458, 551-562`).
- Change the search placeholder to "Search meetings" until ask-over-notes exists (`RecallView.tsx:407`).
- Relabel Review's 'New meeting' chips (or wire the live case to startListen) (`Review.tsx:296-299`).
- Skip the auto-suggest view switch when an answer is on screen (`App.tsx:382-386`).
- Pass listen.paused to ControlPill and grey the rec-dot (`ControlPill.tsx:63-64`).
- 'Transcript' toggle also setView('copilot') (`App.tsx:845-847`).
- shell.trashItem instead of hard delete (`index.ts:947-995`).
- One-line notice when screen capture fails and the ask degrades to text (`App.tsx:441-448`).
- Copilot empty state: AudioLines glyph, not Mic (`Copilot.tsx:112-116`).
- Relabel '2 participants' → 'You + Them' (`Review.tsx:148`); add Join link to CompactEventRow (`RecallView.tsx:213-231`).
- Clipboard "Copy action items / Copy as Jira markdown" from RecapExport (`Review.tsx`, `ipc.ts:207-219`).

### Accessibility
- Pause the toast countdown on hover/focus-within (`MeetingDetectedToast.tsx:38-56`).
- aria-pressed on IconTool toggles; aria-haspopup/aria-expanded on the mode trigger (`Bar.tsx:113-137, 336-342`).
- Mode popover closes on Escape (capture phase, stopPropagation) (`Bar.tsx:156-166`).
- aria-busy on the Copilot live region (`Copilot.tsx:60-62`).
- group-focus-within on IconTool + FieldHint tooltips (`Bar.tsx:133`, `ui.tsx:130`).
- role="alert" on the onboarding consent error (`Onboarding.tsx:297`); role="status" on UpdateReadyToast (`UpdateReadyToast.tsx:14`).
- aria-expanded on Review's transcript disclosure; aria-pressed on Answer thumbs (`Review.tsx:512-531`, `Answer.tsx:175-202`).
- Arrow keys + roving tabindex on the Settings tablist (`Settings.tsx:2379-2408`).

### Onboarding
- 'Enable microphone' action (getUserMedia + stop tracks) on step 5 (`Onboarding.tsx:245`).
- Single 'Continue' when already signed in; hide SSO when unconfigured (`Onboarding.tsx:301-319`, `App.tsx:1101`).
- Wire the provider CheckRow to finish + openSettings('ai') (`Onboarding.tsx:244`, `App.tsx:391`).
- Honest slide-1 permission copy (`Onboarding.tsx:324`); 'quit and reopen' instead of 'restart Listen' (`listen.ts:675, 697`).
- Pre-frame the Automation prompt on step 5; gate Windows checklist rows (`Onboarding.tsx:240-247`, `platform-perms.ts:28-37`).
- AgendaView: show the IT-admin message immediately when auth is unconfigured (`AgendaView.tsx:73-87, 131-146`).

### Docs / positioning
- Fix the three false README claims (git/CI, 40MB download, provider count) — part of P0-12.
- Rewrite the hero; kill 'invisible' framing; separate Cluely provenance from positioning (`README.md:5,19,129-131`).
- Add README bullets: bundled offline ASR, Dust follow-up workflow, $0 CLI-subscription routing, live fact-check.
- "Transcribed on this Mac." on the meeting-detected toast subtitle (`MeetingDetectedToast.tsx:73`).
- Tagline: "Transcription on your Mac. Answers from your AI." (`Onboarding.tsx:309`).
- Pillar-3 line in the onboarding tour (`Onboarding.tsx:222-234`).
- Prune REMAINING.md (duplicate Parakeet checklist, shipped flush-on-stop); annotate Google items 'removed in 3b74951'; label iOS experimental/frozen.
- Merge the 49-commit branch to main; triage the two stale remote branches.

### CI / QA / release
- `releaseType: release` in electron-builder publish — done (set + enforced by check:release); part of P0-8.
- Artifact size (<~1.95 GiB) + content assertions (models/asr/ort/sherpa present) — part of P0-8.
- CI: cache resources/{models,asr,ort}; gate package jobs to main/tags; upload only installers + manifests; bump the Windows timeout (`build.yml`).
- Add `npm test` to the build-macos CI job.
- Commit deep-qa-test.mjs (scrubbed), set process.exitCode, add `npm run qa:e2e`; use the phase() wrapper; gate Phase 19 on ELECTRON_RENDERER_URL; attach the console listener first; mkdtemp the userdata/artifact dirs.
- Extract + pin resolveAsrModelPath() (traversal/403/404) from `index.ts:1651-1673`.
- test:coverage script + renderer in the coverage include; loud skip-count reporting.
- Make bidstackClient.test.ts skip (not fail) when the mock server can't bind.
- Download and install the CI Windows Setup.exe on one real Windows box; record the result.

---

## Full backlog by category

Legend: **[P0-n]** = in the top-12 list · impact/effort · reporters.

### Reliability

1. **[P0-5] Silent mid-meeting capture death** — track.onended + devicechange + powerMonitor resume + periodic watchdog, wired into the session-epoch re-acquire. high/medium. (Audio, SRE)
2. **[P0-3] CLI stream ignores the per-tier idle budget** — thread idleMs; delete the duplicate watchdog. high/small. (Arch, LLM)
3. **[P0-8] Release pipeline: draft releases (since fixed: `releaseType: release` + preflight gate), 2 GiB ceiling, unverified artifacts, never-installed >2GB NSIS** — remaining: size/content gates, one real Windows install. high/small each. (Build)
4. **[P0-9] Fixed-threshold VAD** — rolling-min noise floor with relative ON/OFF inside makeVad (keeps the tested-transplant design). high/medium. (Audio, ASR)
5. **[P0-6] Crash-recovery loop end-to-end** — sweep orphan drafts (small), launch-time "Recover interrupted meeting" promotion (medium), tray-quit flush handshake (small), render-process-gone self-heal (small), 15s autosave + failure telemetry (small). high/mixed. (Storage, SRE, UXR, CS)
6. **No local fallback when the meetings folder is unwritable** — after retries, write to userData/recovery; drafts too. high/medium. (SRE) — `transcripts.ts:333`, `App.tsx:256-273`
7. **Whisper has no RTF guard / per-window-error fallback counter** — measure decode RTF; fall back to WASM base via onEngineFallback after N failures (Parakeet already has this). high/medium. (ASR, SRE) — `whisper.worker.ts:29-38`, `listen.ts:287-295`
8. **Failed recap has no Retry** — pass retryAnswer into Review. high/small. (UXR) — `Review.tsx:351-352`
9. **e2e harness untracked + always exits 0** — commit, exit-code, npm script. high/small. (QA) — `deep-qa-test.mjs`
10. **1.9 GiB forced background download per release; differential unproven** — measure a real v0.1.0→v0.1.1. medium/medium. (Build) — `updater.ts:26-27`
11. **cliConnected never cleared** — routing keeps trying a dead CLI first. medium/small. (Arch) — `index.ts:836-839`
12. **Backpressure drops audio with only console.warn** — sticky note + optional quality downshift. medium/small. (Audio) — `listen.ts:406-412`
13. **Notifier makes a Graph call every 30s all day** — separate ~5-min TTL. medium/small. (MainPerf) — `index.ts:536, 621`
14. **'restart Listen' advice loops users after a TCC grant** — relaunch offer. medium/small. (Onb) — `listen.ts:675, 697`
15. **CI never runs tests on macOS** — one line in build-macos. medium/small. (QA) — `build.yml`
16. **49 commits ahead of main, no merge cadence** — merge now; per-feature cadence. medium/small. (PM)
17. **Harness state pollution (.temp-qa-userdata in the OneDrive repo; foreign artifact dir)** — mkdtemp. medium/small. (QA) — `deep-qa-test.mjs:14-15`
18. **Build outputs + 2.26 GB weights churn through OneDrive sync** — move output dir. low/small. (Build) — `electron-builder.yml:9`

### Bug-risk

1. **[P0-2] Anthropic deep tier 400s (temperature → opus-4-8)** — omit temperature for /opus-4-[78]|sonnet-5/; log cache usage. high/small. (LLM) — `anthropic.ts:36`
2. **[P0-6] Escape from Review after a failed recap discards the meeting** — add saveMeetingNow to the Escape branch. high/small. (UXR) — `App.tsx:926-934`
3. **[P0-6] startListen after an ASR crash wipes the transcript** — save-before-clear, mirroring newMeeting. high/small. (SRE) — `App.tsx:686`
4. **Infinite 'writing detailed notes…' spinner for recap-less past meetings** — honest empty state. high/small. (CS) — `Review.tsx:351-363`
5. **openPastMeeting is a silent dead click on failure** — surface r.error + opening state. high/small. (IxD) — `App.tsx:852-865`
6. **Harness phase() wrapper never called; Phase 19 dev-URL navigation; console listener attached last** — three mechanical harness fixes. high-medium/small. (QA) — `deep-qa-test.mjs:38-45, 615-655, 662-664`
7. **Failover eligibility drift: providerModelsDeep omitted; codex-cli never selectable** — mirror attempt()'s rules. medium/small. (Arch, LLM) — `index.ts:1072`, `providers.ts:256-269`
8. **Corrections regex fails on accented word edges (verified)** — Unicode lookarounds + `u`. medium/small. (ASR) — `listen.ts:170`
9. **Title round-trip lossy: escapes render literally (verified repro)** — unescape on read + test. medium/small. (Storage) — `recall.ts:17`, `transcripts.ts:407-408`
10. **Stereo loopback right channel discarded** — channelCountMode explicit. medium/small. (Audio) — `listen.ts:431-435`
11. **Fixed tmp filename + unserialized autosave races** — random suffix + in-flight guard. medium/small. (Storage) — `transcripts.ts:226`
12. **Speaker-mode echo bleed mislabels far side as 'you' and suppresses auto-answer** — near-duplicate drop in commitLine. medium/medium. (Audio) — `listen.ts:590-592, 206`
13. **Own 'ready' cue feeds the boosted them-channel VAD** — gate cues during loopback. low/small. (Audio) — `App.tsx:348`, `listen.ts:440`
14. **autoGainControl unpinned while the VAD calibration depends on it** — pin true. low/small. (Audio) — `listen.ts:591`

### Perf

1. **[P0-7] Recall O(N) full read + sync decrypt per call** — (file, mtime, size)-keyed cache or sidecar index; serve lists from index.md. high/medium. (Arch, MainPerf, Storage) — `recall.ts:62-69, 244-267`
2. **settingsSet: global-shortcut storm + double AES cycle per slider tick/keystroke** — gate side effects on patch keys; debounce continuous controls. high/small. (Arch, MainPerf) — `index.ts:745-771`, `store.ts:279-315`
3. **Unstable shikiTheme array defeats Streamdown's memo (verified)** — module const. high/small. (ReactPerf) — `Markdown.tsx:16`
4. **Unmemoized transcript rows in Copilot (and Review)** — memo'd TranscriptRow + useMemo list. high/small. (ReactPerf) — `Copilot.tsx:145-161`, `Review.tsx:548-565`
5. **Always-on @property conic-gradient rings repaint per frame, even idle** — compositor-only transform rotation, visually identical; extend prefers-reduced-motion. high/medium. (ReactPerf) — `styles.css:468-576`
6. **seconds ticker at App root: 3,600 full-tree renders/hour** — leaf MeetingClock in Bar's fixed slot. high/medium. (ReactPerf) — `App.tsx:107, 142-150`
7. **CI uploads 14.2 GB of artifacts and re-downloads 2.1 GB of models per push** — cache, gate, slim. high(cost)/small. (Build) — `build.yml:8, 81-109`
8. **useAsk returns a fresh object per render** — useMemo; prerequisite for all memo boundaries. medium/small. (ReactPerf) — `state.ts:305`
9. **useSettings/usePermissions identity churn** — structural compare. medium/small. (ReactPerf) — `state.ts:317-327, 434-446`
10. **Dust resends the full preamble every message** — send once per conversation. medium/small. (LLM) — `dust.ts:126, 168`
11. **Anthropic prompt cache silent no-op; no history breakpoint; no cache telemetry** — breakpoint + usage logging. medium/small. (LLM) — `anthropic.ts:37-39`
12. **isHardQuestion over-escalates to Opus** — require two technical signals. medium/small. (LLM) — `routing.ts:27, 31`
13. **parakeetRelease() dead — recognizer resident forever** — call on listen-off. medium/small. (Arch) — `parakeet.ts:199-206`
14. **graphify probes: multi-process chain per status call; full graph.json parse per call** — negative-result + mtime caches. medium/small. (MainPerf) — `graphify.ts:84-123, 163-192, 340-348`
15. **Prewarm loads 'fast' unconditionally** — prewarm the configured quality/engine. medium/small. (ASR) — `listen.ts:852-867`
16. **publicSettings round-trips the full contextDocs corpus** — metadata in PublicSettings + getContextDoc IPC. medium/medium. (Arch) — `index.ts:156-189`
17. **requireAuth: 5-8 uncached sync fs ops per call incl. per ASR window** — mtime-cached managed-config/auth reader shared with store.ts/transcripts.ts. medium/medium. (MainPerf) — `auth.ts:461-466, 95-114, 437-448`
18. **useAutoResize: two full-tree selector scans + forced layout per frame** — track marker presence from mutation records. medium/medium. (ReactPerf) — `state.ts:59-74, 100-101`
19. **Ask-input keystrokes render the full tree** — memo boundaries around body components after useAsk fix. medium/medium. (ReactPerf) — `App.tsx:96`
20. **readEvalMetrics sync-reads 5MB + parses 10k lines on the loop** — async / tail read. low/small. (MainPerf) — `metrics.ts:86-105`
21. **Draft autosave rewrites + re-encrypts unchanged transcripts every 60s** — skip when unchanged. low/small. (MainPerf) — `transcripts.ts:527-561`
22. **21 MB ORT wasm ships twice** — keep as safety net consciously or exclude. low/small. (Build)
23. **All LLM SDKs eagerly loaded at boot** — dynamic import at first ask; measure first. low/medium. (Build)

### Knowledge-pipeline

1. **[P0-1] Recap slice(-16000): long meetings lose their first two-thirds** — raise caps now; chunked map-reduce recap + "notes cover the last ~N minutes" disclosure. high/small→large. (LLM, SRE, CS)
2. **Cross-meeting Ask (RAG-lite over recallSearch hits, streamed with GROUNDING_RAIL citations)** — the missing table-stakes/demo-defining capability; all plumbing exists. high/medium. (CMO, Comp, UXR, CS)
3. **Default encryption breaks the advertised Dust folder share** — fix the copy now; explicit per-meeting 'Share to Dust' with visible state strategically. high/small+medium. (CS) — `ipc.ts:320`, `transcripts.ts:311-313, 438, 501`
4. **Recap-less meetings are permanent dead ends** — 'Generate notes' from pm.lines, re-save via saveTranscript. high/medium. (CS) — `Review.tsx:366, 416`, `App.tsx:719`
5. **English-only hallucination phantom list** — multilingual set + substring rules. high/small. (ASR) — `transcript-filter.ts:13`
6. **Speaker identity stops at you/them** — sherpa-onnx on-device diarization; pair with calendar attendee matching. high/large. (Comp, UXR) — `ipc.ts:182`
7. **6s hard-cap cuts mid-word without overlap** — silence-aligned cut or ~0.4s carry-over. medium/medium. (Audio, ASR) — `whisper-worklet-src.ts:23, 65`
8. **Phantom filter deletes genuine 'Okay'/'Thank you' turns** — energy-gated filtering. medium/medium. (ASR) — `transcript-filter.ts:18-24`
9. **Line timestamps are decode-time, not capture-time** — capturedAt threading + ordered insert. medium/medium. (Audio) — `listen.ts:189, 402-416`
10. **Per-window language auto-detect flips languages mid-meeting** — majority-vote lock + optional setting. medium/medium. (ASR) — `whisper.worker.ts:123-129`
11. **Recall search quality: substring scoring, no stopwords, YAML/markdown snippets** — word-boundary counting, stopwords, frontmatter-stripped snippets. medium/small. (Storage, CS) — `recall.ts:246-263`
12. **index.md append-only with no rebuild path** — rebuildIndex() from existing pieces. medium/small. (Storage) — `transcripts.ts:339-348`
13. **CRLF breaks the frontmatter parser; type guard admits typeless files** — `\r?\n` tolerance. medium/small. (Storage) — `recall.ts:13, 42, 106`
14. **Saved notes (type:note) invisible to list/search** — include or stop implying coverage. medium/small. (CS) — `recall.ts:42`
15. **Junk titles for abandoned meetings** — mode+date fallback (calendar subject when available). medium/small. (CS) — `App.tsx:745`
16. **Structured RecapExport never leaves the app** — clipboard/Jira-markdown copy now; Dust/BidStack contract strategically. medium/small. (Comp)
17. **Calendar-event matching for titles/participants/recipients** — when Azure lands. medium/medium. (Comp, CS)
18. **'status: ready-for-followup' never updated by the app itself** — rewrite after in-app follow-up. low/small. (CS) — `transcripts.ts:426, 489`
19. **[P0-12] README false claims + stale production-readiness NOT READY verdict + REMAINING.md drift + dead-feature backlog entries** — one source of truth for project state. high/small-medium. (PM, CMO, Comp)

### UX-behavior

1. **[P0-4] Ambient TTL wipes deliberate answers (mid-stream kill at 7s)** — origin/ephemeral flag on AskRequest; hover/focus pauses timers; 'last suggestion' recall from copilotHistoryRef. high/medium. (UXR, IxD, A11y)
2. **[P0-10] 6-second once-per-meeting capture opt-in** — persist while meeting active + not listening; countdown pauses on hover/focus. high/small. (UXR, A11y)
3. **One-keypress unconfirmed meeting end (⌘⇧L / Listen toggle) with no live Resume** — wire onResume for the live-ended branch (logic exists in resumePastMeeting). high/medium. (IxD) — `App.tsx:721-724, 870-881, 1178`
4. **Follow-up drafting hard-gated on Dust** — active-provider fallback. high/small. (CS) — `App.tsx:654-658`
5. **Auto-suggest yanks the user out of an answer mid-read** — skip the view switch when an answer is present. medium/small. (UXR) — `App.tsx:382-386`
6. **RecallView: Enter unwired, double-click-only open, wrong ⌘R hint, selection invisible to AT** — single-click open + Enter + aria-current + list semantics. medium/small-medium. (UXR, IxD, A11y) — `RecallView.tsx:404-458, 551-562`
7. **'New meeting' means three different things** — relabel or wire to startListen. medium/small. (UXR, IxD) — `Review.tsx:296-299`, `Bar.tsx:424-429`
8. **'Ask or search anything' placeholder over-promises** — "Search meetings" until cross-meeting Ask ships. medium/small. (UXR, Comp, CS) — `RecallView.tsx:407`
9. **No path to History during a live meeting** — keep it reachable in the right cluster. medium/small. (UXR) — `Bar.tsx:419-449`
10. **Minimized pill shows a live rec-dot while paused** — pass paused; grey dot (consent-truth issue). medium/small. (UXR) — `ControlPill.tsx:63-64`
11. **Screen-capture failure silently degrades to a blind ask** — one-line notice. medium/small. (IxD) — `App.tsx:441-448`
12. **Hard delete despite a free OS undo path** — shell.trashItem. medium/small. (IxD) — `index.ts:947-995`
13. **Second-device encrypted meetings silently vanish from History** — locked rows or an "N transcripts locked to another device" banner. medium/medium. (Storage) — `recall.ts:39-42`
14. **'What to say next' has no hotkey** — add a whatnext HotkeyAction. medium/medium. (IxD)
15. **Them-silence watchdog false-positives on a quiet far side** — alive-ping distinction. medium/small. (Audio) — `listen.ts:472-481`
16. **Fact-check verdict honesty + claim slicing** — see Provider fast lane. medium/small. (LLM)
17. **Stale model defaults in the picker** — catalog pass. medium/small. (LLM) — `providers.ts:157`
18. **Agenda 'Connect Outlook' dead-end CTA** — configured-check on mount. medium/small. (PM) — `AgendaView.tsx:131-146`
19. **English-only question detection for auto-answer** — per-language interrogative/dangling lists. medium/medium. (ASR) — `listen.ts:70-83`
20. **'Transcript' button invisible outside copilot view** — also switch view. low/small. (UXR) — `App.tsx:845-847`
21. **'2 participants' always** — relabel. low/small. (UXR) — `Review.tsx:148`
22. **Upcoming rows omit the Join link** — add joinUrl anchor. low/small. (UXR) — `RecallView.tsx:213-231`
23. **Copilot empty state names the wrong icon** — AudioLines. low/small. (IxD) — `Copilot.tsx:112-116`
24. **Shortcut hints hardcoded; lie after rebinds** — resolveDisplayShortcut from settings.shortcuts. low/medium. (IxD)

### Onboarding

1. **Screen Recording ungrantable in-flow — first meeting degrades to mic-only** — TCC registration + System Settings deep-link on step 5. high/medium. (Onb) — `Onboarding.tsx:246`
2. **Mic prompt never triggered in onboarding** — enable action. high/small. (Onb) — `Onboarding.tsx:245`
3. **Double Microsoft sign-in for managed users** — single Continue when authenticated. high/small. (Onb) — `Onboarding.tsx:163-169, 301-311`
4. **Pillar 3 untold in the tour** — one ActionRow: "Every meeting becomes a note your Dust agents can act on." high/small. (CMO) — `Onboarding.tsx:222-234`
5. **Unexplained Automation prompt ~7s post-onboarding** — pre-frame or defer. medium/small. (Onb) — `index.ts:571-605`
6. **Provider hint is a dead end (Settings unreachable)** — wire finish + openSettings. medium/small. (Onb) — `Onboarding.tsx:244`
7. **Slide-1 copy false for Screen Recording** — soften. medium/small. (Onb) — `Onboarding.tsx:324`
8. **Settings → Permissions is status-only** — per-row Open System Settings action; gate the note on !granted. medium/small. (Onb) — `Settings.tsx:3652-3702`
9. **Graphify prerequisites (python + graphify + claude CLI) undocumented** — README/Settings copy. medium/small. (PM) — `graphify.ts:71-118`
10. **Windows checklist rows can never turn green** — hide/informational on win32. low/small. (Onb) — `platform-perms.ts:28-37`
11. **CLI setup dead-ends non-technical users** — label as a developer path upfront. low/small. (Onb) — `Settings.tsx:899-902`

### Accessibility

1. **Auto-vanishing suggestions/toasts violate WCAG 2.2.1** — merged into P0-4/P0-10 (hover/focus pause + optional hold-until-dismissed). high/medium. (A11y)
2. **No screen-reader announcements for recording start/stop/pause/saved** — one aria-live=polite announcer in App root. high/medium. (A11y)
3. **Bar toggles stateless to AT** — aria-pressed via IconTool prop. medium/small. (A11y) — `Bar.tsx:113-137`
4. **Mode popover Escape layering + missing aria-haspopup/expanded** — capture-phase close. medium/small. (A11y) — `Bar.tsx:153-166, 336-342`
5. **Copilot live region churns per token** — aria-busy while streaming. medium/small. (A11y) — `Copilot.tsx:60-62`
6. **Settings tablist: no arrow keys / roving tabindex** — APG pattern. medium/small. (A11y) — `Settings.tsx:2379-2408`
7. **RecallView semantics: no Enter, invisible selection, bare divs** — merged with UX #6. medium/medium. (A11y)
8. **Tooltips hover-only** — group-focus-within. medium/small. (A11y) — `Bar.tsx:133`, `ui.tsx:126-135`
9. **Onboarding consent error + step changes silent** — role=alert; announce steps. medium/small. (A11y) — `Onboarding.tsx:79-90, 297`
10. **UpdateReadyToast role contradiction** — role=status. low/small. (A11y) — `UpdateReadyToast.tsx:14`
11. **Missing disclosure/rating states** — aria-expanded / aria-pressed. low/small. (A11y) — `Review.tsx:512-531`, `Answer.tsx:175-202`

### Security

1. **[P0-11] Electron 33 past EOL — DONE: bumped to Electron 39 (Chromium 142 / Node 22, min macOS 12)** — re-run the Playwright harness over capture/loopback/asr-model://; adopt a quarterly currency policy. (Build)
2. **fetch-models pins nothing, verifies nothing** — commit-SHA URLs + byte/hash assertions (mirror the pin in whisper.worker.ts MODEL_REVISION). medium/small. (Build, ASR) — `fetch-models.mjs:36-38, 88-120`
3. **IPC boundary gaps: cli*/recall*/window* unvalidated** — zod schemas at the boundary. medium/small. (Arch) — `index.ts:826-857`
4. **Encryption lifecycle: toggling strands files both directions; index desync** — batch migrate + rebuild on toggle. medium/medium. (Storage)
5. **asr-model:// traversal/symlink guard untested** — extract + pin. medium/small. (QA) — `index.ts:1651-1673`
6. **testCli drops the --disallowedTools '*' invariant** — restore + throwaway cwd. low/small. (LLM) — `cli.ts:360`

### Test-gap

1. **Renderer: zero test capability; all recent defects are renderer** — jsdom + @testing-library, aimed at toast lifecycle, Review clicks, onboarding gating, Bar controls. high/medium. (QA)
2. **Ask routing/failover engine: ~190 untested lines that have already drifted** — extract src/main/ask-router.ts (pure) + unit tests for ordering, CLI priority, deep-tier resolution, vision-gap fallback. high/medium. (Arch)
3. **'them'-turn coalescing has no regression net** — extract coalesceThemRun() + pin join/reset/fire-once. high/medium. (QA)
4. **No packaged-artifact verification** — merged into P0-8. high/small. (Build)
5. **Worklet buffering paths (hard cap, RMS gate, flush) untested** — vm-eval with stub processor. medium/medium. (Audio)
6. **Zero multilingual fixtures (phantoms, questions, corrections)** — small table-driven additions. medium/small. (ASR)
7. **selftest.ts never runs automatically** — wire ASKTOTO_SELFTEST into macOS CI. medium/medium. (QA)
8. **Coverage excludes the renderer; never runs in CI** — include + artifact. low/small. (QA)
9. **bidstack tests hard-fail without network** — ctx.skip(). low/small. (PM, QA)
10. **Silent environment skips (270/287 enforced)** — loud skip reporting in CI. low/small. (QA)

### Code-efficiency

1. **index.ts God module (1,736 lines, ~60 IPC handlers, shared mutable state)** — mechanical split: window.ts, capture.ts, meeting-schedulers.ts, ipc/ groups. medium/large. (Arch)
2. **Settings.tsx monolith (4,013 lines, 53 useState, 33 inner components)** — per-tab split behind the existing lazy boundary. medium/large. (Arch)
3. **Dust session import triplicated** — importDustSession(). medium/small. (Arch)
4. **Duplicated managed-config readers across store/auth/transcripts** — one mtime-cached layer. medium/medium. (MainPerf)
5. **Calendar cache-fill + tz resolution duplicated** — getTodayEvents(). low/small. (Arch) — `index.ts:551-567, 619-631`
6. **Dead IPC params (windowMode mode, parakeetFeed speaker)** — drop. low/small. (Arch)

### Device-compat

1. **>2GB Windows NSIS installer never installed on real hardware; Windows headlined but unverified** — one real install, or demote the README claim. high/small. (Build, PM)
2. **macOS arm64-only; no x64 in the update manifest** — decide explicitly (add x64 artifacts or declare Apple-silicon-only). medium/medium. (Build)
3. **Cross-building Windows from macOS silently drops sherpa-onnx; no win-arm64 binary exists** — presence check in the artifact gate; "Windows builds only from Windows CI". medium/small. (Build)
4. **Windows onboarding rows permanently amber** — merged into Onboarding #10. low/small. (Onb)

### Positioning

1. **[P0-12] README hero 'invisible' + stale Known-gaps unselling the moat** — anti-Cluely, consent-forward rewrite. high/small. (CMO, Comp, PM)
2. **Cross-meeting Ask as the demo-defining capability** — merged into Knowledge #2. high/medium. (CMO, Comp)
3. **Default 'fast' ASR ships the weakest model though the best is bundled** — merged into ASR fast lane. high/small. (ASR)
4. **Privacy moat invisible in-product after onboarding** — toast tagline + transcript-header cue. medium/small. (CMO)
5. **$0 / unlimited-minutes story untold** — README + onboarding one-liners. medium/small. (CMO, Comp)
6. **Dust follow-up workflow untold** — README bullet + onboarding pillar-3 line. medium/small. (CMO)
7. **On-device tagline overclaims (answers are cloud)** — precise phrasing. medium/small. (CMO) — `Onboarding.tsx:309`
8. **Usage panel lacks value counters** — meetings/hours/answers from data on disk. medium/medium. (CMO)
9. **iOS: unowned fourth surface with drifted claims** — freeze labeled experimental until desktop v1.0. medium/decision. (PM)
10. **Content-protection parity with Cluely's paid tier unstated/unverified** — README line + harness capture-black check. low/small. (Comp)
11. **Live fact-check demo gold buried** — README bullet + demo-script beat 2. low/small. (CMO)

---

## Strategic moves (larger than backlog items — sequencing input for the roadmap)

1. **Ship the trust batch (P0-1..P0-6)** — one line to un-corrupt recaps, four small data-loss fixes, TTL scoping, capture-death watchdog. This is a week of work that changes whether users can rely on the product.
2. **Send MANTU-IT-REQUEST.md this week** — the critical path (m8 signing + Azure) is entirely human/external and has been idle since 2026-06-28 against a 2026-08-09 goal. (PM)
3. **Extract-and-test program** — ask-router out of the askStart closure, coalesceThemRun out of useListen, resolveAsrModelPath out of index.ts; jsdom renderer foundation. Turns the three untestable megafiles into tested modules. (Arch, QA)
4. **Recall that scales + cross-meeting Ask** — persistent read cache/sidecar index, then RAG-lite Q&A with cited answers. Fixes the perf wall and closes the category's table-stakes gap in one arc. (MainPerf, Storage, CMO, Comp)
5. **Crash-recovery + capture-health as a product promise ("AskToto never loses a meeting")** — draft promotion UX, local-fallback writes, onended/powerMonitor watchdogs, live Resume. (SRE, Storage, IxD)
6. **Release train hardening** — sub-1GB artifact strategy (q4f16 or in-app 'accurate' download), one proven end-to-end update, Electron currency policy, CI cost sanity. (Build)
7. **Make multilingual real** — noise-floor VAD, language lock, localized question lists, multilingual phantom corpus, Unicode corrections. The 99-language claim currently holds only for English. (ASR, Audio)
8. **Claim the anti-Cluely category** — consent-forward story unified across README/onboarding/toasts; value counters; agent-knowledge exhaust as the platform wedge. (CMO, Comp)
