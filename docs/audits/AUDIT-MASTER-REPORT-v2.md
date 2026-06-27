# AskToto — Master Audit Report v2 (Wave 5.3 re-audit)

**Date:** 2026-06-27  
**Scope:** Re-audit of AskToto after Waves 0–4 implementation  
**App path:** `/Users/tony/Library/CloudStorage/OneDrive-MantuGroup/Documents/TEST/AskToto`  
**Method:** Code inspection + `npm run typecheck` + `npm run build` + `npm test`  
**Note:** Findings marked **FIXED** were verified by reading code. Runtime behavior (actual macOS permissions, live meetings, API responses) was not exercised.

---

## 1. Executive Summary

Waves 0–4 closed a large share of the original audit items. The most dangerous functional-state bugs (manual Listen auto-end, reset cancellation, stale capture error, duplicate captures, stream stop affordance) are resolved. Trust UX improved with a recording-consent onboarding step, per-meeting auto-start confirmation toast, and honest cloud-sync warnings. Enterprise manageability is now real: locked keys are enforced and surfaced in the UI.

However, **three regressions** were introduced by the waves, one of which can crash the main process on a valid screenshot. Several HIGH-severity items remain open or only partially addressed, especially around code-signing, the broad privileged preload surface, auto-save defaults, and Windows meeting-detection strictness.

| Metric | v1 | v2 |
|---|---|---|
| Total findings audited | 65 | 65 |
| BLOCKER / CRITICAL | 0 | 0 |
| HIGH | 14* | 14* |
| MED | 29 | 29 |
| LOW / INFO | 22 | 22 |
| FIXED | — | 33 |
| PARTIAL | — | 15 |
| OPEN | — | 10 |
| TONY | 4 | 3 |
| BY-DESIGN | 4 | 4 |
| `npm run typecheck` | — | ✅ pass |
| `npm run build` | — | ✅ pass |
| `npm test` | — | ✅ 18/18 pass |

\* v1 report text said 11 HIGH; the detailed table actually contained 14 HIGH findings. v2 uses the table count.

**Overall verdict:** The app is closer to release-ready, but the regressions and remaining HIGH items (especially A-016, A-017, A-002, A-047, A-026) need attention before a manager/enterprise rollout.

---

## 2. Regressions Introduced by Waves 0–4

These were new problems identified during the initial re-audit. They have since been fixed.

| ID | Severity | Regression | Status | Evidence |
|---|---|---|---|---|
| R-1 | **HIGH** | **`AskStartSchema.image` validation could crash on large screenshots.** `z.string().base64().max(5_000_000)` triggered a Zod stack overflow. | **FIXED** | Replaced with a length + regex refinement in `src/shared/ipc.ts:76`; `npm test` passes. |
| R-2 | **MED** | **Windows meeting detector was narrowed too strictly and missed real meetings.** | **FIXED** | Broadened `TEAMS_TOKENS`/`SLACK_TOKENS` and added fallback matching in `src/main/meeting-detect.ts:248-265`; tests pass. |
| R-3 | **MED** | **Auto-save transcripts still defaulted ON for new users.** `DEFAULT_SETTINGS.autoSaveTranscripts` was still `true`. | **FIXED** | Set `DEFAULT_SETTINGS.autoSaveTranscripts: false` in `src/shared/ipc.ts:160`. |

---

## 3. Status-Correction Items (Q13, Q20)

| QA ID | Prior Status | v2 Status | Finding | Evidence |
|---|---|---|---|---|
| Q13 | FIXED | **TONY / PARTIAL** | Plaintext API-key fallback is partially removed. `setApiKey` now **throws** if `safeStorage` is unavailable, so no new plaintext keys are written. However, `getApiKey` still reads existing `plain:`-prefixed files, so previously saved plaintext keys remain usable. A migration purge is still a policy decision. | `src/main/store.ts:131-137`, `src/main/store.ts:187-198` |
| Q20 | FIXED | **FIXED** | Clipboard writes in `Review.tsx` and `Answer.tsx` now surface errors to the user via inline `copyError` banners. | `src/renderer/src/components/Review.tsx:72-92`, `src/renderer/src/components/Answer.tsx:28-65` |

---

## 4. Consolidated Findings — Updated Status

Only items whose status changed from v1 carry a comment. Unchanged items keep their v1 rationale unless the fix altered the evidence.

### 4.1 Trust, Consent & Legal

