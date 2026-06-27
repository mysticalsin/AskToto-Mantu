# AskToto — QA Test Plan

Owner: QA automation + reliability review · Date: 2026-06-27 · Gate scope: **Gate 9 (QA)**, **Gate 10 (Perf/Reliability)**

AskToto is a **local Electron desktop app** (macOS + Windows). There is no server, no API tier, no
multi-tenant backend. The QA strategy is therefore: deterministic unit tests over the pure logic that
sits at the trust boundary, an in-Electron smoke harness for runtime-bound code, and a documented
manual matrix for the one flow that needs real hardware (mic + screen-recording).

## 1. Objectives

1. Prove the three release gates are green and reproducible: `typecheck`, `test`, `build`.
2. Verify the security-critical pure logic is unit-tested: settings layering + encryption marker,
   provider/path validation, IPC schema validation, model routing, transcript serialization + YAML
   safety, Dust CLI keychain mapping, graph `computeRelated`, consent timing.
3. Identify and register the coverage gaps that cannot be unit-tested without an Electron runtime or
   real hardware, and define the manual procedure that covers them.
4. Catalogue flaky / environment-dependent tests so CI is deterministic.

## 2. Test levels & tooling

| Level | Tool | What it covers | Where |
|-------|------|----------------|-------|
| Static type | `tsc --noEmit` (node + web projects) | whole codebase | `npm run typecheck` |
| Unit | Vitest 4.1.9 (`environment: node`) | `src/main`, `src/shared`, `src/preload`, renderer `lib` | `npm test` (10 files, 59 tests) |
| Coverage | `@vitest/coverage-v8` | same include set | `npx vitest run --coverage` |
| In-Electron smoke | `selftest.ts` via `ASKTOTO_SELFTEST=<out.json>` | real main-process logic in the Electron runtime (settings repair, transcript save, model resolve, injection guard, provider validation) | manual / packaging step |
| Renderer screenshot | `ASKTOTO_SHOT` + `ASKTOTO_DEMO` env, `win.capturePage()` | visual smoke of overlay surfaces | manual / Playwright `_electron` harness in scratchpad |
| Supply chain | `npm audit` | dependency CVEs | manual / CI candidate |
| Manual hardware | tester + real mic/display | live listen → transcribe → save → recap | manual matrix (§6) |

The Electron API is stubbed for unit tests by `__mocks__/electron.ts` (mocks `app.getPath`,
`safeStorage` with an `enc:` prefix, `desktopCapturer`, `ipcMain`, `BrowserWindow`). This lets
`store.ts` and `transcripts.ts` run headless — but note the encryption tests exercise the **code path
and marker logic, not real OS keychain crypto** (see COVERAGE_REPORT.md).

## 3. Unit-test inventory (target → file)

- `src/shared/ipc.test.ts` (10) — `AskStartSchema` image size/base64 rejection; `SettingsSchema`
  custom-provider https enforcement; consent/recording defaults.
- `src/shared/routing.test.ts` (9) — `isHardQuestion`, `routeTier` (suggest=base, recap=think,
  always/never override), `resolveModelTier` provider defaults + user override.
- `src/main/store.test.ts` (5) — default<managed<user layering; locked-key drop; **encryption at rest**
  (context docs + profile not plaintext); legacy plaintext migration; malformed-key tolerance.
- `src/main/transcripts.test.ts` (6) — encrypt round-trip via `readSavedFile`; plaintext+index default;
  YAML title sanitization (quotes, newlines, control chars); dated slug path; filename dedupe.
- `src/main/personas.test.ts` (4) — multilingual language policy (`suggest` mirrors speaker; `recap`/
  `answer` use output language; `auto` falls back).
- `src/main/graphify.test.ts` (3) — `computeRelated` 1-hop/2-hop, symmetry, absent-note safe-empty.
- `src/main/dustcli.test.ts` (4) — **real macOS keychain** round-trip + EU/US region→baseURL mapping
  (gated `runIf(isMac)`; uses a throwaway service so the user's real session is untouched).
- `src/main/meeting-detect/shared.test.ts` (4) + `win.test.ts` (12) — meeting-title / native-window
  matching across Zoom/Teams/Slack/Webex incl. chat-only rejection.
- `src/renderer/src/lib/consent.test.ts` (4) — `shouldShowConsentReminder` 24h window + enterprise force.

## 4. Entry criteria
- `npm ci` clean; Node 20 (CI) / local Node.
- macOS for the full suite (dustcli keychain tests are macOS-gated and need keychain write access).

## 5. Exit / release criteria (gate pass)
- `npm run typecheck` exit 0.
- `npm test` **59/59 pass on a real macOS host** (keychain available). A sandboxed/headless runner that
  blocks keychain writes will fail 3 dustcli tests — this is an environment limitation, see
  FLAKY_TEST_REGISTER.md; CI must run on `macos-latest` with keychain access or the tests must be
  refactored to mock `security`.
- `npm run build` exit 0, all three bundles emitted.
- No new CRITICAL/HIGH finding open against the trust boundary.
- Coverage of pure security/routing logic stays ≥ its current level (routing 96%, dustcli 94%,
  transcripts 62%, store 47%) — see COVERAGE_REPORT.md.

## 6. Manual / hardware matrix (the unit suite cannot reach these)

| ID | Flow | Steps | Pass condition |
|----|------|-------|----------------|
| M1 | Live Listen E2E | Start Listen (mic+system) → speak a question → observe live transcript + auto-answer → Stop → Save | transcript file written with frontmatter `status: ready-for-followup`; recap generated |
| M2 | First-run model fetch | Fresh profile, first Listen | Whisper ONNX downloads from HF CDN, worker posts `ready`; if offline → clean worker error, mic still captured |
| M3 | Bad key degradation | Set an invalid provider key → Ask | `streamError` with actionable message, no crash |
| M4 | System-audio denied | Deny Screen Recording → Listen both | degrades to mic-only with a clear banner (listen.ts) |
| M5 | Azure SSO lock | Configure tenant+domain → sign in with out-of-domain account | rejected with `Use your @<domain> account` |
| M6 | Encrypted transcript open | Enable encrypt → save → Recall → open | opens decrypted temp copy; on-disk file carries `ATKENC1` marker |
| M7 | Settings round-trip resize | Open/close Settings repeatedly | window keeps resizing (callback-ref ResizeObserver) |

## 7. Risks to test validity
- Unit suite runs `environment: node`; **no jsdom/RTL** → zero renderer-component tests (App, Copilot,
  Settings render paths untested).
- `selftest.ts` is **not** part of `npm test` and **not** invoked by CI — its ~20 assertions only run if
  someone launches the packaged app with `ASKTOTO_SELFTEST`. It should be wired into CI on `macos-latest`.
- Shared fixed userData path (`/tmp/asktoto-test-userdata`) is reused by store/transcripts tests — see
  FLAKY_TEST_REGISTER.md for the parallel-collision risk.
