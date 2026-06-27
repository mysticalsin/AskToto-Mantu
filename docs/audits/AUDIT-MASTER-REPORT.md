# AskToto — Master Audit Report

**Date:** 2026-06-27  
**Scope:** Full UX/UI/Security/Engineering/QA audit of AskToto v0.1.0  
**App path:** `/Users/tony/Library/CloudStorage/OneDrive-MantuGroup/Documents/TEST/AskToto`  
**Auditors:** PM, senior full-stack engineer, security/pen-tester, bug hunter, 3 independent QA testers, UI/UX Apple-liquid-glass specialist.  
**Cross-reference:** Existing `QA-REPORT.md` (Q01–Q26 + P1–P11) was used as ground truth; FIXED items were not re-reported unless evidence showed the fix was incomplete.

---

## 1. Executive Summary

AskToto is a technically impressive Electron overlay: the core streaming pipeline, IPC contract, and enterprise transcript-save mechanics are largely solid after the previous QA loop. However, the app still has **significant user-experience, trust, and security gaps** that would block a confident manager/enterprise rollout.

The biggest blockers are **trust/legal UX** (covert recording without per-meeting consent, auto-save to cloud ON by default, “undetectable” framing), **functional state bugs** (manual Listen sessions incorrectly auto-ended, reset not cancelling streams, stale capture errors masking answers), and **shortcut/permission discoverability** (advertised shortcuts do not match registered globals, required macOS permissions are not explained).

| Metric | Value |
|---|---|
| Total raw findings from 8 agents | ~120 |
| Consolidated unique findings | 46 |
| BLOCKER / CRITICAL | 0 |
| HIGH | 11 |
| MED | 23 |
| LOW / INFO | 12 |
| Status: OPEN | 38 |
| Status: TONY (needs your decision/infra) | 4 |
| Status: BY-DESIGN | 4 |
| Surfaces passing physical tests | 11/11 (from QA-REPORT) |

**Overall verdict:** The app is **not release-ready for a general manager audience** until the HIGH-severity trust, functional-state, and discoverability issues are fixed. The UI is already polished at a baseline but needs a Liquid Glass pass to feel truly Apple-native.

---

## 2. Scorecard by Track

| Track | Findings | HIGH | MED | LOW | Pass/Fail |
|---|---|---|---|---|---|
| PM / Product | 15 | 4 | 7 | 4 | **FAIL** |
| Full-Stack Engineering | 15 | 2 | 7 | 6 | **FAIL** |
| Security / Pen-test | 18 | 6 | 6 | 6 | **FAIL** |
| Bug Hunter / Functional | 8 | 1 | 5 | 2 | **FAIL** |
| QA — Ask/Capture/Answer | 15 | 2 | 6 | 7 | **FAIL** |
| QA — Listen/Copilot/Review | 15 | 1 | 6 | 8 | **FAIL** |
| QA — Settings/Onboarding/Enterprise | 21 | 2 | 11 | 8 | **FAIL** |
| UI/UX Liquid Glass | 24 | 3 | 10 | 11 | **FAIL** |

*Failures are expected at this stage; they identify the exact work needed before release.*

---

## 3. Consolidated Findings

Findings are grouped by theme and merged across agents. IDs are stable (`A-001` … `A-046`). Each row includes the source track IDs and the existing `QA-REPORT.md` item if applicable.

### 3.1 Trust, Consent & Legal (blockers for enterprise)

