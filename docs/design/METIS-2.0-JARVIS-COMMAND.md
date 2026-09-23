# Métis 2.0 Jarvis Command Experience

**Status:** Approved for implementation by Tony, 2026-09-20
**Product:** Métis desktop app
**Platforms:** macOS universal and Windows x64
**Reference:** `/Users/tony/Downloads/igexport-Ddevf2hNeHc.mp4`

## Product brief

Build Métis into a calm, fast meeting companion that can be summoned by a configurable keyboard shortcut and, after an explicit opt-in, the local phrase **“Hey Métis.”** It must support a compact top-center command pill or a dedicated right-edge sidecar, depending on the user’s chosen placement. A spoken request creates one clear, typed action proposal. Métis can perform safe in-app actions immediately; every action that opens an external app, opens a URL, creates or captures content, types, clicks, sends, or changes a file requires an explicit visible confirmation.

The experience must be equally usable on a Mac and a Windows PC. The implementation must be TypeScript/Electron-first, packaged inside the signed app, and must not add a Python sidecar, a shared vendor secret, a runtime model download, or a cloud audio dependency. It must remain responsive on devices with 8–16 GB of RAM and must never degrade active meeting transcription to provide a command feature.

## Problem statement

Meeting participants need a low-friction way to retrieve notes, control Métis, and prepare follow-up work while staying focused on the conversation. Today they must switch windows, search manually, or interrupt their note-taking flow. A traditional full-width overlay is especially unsuitable when the user places Métis at the right edge of the screen, and uncontrolled speech-driven desktop automation would create unacceptable privacy and safety risks.

## Personas and jobs

### Meeting participant

Needs to summon Métis without losing focus, view a live command transcript, and complete an intentional action without accidental app or browser behavior.

### Privacy-conscious administrator

Needs voice activation, command data, provider credentials, and desktop-control permissions to be explicit, minimized, auditable, and revocable.

### Windows user

Needs the same command and sidecar experience as macOS without a hidden Mac-only dependency or a silent fallback to a different application.

## In scope

1. Placement-aware presentation rules:
   - `top-center` supports Hide, Island, and Bar.
   - `right-edge` supports Hide and Island only.
   - Persisted `right-edge + bar` resolves deterministically to `right-edge + island`.
   - Choosing Right Edge while Bar is selected saves Right Edge, Island, and auto-hide together.
2. A dedicated right-edge sidecar:
   - 48–52 px resting edge tab.
   - Fixed-width, left-expanding drawer with a conversation area, command capture control, live command text, action proposal, and Confirm/Cancel controls.
   - No horizontal Bar, Bar orb, or streamed-content native window resize loop.
3. A separate command session, distinct from meeting capture:
   - Configurable global summon keybind using the existing shortcut framework.
   - Push-to-talk or explicit microphone control for a bounded command utterance.
   - Main-process authority for proposal creation, confirmation, expiry, policy, and execution.
4. Typed command proposals:
   - Deterministic parsing first.
   - Optional Jev/TypeSafe disambiguation only among code-defined candidate IDs.
   - One proposal at a time and one external action per confirmation.
5. A cross-platform, static adapter allowlist:
   - Métis-only actions may run immediately.
   - Application launch, URL navigation, camera launch, file creation, typing, click, send, delete, upload, download, account action, payment, credential, and permission actions require confirmation or remain unavailable.
6. Opt-in local wake activation architecture:
   - Exact default phrase: “Hey Métis.”
   - Wake opens the command surface; wake text or audio never has execution authority.
   - The shortcut is always available as a fallback.
7. Performance and reliability instrumentation with physical packaged-app QA on macOS and Windows.

## Out of scope

- Arbitrary desktop control, arbitrary UI Automation, or an automatic multi-step control loop.
- Screen, accessibility-tree, or browser-session export to Jev/TypeSafe by default.
- Mobile-device control. That needs a separately paired mobile client and is not a desktop-adapter extension.
- Shared Picovoice or other vendor keys in the installer.
- Cloud speech as a silent fallback for local command or wake processing.
- Using meeting, import, cloud STT, screen OCR, Mantu Intelligence, diarization, or transcript events as command input.

