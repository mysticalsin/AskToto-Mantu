# AskToto — Deep Baton: 10× Better Roadmap

> **For:** the next Claude session  
> **From:** Wave 0–5 implementation + re-audit  
> **Date:** 2026-06-27  
> **App path:** `/Users/tony/Library/CloudStorage/OneDrive-MantuGroup/Documents/TEST/AskToto`  
> **Created by:** Tony Walteur

---

## 1. Where we are right now

### What the app is
AskToto is a macOS-first Electron 33 overlay assistant (Cluely-style). It sits as a frameless, transparent, always-on-top glass bar with these core modes:

- **Ask** — typed question → streamed markdown answer
- **Capture** — screenshot → AI vision reasoning
- **Listen** — live Whisper transcription + copilot suggestions during meetings
- **Fact-check** — typed claim or screen context → verdict
- **Review** — meeting recap + transcript saved to OneDrive/Dust

### Stack
`Electron 33` + `Vite 5` + `React 18` + `TypeScript` + `Tailwind v4` + `Base UI` + `Lucide` + `streamdown` + `Shiki` + `@huggingface/transformers` (on-device Whisper) + `Anthropic/OpenAI` SDKs.

### What just got done (Waves 0–5)
- 38 of 65 audit findings fixed
- All build/tests green: `typecheck`, `build`, `test` (18/18), `dist` produces `.app`
- Critical state bugs fixed (auto-end, cancellation, stale errors)
- Trust UX added (recording-consent onboarding, per-meeting confirmation toast, cloud-sync warning)
- Security hardened (no silent video capture, key storage refuses plaintext fallback, managed-config locking, CSP tightened)
- Apple Liquid Glass design tokens applied across components
- Accessibility basics added (`aria-live`, focus rings, reduced motion)
- Vitest harness with 24 tests covering IPC schemas, store layering, transcript frontmatter, Windows meeting detection
- Cross-platform permission abstraction (`src/main/platform-perms.ts`) + IPC channel

### Cross-platform status
The app is now **macOS + Windows** with shared abstractions:

- Meeting detection is split into `src/main/meeting-detect/mac.ts` and `src/main/meeting-detect/win.ts`.
- Windows detection uses PowerShell process-title matching + **UI Automation browser-URL fallback** for Chrome/Edge/Brave.
- Cross-platform permission abstraction lives in `src/main/platform-perms.ts` and is exposed via `usePermissions()`.
- Settings and Onboarding now show **platform-specific copy** (macOS "System Settings" vs Windows "Settings → Privacy & security").
- `electron-builder.yml` includes `nsis`, `portable`, and `appx` Windows targets + signing env placeholders.
- GitHub Actions workflow builds macOS + Windows artifacts on every push/PR.
- Build has **not been run on a real Windows machine** yet; CI will exercise this.

### Known remaining HIGH items
| ID | Item | Owner |
|---|---|---|
| A-016 | Apple signing / notarization / real update host | TONY |
| A-001 | Per-meeting third-party consent / audible-visible indicator policy | TONY |
| A-015 | Migrate / purge existing plaintext API-key files | TONY |
| A-017 | Further preload hardening | eng |
| A-026/A-029 | Accessibility permission UX in onboarding | eng |

---

## 2. What “10× better” means

A 10× better AskToto is not more features. It is:

1. **Trustworthy by default** — users and enterprises trust it with sensitive meetings.
2. **Invisible until needed** — feels like a native macOS extension, not a third-party overlay.
3. **Correct under stress** — never loses data, never records when it shouldn't, never lies about shortcuts.
4. **Delightfully fast** — sub-200 ms from hotkey to visible response.
5. **Accessible** — works with VoiceOver, keyboard-only, and reduced motion.
6. **Observable** — errors and telemetry are surfaced, not swallowed.
7. **Shippable** — signed, notarized, auto-updating, with a clean legal posture.

---

## 3. The 10× roadmap (prioritized)

### Phase A — Ship the trust foundation (do first)

These are blockers for any real user pilot. Do not skip.

#### A.1 Per-meeting consent & recording indicator ✅ Done
**Goal:** Make covert recording impossible.

