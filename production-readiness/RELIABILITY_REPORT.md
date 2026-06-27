# AskToto — Reliability Report

Date: 2026-06-27. Reliability for a local desktop overlay = **graceful degradation** (bad input, missing
key, provider down, offline, unwritable folder), **no-crash invariants**, **concurrency safety**, and
**clean teardown**. Evidence is from code-read + the in-Electron `selftest.ts` harness; runtime failure
paths that need network/hardware are listed as manual checks.

## 1. Graceful-degradation matrix (verified by code-read)

| Failure | Behavior | Evidence | Status |
|---------|----------|----------|--------|
| No API key for active provider | `streamError` "No API key for X. Open Settings…" — no throw | index.ts:497-503 | PASS |
| Provider can't do vision | Clear message to switch provider / drop screenshot | index.ts:518-524 | PASS |
| No model / no Dust agent set | Targeted message per provider | index.ts:508-517 | PASS |
| Bad request payload (`AskStartSchema`) | Caught, `streamError` "Could not start the answer." | index.ts:557-562 | PASS |
| Provider/network error mid-stream | `onError` → `streamError`; partial answer preserved (flush before settle) | llm.ts:186-189; state.ts:96-104 | PASS |
| User abort / restart | `aborted`/`settled` guards prevent double-emit; prior stream aborted before new one | llm.ts:184-217; state.ts:123 | PASS |
| System audio denied | **Degrades to mic-only** with banner instead of killing session | listen.ts:201-211 | PASS |
| Hard mic+system failure | Full teardown (channels closed, tracks stopped, listening=false) | listen.ts:213-229 | PASS |
| Whisper model fails to load / errors | Worker posts `error`; renderer surfaces it, `busy` cleared, queue pumps on | whisper.worker.ts:23-24,42-43; listen.ts:99-102,121-127 | PASS |
| Malformed managed-config | `getSettings` **never throws** — drops bad keys, repairs custom-provider invariant, falls back to DEFAULT | store.ts:142-160; selftest §1 | PASS (smoke-verified) |
| Stale/bad user settings.json | Tolerant migration keeps valid keys, repairs, can't brick IPC | store.ts:151-159; selftest §2 | PASS (smoke-verified) |
| Undecryptable settings (keychain/user changed) | Falls back to defaults, doesn't brick | store.ts:114-120 | PASS |
| safeStorage unavailable when saving key | Refuses with honest error (no silent plaintext key) | store.ts:195-200 | PASS |
| Meetings folder offline/unwritable (OneDrive) | `ensureMeetingsFolder` fail-open; writes are atomic (tmp+rename) with tmp cleanup on failure | transcripts.ts:92-104,39-62 | PASS |
| Encrypted transcript opened in editor | Decrypts to temp copy instead of showing ciphertext | index.ts:649-651; transcripts.ts:65-69 | PASS |
| Duplicate app launch | `requestSingleInstanceLock` focuses existing window | index.ts:681-689 | PASS |

## 2. Concurrency safety — VERIFIED
- **Graph build guard (the key one):** `building` flag is set **synchronously before any `await`**
  (graphify.ts:194-198) precisely so a rebuild double-click + the 20 s debounced auto-rebuild can't both
  pass the `if (building)` check and spawn concurrent builds into the same `outDir`. The race the comment
  describes is closed. `finally { building = false }` always releases. PASS.
- **Debounced rebuild:** coalesces a burst of saves into one incremental build; skipped entirely when
  transcripts are encrypted (runner can't read them) — graphify.ts:234-243. PASS.
- **Meeting poller:** `meetingDetecting` guard prevents overlapping detects (index.ts:313-335). PASS.
- **Stream registry:** in-flight streams tracked in a `Map`, deleted on done/error/cancel (index.ts:79,
  548-569). No leak of abort handles. PASS.
- **Whisper queue:** single `busy` flag + one-terminal-reply contract → queue can't wedge or double-pump
  (listen.ts:81-88; whisper.worker.ts:33-35). PASS.

## 3. Trust-boundary robustness
Every privileged `ipcMain.handle` calls `assertMainWindow(e)` (rejects non-main-window sender,
subframes, mismatched URL — index.ts:83-92) and the privileged ones add `requireAuth()`. `requireAuth`
returns true when SSO is **not configured** (dev/single-user) and only enforces sign-in when an Entra
tenant+domain is configured (auth.ts:152-155). **Reliability note for "production with sensitive data":**
in the default unconfigured posture there is no sign-in gate — acceptable for single-user local use, a
posture gap if deployed to handle sensitive multi-user data. (Security-domain item; flagged here because
it affects the reliability of the access guarantee.)

## 4. Auto-update reliability
- `initAutoUpdate` only runs in the packaged app and **skips when the publish host is the placeholder**
  (`REPLACE-WITH`) so it doesn't error every launch (updater.ts:11-21; electron-builder.yml `publish.url`
  is still the placeholder). Errors are logged, not thrown (updater.ts:27,30). 
- **Gap (MEDIUM, UNKNOWN in prod):** no real update host is configured → there is currently **no update /
  rollback channel**. A shipped defect cannot be remediated via auto-update until a host + signed builds
  are wired (also blocked by unconfigured code-signing — see below).

## 5. Offline behavior
- LLM answers require network (provider SDKs over HTTPS) — expected; failure path is clean (§1).
- **First Listen requires network** to fetch the Whisper model from the HF CDN (no bundled model, no
  SRI). Offline-first-run = transcription unavailable; the worker reports an error and mic capture still
  runs but produces no text. Reliability + supply-chain gap (P-PERF-3 / known). Subsequent runs use the
  HTTP cache.

## 6. Build/release reliability gaps
- **Code signing / notarization NOT configured** (env-driven `CSC_LINK`/Apple creds; electron-builder.yml
  comments + SIGNING.md). Unsigned builds → Gatekeeper/SmartScreen friction and **no trusted auto-update**.
  Release-blocking for distribution, though not a runtime defect. UNKNOWN until certs are provided.
- `selftest.ts` and `npm audit` are **not in CI** → reliability regressions in settings-repair / injection
  guard / dependency CVEs would not block a merge. Recommend wiring both into `.github/workflows/build.yml`.

## 7. Summary
Runtime reliability of the implemented features is **strong**: comprehensive graceful degradation, a
correctly-ordered concurrency guard, clean teardown, no-crash settings invariants (smoke-verified). The
open reliability items are **operational, not behavioral**: no production update channel, unconfigured
signing, offline-first-Listen model dependency, and two strong checks (selftest, audit) left out of CI.