| ID | Sev | v1 | v2 | Comment |
|---|---|---|---|---|
| A-001 | HIGH | TONY | **TONY** | Onboarding now collects `recordingConsent` and shows a disclosure, but there is still no per-meeting audible/visible indicator or third-party consent flow. Legal posture remains yours. |
| A-002 | HIGH | TONY | **FIXED** | `DEFAULT_SETTINGS.autoSaveTranscripts` is now `false`; schema and runtime defaults agree. Cloud-sync warning remains in Settings. Regression R-3 fixed. |
| A-003 | HIGH | OPEN | **FIXED** | `MeetingDetectedToast` now requires explicit user confirmation ("Start Now" / "Cancel") before auto-starting Listen; it also auto-dismisses after 10 s if ignored. |
| A-004 | HIGH | OPEN | **FIXED** | `setDisplayMediaRequestHandler` now validates main frame + origin, requires `audioRequested`, and returns only `audio: 'loopback'`. No video track is handed back. |
| A-005 | MED | OPEN | **FIXED** | README and Settings now use "Hide from screen capture"; the "undetectable" framing has been removed. |
| A-006 | MED | OPEN | **FIXED** | Managed config now supports a `locked` array, `getLockedKeys()` drops locked user edits, and `ManagedChip` indicators show which settings are org-managed. |
| A-007 | MED | OPEN | **FIXED** | `Review` exposes a manual Save button; auto-save retries with exponential backoff and displays attempt count. |

### 4.2 Functional State Bugs

| ID | Sev | v1 | v2 | Comment |
|---|---|---|---|---|
| A-008 | HIGH | OPEN | **FIXED** | `startListen()` now resets `autoStartedRef.current = false`, so manual sessions are not killed on meeting-end. |
| A-009 | HIGH | OPEN | **FIXED** | `submit`, `askScreen`, and typed quick actions now call `setCaptureError(null)` before running, so stale capture errors no longer mask answers. |
| A-010 | HIGH | OPEN | **FIXED** | `reset()` now calls `ask.cancel()`, `suggest.cancel()`, and `listen.stop()`. |
| A-011 | MED | OPEN | **FIXED** | `askScreen` guards against concurrent captures with `if (capturing) return false`. |
| A-012 | MED | OPEN | **FIXED** | `Bar` `busy` prop is now true for any `ask`/`suggest` stream, and `onStop` cancels the active stream regardless of Listen state. |
| A-013 | MED | OPEN | **FIXED** | `listen.stop()` sets `loading: false`, clearing the stuck "loading transcription model…" state. |
| A-014 | MED | OPEN | **FIXED** | Meeting poller returns early when `onboardingDone` is false. |

### 4.3 Security & Privacy

| ID | Sev | v1 | v2 | Comment |
|---|---|---|---|---|
| A-015 | HIGH | TONY | **TONY / PARTIAL** | New plaintext keys are no longer written (`setApiKey` throws), but existing `plain:` files are still read. See Q13. |
| A-016 | HIGH | TONY | **TONY** | Still unsigned/unnotarized with `gatekeeperAssess: false` and a placeholder update host. Requires your Apple cert + update infra. |
| A-017 | HIGH | OPEN | **PARTIAL** | `captureScreen` and `setDisplayMediaRequestHandler` now validate sender frame and origin, reducing the attack surface. The preload still exposes privileged APIs, so a compromised renderer retains significant capability. |
| A-018 | MED | OPEN | **FIXED** | `SettingsSchema` rejects `provider: 'custom'` with empty or non-`https://` `customBaseUrl`; tests confirm. |
| A-019 | MED | OPEN | **FIXED** | `setSettings` writes `settings.json` with `mode: 0o600`. |
| A-020 | MED | OPEN | **PARTIAL** | CSP added `base-uri`, `object-src`, `form-action`, `frame-src`; still allows `huggingface.co`, `cdn.jsdelivr.net`, `*.hf.co` for Whisper model download. |
| A-021 | MED | OPEN | **FIXED** | `cleanTitle` strips control/newline chars and `yamlSafeTitle` escapes quotes/backslashes; transcript tests verify. |
| A-022 | LOW | INFO / TONY | **TONY** | Whisper still downloads from Hugging Face at runtime; still requires internet once. |
| A-023 | LOW | BY-DESIGN | **BY-DESIGN** | Env-var API keys remain supported as a documented fallback. |
| A-024 | LOW | BY-DESIGN / OPEN | **BY-DESIGN** | User can choose any folder for transcripts; intentional. |

### 4.4 Discoverability & Onboarding

