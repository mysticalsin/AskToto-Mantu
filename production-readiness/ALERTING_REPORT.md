# AskToto — Alerting Report

Scope: AskToto 0.1.0 is a local desktop app. **Server/ops alerting (PagerDuty, on-call, threshold
alerts, paging) is N/A** — there is no service, no SRE/on-call team, and nothing runs unattended on
infrastructure. The only meaningful "alerting" is **user-facing, in-app notification** of conditions the
single user must act on. Evidence = `file:line`.

Date: 2026-06-27.

---

## 1. User-facing alerts that exist (verified)

| Condition | How the user is alerted | Evidence |
|-----------|-------------------------|----------|
| Answer/stream failure (no key, bad model, provider error, vision unsupported) | inline error message in the UI via `stream:error` | `index.ts:485-560` |
| Not signed in (when SSO enforced) | "Sign in with your Mantu account…" error | `index.ts:485-490` |
| Recording in progress | persistent visible recording indicator | `RecordingIndicator.tsx:11-16` |
| Recording consent | reminder banner "Make sure everyone has consented" | `RecordingConsentReminder.tsx:50`, `consent.ts` |
| Update downloaded | OS notification via `checkForUpdatesAndNotify()` | `updater.ts:29-30` |
| Encryption unavailable (cannot store key safely) | thrown error surfaced in Settings | `store.ts:195-200` |
| Meeting detected (auto-start) | toast | `MeetingDetectedToast.tsx`, `index.ts:312-335` |
| Permission missing (mic/screen) | status reflected in Settings/onboarding | `platform-perms.ts`, `Onboarding.tsx` |

## 2. What is intentionally absent

| Alert type | Status | Justification |
|------------|:---:|---------------|
| Ops paging / on-call escalation | **N/A** | No service to keep up; failures are local and visible to the user immediately |
| Threshold/anomaly alerts on metrics | **N/A** | No metrics pipeline (no telemetry by design — see OBSERVABILITY) |
| Uptime/health-check alerts | **N/A** | No endpoint to probe |
| Security alerting (SIEM) | **N/A** locally | A managed enterprise rollout would rely on the org's EDR/MDM (Intune/Defender) on the endpoint, not on AskToto |

## 3. Findings

| Sev | Title | Evidence | Fix |
|-----|-------|----------|-----|
| LOW | No alert when auto-update silently disabled (placeholder host) | `updater.ts:14-18` logs but does not notify | Acceptable while host is a placeholder; once a real host is set, surface "update available/failed" in-app |
| LOW | Silent main-process crash gives no alert (ties to OBSERVABILITY MEDIUM) | no global handler | Adding the crash handler (OBSERVABILITY fix) lets the next launch show "AskToto recovered from an error" |

## 4. Gate note

No dedicated alerting gate for a local app. The user-facing alerting that matters is present and
verified; ops alerting is justified **N/A**. Linked to Gate 11 (Observability).