| ID | Sev | Finding | Evidence | Source | QA Ref | Status |
|---|---|---|---|---|---|---|
| A-001 | **HIGH** | **No third-party consent flow for covert system-audio recording.** The app can record all meeting participants with no per-meeting disclosure, audible indicator, or explicit consent UI. | `main/index.ts:411-423` serves `audio: 'loopback'` once `audioArmed` is true; onboarding frames this as “hear the other person.” | PM-02, SEC-01, QA-G-11 | Q02 | **TONY** |
| A-002 | **HIGH** | **Auto-save transcripts defaults ON and writes plaintext PII to a cloud-synced OneDrive folder.** No onboarding opt-in or cloud-sync warning. | `ipc.ts` defaults `autoSaveTranscripts: true`; `App.tsx:96-124` auto-saves on review; `transcripts.ts` writes cleartext markdown. | PM-04, SEC-04, QA-G-03 | Q21 | **TONY** |
| A-003 | **HIGH** | **Auto-start on meeting silently begins recording with no per-meeting confirmation.** Even after opt-in, a detected meeting immediately starts Listen + system audio. | `main/index.ts:207-229` poller → `meeting:detected`; `App.tsx:304-318` calls `startListen()` unconditionally. | PM-08, SEC-16, QA-F-15 | — | **OPEN** |
| A-004 | **HIGH** | **Display-media handler can silently return a screen video track to the renderer.** `useSystemPicker: false` + `video: sources[0]` means any renderer request gets screen capture without the macOS picker. | `main/index.ts:411-423` returns `video: sources[0]` and ignores the request object. | SEC-02, SEC-10, FS-06 | — | **OPEN** |
| A-005 | MED | **“Undetectable” framing overstates protection and creates trust/legal risk.** Copy positions the product as covert. | README: *“undetectable mode (hidden from screen recording)”*; Settings toggle label. | PM-03, QA-G-12 | — | **OPEN** |
| A-006 | MED | **Managed config is defaults-only, not enforceable enterprise policy.** Users can override IT presets; no `lockedKeys` or “managed by org” indicator. | `store.ts:38-63` merges user overrides; example file says “DEFAULT values (not locked).” | PM-05, SEC-09, FS-15, QA-G-05, QA-G-13 | Q15 | **OPEN** |
| A-007 | MED | **Auto-save failure in Review is shown but not actionable.** No retry or manual save path; transient OneDrive failure can mean data loss. | `Review.tsx:46-50` shows error only; `App.tsx:96-124` auto-retries but user has no control. | PM-13, QA-F-04, QA-F-13 | — | **OPEN** |

### 3.2 Functional State Bugs

| ID | Sev | Finding | Evidence | Source | QA Ref | Status |
|---|---|---|---|---|---|---|
| A-008 | **HIGH** | **Manual Listen session can be incorrectly auto-ended by a stale `autoStartedRef`.** After an auto-started session, any manual session started while the meeting is still active is treated as auto-started and killed on meeting-end. | `App.tsx:304-318` sets `autoStartedRef.current = true` in the handler but `startListen()` never resets it. | BUG-01, QA-F-01 | — | **OPEN** |
| A-009 | **HIGH** | **Stale capture error masks subsequent typed answers/fact-checks/explanations.** `captureError` is not cleared before non-capture actions, so a prior screenshot failure appears to break every typed query. | `App.tsx:183-187` and `App.tsx:222-226` call `ask.run()` without `setCaptureError(null)`; `App.tsx:365-372` renders `captureError ?? ask.answer?.error`. | QA-E-01 | — | **OPEN** |
| A-010 | **HIGH** | **“New / reset” does not cancel in-flight LLM streams or stop listening.** Background API calls continue; mic can stay hot. | `App.tsx:272-280` calls `ask.clear()`/`suggest.clear()`/`listen.clear()` but never `cancel()`/`stop()`. | BUG-02, QA-E-02 | — | **OPEN** |
| A-011 | MED | **Capture allows duplicate concurrent captures and clears the typed prompt before success.** Rapid clicks launch multiple `desktopCapturer` calls; on failure the prompt is lost. | `App.tsx:139-154` lacks an in-flight guard; `App.tsx:235-238` clears `input` before `askScreen()` returns. | QA-E-03 | — | **OPEN** |
| A-012 | MED | **Answer/Ask stream started during Listen is uncancellable from the bar.** `busy`/`onStop` are chosen based only on `listen.listening`, so the `ask` stream has no stop affordance. | `App.tsx:405-410`; `Bar.tsx:65-73`. | BUG-03, QA-E-06 | — | **OPEN** |
| A-013 | MED | **Listen “loading model” state is not cleared when the user stops during load.** UI can remain stuck showing “loading transcription model…”. | `listen.ts:150` sets `loading: true`; `listen.ts:212-218` `stop()` only updates `listening`. | BUG-06, FS-09 | — | **OPEN** |
| A-014 | MED | **Onboarding can auto-start recording before the user finishes setup.** Managed config with `autoStartOnMeeting: true` + `onboardingDone: false` starts Listen while onboarding is visible. | `main/index.ts:207-229` starts poller unconditionally; `App.tsx` onboarding gate returns early but effect handlers remain active. | BUG-05 | — | **OPEN** |