## Experience model

### Top center

When the selected placement is Top center, a command session can show a compact listening pill inspired by the reference video. It is an ephemeral command status surface, not the full Bar. It shows the listening state, concise live command text, and a Stop control. Keyboard activation opens without animation.

### Right edge

When the selected placement is Right Edge, Bar is absent from onboarding, Settings, persistence normalization, previews, and runtime rendering. The resting surface is a small rounded edge tab. Hover on a fine-pointer device may reveal it; click, keyboard summon, or a wake event opens the full left-expanding sidecar. The sidecar has fixed outer bounds and internal scrolling. It uses only opacity and `translateX` for transitions. Reduced-motion opens it without spatial movement. Hover does not take keyboard focus.

### Command states

`idle → listening → transcribing → proposing → awaiting-confirmation → executing → result → idle`

- Escape, Stop, microphone removal, application lock/suspend, session replacement, proposal expiry, or a policy denial returns to idle and invalidates pending authority.
- A new partial transcript invalidates any older remote decision request.
- A command proposal displays the exact app, URL host, or in-app consequence before confirmation.

## Trust and privacy boundary

Audio and model decisions can propose; only the main process can authorize and execute.

1. A command microphone path is separate from `useListen` and has no system audio or meeting-audio input.
2. The capture source may provide untrusted text to the main process, but it never receives a generic desktop-action IPC method.
3. Main owns a proposal nonce, owning `webContents.id`, action fingerprint, expiration, and policy decision.
4. The renderer can only confirm or cancel its current proposal. Main rechecks nonce, owning window, expiry, action allowlist, entitlement, and foreground-state requirements before execution.
5. The portal broker keeps provider credentials. The installed app sends only bounded command text and candidate IDs for optional typed decisioning. It never sends raw audio, screenshots, browser DOM values, accessibility trees, meeting history, or a provider API key.
6. Command audit records contain minimized action metadata and outcome only. They do not store raw voice, screen content, or typed secrets.

## Jev and upstream-pattern decisions

Métis may adopt the following ideas but will not embed the upstream control runtimes:

- TypeSafe: typed choices and confidence-controlled disambiguation.
- Jev Ultrafast: observed-target freshness and bounded one-decision cycles for a future separately enabled Browser Assist.
- Jev Voice Browser: cancellation of stale partial ASR requests and one-action-per-utterance discipline.
- Fast Jev Compaction: deterministic context budgets, not model-directed deletion of meeting data.

The direct projects are not runtime dependencies for Métis 2.0. Their automatic browser or desktop loops, unbounded data capture, direct provider credentials, and unsupported platform paths are excluded.

## Voice-activation policy

Voice activation is disabled by default. Enabling it requires an onboarding or Settings consent control that explains local microphone use, visible listening state, immediate Stop control, and shortcut fallback.

The production wake model must meet all of these gates before it is enabled in an installer:

1. Its exact model, training data provenance, redistribution terms, SHA-256, and third-party notices are documented.
2. It runs entirely on-device with no shared vendor credential or runtime download.
3. It passes false-wake, miss-rate, CPU, RAM, microphone recovery, and active-meeting coexistence tests on packaged macOS and Windows applications.
4. It pauses rather than competes with protected transcription/import work under memory pressure.

The initial technical candidate is a first-party “Hey Métis” model exported for a sandboxed Electron worker using the Heed preprocessing contract. Heed itself is a v0.1 upstream and therefore requires a signed-package proof before activation. If the model gate is not passed, voice activation remains unavailable while keybind and push-to-talk command use remain fully functional; the UI must say why rather than pretending it is enabled.

## Performance requirements

These are acceptance budgets to baseline and validate on real packaged devices; they are not current measured claims.

| Operation | Proposed budget | Measurement |
|---|---:|---|
| Global shortcut to visible command surface, P95 | ≤ 100 ms | packaged device trace |
| Wake detection to visible listening state, P95 | ≤ 250 ms | packaged device trace |
| Final command text to deterministic proposal, P95 | ≤ 300 ms | synthetic and physical trace |
| Escape/Stop to revoked command state, P95 | ≤ 100 ms | main/renderer trace |
| Native resize IPC caused by a streamed open sidecar | 0 | integration test |
| Main/renderer long task during 60 Hz partial feed | no task > 50 ms | renderer trace |