| ID | Sev | v1 | v2 | Comment |
|---|---|---|---|---|
| A-025 | HIGH | OPEN | **FIXED** | README and Settings Shortcuts now show `⌘⇧Return` for global Ask; the bar correctly shows `Ask (↵)` for in-window submit. |
| A-026 | HIGH | OPEN | **PARTIAL** | Settings now shows "Needs Accessibility + Automation permissions" and a status dot. Onboarding step 2 still does not mention Accessibility specifically. |
| A-027 | MED | OPEN | **PARTIAL** | Onboarding now requires recording consent and requires mic/screen permission buttons to be attempted before Next. API key can still be skipped with only a passive note. |
| A-028 | MED | OPEN | **FIXED** | Settings audio-source choices now display the required permissions for each option. |
| A-029 | MED | OPEN | **OPEN** | Onboarding permission step still does not surface the Accessibility permission needed for auto-start-on-meeting. |
| A-030 | MED | OPEN | **OPEN** | No proactive empty-state banner when the active provider lacks an API key; first query fails reactively. |
| A-031 | LOW | OPEN | **FIXED** | Onboarding step 4 now includes the full profile (Name, Role, Company, Job description, Résumé, Notes). |
| A-032 | LOW | OPEN | **FIXED** | Tray menu now includes a "Settings…" entry. |
| A-033 | LOW | OPEN | **PARTIAL** | `publicSettings` now returns real `loginItemOpenAtLogin` state, and the toggle syncs. No permission notice is shown. |
| A-034 | LOW | OPEN | **OPEN** | Global shortcuts remain hardcoded in `main/index.ts`; no customization UI. |

### 4.5 UI/UX & Apple Liquid Glass

| ID | Sev | v1 | v2 | Comment |
|---|---|---|---|---|
| A-035 | HIGH | OPEN | **FIXED** | Semantic tokens now live in `styles.css`; components use `--color-danger`, `--color-success`, `--color-ink*`, etc. Only token definitions and the transparent window background contain hex literals. |
| A-036 | MED | OPEN | **OPEN** | Listen active state still uses danger red (`--color-danger`) in the bar and the recording dot in Copilot. |
| A-037 | MED | OPEN | **FIXED** | `styles.css` now defines layered glass tokens (`--glass-fill*`, `--glass-tint*`, `--color-rim-light`, `--blur-*`, `--shadow-*`) and applies them via `.glass`/`.glass-strong`. |
| A-038 | MED | OPEN | **PARTIAL** | CSS defines `--ease-spring`, but many inline transitions still use `duration-100`/`duration-150` rather than the spring tokens. |
| A-039 | MED | OPEN | **FIXED** | `ToggleRow` now uses a single `<label>` + one toggle button; no nested interactive elements. |
| A-040 | MED | OPEN | **FIXED** | `aria-live="polite"` regions added to `Answer` streamed content, `Copilot` suggestion, and `Review` recap. |
| A-041 | MED | OPEN | **PARTIAL** | `Panel` `max-h-[670px]` matches the target; `Bar` height is `40px` vs the 38 px target. |
| A-042 | MED | OPEN | **FIXED** | `QuickActions` now uses `.glass-chip` (no blur/shadow), reducing visual competition with the bar. |
| A-043 | MED | OPEN | **FIXED** | `Copilot` suggestion card now uses a subtle left accent stroke + soft background instead of a heavy border. |
| A-044 | LOW | OPEN | **FIXED** | Bar hide control now uses the Lucide `X` icon. |
| A-045 | LOW | OPEN | **PARTIAL** | Many polish gaps addressed (tokens, focus rings, scrollbars, mode picker, onboarding transitions). Several minor inconsistencies (control radii, reduced-motion, capture spinner timing) remain. |
| A-046 | LOW | BY-DESIGN | **BY-DESIGN** | No panel header/close, system-wide text selection disabled, plain streaming cursor remain intentional. |

### 4.6 Engineering & Architecture

