# AskToto — Observability Report (Gate 11)

Scope: AskToto 0.1.0 is a **local desktop app with no server**. Server-side observability
(metrics/traces/dashboards/log aggregation/SLOs) is **N/A** — there is no backend emitting telemetry and,
**by deliberate design, no telemetry or crash reporting is sent off-device** (a privacy positive).
"Observability" for this app means: local logging, user-facing error surfacing, and self-test.
Evidence = `file:line` / command output.

Date: 2026-06-27.

---

## 1. What exists (verified)

| Capability | Present? | Evidence |
|------------|:---:|----------|
| Local file logging | Yes — `electron-log` | `updater.ts:5,16-32`; logs to electron-log default path |
| User-facing error surfacing | Yes — `stream:error` events to the UI | `index.ts:485-560` (every failure path sends `IPC.streamError` with a human message) |
| Tolerant config (never bricks) | Yes | `getSettings()` repairs/falls back, never throws (`store.ts:142-160`); proven by `selftest.ts` cases 1-2 |
| In-app self-test | Yes — runs real main-process logic, writes pass/fail JSON | `selftest.ts:20-139`, invoked `index.ts:694` |
| Shortcut/registration warnings | Yes — `console.warn` | `index.ts:300-302` |
| Updater lifecycle logs | Yes | `updater.ts:27-30` (error/downloaded/check-failed) |

## 2. What is intentionally absent (and why that's correct here)

| Capability | Status | Justification |
|------------|:---:|---------------|
| Crash reporting (Sentry / Electron crashReporter upload) | **None, by design** | Verified `grep -rn "crashReporter\|Sentry\|setUploadToServer" src/` → none. No PII/transcript content is shipped to any vendor for diagnostics — aligns with the no-telemetry privacy stance |
| Product analytics / usage telemetry | **None, by design** | `grep "analytics\|telemetry"` → none |
| Server metrics / traces / APM | **N/A** | No server to instrument |
| Log aggregation / SIEM | **N/A** | Single machine; logs stay local for the user to inspect |
| SLO / SLI dashboards | **N/A** | No service level to measure |

## 3. Gap: no global crash/error handler in main

`grep -rn "uncaughtException\|unhandledRejection\|render-process-gone\|child-process-gone" src/main/` →
**none**. There is no process-level handler, so an unhandled exception/rejection in the main process can
terminate the app with **no local diagnostic written**. The renderer-facing paths are well guarded, and
startup failures log (`index.ts:759`), but a deep async failure could be silent for the user.

## 4. Findings

| Sev | Title | Evidence | Fix |
|-----|-------|----------|-----|
| MEDIUM | No global `uncaughtException`/`unhandledRejection` handler or Electron `crashReporter` (local dump) | `grep` (none) in `src/main/`; only `electron-log` imported | Add `process.on('uncaughtException'/'unhandledRejection', …)` that writes to `electron-log`, and optionally `crashReporter.start({ uploadToServer: false })` for **local-only** minidumps — keeps the no-egress stance while giving the user a crash artifact |
| LOW | Logging is updater-centric; main-process operational events under-logged | only `updater.ts` imports `electron-log`; rest use `console.*` | Route key main events (auth, save, stream errors) through `electron-log` so they land in the user's log file for support |
| LOW | No log rotation/retention policy documented | electron-log defaults | Confirm electron-log rotation defaults are acceptable; document log location for support |

## 5. Gate 11 (Observability) — **PASS**

For a local, telemetry-free desktop app the observability that is *appropriate* is present and verified:
local logging (`electron-log`), comprehensive user-facing error surfacing (`stream:error` on every
failure path), tolerant configuration that cannot brick, and a runnable self-test. Server-side
observability is correctly **N/A**. The MEDIUM gap (no global crash handler) is a hardening item, not a
release blocker; it is recommended for the next iteration and does **not** require shipping any data
off-device.