On 8 GB systems, command activation must not cold-start a local LLM, a multimodal projector, or a duplicate high-memory ASR process. The wake listener must pause under measured memory pressure or a protected transcription/import reservation, while shortcut summon remains available.

## Acceptance criteria

### Placement and sidecar

1. Given Right Edge is selected, when the appearance options render, then Bar is absent and Hide/Island remain selectable.
2. Given a legacy Right Edge + Bar setting, when Métis starts, then it renders as Right Edge + Island without showing an 880 px Bar.
3. Given a user switches from Bar to Right Edge, when settings save, then placement, Island layout, and auto-hide persist atomically.
4. Given an open right-edge sidecar receives streaming text, when its internal content grows, then its native window bounds do not change except for an explicit display reanchor.

### Command and confirmation

1. Given a meeting transcript contains “Métis,” when it reaches the existing meeting pipeline, then it cannot open a command session, create a proposal, or execute an action.
2. Given a user invokes the command shortcut, when no permission is granted, then the command surface opens and explains how to start a command without silently capturing microphone input.
3. Given command text resolves to an external action, when the proposal appears, then nothing executes before Confirm.
4. Given a stale, expired, cancelled, or wrong-window proposal, when Confirm is sent, then main rejects it and performs no action.
5. Given a confirmed app launch or HTTPS URL, when the adapter succeeds or fails, then the sidecar reports a typed outcome without exposing internal error details.

### Voice activation

1. Given voice activation is disabled, when “Hey Métis” is spoken, then no command session starts.
2. Given voice activation is enabled and the production model is available, when “Hey Métis” is detected, then Métis opens the placement-appropriate command surface and starts one bounded command session.
3. Given Escape, Stop, microphone loss, lock, sleep, or pressure pause, when a wake listener exists, then it stops immediately and does not retain raw audio.

## Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| A wake model lacks acceptable redistribution provenance | Medium | High | Do not package it; retain shortcut and push-to-talk; complete first-party model gate. |
| Wake processing competes with active transcription on 8 GB devices | Medium | High | Separate worker, memory-pressure pause, synthetic and physical device gates. |
| An ASR error proposes an unsafe operation | Medium | High | Typed allowlist, one action, visible confirmation, nonce/expiry recheck in main. |
| Sidecar redraw causes flashing or resize churn | Medium | Medium | Fixed outer geometry, sidecar state isolation, transform/opacity-only motion, trace gate. |
| Windows app mapping differs from macOS | High | Medium | Disclosed platform-specific adapter mapping and physical EXE tests; no silent substitution. |

## Delivery phases

### Phase A: Sidecar and command foundation

Ship placement normalization, sidecar UI, shortcut summon, bounded command capture, typed proposals, main-owned confirmation, static adapter policy, cancellation, and performance instrumentation. This phase delivers a working, cross-platform “summon Métis” experience using keybind and explicit command mic input.

### Phase B: Local wake model pilot

Implement the sandboxed worker boundary, model asset integrity checks, opt-in settings, and packaged macOS/Windows tests. Enable “Hey Métis” only after the model provenance and device-quality gates pass.

### Phase C: Browser Assist evaluation

If separately approved, add a user-selected browser-only assist surface with one reviewed action at a time. It is not part of the desktop command release.

## Decision log

| Decision | Date | Rationale |
|---|---|---|
| Use a TypeScript/Electron core, not the upstream control loops | 2026-09-20 | Preserves Windows parity, packaging control, and consent boundaries. |
| Right Edge excludes Bar | 2026-09-20 | A horizontal Bar is structurally incompatible with the right-edge interaction. |
| Audio may propose but never execute | 2026-09-20 | Prevents meeting audio, ASR errors, or compromised renderer input from gaining desktop authority. |
| Use a model gate for “Hey Métis” | 2026-09-20 | No reviewed drop-in model currently clears licensing, privacy, and performance requirements. |
