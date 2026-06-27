# AskToto — Flaky / Environment-Dependent Test Register

Date: 2026-06-27. "Flaky" here means a test whose pass/fail depends on the **environment** (OS access,
shared filesystem state, timing) rather than the code under test. There are no observed timing/order
races in the deterministic suite — all 59 pass repeatably on a real macOS host.

## F1 — dustcli.test.ts keychain writes (CONFIRMED environment-dependent) · MEDIUM

| Field | Value |
|-------|-------|
| Tests | `imports token + workspace and maps EU region…`, `maps US region to dust.tt`, `fails when only a partial session exists` (3 of 4) |
| File | `src/main/dustcli.test.ts:50-70` (setup `setSession` → `security add-generic-password`, line 30) |
| Trigger | Any environment where `security add-generic-password` is blocked (sandbox, headless CI without a Keychain, locked login keychain) |
| Symptom | `security: SecKeychainItemCreateFromContent (<default>): UNIX[Operation not permitted]` → the 3 *write*-dependent tests fail; the read-only "empty keychain" test still passes |
| Verified cause | Re-ran the file outside the sandbox → `PASS (4) FAIL (0)`. The app code (`importDustCliSession`) is correct; only the test's keychain *fixture write* is blocked. |
| Determinism risk | The suite is green on `macos-latest` with an unlocked keychain, red on Linux runners and any sandbox. `describe.runIf(isMac)` already skips non-mac, but does NOT protect against a mac runner with a locked/denied keychain. |
| Recommended fix | Refactor to mock the `execFile('security', …)` boundary (inject the keychain reader) so the region-mapping + partial-session logic is tested without touching the real keychain. Keep ONE opt-in real-keychain integration test behind an env flag (e.g. `ASKTOTO_KEYCHAIN_IT=1`) run only on the signing/macOS job. |
| Workaround until fixed | Pin the keychain tests to the `macos-latest` CI job with `security unlock-keychain` in a setup step; never run them on `ubuntu-latest`. |

## F2 — shared fixed userData path across store/transcripts tests · LOW (latent)

| Field | Value |
|-------|-------|
| Cause | `__mocks__/electron.ts` returns a **constant** `app.getPath('userData') = /tmp/asktoto-test-userdata` and `documents = /tmp/asktoto-test-documents` for every test. `store.ts` writes `settings.json`/`key-*.bin` there; `transcripts.ts`/`selftest` write meeting folders. |
| Risk | If Vitest runs these files **in parallel** in the same process pool with a shared CWD, or if a prior run left state, settings/key files can bleed between tests. Today it passes because the relevant tests set explicit folders and Vitest isolates per-file, but it is one config change (`pool`, `--no-isolate`, parallel sharding) away from order-dependent flakiness. |
| Recommended fix | Make the mock return a per-test temp dir (e.g. `fs.mkdtemp`) or set `test.fileParallelism`/`isolate` explicitly and clean userData in `beforeEach`. |

## F3 — selftest transcript dates / locale (LOW, harness-only)
`selftest.ts` uses `new Date(...).toLocaleString()` and parses `2026-06-26T16:00:00` (no TZ). Output
strings are locale/timezone-dependent. It only checks for substrings (`status: ready-for-followup`,
`[open]` count), so it is robust today — but any future assertion on a formatted date/time would be
flaky across machines. Note for whoever wires selftest into CI.

## Register status
- Quarantined / skipped tests: **none** currently.
- `it.skip` / `describe.skip` in repo: **none** (only `describe.runIf(isMac)` gating, which is correct).
- Net: the deterministic suite is reliable; the **only** real flakiness is the keychain-write coupling
  (F1), which is a CI-environment concern, not a product defect.