- ✅ Persistent "Recording" pill in the Bar with pulsing red dot + glowing shadow + elapsed timer.
- ✅ Main-process tray/menubar tooltip updates to `🔴 AskToto — Recording` and macOS title shows `🔴 Toto` while listening.
- ✅ First-use-per-day (or enterprise-forced) consent reminder toast: *"AskToto is listening. Other participants are being recorded."* with auto-dismiss.
- ✅ Setting "Play a soft chime when recording starts" (default ON); chime generated in-browser via Web Audio API.
- ✅ Enterprise policy `requireConsentIndicator` that IT can lock ON (reminder shown every Listen start).
- ⬜ Optional: audible "recording in progress" announcement every N minutes (deferred — legal/business decision).

**Files:** `src/renderer/src/components/Bar.tsx`, `src/renderer/src/components/RecordingConsentReminder.tsx`, `src/renderer/src/lib/listen.ts`, `src/renderer/src/App.tsx`, `src/main/index.ts` (tray icon state), `src/shared/ipc.ts`.

#### A.2 Auto-save truly opt-in
**Goal:** No plaintext PII leaves the device unless the user explicitly opts in.

- Current state: `DEFAULT_SETTINGS.autoSaveTranscripts: false` and cloud-sync warning exists.
- Add an onboarding screen specifically for auto-save: explain what is saved, where, and that it is plain text.
- Require explicit toggle ON during onboarding; default stays OFF.
- Add an in-app "Your last transcript was saved locally" confirmation (not just tray).
- Add an enterprise policy `allowAutoSaveTranscripts` that IT can lock OFF.

**Files:** `src/renderer/src/components/Onboarding.tsx`, `src/renderer/src/components/Settings.tsx`, `src/renderer/src/App.tsx`.

#### A.3 Accessibility permission UX
**Goal:** Auto-start-on-meeting cannot fail silently.

- Detect Accessibility permission status on macOS (use `systemPreferences.isTrustedAccessibilityClient(prompt)` or AX API checks).
- In onboarding step 2, add an explicit "Enable Accessibility" button + status.
- In Settings, show a red/yellow/green status dot for Accessibility + Screen Recording + Mic.
- If the user enables auto-start but permissions are missing, disable the toggle and show a direct "Open System Settings" button.

**Files:** `src/main/index.ts`, `src/renderer/src/components/Onboarding.tsx`, `src/renderer/src/components/Settings.tsx`.

#### A.4 Clipboard error surfacing (just completed)
✅ Done in Wave 5. `Answer.tsx` and `Review.tsx` now show inline copy errors.

---

### Phase B — Native macOS feel (biggest perceived quality jump)

#### B.1 True Liquid Glass depth
**Goal:** The overlay looks and feels like it belongs in macOS Sequoia+.

Current state: tokens exist, `.glass`/`.glass-strong` are decent but flat.

Next level:
- Add a **refractive rim-light** shader or CSS `mask-image` highlight that follows the mouse (subtle).
- Use **layered backdrop blurs**: bar at 28 px, panel at 36 px, elevated chips at 18 px.
- Add **inner shadows** and **1 px hairlines** that respond to panel position.
- Replace the remaining hardcoded white/opacities with semantic tokens.
- Add a **dynamic background tint** based on the screen behind the window (sample a blurred pixel region from `desktopCapturer` when idle — optional, advanced).
- Implement **spring physics everywhere**: panel enter, bar state changes, chip hover, suggestion cards.
- Add a **compact mini-bar** when collapsed (currently it just hides the panel).

**Files:** `src/renderer/src/styles.css`, `src/renderer/src/components/Bar.tsx`, `src/renderer/src/components/Panel.tsx`, all chip/button components.

#### B.2 Native text rendering and selection
**Goal:** Text feels like macOS, not a web page.

- Currently `user-select: none` is applied globally. Remove it for answer/review content; keep it for the bar input only.
- Use `-webkit-font-smoothing: antialiased` and proper text-rendering.
- Allow users to select and copy answer text directly (in addition to the Copy button).
- Add markdown heading anchors and smooth scroll.

**Files:** `src/renderer/src/styles.css`, `src/renderer/src/components/Answer.tsx`, `src/renderer/src/components/Markdown.tsx`.

#### B.3 Menu bar integration
**Goal:** AskToto feels like a menubar-first app.

