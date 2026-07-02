# AskToto — Remaining work to reach v1.0 (Cluely competitor)

Goal: `goal-2026-06-28-asktoto-cluely-competitor` (deadline 2026-08-09). This is the resume-here list of
what is NOT yet done. Everything else (the 3 UX P0s, transcription engine, system-audio fix, a11y core,
capstone-audited code) is shipped + verified. Updated 2026-06-28.

## 🔒 Human-gated — cannot be coded, need someone to act

### m8 — Code-signing, notarization, distribution + Azure (BLOCKER for "shippable")
Owner: **Tony + Mantu IT**. Without these the app can't be installed by a normal user (Gatekeeper blocks
unsigned builds) and the Outlook agenda / SSO stay dormant.
- [ ] **Apple Developer ID cert + notarization creds** — set `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`,
      `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`; flip `electron-builder.yml` `gatekeeperAssess` + enable
      `notarize`. Verify the signed `.dmg` passes Gatekeeper on a clean Mac.
- [ ] **Windows Authenticode or Azure Trusted Signing** (if shipping Windows) + a Windows signing runner.
- [ ] **Azure (Entra) app registration** — "Mobile and desktop applications" platform, loopback redirect;
      grant delegated **`User.Read` + `Calendars.Read`**; set `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`,
      `azureAllowedDomain`. Once set, the in-app "Connect Outlook calendar" goes live (code is all there:
      `src/main/auth.ts` getGraphToken + `src/main/calendar.ts` + `AgendaView.tsx`).
- [ ] **Signed update channel** — `verifyUpdateCodeSignature: true` is set and publish is wired to the
      AskToto-Releases GitHub repo with `releaseType: release` (enforced by the `npm run check:release`
      preflight gate); remaining: sign the artifacts (above).

### m9 — Acceptance (BLOCKER for "done")
- [ ] **Real-call sign-off (Tony)** — a real 30-min call incl. a non-English speaker: transcription accurate,
      all 3 P0s work, auto-summary produced, zero errors.
- [ ] **Non-technical pilot tester** — installs the signed build, completes a meeting unaided, rates it usable.
- [ ] Re-run the multi-agent capstone audit on the final build.

## 🛠 Dedicated code efforts — too large/risky to batch; each needs a focused pass

### m2 — Parakeet v3 optional engine ✅ DONE + VERIFIED (2026-06-28)
Whisper is the **default** engine; the default quality tier is 'fast' (WASM whisper-base q8), with 'best'
(WebGPU large-v3-turbo, ~99 languages) the opt-in Settings → Audio quality — its weights are already bundled.
**Parakeet v3 is now integrated** as the opt-in "fastest, 25 European languages" engine (Settings → Audio →
"Use Parakeet engine").

Shipped: `sherpa-onnx-node` v1.13.3 (N-API native addon — loads in Electron, no rebuild) in `src/main/parakeet.ts`
(OfflineRecognizer + bundled model weights — `resources/asr` via `npm run fetch-models`, zero-download in packaged
builds, one-time userData download only as a dev fallback — + transcribe), IPC `parakeet:status/ensure/feed`,
preload methods, `listen.ts` engine routing (Whisper-fallback-safe — any Parakeet failure degrades to Whisper),
the Settings selector, and `asarUnpack` for the native binary. **Verified end-to-end**: recognizer constructs +
transcribed the German sample correctly ("Alles hat ein Ende, nur die Wurst hat zwei."), and the default Whisper
path is untouched (qa-full 26/26).

Remaining polish (not blockers):
- [ ] **Windows/Linux binaries** ship automatically via sherpa's per-platform optionalDependencies when building
      the installer on those OSes — verify on a Windows build (ties into m8 signing).
- [ ] **VAD segmentation** (`Vad` is in the addon) instead of per-6s-window decode, to cut on speech pauses.
- [ ] Optionally make Parakeet the default for European-heavy users (one-line: `asrEngine` default). Kept Whisper
      default because Parakeet is European-only and would mis-handle non-European speech.

### Audio pipeline fixes (M) — applies to either engine
- [ ] **Flush-on-stop**: the last ~6s of speech is dropped at `stop()` (worklet residual buffer never
      emitted). Needs a flush handshake on the realtime audio thread + keep `liveRef` alive until the final
      window transcribes + fold it into the recap. Deferred originally because a racy flush risks worse bugs;
      needs live-audio verification.
- [ ] **VAD segmentation** (replace fixed 6s windows) so cuts land on speech pauses, not mid-word — removes
      the boundary-word artifact. Use silero-vad (`@ricky0123/vad-web` in renderer, or sherpa VAD in main).
- [ ] Carry ~400ms overlap / previous-segment context across windows.

### m4 — Onboarding & activation (M)  — IN PROGRESS this session (primer step added)
- [ ] Permission pre-flight with deep-links to System Settings + a visible mic-only fallback chip.
- [ ] Reorder Settings "AI" so the active provider's **key field is first** with inline auto-verify;
      demote the Dust/CLI wall to a collapsed disclosure.

### m6 — Visual & motion premium pass (L)
- [ ] Audit inline transitions still using `duration-100/150` → move to the `--ease-spring`/`--duration-*`
      tokens. Hierarchy + glass-depth + spacing-rhythm polish to hit Cluely/Granola-grade craft.
- [ ] Focus-ring visibility audit across all interactive elements.

### m7 — Performance & optimization (L)
- [ ] **Instant-start tier**: load whisper-base immediately for the first seconds of transcription while
      large-v3-turbo downloads in the background, then swap. (Mid-session model swap — needs care.)
- [ ] First-run **~800MB download** UX: a clearer "downloading the speech model (~800MB, one-time)" notice +
      metered-connection awareness. (A `loadingPct` % already shows.)
- Note: packaged builds bundle all weights — **no first-run download**. The two items above apply only to
      dev builds without `fetch-models`; deprioritize or drop.
- [ ] 60-minute meeting soak test (memory stability under continuous WebGPU inference — transformers.js #860).

## P2 nits from the capstone audit (low priority, deferred)
- [ ] Abort/cancel suppression in `state.ts` uses a substring regex — could swallow a genuine network error
      whose message contains "abort"/"cancel". Gate on a real user-cancel flag tagged by the main process.
- [ ] `getSettings()` does 2 managed-config disk reads per call (locked-keys-on-read) — cache if it ever
      shows on a hot path.
- [ ] `display-media` handler now grants a screen **video** source for macOS loopback (renderer drops it
      instantly). Gated (armed + main-frame + origin); revisit if a non-screen-capture loopback path appears.
