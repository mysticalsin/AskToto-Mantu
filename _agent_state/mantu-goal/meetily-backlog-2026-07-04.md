# What to take from meetily (Zackriya-Solutions) — ranked adopt-backlog

Mined 2026-07-04 from github.com/Zackriya-Solutions/meetily via 4 grounded analysts (ASR/audio, LLM/summarization, UX/features, infra) + Opus synthesis. Every item is tied to real meetily code. meetily is a different stack (Tauri/Rust + Python + whisper.cpp + llama.cpp), so these are ideas adapted to AskToto's Electron/TS, not code lifts.

## Themes
1. Ship-safety before v1.0.0: cheap release-time guardrails (verify signing, rehearse auto-update, retry model downloads) turn silent ship-in-the-wild failures into loud pre-upload failures.
2. Close the recap loop: AskToto varies the LIVE prompt by mode but throws that away at recap time, regex-parses recap prose (already caused a real empty-recap bug), and offers no per-run steering or edit.
3. Turn the brain into an ASR advantage: AskToto uniquely knows attendee/account/deal names pre-meeting; biasing decoding toward them is a differentiator competitors can't copy.
4. Feed the pipeline from more than the live mic: audio-file import and rename reuse the existing offline ASR + saveMeeting/ingest path.

## Backlog (rank / value / effort)
1. [high/small] Verify code-signing + notarization after every build (codesign --verify + spctl / Get-AuthenticodeSignature), gate uploads. → scripts/check-release.mjs or new verify-signing.mjs.
2. ~~Local auto-update rehearsal harness (local HTTP server)~~ — REJECTED by Tony (2026-07-04): no localhost server in AskToto, it is a file:// offline desktop app. Validate updates server-free instead: keep check-release.mjs static validation of electron-builder.yml + latest.yml, and if a live test is ever wanted, point electron-builder publish.url at a GitHub pre-release asset (real feed), not a localhost server.
3. [high/medium] Meeting-type-aware recap templates: recap honors the mode personas.ts already varies live (line 96 discards it). → prompts.ts per-mode section maps + personas.ts + transcripts.ts KNOWN set.
4. [high/medium] Schema-constrained structured output for recap metadata (title/tags/action-items+owner) instead of regex-over-prose, with one re-ask. → anthropic.ts/openai.ts + transcripts.ts fallback.
5. [high/medium] Import an existing audio file into a new transcribed meeting (batch through offline Parakeet/Whisper → saveMeeting/ingest). → new importAudio.ts + ipc + dialog/drag-drop.
6. [high/medium] Bias transcription toward known meeting entity names (feed brain's attendee/account/deal names as decoding conditioning). → whisper.worker.ts + parakeet.ts, names from brain/ingest.ts.
7. [medium/small] One-off steering instruction when regenerating a recap (a text field by Retry, appended to that single run only). → Review.tsx + ipc + llm/shared.ts.
8. [medium/small] Rename a meeting title after the fact (pencil on RecallView row + renameMeeting rewriting H1+frontmatter). → RecallView.tsx + recall.ts + ipc.
9. [medium/small] Retry + integrity check on build-time model downloads (backoff + content-length check). → scripts/fetch-models.mjs.
10. [medium/small] Live input-level meter in the mic picker (AnalyserNode/RMS bar next to the dropdown). → Settings.tsx mic chooser.
11. [medium/small] Cut long monologues at a silence point, not a hard 6.000s sample boundary (backtrack to local-min RMS). → whisper-worklet-src.ts + vad.ts.
12. [medium/medium] Model-aware transcript clipping budget (context-window lookup vs flat 240k/120k caps). → llm/shared.ts clippedTranscript.
13. [medium/medium] Editable AI recap (edit/preview textarea over the .md, save + re-derive topics). → recall.ts updateMeetingBody + recap view + ipc.
14. [medium/medium] Per-segment ASR confidence dot on low-confidence turns (if transformers.js/whisper.cpp expose logprob). → whisper.worker.ts + Bar/Review + Settings toggle.
15. [medium/large] Fully offline local-LLM recap path (bundled quantized GGUF via llama.cpp) for zero-key/zero-CLI users, mirroring the offline-ASR pattern. → new llm/local.ts + fetch-models.mjs + Settings card.
16. [high/large] Core Audio Process Tap (macOS 14.4+) as a lighter-permission system-audio backend vs the Screen-Recording-permission getDisplayMedia path. → index.ts loopback + platform-perms.ts.

## Deliberately skipped (with reason)
- Retranscribe-with-different-model after the fact: needs persisting raw audio, fights AskToto's "encrypted transcript, no raw audio" privacy design. Product-philosophy call for Tony.
- Neural (Silero) VAD second opinion: marginal gain; existing RMS hysteresis gate is well-tuned; #11 addresses the real monologue-slice defect more cheaply.
- Auto-suggest ASR quality tier from hardware: cosmetic; asrQuality is already a fast/best toggle.
