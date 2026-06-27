# AskToto — Compliance Mapping

**No compliance certification is claimed.** This is an evidence package mapping AskToto 0.1.0 against the
GDPR principles and SOC 2 Trust Services Criteria that are *meaningful for a local, single-user desktop
client*. Criteria that presuppose a service organization (multi-tenant SaaS, server infrastructure,
sub-processor hosting) are marked **N/A** with justification. Evidence = `file:line` / command output.

Date: 2026-06-27.

---

## A. GDPR principles (Art. 5) — local client

| Principle | Applies? | Status | Evidence |
|-----------|:---:|:---:|----------|
| Lawfulness/fairness/transparency | Yes | PARTIAL | Consent reminder present (`RecordingConsentReminder.tsx:50`); no in-app privacy notice (PRIVACY_REVIEW finding) |
| Purpose limitation | Yes | PASS | Data used only for the requested AI action; PII only added in interview/sales (`personas.ts`) |
| **Data minimization** | Yes | PASS | On-device ASR; prompt caps; keys never to renderer (`whisper.worker.ts`, `llm.ts:18-40`, `store.ts:312-316`) |
| Accuracy | Yes | PASS | All profile/settings user-editable (`Settings.tsx`) |
| **Storage limitation** | Yes | PARTIAL | Deletion is self-service; no automated retention/TTL (`transcripts.ts`) |
| **Integrity & confidentiality** | Yes | PASS (with caveat) | safeStorage encryption for keys/settings/session always on; transcripts opt-in (`store.ts:186-202`, `transcripts.ts:39-62`) |
| Accountability | Yes | PARTIAL | Optional Entra SSO gives attribution; off by default (`auth.ts:152-155`) |

GDPR data-subject rights (erasure/rectification/portability/restriction): all exercisable self-service —
see PRIVACY_REVIEW §4. **Sub-processors** (Art. 28) the deploying org must have agreements with: the
chosen LLM provider(s), Microsoft (Entra + OneDrive), Hugging Face (model CDN), Dust. AskToto ships none
of these credentials — the user supplies their own.

## B. SOC 2 Trust Services Criteria — applicability to a desktop binary

| TSC | Applies to a local client? | Status | Evidence / justification |
|-----|:---:|:---:|----------|
| CC6.1 Logical access — encryption | Yes | PASS | safeStorage at-rest encryption, `0o600` files (`store.ts:181,201`, `auth.ts:127`) |
| CC6.1 Logical access — authn | Partial | PARTIAL | Optional Entra SSO, tenant+domain locked; no-op when unconfigured (`auth.ts:152-155,227-232`) |
| CC6.6 Boundary protection | Yes | PASS | Trust boundary = main; `assertMainWindow`+`requireAuth` on privileged IPC; sandbox/contextIsolation (ARCHITECTURE.md) |
| CC6.7 Data in transit | Yes | PASS | Provider SDKs use HTTPS; loopback PKCE on `127.0.0.1` only (`auth.ts:194-197`) |
| CC6.8 Malicious software / supply chain | Partial | PARTIAL | npm audit run (VENDOR review); Whisper no-SRI; signing not configured |
| CC7.1 Detection of events | Partial | PARTIAL | Local `electron-log` only; no telemetry by design (OBSERVABILITY) |
| CC7.2 Incident response | Yes (local) | PASS | INCIDENT_RESPONSE_RUNBOOK.md |
| CC8.1 Change management | Yes | PASS | CI runs typecheck/build/test (`.github/workflows/build.yml`); auto-update (`updater.ts`) |
| A1.x Availability (SLA/redundancy) | **N/A** | N/A | No service operated by AskToto; availability = the user's own machine |
| PI1.x Processing integrity (of a service) | **N/A** | N/A | No backend processing pipeline; output is the LLM's |
| C1.x Confidentiality of *customer* data in a service | **N/A** | N/A | No multi-customer data store; all data is the single user's, local |
| P1–P8 Privacy (service-org) | Partial | see GDPR §A | Mapped via GDPR above; no service-side privacy program because no service |

## C. Other regimes

- **EU AI Act**: AskToto is a thin client over third-party LLMs (limited-risk transparency tier at most;
  the user is the deployer). Transparency: the UI clearly labels AI output; recording consent reminder
  present. A full classification belongs to the deploying org.
- **Recording / wiretap law (two-party consent)**: jurisdiction-dependent and the **user's**
  responsibility; the app provides a consent reminder + visible indicator but cannot enforce law.
- **PCI/HIPAA**: **N/A** — app is not designed for and should not be used with cardholder/PHI data
  without an organizational risk assessment and provider BAAs.

## D. Findings

| Sev | Title | Evidence | Fix |
|-----|-------|----------|-----|
| MEDIUM | No documented sub-processor list / DPA tracking surfaced to deployers | §A, `UNKNOWN_ITEMS.md #17` | Maintain an approved-provider + DPA register; ship as managed-config allowlist |
| LOW | Accountability (attribution) off by default | `auth.ts:152-155` | Mandate Entra SSO via managed-config for regulated deployments (see ACCESS_REVIEW) |

## E. Gate note

This document does not own an audit gate by itself; it feeds Gate 13 (Privacy) and the access/observability
gates. See respective reports. **No certification is asserted.**