### 3.3 Security & Privacy

| ID | Sev | Finding | Evidence | Source | QA Ref | Status |
|---|---|---|---|---|---|---|
| A-015 | **HIGH** | **API key falls back to plaintext when safeStorage is unavailable.** Key is written with a `plain:` prefix and `0o600` only. | `store.ts:98-102`. | SEC-03 | Q13 | **TONY** |
| A-016 | **HIGH** | **App is unsigned, unnotarized, and uses a placeholder update host.** `gatekeeperAssess: false`. | `electron-builder.yml`; `src/main/updater.ts`. | SEC-05, SEC-14 | Q22 | **TONY** |
| A-017 | **HIGH** | **Broad privileged preload API without sender/gesture validation.** A compromised renderer can capture screen, arm audio, save transcripts, change settings, store keys, quit app. | `preload/index.ts:23-54`; `main/index.ts:253-385`. | SEC-06 | — | **OPEN** |
| A-018 | MED | **Custom provider with empty baseURL silently calls OpenAI.** User’s custom key is sent to the wrong host. | `main/index.ts:326`; `llm.ts:127`; `ipc.ts:95`. | FS-02, SEC-07 | — | **OPEN** |
| A-019 | MED | **settings.json is created world-readable.** Contains profile PII; inherits umask (~0o644). | `store.ts:90`. | SEC-08 | — | **OPEN** |
| A-020 | MED | **CSP `connect-src` allows broad external exfiltration targets.** Hugging Face, jsDelivr, `*.hf.co` are allowed. | `src/renderer/index.html:6-9`. | SEC-11 | — | **OPEN** |
| A-021 | MED | **Frontmatter injection via unsanitized transcript title.** First “them” utterance is inserted into YAML with minimal escaping. | `transcripts.ts:109`, `transcripts.ts:134`. | SEC-12 | — | **OPEN** |
| A-022 | LOW | **Whisper model is downloaded from the internet at runtime.** Supply-chain/MITM exposure; wide CSP increases risk. | `listen.ts:151`; `index.html:6-9`. | SEC-18 | — | **INFO / TONY** |
| A-023 | LOW | **Environment-variable API keys take precedence and are cross-process readable.** Weaker than encrypted store. | `store.ts:109-111`. | SEC-15 | — | **BY-DESIGN** |
| A-024 | LOW | **meetingsFolder accepts arbitrary filesystem paths.** Could write transcripts to sensitive directories. | `store.ts:83-92`; `transcripts.ts:82-86`. | SEC-17 | — | **BY-DESIGN / OPEN** |

### 3.4 Discoverability & Onboarding

| ID | Sev | Finding | Evidence | Source | QA Ref | Status |
|---|---|---|---|---|---|---|
| A-025 | **HIGH** | **In-app shortcut reference is wrong and inconsistent with actual global shortcuts.** Bar tooltip says “Ask (⌘Enter)”; Settings/Readme show `⌘Enter`; actual global Ask is `⌘⇧Return`. | `Bar.tsx:70`; `Settings.tsx:380`; `README.md:37`; `main/index.ts:193`. | PM-06, BUG-07, QA-G-01, QA-E-07 | — | **OPEN** |
| A-026 | **HIGH** | **Auto-start-on-meeting omits required macOS Accessibility/Automation permissions.** Toggle is shown with no explanation or status indicator. | `Settings.tsx:356-359`; `meeting-detect.ts:4-5`; `main/index.ts:207-228` silently returns empty when denied. | QA-G-02 | — | **OPEN** |
| A-027 | MED | **Onboarding lets users skip API key and permissions without warning.** Users can finish onboarding in a non-working state. | `Onboarding.tsx` unconditional Next; `onDone={() => void 0}`; `App.tsx:322-330`. | PM-01, PM-07, QA-G-19 | — | **OPEN** |
| A-028 | MED | **Audio-source choices lack permission/privacy context.** “Both” records other participants but has no Screen Recording or consent note. | `Settings.tsx:270-294`; `main/index.ts:411-422`. | PM-09, QA-G-08 | — | **OPEN** |
| A-029 | MED | **Onboarding permission step skips Accessibility and conflates screen/system audio.** No mention of Accessibility permission needed for auto-start. | `Onboarding.tsx:127-140`. | QA-G-11 | — | **OPEN** |
| A-030 | MED | **No proactive empty-state or key banner when provider has no API key.** First query fails reactively. | `main/index.ts:304-309`; onboarding allows skipping key. | PM-07 | — | **OPEN** |
| A-031 | LOW | **Onboarding profile is a subset of Settings profile.** Missing Company/Job description weakens first-run personalization. | `Onboarding.tsx:176-195` vs `Settings.tsx:411-433`. | QA-G-10 | — | **OPEN** |
| A-032 | LOW | **Tray menu lacks Settings entry.** Menubar-only app should expose Settings from tray. | `main/index.ts:240-245`. | QA-G-06 | — | **OPEN** |
| A-033 | LOW | **Launch-at-login toggle lacks permission notice and real state sync.** macOS may disable it; UI does not reflect actual state. | `Settings.tsx:361-366`; `main/index.ts:260-263`. | QA-G-07 | — | **OPEN** |
| A-034 | LOW | **Global shortcuts are hardcoded and non-customizable.** Conflicts with other apps cannot be resolved by users. | `main/index.ts:188-201`; `Settings.tsx:377-398` only displays them. | QA-G-15 | — | **OPEN** |