- Add a real status-item icon in the macOS menu bar (not just the tray).
- Show current state via icon badge: idle, listening, capturing, error.
- Add a global "Quick Ask" floating input invoked from menubar (⌘⇧Return currently opens the overlay).
- Add recent-meetings submenu in menubar/tray.

**Files:** `src/main/index.ts`, new `src/main/menubar.ts`.

---

### Phase C — Performance & reliability

#### C.1 Sub-200 ms hotkey-to-response
**Goal:** The app feels instant.

- Profile the main-to-renderer IPC path; eliminate unnecessary round-trips.
- Pre-warm the LLM connection pool (keep-alive HTTP/2) when the app starts.
- Cache the Whisper model download and verify checksums; show offline-ready state.
- Add a lightweight "instant answer" cache for repeated questions.
- Lazy-load heavy Shiki themes; only bundle `catppuccin-mocha`.

**Files:** `src/main/llm.ts`, `src/renderer/src/lib/listen.ts`, `src/renderer/src/components/Answer.tsx`, build config.

#### C.2 Robust streaming & cancellation
**Goal:** Never leave a ghost stream running.

Current state: reset cancels streams; still some edge cases.

- Add an `AbortController` per `useAsk`/`useSuggest` run and propagate it through IPC.
- Ensure `listen.stop()` always terminates the worker and closes audio tracks.
- Add a global "Stop everything" hotkey (Esc or ⌘⇧X) that cancels all AI/audio activity.
- Add a timeout watchdog: if a stream hangs for >30 s, auto-cancel and show error.

**Files:** `src/renderer/src/state.ts`, `src/renderer/src/lib/listen.ts`, `src/main/llm.ts`, `src/shared/ipc.ts`.

#### C.3 Offline and degraded-mode UX
**Goal:** The app is useful even without internet or API keys.

- Detect no-network and show "Offline — transcript-only mode".
- Allow Listen to work without an API key (local transcription only).
- Cache the last N answers for reuse.
- Gracefully degrade when the model provider is rate-limited.

**Files:** `src/renderer/src/App.tsx`, `src/renderer/src/components/Copilot.tsx`, `src/main/llm.ts`.

---

### Phase D — Enterprise & ops

#### D.1 Signed, notarized, auto-updating binary
**Goal:** Normal users can install without Gatekeeper warnings.

- Acquire Apple Developer ID Application cert (TONY).
- Configure `electron-builder.yml` signing identity and hardened runtime entitlements.
- Set up a real update server (S3/R2 + public key) and replace `updater.ts` placeholder.
- Add update-notification UX.

**Files:** `electron-builder.yml`, `src/main/updater.ts`, entitlements plist.

#### D.2 Telemetry and crash reporting (privacy-preserving)
**Goal:** You can improve what you can measure.

- Add Sentry or a self-hosted error tracker with PII scrubbing.
- Track only anonymized events: hotkey used, stream errors, capture failures, save failures, onboarding completion.
- Never send transcript content, screenshots, or API keys.
- Add an in-app "Send diagnostics" opt-in.

**Files:** `src/main/index.ts`, `src/renderer/src/App.tsx`, new `src/main/telemetry.ts`.

#### D.3 Enterprise admin tooling
**Goal:** IT departments can deploy with confidence.

- Expand managed config to support `locked`, `hidden`, and `required` keys.
- Add a JSON schema for `managed-config.json`.
- Provide an MDM-deployable pkg installer.
- Document every enterprise policy in `docs/ENTERPRISE.md`.

**Files:** `build/managed-config.example.json`, `src/main/store.ts`, docs.

---

### Phase F — Windows Excellence (must be first-class, not macOS-afterthought)

#### F.1 Windows installer & distribution
**Goal:** Windows users install AskToto as easily as macOS users.

- Verify `npm run dist` on a Windows CI runner or VM.
- Test NSIS installer, portable EXE, and MSIX/appx packages.
- Add EV code-signing certificate config (env placeholders already in `electron-builder.yml`).
- Add Windows Store submission metadata.
- Ensure auto-updater works with Windows deltas (`latest.yml` + `.exe` blockmap).

**Files:** `electron-builder.yml`, CI workflow, `src/main/updater.ts`.

