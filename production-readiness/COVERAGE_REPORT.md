# AskToto — Coverage Report

Source: `npx vitest run --coverage` (v8 provider; include = `src/main/**`, `src/shared/**`,
`src/preload/**`). Date: 2026-06-27. 10 test files, 59 tests, all passing on a real macOS host.

## 1. Full table (as reported)

```
-------------------|---------|----------|---------|---------|
File               | % Stmts | % Branch | % Funcs | % Lines |
-------------------|---------|----------|---------|---------|
All files          |   21.13 |   20.51  |  19.39  |  21.04  |
 main              |   17.50 |   14.23  |  20.79  |  17.43  |
  auth.ts          |     0   |     0    |    0    |    0    |
  dustcli.ts       |   94.11 |   78.57  |   100   |  94.11  |
  graphify.ts      |   34.31 |   23.64  |  34.37  |  33.33  |
  index.ts         |     0   |     0    |    0    |    0    |
  llm.ts           |     0   |     0    |    0    |    0    |
  personas.ts      |    40   |   52.38  |   75    |  47.05  |
  platform-perms.ts|     0   |     0    |    0    |    0    |
  recall.ts        |     0   |     0    |    0    |    0    |
  selftest.ts      |     0   |     0    |    0    |    0    |
  store.ts         |   47.50 |   24.48  |  55.55  |  47.82  |
  transcripts.ts   |   59.13 |   42.25  |  73.68  |    62   |
  updater.ts       |     0   |     0    |    0    |    0    |
 meeting-detect    |   31.73 |   45.45  |  13.63  |  30.86  |
  index.ts         |     0   |     0    |    0    |    0    |
  mac.ts           |     0   |     0    |    0    |    0    |
  win.ts           |   38.18 |   56.60  |  12.50  |  37.77  |
 preload/index.ts  |     0   |    100   |    0    |    0    |
 shared            |   66.99 |   52.17  |  72.72  |  71.76  |
  prompts.ts       |    100  |    50    |   100   |   100   |
  providers.ts     |   19.51 |   21.56  |   25    |   25    |
  routing.ts       |   96.29 |   92.85  |   100   |   100   |
-------------------|---------|----------|---------|---------|
```

(`ipc.ts` and `meeting-detect/shared.ts` are exercised by their test files but not listed as separate
rows by v8 in this run; the schema and `titleLooksLikeMeeting` assertions pass — see QA_TEST_RESULTS.md.)

## 2. The number that matters: critical-logic coverage, not the 21% headline

The 21% global figure is **expected and acceptable for this architecture**. More than half the main
process is thin Electron glue (window/IPC/tray wiring, MSAL OAuth, SDK streaming) that cannot run under
`environment: node`. What matters for a security/reliability gate is whether the **pure decision logic
at the trust boundary** is covered. It largely is:

| Critical concern | File | Coverage | Tested behavior |
|------------------|------|----------|-----------------|
| Model routing / cost/escalation | routing.ts | **96% / 100% funcs** | hard-question heuristic, base/think tiers, suggest-always-base |
| Dust CLI keychain import + region | dustcli.ts | **94%** | token/workspace read, EU/US baseURL, partial-session fail |
| Settings layering + encryption marker | store.ts | 47% | default<managed<user, locked-key drop, `ATKENC1` at-rest, legacy migration, malformed drop |
| Transcript serialization + YAML safety | transcripts.ts | 62% | encrypt round-trip, title sanitization, collision-safe naming, index |
| Persona / language policy / injection text | personas.ts + prompts.ts | 40% / **100%** | multilingual policy; prompt assembly |
| Graph relatedness | graphify.ts `computeRelated` | function fully tested | 1/2-hop, symmetry, absent-note |
| IPC payload validation | ipc.ts (via ipc.test.ts) | schemas exercised | image size/base64, https custom URL, consent defaults |
| Consent reminder timing | consent.ts | covered by 4 tests | 24h window + enterprise force |

## 3. Coverage gaps (0% — and why)

| File | Why 0% | Compensating control | Residual risk |
|------|--------|----------------------|---------------|
| `main/index.ts` (IPC handlers, `requireAuth`+`assertMainWindow` on every privileged handler) | needs live Electron `ipcMain`/`BrowserWindow` | code-read verified: every handler calls `assertMainWindow(e)` and privileged ones call `requireAuth()`; injection guard checked by selftest | **HIGH** — the trust-boundary enforcement has no automated regression test |
| `main/auth.ts` (Azure MSAL, tenant+domain lock, `requireAuth`) | needs MSAL + loopback server + Electron `safeStorage` | manual M5 | MEDIUM — auth-bypass regressions wouldn't be caught by CI |
| `main/llm.ts` (Anthropic/OpenAI/Dust streaming, abort/settled guards) | needs network + SDKs | manual M3 | MEDIUM — provider-down / double-emit paths untested |
| `main/recall.ts` (list/search) | reads real folder | none | LOW — pure-ish, but synchronous full-folder scan untested at scale |
| `main/updater.ts`, `platform-perms.ts`, `meeting-detect/mac.ts`, `preload/index.ts` | Electron/OS bound | manual | LOW |

## 4. Encryption-test caveat (important)
`store.test.ts` and `transcripts.test.ts` assert "encrypted at rest" against the **mocked** `safeStorage`
in `__mocks__/electron.ts` (`encryptString` = `Buffer.from('enc:'+v)`). This validates the **marker
logic and the no-plaintext invariant in code**, but does **not** exercise real OS keychain crypto. Real
crypto is only indirectly touched by the manual M6 flow and the in-Electron `selftest.ts`.

## 5. Recommendations (priority order)
1. **Add Electron-runtime IPC tests** (e.g. via Playwright `_electron` or `electron-mocha`) asserting
   `assertMainWindow` rejects non-main frames and `requireAuth` blocks privileged handlers when SSO is
   configured-and-signed-out. This closes the highest-risk 0% (index.ts/auth.ts).
2. **Wire `selftest.ts` into CI** on `macos-latest` — it already exercises the managed-config repair,
   transcript save, injection guard, and provider-traversal rejection in the real runtime.
3. Add renderer-component tests (jsdom + RTL) for `useAsk` rAF batching and Copilot state machine.
4. Raise a coverage floor only on the pure modules (`routing`, `dustcli`, `transcripts`, `store`,
   `graphify`, `personas`, `ipc`, `consent`) so the headline glue % doesn't mask regressions there.
