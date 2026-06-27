# UX Review — AskToto

**Scope:** core journeys (onboarding, ask, listen→copilot, capture, review/save, history, settings) and the
state matrix (loading / empty / error / destructive). Desktop overlay (always-on-top glass bar).
**Date:** 2026-06-27.

---

## Verdict (Gate 3 — UX sub-area)

**PASS with polish items.** The product nails the hard parts: a true ≤15s onboarding, comprehensive
loading/empty/error states, and unusually resilient failure handling (mic-only degradation, exponential
save-retry with a visible attempt counter). Open items are minor: an aggressive auto-record default behavior,
no Escape-to-dismiss, and one unconfirmed discard path.

---

## Journey-by-journey

### Onboarding — ≤15s, single screen (PASS)
- `src/renderer/src/components/Onboarding.tsx` is one screen: a consent checkbox + "Sign in with Microsoft"
  + "Skip for now". No multi-step wizard, no key entry blocking first run (keys/profile deferred to Settings,
  permissions deferred to first Listen). A user can finish in one decision.
- **Good:** consent is gated — `finish()` blocks with "Please confirm the consent box to continue."
  (`Onboarding.tsx:40-43`) until the recording-consent box is checked; the primary button is `disabled`
  until then (`:97`).
- **Note (LOW):** "Skip for now" bypasses sign-in when Azure SSO is unconfigured — correct for dev/single-user,
  but it means the only hard gate in production is the SSO wall (`App.tsx:426`), which is itself optional
  (see security/auth posture). Product-acceptable; flagged for the release owner.

### Ask (type → answer) (PASS)
- `Bar.tsx:60-74`: single input, Enter submits (Shift+Enter ignored), clear placeholder "Ask anything…",
  `aria-label`. Busy state swaps the send affordance for a Stop button (`Bar.tsx:76-84`). Multi-turn memory is
  retained (`App.tsx:179-191`, last 12 turns). Streaming answer renders incrementally with a caret.

### Listen → live copilot (PASS, with one default concern)
- Start: chime + neutral-gray glass swap for readability while recording (`styles.css:242-264`), live
  "Recording m:ss" pill (`Bar.tsx:109-112`) **and** a floating indicator (`RecordingIndicator.tsx`).
- Copilot view streams "Say this / Suggested point / Next move" plus quick actions (Answer now / What to say
  next / Fact-check / Ask / End & review) — `Copilot.tsx:84-118`.
- **Resilience (excellent):** if system-audio loopback fails but mic succeeded, the session degrades to
  mic-only instead of dying, with an explanatory inline error (`listen.ts:201-210`).
- **Concern (MEDIUM, privacy-UX):** the meeting-detected toast **auto-starts recording** after a 10s countdown
  whose default action is *Start*, not *Cancel* (`MeetingDetectedToast.tsx:30-37`, `timeoutMs=10000` from
  `App.tsx:559`). It is correctly gated behind `autoStartOnMeeting` (default **false**, `ipc.ts:282`) plus the
  one-time global consent, so it is opt-in — but once enabled, user inattention begins capturing mic+system
  audio. Consider defaulting the countdown to *dismiss*, lengthening it, or requiring a click to start.

### Capture screen (PASS)
- `App.tsx:218-237` `askScreen`: sets a capturing state, shows a spinner in the camera button
  (`Bar.tsx:137-139`), and surfaces capture failures via `captureError` (`App.tsx:495-504`). Vision-incapable
  providers get a specific, actionable error from main (`index.ts:518-524`).

### Review & save (PASS — best-in-class error handling)
- `Review.tsx`: duration + participant chips, streaming "Meeting notes", full transcript with copy.
- **Save resilience:** auto-save (when enabled) and manual save both pin only on success so failures retry;
  `App.tsx:158-176` implements exponential backoff (`1s·2^n`, capped 30s, max 5) and `Review.tsx:120-128`
  renders "Retrying… attempt N / 5" with the error. Success shows an "Open folder" affordance
  (`Review.tsx:130-143`).
- **Note (LOW, data-loss):** "New meeting" (`Review.tsx:108-116` → `App.tsx:356 reset()`) discards the current
  session with no confirmation. It is safe when the transcript is saved, but if the last save **failed**, the
  unsaved transcript is dropped silently. Consider a confirm when `saveError && !savedPath`.

### History / Recall (PASS)
- `RecallView.tsx`: debounced search (250ms), clear empty states ("No meetings saved yet — finish one with
  End & review." vs "No matching meetings."), per-item open + connections expander, optional knowledge-graph
  bar that only appears when graphify is enabled.

### Settings (PASS)
- `Settings.tsx` is lazy-loaded (`App.tsx:8`), opens as a panel below the bar (not a takeover), self-contained
  Cluely-style two-pane on solid surfaces. Key entry has inline provider auto-detect hints
  (`Settings.tsx:273-287`), a Test button with ok/error feedback (`:508-519`), and a clear "•••••• saved —
  paste to replace" affordance. Managed/locked keys show a "Managed by your organization" chip.

---

## State-matrix coverage

| State | Covered? | Evidence |
|---|---|---|
| Loading | Yes | `Answer` skeleton shimmer (`Answer.tsx:5-13`), `Spinner` "thinking…" (`Copilot.tsx:96-99`), "writing detailed notes…" (`Review.tsx:158-160`), "loading transcription model…" (`Copilot.tsx:160-163`) |
| Empty | Yes | Answer ("Ask a question or press ⌘⇧S…"), Copilot ("Press Listen to start…"), Recall ("No meetings saved yet…"), Review ("No speech was captured…") |
| Error | Yes | Answer error block + Retry (`Answer.tsx:111-121`, `App.tsx:349-354`), copy/save errors inline, listen worker errors surfaced (`listen.ts:121-127`) |
| Destructive | Partial | Key/Dust removal instant but recoverable (re-paste); sign-out instant; "New meeting" discard unconfirmed when save failed (LOW above) |

## Polish backlog (non-blocking)
- **No Escape-to-dismiss** anywhere (`grep -rn "Escape" src/renderer/src` → none). Panels/Settings/toast close
  only via mouse or the global ⌘\ hide. Escape is a strong overlay expectation — add it.
- **`RecordingIndicator` clipping:** positioned `absolute -bottom-8` (`RecordingIndicator.tsx:13`) relative to a
  window that hugs content and sets `overflow: hidden` (`styles.css:184-195`); the 32px-below indicator can be
  clipped by the window bounds. Cross-referenced in the a11y + perf reports.

## N/A
- Mobile/responsive breakpoints, multi-page IA, web nav/routing — N/A (fixed-size desktop overlay, no router).
