# AskToto — QA Report (full audit)

Audit: 4 lenses (QA · PM · Security · Senior-FullStack), 60 agents, each finding adversarially verified.
Physical test: app launched, every surface screenshotted, pipelines run. Statuses updated as fixed.

Legend: **FIXED** (corrected + typecheck/build green) · **OPEN** (to fix in loop) · **TONY** (needs your
decision/cert/infra) · **BY-DESIGN**.

## Physical tests (P)
| ID | Check | Result |
|----|-------|--------|
| P1 | Onboarding renders | ✅ PASS |
| P2 | Idle bar + quick actions (What to say next) | ✅ PASS |
| P3 | Settings (providers, About-you, folder, toggles) | ✅ PASS |
| P4 | Interview Copilot (say-this + actions, transcript hidden) | ✅ PASS |
| P5 | Answer + Ask + shiki-colored code | ✅ PASS |
| P6 | typecheck + electron-vite build | ✅ PASS |
| P7 | Claude SDK reachability (401 auth) | ✅ PASS |
| P8 | Transcript + index format (6/6) | ✅ PASS |
| P9 | AppleScript detector syntax (osacompile) | ✅ PASS |
| P10 | Packaged .app + icon (icon.icns) | ✅ PASS |
| P11 | Bundle size 284 MB (trimmed) | ✅ PASS |

## Findings (Q) — numbered tracking
| ID | Sec | Sev | Issue | Status |
|----|-----|-----|-------|--------|
| Q01 | 11 | HIGH | Auto-started meeting never auto-ends/saves → transcript data loss | FIXED |
| Q02 | 18 | HIGH | No third-party consent flow for covert system-audio recording (legal/GDPR/2-party) | TONY (consent UI + doc added; legal posture is yours) |
| Q03 | 2 | MED | Global `Cmd+Enter` hijacks send/submit OS-wide (Slack/Gmail/Jupyter) | FIXED |
| Q04 | 7 | MED | Whisper `tiny.en` is English-only → non-English meetings fail (multinational) | FIXED (multilingual model) |
| Q05 | 7 | MED | Unbounded capture queue if Whisper model never loads | FIXED (queue cap + drop-oldest) |
| Q06 | 18/19 | MED | `setApiKey` provider not validated → used in filesystem path (traversal) | FIXED |
| Q07 | 19 | MED | `setSettings` writes raw patch unvalidated | FIXED (validate before persist) |
| Q08 | 16 | MED | Tray uses empty image → invisible/unusable on Windows | FIXED (real icon) |
| Q09 | 18 | MED | `loadDotEnv` reads `.env` from cwd in packaged app (key injection) | FIXED (dev-only) |
| Q10 | 5 | MED | Full-res screenshot sent to cloud with no downscale (payload/latency) | FIXED (cap ≤1568px) |
| Q11 | 14 | MED | Onboarding hardcodes Claude regardless of active/managed provider | FIXED (provider-aware) |
| Q12 | 18 | MED | Injection GUARD keyed on mode; bypassed by answer-mode transcript flows | FIXED (guard on all transcript-bearing prompts) |
| Q13 | 18 | MED | API key cleartext fallback when safeStorage unavailable | FIXED (0o600 + honest "encryption unavailable" copy; refuse-persist = OPEN option) |
| Q14 | 17 | MED | Auto-update hits placeholder host every launch | FIXED (skip until real host set) |
| Q15 | 15 | MED | Managed config from user-writable path; "locked" implied but not enforced | PARTIAL (also reads admin path; comment corrected; true key-locking = OPEN) |
| Q16 | 18 | LOW | CSP missing base-uri/object-src/form-action | FIXED |
| Q17 | 16 | LOW | Entitlement `disable-library-validation` unnecessary | FIXED (removed) |
| Q18 | 9 | LOW | Empty meeting → perpetual "writing notes…" spinner | FIXED |
| Q19 | 11 | LOW | Meeting poller setInterval has no in-flight overlap guard | FIXED |
| Q20 | 13/9 | LOW | Provider/audio tiles lack aria-pressed; clipboard writes no .catch | FIXED |
| Q21 | 18 | MED | Full transcripts (PII) plaintext to cloud-synced OneDrive, auto-save default on | TONY (consent+doc added; default/encryption is your deployment policy) |
| Q22 | 16/17 | MED | No code-signing/notarization; publish host placeholder; mac-only dist | TONY (Apple Dev-ID cert + update host) |
| Q23 | 11 | LOW | Detection brittle (title substrings); default autoStartOnMeeting off | PARTIAL (kept opt-in by design; broadened titles) |
| Q24 | 4 | LOW | No multi-turn conversation memory | BY-DESIGN (single-shot; documented) |
| Q25 | 19 | LOW | `setInteractive` IPC exposed but unused | OPEN (harmless; wire click-through or remove) |
| Q26 | 4 | LOW | OpenAI token usage not requested (stream_options) | OPEN (telemetry only; compat-safe to skip) |

_Updated by the QA loop; see PLAN-v4-enterprise.md for build context._