### 3.5 UI/UX & Apple Liquid Glass

| ID | Sev | Finding | Evidence | Source | QA Ref | Status |
|---|---|---|---|---|---|---|
| A-035 | **HIGH** | **Hardcoded semantic colors and inconsistent token usage.** `#f0717a`, `#83c092`, `#7c8cf8` are scattered as hex literals instead of semantic tokens. | `Bar.tsx`, `Settings.tsx`, `Copilot.tsx`, `CodeBlock.tsx`, `styles.css`. | UI-01, UI-03 | — | **OPEN** |
| A-036 | MED | **Listen active state uses danger red, which is semantically wrong.** Recording is not an error. | `Bar.tsx:78-97` `bg-[rgba(240,113,122,0.16)] text-[#f0717a]`. | UI-01 | — | **OPEN** |
| A-037 | MED | **Glass surfaces lack liquid-glass depth.** Single blur layer; missing refractive rim light and layered tints. | `styles.css` `.glass` / `.glass-strong`. | UI-05 | — | **OPEN** |
| A-038 | MED | **Motion uses default Tailwind easing instead of spring physics.** Premium feel is missing. | `styles.css` `duration-100/150` defaults; no custom cubic-bezier tokens. | UI-04 | — | **OPEN** |
| A-039 | MED | **ToggleRow nests interactive buttons, breaking accessibility and event handling.** | `Settings.tsx:92-103`. | UI-06, QA-G-04 | — | **OPEN** |
| A-040 | MED | **Dynamic streamed content is not announced to assistive technology.** No `aria-live` regions in Answer/Copilot/Review. | `Answer.tsx`; `Copilot.tsx`; `Review.tsx`. | UI-21, QA-E-08, QA-F-10 | — | **OPEN** |
| A-041 | MED | **Bar height and Panel max-height diverge from the Cluely spec target.** Bar is 44px vs 38px target; Panel max-h 600px vs 670px target. | `Bar.tsx:39`; `Panel.tsx:5`; `DESIGN-SPEC.md`. | UI-07 | — | **OPEN** |
| A-042 | MED | **QuickActions visually compete with the bar instead of reading as secondary affordances.** | `QuickActions.tsx` uses full `.glass` class. | UI-08 | — | **OPEN** |
| A-043 | MED | **Copilot suggestion card uses a heavy accent border that breaks hierarchy.** | `Copilot.tsx` `border-[rgba(124,140,248,0.35)]`. | UI-10 | — | **OPEN** |
| A-044 | LOW | **Hide control uses text glyph `×` instead of a Lucide icon.** | `Bar.tsx:114-116`. | UI-02 | — | **OPEN** |
| A-045 | LOW | **Numerous small polish gaps:** inconsistent control radii/padding, onboarding layout shift, code-block header contrast, reduced-motion abruptness, wordmark mismatch, markdown table overflow, capture spinner timing, empty answer state, etc. | Multiple files. | UI-08–UI-20, QA-E-09–QA-E-15, QA-F-02, QA-F-09, QA-F-11, QA-F-12, QA-G-16, QA-G-17 | — | **OPEN** |
| A-046 | LOW | **By-design UI choices that may still warrant user testing.** No panel header/close, text selection disabled system-wide, plain streaming cursor. | `Panel.tsx`, `styles.css`, `Answer.tsx`. | UI-13, UI-14, UI-23 | — | **BY-DESIGN** |

