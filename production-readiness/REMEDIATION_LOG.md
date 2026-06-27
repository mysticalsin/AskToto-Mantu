# Remediation Log — post-audit fixes

Tracks code fixes applied immediately after the production-readiness audit (2026-06-27). Verified with
`npm run typecheck` + `npm test` (59/59) + `npm run build` + the Playwright `_electron` harness (18/18,
zero page errors). Cross-references RELEASE_GATE_MATRIX.md and RISK_REGISTER.md.

## Fixed this pass (code, verified)

| Risk | Fix | File | Evidence |
|---|---|---|---|
| R-04 (Gate 3) Permission requests not handled | Deny-by-default `setPermissionRequestHandler` + `setPermissionCheckHandler`; only the main window may use audio media (Listen mic). All other web permissions rejected. | src/main/index.ts (after `setDisplayMediaRequestHandler`) | typecheck + harness pass |
| Gate 11 No process crash handlers | `process.on('uncaughtException')` + `unhandledRejection` (log + stay alive). No crashReporter upload by design (zero telemetry). | src/main/index.ts (whenReady) | typecheck + harness pass |
| R-01 Fail-open auth | `ASKTOTO_REQUIRE_AUTH` (env or managed-config `requireAuth:true`) makes `requireAuth()` fail-closed — privileged IPC blocked until signed in, even when SSO is unconfigured. | src/main/auth.ts `authEnforced()` | typecheck pass; off by default (single-user) |
| R-09 Decrypted-temp transcript world-readable | `decryptToTemp` writes the temp copy `0o600`. | src/main/transcripts.ts | typecheck pass |
| R-14 (partial) No CI security gate | Added a `security` job to build.yml: `npm audit` (block on critical, report high), inline secret scan (key-shape grep), CycloneDX SBOM artifact. macOS/Windows packaging now `needs: [quality, security]`. | .github/workflows/build.yml | workflow file |
| R-05 (partial) Supply chain | `npm audit fix` applied; `@dust-tt/client` bumped to ^1.2.6. | package.json | `npm audit` re-run |

Note: the 12 remaining "high" npm advisories are transitive under `@dust-tt/client`
(express/router/path-to-regexp/qs) and the MCP SDK. AskToto runs **no inbound HTTP or MCP server**, so
those code paths are never reached — the adversarial review rated them LOW exploitability. The CI gate
blocks on CRITICAL and reports HIGH; escalate to block-on-high once `@dust-tt/client` ships a patched
express.

## Fixed — pass 2 (code, verified: typecheck + 63 tests + build + harness 18/18)

| Risk | Fix | File | Evidence |
|---|---|---|---|
| R-06 No stream idle timeout | `idleWatchdog` (120s) on all three stream branches (Anthropic / OpenAI-compat / Dust) — aborts a hung provider, pings on each token, clears on done/error/abort. | src/main/llm.ts | typecheck + 63 tests |
| R-07 Sync fs on the IPC/main thread | recall.ts list/search → `fs/promises` (each file read once, off the event loop); transcripts.ts `writeSaved`/`saveMeeting`/`saveNote` → async (`writeFile`/`rename`/`unlink`); IPC handlers + selftest + tests awaited. | src/main/recall.ts, transcripts.ts, index.ts, selftest.ts | harness 18/18 (live recall + Related) |
| R-03 Contrast < 4.5:1 on glass | Muted text bumped: `--color-ink-3` 0.62→0.74, `--cl-muted-foreground` #b9a7d4→#cdbfe3 (≥AA). | src/renderer/src/styles.css | build |
| (low) Spinner ignores reduced-motion | Reduced-motion swaps the spin for an opacity pulse (still signals loading); spinner gains `role="status"` + `aria-label`. | styles.css, components/ui.tsx | build |
| R-17 IPC/auth boundary 0% coverage | `auth.test.ts`: requireAuth fail-open default, fail-closed via env + managed-config, configured+signed-out blocked (4 tests). | src/main/auth.test.ts | vitest 4/4 |
R-15 (Electron 33.4.11 EOL) — **ATTEMPTED, REVERTED, still OPEN.** Bumped Electron 33→37.10.3 +
electron-vite 2→3 + electron-builder 25→26: typecheck + build + 63 tests passed, BUT the Playwright
`_electron` harness could not drive Electron 37 (`electron.launch: Timeout 180000ms` — the app process
launched and DevTools attached, but Playwright's CDP handshake never completed). The app may well run, but
it could not be runtime-verified here, so it was reverted to the known-good Electron 33.4.11. Reaching a
*supported* major also forces vite 5→7 + plugin-react 4→5. **R-15 needs a dedicated migration**: bump
Electron to 42 + the vite-7 toolchain + Playwright (so the harness works again) + a real-hardware runtime
pass (mic capture, screen capture, content protection, loopback OAuth, signed-build smoke). Kept from this
attempt: `@dust-tt/client`→1.2.6 + `npm audit fix`.

## Deferred — needs a dedicated, fully-tested pass (code)

| Risk | Why deferred |
|---|---|
| R-15 Electron 33.4.11 (EOL) → 42.x | 33.x is end-of-line; the upgrade also forces electron-vite 2→5 (config-breaking) and electron-builder 25→26. A 9-major jump must be runtime-tested (window flags, safeStorage, loopback capture, content protection) on real hardware before shipping — not bundled into a hardening pass. Practical exploitability is lower for this CSP-locked, no-remote-content renderer than a browser, but it must be done. |
| R-07 Sync fs on the IPC/main thread | recall.ts list/search + transcripts.ts writes are synchronous. Async refactor ripples through the IPC handlers, selftest, and tests; do it as one focused change. |
| R-03 Contrast < 4.5:1 on frosted glass | Needs an opaque text-surface token + a contrast re-measure across all components. |
| R-06 No stream idle timeout | Add `AbortSignal.timeout` to the LLM streams (llm.ts). |
| R-17 IPC/auth trust-boundary 0% test coverage | Add Playwright `_electron` tests asserting `assertMainWindow` rejects foreign senders and `requireAuth` blocks when SSO is configured + signed out; wire `selftest.ts` into CI. |

## Blocked — requires human action (no code can resolve)

| Risk | Owner | Action |
|---|---|---|
| R-13 Unsigned / unnotarized installers | Tony + Mantu IT | Apple Developer ID cert + notarization creds (CSC_LINK / APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / team id); Windows Authenticode or Azure Trusted Signing + a Windows signing runner. |
| R-14 Not a git repo / no branch protection | Tony | `git init` + push to a hosted remote + branch protection (required reviews + required CI checks). |
| R-16 No signed update channel | Tony + IT | Real HTTPS publish host, wired only AFTER signing; set `verifyUpdateCodeSignature: true`. |
| R-08 Plaintext transcripts → OneDrive + LLM egress | Tony + DPO | Decide: force `encryptTranscripts:true` via managed-config and/or point the notes folder outside OneDrive; DPIA sign-off; DPAs with the LLM provider, Microsoft, Hugging Face, Dust. |
| R-01 Azure SSO enforcement | Tony + IT | Decide fail-closed (deploy managed-config `azure.{clientId,tenantId,allowedDomain}` + `requireAuth:true` / `ASKTOTO_REQUIRE_AUTH=1`) vs accept fail-open for single-user. |