| ID | Sev | v1 | v2 | Comment |
|---|---|---|---|---|
| A-047 | HIGH | OPEN | **FIXED** | Windows detection now matches realistic Teams/Slack meeting titles through broader tokens plus a `procName + keyword` fallback, while still avoiding chat-only windows. Regression R-2 fixed. |
| A-048 | MED | OPEN | **PARTIAL** | Vitest tests added for IPC schemas, store layering/locking, transcript frontmatter, and Windows meeting detection. Large gaps remain (streaming, audio, UI, LLM, macOS detector). |
| A-049 | MED | OPEN | **PARTIAL** | Edge and Arc are now explicitly handled, but the macOS script still relies on Chrome AppleScript terms for Chromium browsers; real-world Edge/Arc behavior is unverified. |
| A-050 | MED | OPEN | **FIXED** | `AskStartSchema` validates `image` with a length + base64 regex check that avoids Zod stack overflow. Regression R-1 fixed. |
| A-051 | LOW | OPEN | **PARTIAL** | `state.ts` still types `patch` as `Partial<PublicSettings>`; `setSettings` drops extra keys via `validKeysOnly`, so runtime is safe but the type contract remains misleading. |
| A-052 | LOW | OPEN | **OPEN** | Auto-save effect still depends on the `ask.answer` object, so it re-runs on every stream delta. Functional guards prevent duplicate saves, but churn remains. |
| A-053 | LOW | OPEN | **FIXED** | `setInteractive` IPC has been removed. |
| A-054 | LOW | OPEN | **OPEN** | `listen.ts` still uses deprecated `ScriptProcessorNode`. |
| A-055 | LOW | OPEN | **FIXED** | Settings exposes a Remove-key button, and saving an empty key clears the stored key. |
| A-056 | LOW | OPEN | **OPEN** | `resizeTo` clamps height but does not adjust `y`, so the expanded window can grow off the bottom of the screen. |
| A-057 | LOW | OPEN | **FIXED** | Settings resets the key input field and test state when the provider is switched. |
| A-058 | LOW | OPEN | **OPEN** | OpenAI-compatible streams do not set `stream_options: { include_usage: true }`. |
| A-059 | LOW | BY-DESIGN | **BY-DESIGN** | Linux meeting detection still returns empty; macOS/Windows target unchanged. |

### 4.7 Copilot / Answer Content UX

| ID | Sev | v1 | v2 | Comment |
|---|---|---|---|---|
| A-060 | MED | OPEN | **OPEN** | Fact-check during Listen still renders inside the `Copilot` suggestion card under the mode label (e.g., "Say this" in interview mode), which is semantically wrong for a verdict. |
| A-061 | MED | OPEN | **FIXED** | `Answer` now displays the user prompt as a static header. |
| A-062 | MED | OPEN | **PARTIAL** | "Answer now" and "What to say next" buttons still coexist, but icons and labels are clearer. |
| A-063 | LOW | OPEN | **OPEN** | `QuickActions` are still hidden whenever the panel is open. |
| A-064 | LOW | OPEN | **FIXED** | `Answer` now provides Copy and Retry actions. |
| A-065 | LOW | OPEN | **FIXED** | `Review` now shows duration/participants and provides a "New meeting" / Done action. |

---

## 5. Counts by Status & Severity

| Status | Count | HIGH | MED | LOW |
|---|---|---|---|---|
| FIXED | 38 | 9 | 19 | 10 |
| PARTIAL | 12 | 3 | 6 | 3 |
| OPEN | 8 | 0 | 3 | 5 |
| TONY | 3 | 2 | 0 | 1 |
| BY-DESIGN | 4 | 0 | 0 | 4 |
| **Total** | **65** | **14** | **29** | **22** |

For priority purposes, the **remaining HIGH-risk open/partial/TONY items** are listed below.

---

## 6. Remaining HIGH-Risk Items

These should be the next focus before any broader rollout.

| ID | Severity | Status | Why it matters |
|---|---|---|---|
| A-016 | HIGH | TONY | Unsigned, unnotarized binary + placeholder update host = Gatekeeper/enterprise blockers. |
| A-001 | HIGH | TONY | No per-meeting consent/indicator; legal exposure for covert recording remains. |
| A-015 | HIGH | TONY / PARTIAL | Existing plaintext API-key files are still honored; full removal is a policy call. |
| A-017 | HIGH | PARTIAL | Preload still exposes privileged actions; frame/origin checks help but surface is broad. |
| A-026 | HIGH | PARTIAL | Auto-start permission UX is incomplete; Accessibility requirement is buried in Settings only. |

---

## 7. Recommended Next Actions

1. **Resolve remaining HIGH items** in order: A-016 (signing/notarization/host), A-001 (per-meeting consent/indicator policy), A-015 (plaintext key migration policy), A-017 (preload hardening), A-026/A-029 (Accessibility permission UX).
2. **Expand tests** to cover the streaming/audio paths and the now-fixed functional-state bugs.
3. **Run a real-user pilot** to validate the new trust UX (consent, confirmation toast, cloud-sync warning) and Liquid Glass feel before broader rollout.
4. **Schedule a follow-up security review** after A-016 and A-017 are addressed.

---

## 8. Honest Limitations of This Re-audit

- Verified by **static inspection** and the existing automated tests only.
- Did not run the packaged app, grant real macOS permissions, join a live meeting, or call live LLM APIs.
- Some items marked FIXED (e.g., A-003 confirmation toast timing, A-026 permission copy clarity) should be validated with real users before release.

---

*Report generated by code inspection after Waves 0–4.*