### 3.6 Engineering & Architecture

| ID | Sev | Finding | Evidence | Source | QA Ref | Status |
|---|---|---|---|---|---|---|
| A-047 | **HIGH** | **Windows meeting detector triggers on any Microsoft Teams window.** Chat windows match the catch-all clause. | `meeting-detect.ts:88-96`. | FS-01 | Q23 | **OPEN** |
| A-048 | MED | **No automated test coverage.** Complex IPC, streaming, audio workers, file I/O, and meeting detection are un-tested. | `package.json` scripts. | FS-08 | — | **OPEN** |
| A-049 | MED | **macOS browser detection assumes all Chromium browsers speak Chrome AppleScript terms.** Arc/Edge may fail. | `meeting-detect.ts:29-47`. | FS-12, QA-G-21 | — | **OPEN** |
| A-050 | MED | **`AskStart.image` is not validated as base64/PNG or bounded.** Defense-in-depth gap. | `ipc.ts:67-77`; `main/index.ts:298`. | FS-07 | — | **OPEN** |
| A-051 | LOW | **Renderer `patch` type allows derived `PublicSettings` fields to be passed to `setSettings`.** Misleading type contract. | `state.ts:131`; `preload/index.ts:25`. | FS-10 | — | **OPEN** |
| A-052 | LOW | **Auto-save effect re-runs on every stream delta while in review.** Unnecessary churn. | `App.tsx:96-124`. | FS-11 | — | **OPEN** |
| A-053 | LOW | **`setInteractive` IPC is exposed but unused.** Increases attack surface. | `main/index.ts:382-384`; `preload/index.ts:43-44`. | FS-05, SEC-13 | Q25 | **OPEN** |
| A-054 | LOW | **`ScriptProcessorNode` is deprecated.** Runs on main audio thread. | `listen.ts:129`. | FS-13 | — | **OPEN** |
| A-055 | LOW | **No way to delete/clear an API key from the UI.** Saving empty key is a no-op. | `store.ts:94-103`. | FS-03, QA-G-09 | — | **OPEN** |
| A-056 | LOW | **Expanded window can grow off the bottom of the screen.** `resizeTo()` clamps height but not `y`. | `main/index.ts:159-165`. | BUG-08 | — | **OPEN** |
| A-057 | LOW | **Provider key input persists across provider switches.** Can save the wrong key to the wrong provider. | `Settings.tsx:117`; provider change via `patch({ provider: id })` does not reset `key`. | BUG-04, QA-G-20 | — | **OPEN** |
| A-058 | LOW | **OpenAI-compatible streams do not request usage telemetry.** `stream_options.include_usage` not set. | `llm.ts:131-140`. | FS-04 | Q26 | **OPEN** |
| A-059 | LOW | **Linux meeting detection is not implemented.** Returns empty string. | `meeting-detect.ts:106-110`. | FS-14 | — | **BY-DESIGN** |

### 3.7 Copilot / Answer Content UX

