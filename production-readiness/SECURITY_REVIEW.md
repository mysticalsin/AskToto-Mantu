# AskToto — Security Review

App: AskToto v0.1.0 — local Electron desktop overlay (macOS + Windows), single user, local-first.
Date: 2026-06-27. Consolidated security verdict across the 7 audit domains. Evidence is real file:line + commands re-run this cycle (see EVIDENCE_INDEX.md). Cross-references THREAT_MODEL.md and RISK_REGISTER.md.

## 1. Executive security summary

AskToto's security architecture is, at the design level, strong and senior-grade for a local Electron app. The renderer↔main trust boundary is correctly drawn and consistently enforced: sandbox + contextIsolation + nodeIntegration-off + webSecurity-on, every privileged IPC handler gated by `assertMainWindow()`, data channels additionally gated by `requireAuth()`, all payloads zod-validated, all child processes spawned via `execFile` (no shell), and no secret ever crossing to the renderer.

The security gaps are NOT in the boundary code — they are in three areas a code-read alone wouldn't flag: (1) data-at-rest and cloud replication (plaintext transcripts default-synced to OneDrive and sent to a third-party LLM), (2) software-supply-chain and release integrity (unsigned artifacts, a known-vulnerable shipped Electron, no SCA/SBOM gate, no real update channel), and (3) a fail-open default auth posture. None is a confirmed precondition-free remote RCE, but several are hard blockers for a trusted, distributable, sensitive-data release.

Net: 0 critical, 13 high, 33 medium, 28 low. The app is usable as a personal tool today; it is NOT ready for trusted distribution or sensitive-data production without the remediations below.

## 2. What is genuinely strong (verified PASS)

- Renderer trust boundary — index.ts:155-162 sets sandbox:true, contextIsolation:true, nodeIntegration:false, webSecurity:true; grep confirms no insecure webPreferences anywhere in src/. Preload exposes only `window.toto` (preload/index.ts:85).
- IPC authorization — 32/32 `ipcMain.handle` handlers call `assertMainWindow()` as the first statement (index.ts:83-92); 15 data/privileged channels add `requireAuth()` (index.ts:422-646). Subframes, devtools, and foreign webContents are rejected.
- Input validation — every IPC payload passes a zod schema (AskStart with image ≤5.5MB + charset bound, Set/Clear/TestApiKey, SaveMeeting/SaveNote; settings:set via validKeysOnly safeParse) — ipc.ts:118-362, store.ts:45-54.
- No shell injection — graphify/dustcli/meeting-detect all use `execFile` with argv arrays and static scripts (graphify.ts:211, dustcli.ts:31, mac.ts:143, win.ts:44). API key passed via GRAPHIFY_API_KEY env, not argv.
- Path-traversal safe — recall:open uses `join(folder, basename(file))` (index.ts:648); selftest proves ProviderIdSchema rejects `../../etc/passwd`.
- Secrets — provider keys/settings/session encrypted via Electron safeStorage at 0o600; API-key save hard-refuses if encryption is unavailable (store.ts:195-201). Keys never reach the renderer (PublicSettings booleans only). grep of out/ found no key-shaped strings; `strings app.asar | grep` found only detection patterns, not live secrets.
- Navigation hardening — window.open denied, openExternal https-only, will-navigate preventDefault for any non-current URL (index.ts:176-182).
- CSP — default-src 'self'; script-src has no unsafe-inline/eval (only wasm-unsafe-eval); object/frame-src/form-action 'none'; connect-src explicit host allowlist (index.html:7-10).
- Content protection — setContentProtection on by default and re-applied on settings change (index.ts:69-72,167) — the load-bearing screen-capture privacy control.
- Streaming robustness — exactly one of onDone/onError per stream; abort race closed; graphify build-lock set before any await (llm.ts:115-263, graphify.ts:194-198).
- Azure SSO (when configured) — authority pinned to tenant, tid check, domain endsWith lock, PKCE S256, managed-config cannot be loosened from UI (auth.ts:167,227-232,47-99).
- OAuth loopback — only inbound socket; 127.0.0.1 random ephemeral port, single request, 300s timeout, PKCE-protected, closes immediately (auth.ts:194-213).

## 3. Confirmed weaknesses by category

### 3.1 Authentication / authorization
- HIGH R-01 — Fail-open default auth. `requireAuth()` returns true when Entra SSO is unconfigured (auth.ts:152-154). In the default build there is no app-level identity gate over capture / transcripts / recall / keys — only the OS account. Intentional for single-user dev; a HIGH gap for sensitive-data production unless Entra is configured AND locked via machine-wide managed-config. Enforcement in prod is currently UNKNOWN (R-02) because no managed-config is deployed to test against.

### 3.2 Data protection / cryptography
- HIGH R-08 — Transcripts plaintext by default + OneDrive-synced + LLM egress. encryptTranscripts defaults false (ipc.ts:188,264); the default notes folder is OneDrive-synced (transcripts.ts:146-150). Client-confidential content is cloud-replicated and sent to a third-party LLM with no enforced DPA. The single most likely real-world exposure.
- MEDIUM R-09 — decryptToTemp writes decrypted plaintext to OS temp with a predictable name, no 0o600, no cleanup (transcripts.ts:64-69).
- MEDIUM R-19 — settings/PII silently fall back to plaintext when keychain is unavailable, unlike API keys which fail-closed (store.ts, finding F3).
- Strong baseline otherwise: keys and session fail-closed-encrypted; atomic 0o600 writes.

