# Métis full physical QA ledger

**Date:** 2026-07-13

## Test boundary

Physical testing uses the packaged Apple Silicon macOS app with synthetic data and an isolated profile. Windows x64 artifacts are inspected structurally because no Windows runner or device is available in this environment.

## Workflow matrix

| ID | Workflow | Test method | Status |
| --- | --- | --- | --- |
| WF-01 | First launch and onboarding | Packaged-app UI | Pending |
| WF-02 | Overlay window, keyboard controls, minimize, restore, quit | Packaged-app UI | Pending |
| WF-03 | Settings persistence and privacy controls | Packaged-app UI | Pending |
| WF-04 | Offline audio import and transcription | Packaged-app UI with synthetic fixture | Pending |
| WF-05 | Saved meeting, history, recall, and recovery | Packaged-app UI with synthetic fixture | Pending |
| WF-06 | Métis Local text routing, summary, vision, warm restart | Packaged-app UI and local runtime evidence | Pending |
| WF-07 | Mantu Intelligence, indexing, read views, and guarded backfill | Packaged-app UI | Pending |
| WF-08 | Permissions, capture, error states, and safe recovery | Packaged-app UI | Pending |
| WF-09 | Windows installer and portable payload | Structural package checks | Pending |

## Findings

| ID | Severity | Reproduction | Root cause | Fix | Status |
| --- | --- | --- | --- | --- | --- |
| QA-001 | High | In an offline, Local-only profile, click **Index meetings** with saved meetings present. The command returned without a visible result and queued zero meetings. | Backfill intentionally rejects Local-only extraction but returned only `{ queued: 0 }`; both UI entry points ignored that result. | Return `deferred: 'no-provider'` and show a direct setup explanation in History and the in-app Intelligence view. | Fixed in source, packaged regression pending. |

## Verification record

Pending.