| ID | Sev | Finding | Evidence | Source | QA Ref | Status |
|---|---|---|---|---|---|---|
| A-060 | MED | **Fact-check during Listen is mislabeled and empty-bar behavior diverges from docs.** Verdict renders under “Say this” heading; empty bar fact-checks transcript instead of screen. | `App.tsx:173-191`; `Copilot.tsx:85-108`; `README.md:28-30`. | QA-E-04 | — | **OPEN** |
| A-061 | MED | **Submitted question/prompt is not shown in the answer panel.** Users cannot see what they asked during streams/errors. | `App.tsx` clears `input` before rendering; `Answer.tsx` only renders model output. | QA-E-05 | — | **OPEN** |
| A-062 | MED | **Copilot action labels compete/overlap.** “Answer now” vs “What to say next” is unclear. | `Copilot.tsx:111-116`; `App.tsx:193-209`. | PM-10, QA-F-03 | — | **OPEN** |
| A-063 | LOW | **QuickActions are hidden whenever the panel is open.** Core chips disappear during normal use. | `App.tsx:426-428`. | PM-12 | — | **OPEN** |
| A-064 | LOW | **Answer panel lacks copy/retry actions and screenshot preview.** Code blocks can be copied, but whole answer cannot; no image thumbnail for captures. | `Answer.tsx`; `CodeBlock.tsx`. | QA-E-12, QA-E-13 | — | **OPEN** |
| A-065 | LOW | **Review panel lacks Done/New meeting action and useful metadata.** Dead-end screen; duration/participants not shown. | `Review.tsx`; `transcripts.ts:116-117`. | QA-F-09, QA-F-11 | — | **OPEN** |

---

## 4. Existing QA Items Requiring Status Correction

Two agents found evidence that previously marked FIXED items are not fully resolved:

| QA ID | Prior Status | Finding | Evidence | Recommended Status |
|---|---|---|---|---|
| **Q20** | FIXED | Clipboard write in `Review.tsx:34-42` still swallows failures with `.catch(() => {})`. | `Review.tsx:34-42` | **PARTIAL / OPEN** |
| **Q13** | FIXED | Plaintext API-key fallback still exists in `store.ts:98-102`; the “FIXED” status only added `0o600` and honest copy, but did not remove the `plain:` fallback. | `store.ts:98-102` | **TONY** (awaiting decision to refuse persistence) |

---

## 5. Top 10 Priority Fixes

Ranked by user/business impact and fix cost.

| Rank | ID | Theme | Fix | Est. Effort |
|---|---|---|---|---|
| 1 | A-008 | Manual Listen auto-ended | Reset `autoStartedRef.current = false` inside `startListen()`. | 30 min |
| 2 | A-009 | Stale capture error masks answers | Clear `captureError` at the start of every non-capture action. | 30 min |
| 3 | A-010 | Reset does not cancel streams | Call `ask.cancel()`, `suggest.cancel()`, `listen.stop()` in `reset()`. | 1 hr |
| 4 | A-025 | Wrong shortcut labels | Update Bar tooltip, Settings, README to `⌘⇧Return` for global Ask. | 1 hr |
| 5 | A-026 | Auto-start permissions missing | Add inline copy + status indicator for Accessibility/Automation perms. | 2 hrs |
| 6 | A-001/A-003 | Recording consent & confirmation | Add per-meeting confirmation toast, recording indicator, consent onboarding step. | 1 day |
| 7 | A-002 | Auto-save default ON | Default `autoSaveTranscripts` to OFF; add cloud-sync warning in onboarding and settings. | 2 hrs |
| 8 | A-004 | Silent screen video capture | Refactor display-media handler to audio-only loopback + validate request frame. | 4 hrs |
| 9 | A-027 | Onboarding completion gates | Disable Next until key/permissions attempted; allow explicit skip with warning. | 1 day |
| 10 | A-039 | Nested buttons accessibility | Refactor `ToggleRow` to one focusable target. | 2 hrs |

---

## 6. Apple Liquid Glass Redesign Roadmap

The current UI is a competent dark-glass overlay, but it does not yet feel **Apple-native**. The roadmap below uses the existing Tailwind v4 + CSS custom-properties stack; no framework migration.

### 6.1 Design tokens to add (`styles.css`)