### 3.3 Supply chain & release integrity
- HIGH R-13 — Unsigned / not notarized. codesign shows adhoc, no TeamIdentifier; spctl → Gatekeeper rejects; win.verifyUpdateCodeSignature:false; CI sets ASKTOTO_DISABLE_CP=1 (electron-builder.yml:32,47). Mechanism is wired (docs/SIGNING.md, env-driven CSC_LINK/APPLE_*) but credentials are not configured.
- HIGH R-15 — Electron 33.4.11 shipped with known RCE-class + ASAR-integrity advisories, mis-classed as a devDependency so hidden by `npm audit --omit=dev`.
- HIGH R-05 — Whisper ONNX model + onnxruntime WASM fetched from HF/jsDelivr with no revision pin and no SRI (whisper.worker.ts:2-19). Plus 9 prod advisories (5 high) transitive under @dust-tt/client → @modelcontextprotocol/sdk → express/qs/path-to-regexp/ajv (the MCP/express server paths are not on AskToto's reachable client path → real-world MEDIUM, but un-remediated).
- HIGH R-14 — No CI SCA/secret-scan/SAST/SBOM gate, and the repo is not git-initialised so build.yml has never executed. No dependabot/renovate.
- HIGH R-16 — No real update channel (publish.url placeholder; updater self-disables) and, once wired, updates would be protected by TLS+sha512 only, not signature, until R-13 is fixed. autoDownload + autoInstallOnAppQuit are true, so a bad release would auto-propagate.
- Positive: package-lock pins the full tree; CI uses `npm ci`; no live secrets in artifacts; execFile-only external process model.

### 3.4 Frontend / renderer
- MEDIUM R-04 — No setPermissionRequestHandler/setPermissionCheckHandler → Electron default-grants permission classes (F1).
- MEDIUM R-03 — Default glass contrast ~2.9:1 fails WCAG 1.4.3 AA (security-adjacent only insofar as it blocks an accessible, trustworthy release).
- Positive: only one HTML sink (CodeBlock.tsx:115) fed by escaping shiki output; markdown via streamdown AST with no raw-HTML passthrough; no client-side secret storage.

### 3.5 Robustness / DoS
- MEDIUM R-06 — No LLM stream timeout (llm.ts) → resource leak + stuck spinner on a hung provider.
- MEDIUM R-07 — Synchronous fs on the IPC thread (recall.ts:51-88) blocks the UI on large folders.
- MEDIUM R-20 — No global uncaughtException/unhandledRejection/crashReporter in main.

### 3.6 Network
- PASS for transport: HTTPS-only via maintained SDKs, no rejectUnauthorized:false, custom URL forced https (store.ts:152). No cert pinning (acceptable desktop trade-off, LOW).
- UNKNOWN R-12 — main-process SDK egress is not allowlist-constrained; a "custom" provider can reach any HTTPS host. Should be locked via managed-config + org proxy for enterprise use.

## 4. Justified N/A surfaces

No inbound HTTP/REST/gRPC server (no API auth/CORS/rate-limit/WAF/HSTS to assess); no database (no SQLi); no container/orchestration/registry; no cloud IAM/load balancer/multi-tenant isolation. Each verified by find/grep returning nothing (see EVIDENCE_INDEX.md). These are genuine absences for a local desktop app, not unassessed gaps.

## 5. Verification performed this cycle

- `npm run typecheck` → exit 0 (node + web TS projects clean).
- `npx vitest run` → 59/59 on a real macOS host (3 in-sandbox dustcli keychain tests fail only because `security add-generic-password` is blocked by the command sandbox — environment limitation, re-ran 4/4 PASS unsandboxed).
- `npm run build` → exit 0; renderer 3.73MB + whisper.worker 2.0MB + ort-wasm 21.6MB.
- `npm audit --omit=dev` → 9 vulns (5 high, 4 moderate, 0 critical); full tree 27 (16 high, 11 moderate).
- Electron locked version confirmed 33.4.11 via package-lock.
- Signing: codesign/spctl confirm adhoc/unnotarized; electron-builder.yml verifyUpdateCodeSignature:false, publish.url placeholder confirmed.
- grep confirms no setPermissionRequestHandler, no insecure webPreferences, no createServer/listen beyond the OAuth loopback, no localStorage/sessionStorage/indexedDB in src/.

## 6. Security gate decision

The boundary code passes. The release does not — blocked by R-13 (unsigned), R-15 (vulnerable Electron), R-14 (no CI security gate / not git-init), R-16 (no signed update channel), R-08 (plaintext cloud-replicated sensitive data), and R-01 (fail-open auth for sensitive-data use). See PRODUCTION_READINESS_REPORT.md for the verdict, the 30/60/90 remediation plan, and the required human approvals.