#### F.2 Windows-native overlay behavior
**Goal:** The overlay behaves like a Windows topmost tool window.

- Set `type: 'toolbar'` or use `SetWindowPos` HWND_TOPMOST on Windows.
- Hide from Alt-Tab (`skipTaskbar: true` is already set; verify on Windows).
- Snap to edges and multi-DPI monitor boundaries.
- Respect Windows 11 rounded corners and Mica/Acrylic where possible (Electron transparent window + CSS blur).
- Add a Windows system tray context menu with recent meetings.

**Files:** `src/main/index.ts` (createWindow), `src/main/windows.ts` (new).

#### F.3 Windows meeting detection at production quality
**Goal:** Detect meetings as reliably on Windows as on macOS.

Current state: PowerShell process-title matching + UI Automation browser URL fallback.

Next level:
- Add a lightweight native Node-API addon or use `node-powershell` to query `UIAutomation` for active browser tabs more reliably.
- Detect Microsoft Teams native app calls by reading its window buttons/controls via UIA.
- Detect Discord calls, Google Meet in Chrome, and Teams in Edge.
- Add per-app confidence scoring instead of boolean match.
- Cache window list and poll at 2–3 s intervals to reduce CPU.
- Add unit tests for every realistic window title pattern.

**Files:** `src/main/meeting-detect/win.ts`, new `src/main/meeting-detect/win-uia.ps1`.

#### F.4 Windows permission & privacy UX
**Goal:** Windows users understand what the app can and cannot do.

- Show platform-specific permission status in Settings using `usePermissions()`.
- On Windows, explain that system audio capture uses the same loopback path as "Stereo Mix" and does not need a special OS permission.
- Explain that screen capture requires the user to allow AskToto in Settings → Privacy → Screen capture (Windows 10/11) the first time.
- Add a "Test permissions" button that does a dummy mic + screen capture and reports success/failure.
- In onboarding, replace macOS "Accessibility" copy with Windows-specific copy.

**Files:** `src/renderer/src/components/Settings.tsx`, `src/renderer/src/components/Onboarding.tsx`, `src/main/platform-perms.ts`.

#### F.5 Windows shortcuts & taskbar
**Goal:** Windows users get native global hotkeys and taskbar presence.

- Register global shortcuts with `registerAccelerator` and avoid conflicts (e.g., Win+Shift combos).
- Add a taskbar jump list with "New Ask", "Start listening", "Open settings".
- Support Windows snapping and virtual desktops.
- Add a compact taskbar toolbar mode.

**Files:** `src/main/index.ts`, `src/main/shortcuts.ts` (new).

### Phase E — Intelligence & UX depth

#### E.1 Multi-turn memory that actually remembers
Current state: Wave 1 agent added a `RecallView` and multi-turn memory but it is unverified.

- Verify the recall/memory implementation works end-to-end.
- Add explicit "Memory" section in Settings showing what the app remembers.
- Allow users to edit/delete memory entries.
- Summarize long memories automatically when context window fills.

**Files:** `src/renderer/src/App.tsx` (RecallView), `src/renderer/src/components/Settings.tsx`.

#### E.2 Smart meeting actions
**Goal:** The copilot is proactive, not just reactive.

- Detect action items, decisions, and deadlines in transcript; surface them as follow-up chips.
- Auto-suggest "Answer now" only when the user has been silent during a question.
- Add post-meeting email draft generation (local, no auto-send).
- Integrate with calendar to pre-load meeting context.

**Files:** `src/renderer/src/components/Copilot.tsx`, `src/main/transcripts.ts`, `src/main/calendar.ts` (new).

#### E.3 Voice commands
**Goal:** Hands-free control while presenting.

- Add a wake word or push-to-talk mode (hold ⌘⇧L).
- Recognize commands: "AskToto, summarize", "AskToto, what should I say?".
- Run a lightweight local intent classifier or use the LLM with a cheap model.

**Files:** `src/renderer/src/lib/listen.ts`, `src/renderer/src/App.tsx`.

---

## 4. Architectural improvements that compound

### 4.1 Split the monolithic `App.tsx`
`App.tsx` is now large and handles state, hotkeys, window management, and view routing. Refactor into:

- `AppStateProvider` (settings, listen, ask, suggest state)
- `HotkeyManager`
- `WindowManager`
- `ViewRouter`
- `MeetingOrchestrator`

This makes testing, re-auditing, and future features much cheaper.

### 4.2 Formalize the IPC contract
- Generate TypeScript types from a single source of truth (e.g., `src/shared/ipc.ts` already exists; keep it as the contract).
- Add runtime logging for every privileged IPC call in dev mode.
- Add an IPC permission matrix document.

### 4.3 Add an event log / audit trail
- Log every capture, Listen start/stop, save, and settings change to an append-only local log.
- Users can view it in Settings → Privacy.
- Enterprise admins can require log retention.

### 4.4 Improve the Whisper pipeline
- Replace deprecated `ScriptProcessorNode` with `AudioWorkletNode`.
- Add VAD (voice activity detection) to reduce transcription CPU usage when no one is speaking.
- Support speaker diarization (you/us) more robustly.

---

## 5. Concrete first 48 hours for the next Claude session

If the next session has ~4–8 hours, do this in order:

1. **Read the v2 audit** (`AUDIT-MASTER-REPORT-v2.md`) and the Windows status above.
2. **Run the CI workflow on a Windows runner** (or local Windows VM) and fix any `npm run dist:win` failures.
3. **Implement Phase A.1** (recording indicator + per-meeting consent) — highest user-impact remaining trust item.
4. **Implement Phase F.2** (Windows-native overlay behavior: topmost toolbar, multi-DPI, taskbar jump list).
5. **Add 5–10 more tests** for the functional-state fixes (cancellation, capture guard, meeting confirmation).
6. **Run `npm run typecheck && npm run build && npm test && npm run dist && npm run dist:win`** and fix anything red.

---

## 6. Files to know by heart

| File | Why it matters |
|---|---|
| `src/renderer/src/App.tsx` | Main orchestration; largest file |
| `src/renderer/src/state.ts` | All renderer state hooks |
| `src/renderer/src/lib/listen.ts` | Whisper/audio pipeline |
| `src/main/index.ts` | Main process, IPC handlers, window/shortcuts/tray |
| `src/main/llm.ts` | Streaming AI logic |
| `src/main/store.ts` | Settings + key storage + managed config |
| `src/main/transcripts.ts` | OneDrive/Dust save logic |
| `src/main/meeting-detect.ts` | macOS/Windows meeting detection |
| `src/shared/ipc.ts` | IPC contract and zod schemas |
| `src/renderer/src/styles.css` | Design tokens and glass utilities |
| `AUDIT-MASTER-REPORT-v2.md` | Current audit state |
| `PLAN-v4-enterprise.md` | Original product plan |

---

## 7. Non-negotiables for every future change

1. **Keep `npm run typecheck && npm run build && npm test` green.**
2. **Never silently swallow errors** — log or surface them.
3. **Never add a new privileged IPC without frame/origin validation.**
4. **Never record without a visible indicator.**
5. **Never default a cloud-sync/PII feature to ON.**
6. **Update tests when fixing bugs.**
7. **Update `AUDIT-MASTER-REPORT-v2.md` when status changes.**

---

## 8. Windows-specific notes for the next session

### Files changed in this Windows push
- `src/main/meeting-detect/` — refactored into `index.ts`, `mac.ts`, `win.ts`, `shared.ts`
- `src/main/meeting-detect/win.ts` — added UI Automation browser-URL fallback and testable `nativeWindowMatches()`
- `src/main/meeting-detect/win.test.ts` — 10 unit tests for Windows detection logic
- `src/main/platform-perms.ts` — new cross-platform permission/status helpers
- `src/shared/ipc.ts` — added `permissionsGet` channel + `PlatformPermissions` types
- `src/preload/index.ts` — exposed `getPermissions()`
- `src/renderer/src/state.ts` — added `usePermissions()` hook
- `src/renderer/src/components/Settings.tsx` — added Permissions section, platform-aware audio-source hints, platform-aware auto-start copy
- `src/renderer/src/components/Onboarding.tsx` — Windows-specific permission denied / screen-audio copy
- `electron-builder.yml` — added `portable` and `appx` Windows targets + signing env placeholders
- `package.json` — added `dist:win` script
- `.github/workflows/build.yml` — CI workflow for quality checks + macOS + Windows package builds