```css
/* Background tints */
--glass-fill: rgba(20, 20, 22, 0.52);
--glass-fill-elevated: rgba(24, 24, 27, 0.64);
--glass-fill-strong: rgba(16, 16, 18, 0.78);
--glass-tint-white: rgba(255, 255, 255, 0.06);
--glass-tint-black: rgba(0, 0, 0, 0.18);

/* Blur */
--blur-bar: 28px;
--blur-panel: 32px;
--blur-saturate: 180%;

/* Hairlines */
--color-hair: rgba(255, 255, 255, 0.10);
--color-hair-soft: rgba(255, 255, 255, 0.06);
--color-hair-strong: rgba(255, 255, 255, 0.16);
--color-rim-light: rgba(255, 255, 255, 0.08);

/* Semantic */
--color-danger: #F0717A;
--color-danger-soft: rgba(240, 113, 122, 0.14);
--color-success: #83C092;
--color-success-soft: rgba(131, 192, 146, 0.12);

/* Text */
--color-ink: rgba(255, 255, 255, 0.96);
--color-ink-2: rgba(255, 255, 255, 0.62);
--color-ink-3: rgba(255, 255, 255, 0.48);

/* Motion */
--ease-spring: cubic-bezier(0.22, 1, 0.36, 1);
--ease-bounce: cubic-bezier(0.34, 1.56, 0.64, 1);
--duration-hover: 150ms;
--duration-panel: 220ms;

/* Elevation */
--shadow-bar: 0 8px 28px rgba(0,0,0,0.42), inset 0 0.5px 0 var(--color-rim-light);
--shadow-panel: 0 16px 48px rgba(0,0,0,0.50), inset 0 1px 0 var(--color-rim-light);
```

### 6.2 Component refactor list

| File | Liquid-glass / Apple change |
|---|---|
| `styles.css` | Add tokens; rewrite `.glass`/`.glass-strong` to layer translucent tints + `backdrop-filter` + rim-light inset shadow; add `.glass-chip` (no blur) for secondary actions. |
| `Bar.tsx` | Reduce height to `38–40px`; replace `×` with `X` icon; use accent color (not red) for active Listen; apply spring easing to all state transitions. |
| `Panel.tsx` | Raise `max-h` to `670px`; add panel enter animation (`fade-up` + slight scale); ensure stable scroll gutter. |
| `Settings.tsx` | Fix nested `ToggleRow` buttons; tokenize all semantic colors; unify input radius/padding to one control class; add `aria-live` to save feedback. |
| `Onboarding.tsx` | Stabilize permission button widths; add step transitions; use shared control tokens. |
| `Copilot.tsx` | Remove heavy accent suggestion border; use `bg-accent-soft` + subtle left stroke; add `aria-live` region for suggestions. |
| `Answer.tsx` | Wrap streamed content in `aria-live="polite"`; show user prompt as static header; add copy/retry footer. |
| `QuickActions.tsx` | Use `.glass-chip` (no blur/shadow) so chips read as secondary. |
| `CodeBlock.tsx` | Add `focus-ring` to copy button; raise header contrast; use semantic success for “Copied”. |
| `Markdown.tsx` | Evaluate catppuccin-mocha or gruvbox-dark for a less “GitHub-default” code look. |

### 6.3 Quick wins (biggest visual impact, lowest risk)

1. Replace `×` with Lucide `X` in `Bar.tsx`.
2. Add semantic color tokens and remove all hardcoded `#f0717a` / `#83c092`.
3. Fix `ToggleRow` nested-button bug.
4. Add `aria-live` containers to Answer/Copilot/Review.
5. Stabilize Onboarding permission button widths.
6. Bump `color-ink-3` to ~48% white for helper-text contrast.
7. Standardize motion easing to `--ease-spring`.

---

## 7. Test & QA Recommendations

1. **Add a test harness immediately** (Vitest for units, Playwright for E2E smoke). Priority tests:
   - Settings layering + managed-config behavior
   - Transcript file format + frontmatter escaping
   - IPC schema round-trips
   - Meeting-detector regexes on real window titles
   - Stream cancellation paths
2. **Adopt a release QA checklist** covering: key storage state, permission prompts, shortcut reference accuracy, auto-start confirmation, and auto-save default.
3. **Run a legal/compliance review** before any enterprise launch: third-party recording consent, PII retention, cloud-sync disclosure, and managed-config enforceability.
4. **Schedule a follow-up UI audit** after the Liquid Glass pass to verify contrast, focus rings, and reduced-motion behavior.

---

## 8. Status Legend

- **OPEN** — Fixable in code; no external dependency.
- **TONY** — Requires your decision, certificate, or external infra (legal posture, Apple Dev-ID cert, update host, cloud-PII policy).
- **BY-DESIGN** — Intentional behavior; revisit only if user testing contradicts it.
- **PARTIAL** — Fix applied but incomplete or not fully verified.

---

*Report generated by a focused multi-role audit team and consolidated into this single quantified scorecard.*