### Immediate Windows TODOs — DONE in this session ✅
1. ✅ Wire `usePermissions()` into `Settings.tsx` to show platform-specific permission status.
2. ✅ Replace macOS-only onboarding copy with platform-agnostic or Windows-specific copy.
3. ✅ Add a CI workflow that builds macOS + Windows artifacts on every push.
4. ⬜ Run `npm run dist` on a Windows machine/VM and fix any packaging issues.
5. ⬜ Test the UI Automation PowerShell script on real Windows 10/11 with Chrome/Edge/Teams.
6. ⬜ Add a Windows-native overlay behavior module (`src/main/windows.ts`).
7. ⬜ Add Windows global-shortcut conflict handling and taskbar jump list.

## 9. Long-term vision

AskToto should become the **invisible AI layer for every meeting**: always available, never creepy, instantly helpful, and enterprise-trustworthy on macOS, Windows, and eventually Linux. The next 10× comes from ruthlessly removing friction, hardening trust, making the overlay feel native on every platform, and treating Windows as a first-class citizen — not a macOS afterthought.

---

## 10. Relay baton — production-readiness handoff (2026-06-27)

A full production-readiness audit ran (7 senior-dev domains + red-team verify). Verdict: **NOT READY** for
signed distribution + regulated sensitive-data use; solid as a personal tool. Full package + evidence in
`production-readiness/` (`PRODUCTION_READINESS_REPORT.md`, `RELEASE_GATE_MATRIX.md`, `RISK_REGISTER.md`,
`REMEDIATION_LOG.md`). 0 critical · was 13 high / 33 medium / 28 low. The code-fixable mediums/lows are
DONE (see REMEDIATION_LOG). What remains:

### A. Blocked — needs a human decision/credential (no code resolves these)
1. ⬜ **R-13 Code signing + notarization.** Apple Developer ID cert + notarization creds
   (`CSC_LINK`/`CSC_KEY_PASSWORD`/`APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID`); Windows
   Authenticode (or Azure Trusted Signing) + a Windows signing runner. Then set
   `verifyUpdateCodeSignature: true`.
2. ⬜ **R-14 Branch protection.** Repo is now git-initialised and pushed (this session). Still needed:
   branch protection on `main` (required reviews + required CI checks) so `build.yml` gates merges.
3. ⬜ **R-16 Signed update channel.** Real HTTPS publish host (S3 / Azure Blob / static), wired only AFTER
   signing. `updater.ts` is self-disabled until then.
4. ⬜ **R-08 Transcript data handling.** Decide: force `encryptTranscripts: true` via managed-config and/or
   move the notes folder off OneDrive. DPIA sign-off + DPAs with the LLM provider, Microsoft, Hugging Face,
   Dust.
5. ⬜ **R-01 Auth enforcement.** Decide fail-closed (deploy managed-config `azure.{clientId,tenantId,
   allowedDomain}` + `requireAuth: true` / `ASKTOTO_REQUIRE_AUTH=1`) vs accept fail-open for single-user.

### B. Dedicated code migration (next session)
6. ⬜ **R-15 Electron 33.4.11 (EOL) → 42.** Attempted 33→37 this session; reverted because Playwright
   `_electron` can't drive Electron 37 (launch-timeout). Real fix = Electron 42 + electron-vite 5 + vite 7 +
   `@vitejs/plugin-react` 5 + electron-builder 26 + a Playwright bump (so the harness works again) + a
   real-hardware runtime pass (mic capture, screen capture, content protection, loopback OAuth, signed
   build). One focused migration, not a bundled hardening fix.

### C. Cosmetic lows (optional)
7. ⬜ RecordingIndicator may render outside the viewport on small screens.
8. ⬜ Copilot error-state tint inconsistent with the rest of the UI.

### Already closed this session (code, verified: typecheck + 63 tests + harness 18/18)
Deny-by-default permissions · crash handlers · fail-closed auth option · decrypted-temp `0o600` · CI
security job (audit + secret-scan + SBOM) · stream idle-timeout · async fs off the main thread · AA
contrast + reduced-motion · auth-boundary tests · transcript-at-rest encryption · multilingual recap · the
full graphify knowledge-graph integration.
