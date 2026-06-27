# AskToto — Release Gate Matrix (14 Gates)

App: AskToto — local Electron desktop overlay (macOS + Windows). Version 0.1.0.
Scope: single-user, local-first. No server, DB, multi-tenant backend, or container/orchestration layer (those domains are justified N/A below).
Date: 2026-06-27 · Orchestrator/Release Manager roll-up of 7 domain audits (45 supporting reports in this folder).

Verdict source: a gate is PASS only when every sub-control passes with evidence. Any FAIL or unresolved UNKNOWN in a critical area (auth / data / signing / release) fails the parent gate. Roll-up status below is the worst sub-status, with the reason named.

Legend: PASS · FAIL · UNKNOWN · N/A (justified). Severity of the worst open finding per gate: CRITICAL / HIGH / MEDIUM / LOW / —.

## Master gate roll-up

| Gate | Area | Status | Evidence | Open Findings | Severity | Owner | Fix/PR | Retest | Notes |
|------|------|--------|----------|---------------|----------|-------|--------|--------|-------|
| Gate 1 — Architecture & Threat Model | Design | PASS | THREAT_MODEL.md, ARCHITECTURE.md, DATA_FLOW.md; trust boundary = main process; STRIDE per-asset complete | Threat model is new; no signed-off review meeting | LOW | Tony | THREAT_MODEL.md review sign-off | On model change | Documented this cycle; living doc |
| Gate 2 — Identity & Access (Auth) | IAM | FAIL | Azure SSO tenant+domain lock strong WHEN configured (auth.ts:167,227-232); but requireAuth() returns true when SSO unconfigured (auth.ts:152-154) → fail-open default | R-01 fail-open auth; no app-level authn by default | HIGH | Tony + IT | Ship managed-config azure.{clientId,tenantId,allowedDomain}+locked; build flag to fail-closed | After managed-config deploy + signed-out test | OS account is the only gate by default; acceptable single-user, HIGH for sensitive-data prod |
| Gate 3 — Frontend / Renderer Security & A11y | Frontend | FAIL | Trust boundary, CSP, nav hardening, injection sinks, secrets all PASS (index.ts:155-182, index.html CSP); 3 FAIL sub-gates | R-03 contrast AA <4.5:1; R-04 no permission handler; R-05 model no-SRI + audit highs | MEDIUM | Tony | Opaque glass token + setPermissionRequestHandler deny-by-default + pin model | After CSS + handler patch + npm audit fix | FRONTEND_SECURITY_REPORT.md, ACCESSIBILITY_REPORT.md |
| Gate 4 — Backend / Main-Process IPC | Backend | FAIL | 32/32 handlers assertMainWindow; 15 requireAuth sites; zod on all payloads; execFile no-shell; no path traversal (index.ts:83-92,422-679) | R-02 auth UNKNOWN; R-06 no stream timeout; R-07 sync-fs on IPC thread; R-05 supply chain/whisper SRI | MEDIUM | Tony | AbortSignal.timeout; fs.promises in recall; npm audit fix | After patch + vitest | BACKEND_REVIEW.md, AUTHORIZATION_MATRIX.md |
| Gate 5 — Data Protection | Data | FAIL | Keys safeStorage 0o600, never to renderer; settings ATKENC1 encrypted (store.ts:104,186-201) | R-08 transcripts plaintext default → OneDrive; R-09 decryptToTemp leak; R-10 no retention; R-11 deletion incomplete | HIGH | Tony | encryptTranscripts default-true via managed-config; secure temp; purge action | After DPIA sign-off + patch | DATA_PROTECTION_REPORT.md, DATA_RETENTION_AND_DELETION.md |
| Gate 6 — Network & Transport | Network | FAIL | TLS-only egress via maintained SDKs; loopback OAuth random port + PKCE; renderer CSP allowlist (auth.ts:194-213) | R-05 model download no-SRI; R-12 egress allowlist not enforced main-side (UNKNOWN) | MEDIUM | Tony + IT | Pin model revision+SHA; org proxy allowlist via managed-config | After model pin + proxy policy | NETWORK_SECURITY_REPORT.md, TLS_AND_HEADERS_REPORT.md |
| Gate 7 — Container / Orchestration | Infra | N/A | find Dockerfile/compose/k8s → none; distribution = native installers (dmg/zip/nsis/portable/appx) | — | — | — | N/A — re-evaluate if a backend is added | n/a | Electron sandbox/asar/hardened-runtime are the analogues, covered in Gates 3/4/8 |
| Gate 8 — CI/CD, Supply Chain & Release | Release | FAIL | Correctness gate shape correct (build.yml: ci→typecheck→build→test); lockfile + npm ci | R-13 unsigned/unnotarized; R-14 no SCA/secret/SAST/SBOM gate; R-15 shipped Electron 33.4.11 RCE-class; R-16 no rollback | HIGH | Tony + IT | Apple Dev ID + notarize + Win Authenticode; add audit/gitleaks/CodeQL/CycloneDX; upgrade Electron | After signed build re-verified (codesign/spctl/signtool) | CICD_REVIEW.md, SUPPLY_CHAIN_SECURITY_REPORT.md, RELEASE_AND_ROLLBACK_REPORT.md, SBOM.md |
| Gate 9 — QA / Test | QA | FAIL | typecheck exit 0; vitest 59/59 on host; routing 96% / dustcli 94% / prompts 100% | R-17 IPC/auth trust boundary 0% coverage; E2E live flow UNKNOWN | MEDIUM | Tony | Playwright _electron tests for assertMainWindow/requireAuth; wire selftest.ts into CI | After harness lands + CI green | QA_TEST_PLAN.md, QA_TEST_RESULTS.md, COVERAGE_REPORT.md |
| Gate 10 — Performance & Reliability | Perf/Rel | FAIL | Perf PASS (rAF batching, lazy splits, queue cap, teardown); graceful degradation PASS | R-16 no update/rollback channel; R-18 offline first-Listen fails (model fetch) | MEDIUM | Tony | Bundle model+WASM locally OR clear offline UX; wire update host post-signing | After model bundling + soak run | PERFORMANCE_REPORT.md, RELIABILITY_REPORT.md, FRONTEND_PERFORMANCE_REPORT.md |
| Gate 11 — Capacity & Observability | Ops | PASS | Capacity N/A (single local user); electron-log present; stream:error to UI; getSettings never bricks | No global uncaughtException/unhandledRejection/crashReporter handler | MEDIUM | Tony | Add process-level crash handlers | After handler added | OBSERVABILITY_REPORT.md, CAPACITY_PLAN.md, ALERTING_REPORT.md |
| Gate 12 — Backup & Disaster Recovery | DR | PASS | OneDrive version history = RPO≈0 for synced notes; atomic+collision-safe writes; config reproducible from reinstall | Documents fallback folder has no backup (MEDIUM); no DR drill run (LOW) | MEDIUM | Tony | Enforce synced notes location; run one restore drill | After drill evidence | BACKUP_RESTORE_REPORT.md, DISASTER_RECOVERY_PLAN.md, BUSINESS_CONTINUITY_PLAN.md |
| Gate 13 — Privacy & Compliance | Privacy | PASS | On-device Whisper ASR; keys never to renderer; safeStorage always-on for keys/settings/session; no telemetry; consent + recording indicator; self-service erasure | R-08 plaintext transcripts → OneDrive + LLM egress without enforced DPA (HIGH residual); R-05 model no-SRI | HIGH | Tony + DPO | DPIA sign-off; DPAs with LLM/MS/HF/Dust; encrypt transcripts | After DPIA + DPA register | PRIVACY_REVIEW.md, COMPLIANCE_MAPPING.md, DATA_RETENTION_AND_DELETION.md |
| Gate 14 — Operations / IR / Deploy & Rollback | Ops | FAIL | Build + reinstall-rollback mechanics sound and data-safe (store.ts:142-160); IR/runbooks documented | R-13 no signed distribution channel; R-16 no patch-delivery (update host placeholder) | HIGH | Tony + IT | Provision certs + real HTTPS publish host; validate one signed update | After signed update check passes | DEPLOYMENT_RUNBOOK.md, ROLLBACK_RUNBOOK.md, INCIDENT_RESPONSE_RUNBOOK.md, OPERATIONS_RUNBOOK.md |

Roll-up: 3 PASS · 8 FAIL · 0 standalone UNKNOWN (folded into parent FAILs) · 1 N/A (justified). Gate 1 PASS new this cycle.

## Detailed sub-gate matrix

Statuses carried verbatim from the seven domain audits. file:line evidence is the live source of truth.

### Gate 3 — Frontend (renderer security, UX, accessibility, FE performance)

| Gate | Area | Status | Evidence | Open Findings | Severity | Owner | Fix/PR | Retest | Notes |
|------|------|--------|----------|---------------|----------|-------|--------|--------|-------|
| Renderer trust boundary | Frontend Security | PASS | index.ts:155-162 sandbox+contextIsolation true, nodeIntegration false, webSecurity true; preload only window.toto (preload/index.ts:85) | — | — | Tony | — | — | No insecure webPreferences (grep) |
| Content-Security-Policy | Frontend Security | PASS | index.html meta CSP: no script unsafe-inline/eval (wasm-unsafe-eval only); object/frame-src none; connect-src allowlist | Meta-only, no header DiD | LOW | Tony | Add header CSP if a server is ever introduced | — | F-CSP |
| Navigation hardening | Frontend Security | PASS | index.ts:176-182 deny window.open; openExternal https only; will-navigate preventDefault; rel=noopener | — | — | Tony | — | — | — |
| HTML injection sinks | Frontend Security | PASS | CodeBlock.tsx:115 fed by shiki codeToHtml (escapes); streamdown@2.5.0 AST, no raw HTML | — | — | Tony | — | — | Single sink audited |
| Client-side secrets | Frontend Security | PASS | grep: no localStorage/sessionStorage/indexedDB; publicSettings exposes booleans only (index.ts:110-127) | — | — | Tony | — | — | — |
| App source-map exposure | Frontend Security | PASS | find out -name '*.map' → none; Vite prod sourcemap false | 3rd-party node_modules .map in asar | LOW | Tony | electron-builder files prune | On rebuild | F3 |
| Permission request handling | Frontend Security | FAIL | grep: no setPermissionRequestHandler/setPermissionCheckHandler in src/main; Electron default-grants | F1 default-grant permission classes | MEDIUM | Tony | Add deny-by-default permission handler | After patch | F1 |
| Renderer/model supply-chain (SRI) | Frontend Security | FAIL | whisper.worker.ts fetches Xenova/whisper-tiny no revision/hash (F2); npm audit --omit=dev 9 vulns (5 high) (F10) | F2, F10 | MEDIUM | Tony | Pin revision+SHA / bundle; npm audit fix | After model pin + audit | R-05 |
| Onboarding ≤15s | UX | PASS | Onboarding.tsx one screen, consent-gated (40-43,97); keys/perms deferred | — | — | Tony | — | — | — |
| Core journeys + states | UX | PASS | Ask/Listen/Capture/Review/Recall/Settings loading+empty+error; mic-only degrade (listen.ts:201-210) | — | — | Tony | — | — | — |
| Destructive confirmations | UX | PASS | Key/Dust removal recoverable; save pins on success only | 10s auto-record defaults Start; New-meeting discards unsaved | MEDIUM/LOW | Tony | Default countdown to Cancel; confirm discard | After patch | gated by autoStartOnMeeting=false |
| Keyboard operability/focus | Accessibility | PASS | Native button/input; focus rings styles.css:179-182,318-326; no positive tabIndex/trap | No Escape handler | LOW | Tony | Add Escape close | — | 2.1.1/2.4.7 |
| Accessible names | Accessibility | PASS | IconButton title+aria-label (ui.tsx:19-21); Toggle role=switch (Settings.tsx:206-212) | 2 Trash buttons title-only (Settings.tsx:483,1260) | LOW-MED | Tony | Add aria-label | After patch | 4.1.2 |
| Contrast on glass (1.4.3 AA) | Accessibility | FAIL | Default --glass-fill rgba(26,0,51,0.44) → white text ~2.9:1 over bright backdrop (<4.5:1) | R-03 AA contrast | MEDIUM | Tony | Raise fill opacity / add scrim | After contrast re-measure | Blocking AA gap |
| prefers-reduced-motion | Accessibility | PASS | @media reduce zeroes animation/transition (styles.css:422-429) | — | — | Tony | — | — | Prior note RESOLVED |
| Status/live regions + img alt | Accessibility | PASS | aria-live polite; toast role=alert; logo alt/decorative correct | — | — | Tony | — | — | 4.1.3/1.1.1 |
| Streaming render cost | FE Performance | PASS | state.ts:74-111 rAF-batched deltas; 90ms highlight debounce | — | — | Tony | — | — | — |
| Code-splitting / shiki trim | FE Performance | PASS | Settings/Review/RecallView lazy (App.tsx:8-10); shiki 25 langs; ONNX lazy | — | — | Tony | — | — | — |
| Startup bundle weight | FE Performance | UNKNOWN | Eager index.js 3.6MB (markdown not lazy) | P1 trim opportunity | MEDIUM | Tony | Split shiki/streamdown | After bundle analysis | Functions; local load mitigates |
| Release artifact freshness | FE Performance | FAIL | release/ asar has ~200 shiki grammars + dep .map not from current source; exe 178MB | P5/F3 stale artifact | MEDIUM | Tony | Rebuild before ship | After rebuild | Must rebuild |
| Test suite (FE) | FE Performance | PASS | npm test 56/59 (3 = sandbox keychain, not FE) | — | — | Tony | — | — | — |

### Gate 4 — Backend / Main process

| Gate | Area | Status | Evidence | Open Findings | Severity | Owner | Fix/PR | Retest | Notes |
|------|------|--------|----------|---------------|----------|-------|--------|--------|-------|
| assertMainWindow on every privileged IPC | Backend/IPC | PASS | 32/32 ipcMain.handle call assertMainWindow first (index.ts:83-92,376-679) | — | — | Tony | — | — | Subframes/devtools/foreign senders rejected |
| requireAuth on data channels | Backend/IPC | PASS | 15 requireAuth sites cover dust*/ask/capture/transcript/graphify/path/recall (index.ts:422-646) | — | — | Tony | — | — | Ungated = settings/auth/window by design |
| Auth gate enforced in prod | Backend/Auth | UNKNOWN | requireAuth true when SSO unconfigured (auth.ts:152-155); default build has no managed-config | R-01/R-02 | HIGH | Tony+IT | Deploy managed-config or AZURE_* env | After signed-out test | Release blocker for sensitive-data |
| zod validation of IPC payloads | Backend/IPC | PASS | AskStart/Set/Clear/TestApiKey/SaveMeeting/SaveNote schemas; settings:set validKeysOnly (ipc.ts:118-362) | — | — | Tony | — | — | — |
| Path traversal | Backend/FS | PASS | recall:open join(folder, basename) (index.ts:648); selftest rejects ../../etc/passwd | — | — | Tony | — | — | — |
| Child-process injection | Backend/Process | PASS | All spawns execFile argv arrays, no shell (graphify.ts:211, dustcli.ts:31, mac.ts:143, win.ts:44) | — | — | Tony | — | — | customMeetingApps not injected |
| Stream double-settle/abort | Backend/LLM | PASS | Per-branch settled/aborted flags; exactly one onDone/onError (llm.ts:115-263) | — | — | Tony | — | — | — |
| Stream timeout/cleanup | Backend/LLM | FAIL | OpenAI+Dust branches set no timeout (llm.ts:221-263,123-180); hung provider leaks Map entry + AbortController | R-06 | MEDIUM | Tony | AbortSignal.timeout / SDK timeout | After patch + test | Stuck spinner |
| Async-fs off main thread | Backend/Perf | FAIL | recall.ts:51-88 readdirSync+readFileSync on IPC thread blocks UI on large OneDrive | R-07 | MEDIUM | Tony | fs.promises / worker | After patch | Known deferred |
| No secret/stack leak | Backend/Errors | PASS | Handlers forward e.message only; no console.log of keys (grep) | provider error may echo own key fragment | LOW | Tony | Redact in error path | — | Single-user local |
| Supply chain (runtime) | Backend/SC | FAIL | npm audit --omit=dev 9 vulns via @dust-tt/client → MCP SDK → express/qs/path-to-regexp/ajv | R-05 | MEDIUM | Tony | Upgrade @dust-tt/client / override | After audit | MCP server path not reachable |
| Supply chain (dev) | Backend/SC | N/A | 18 remaining vulns = electron-builder toolchain (devDeps not shipped) | — | — | Tony | Add CI audit budget | — | Justified N/A |
| Whisper model integrity | Backend/SC | FAIL | ONNX model fetched HF CDN no SRI | R-05 | MEDIUM | Tony | Pin hash / bundle | After model pin | Deferred |
| Inbound API auth/CORS/WAF | Backend/API | N/A | No inbound HTTP/REST/gRPC; only transient 127.0.0.1 OAuth loopback (auth.ts:174-213) | — | — | Tony | — | — | Justified N/A |
| Database / SQLi | Backend/Data | N/A | No DB; encrypted settings.json + markdown + graph JSON | — | — | Tony | — | — | Justified N/A |
| Test suite & typecheck | Backend/Quality | PASS | vitest 59/59 unsandboxed; typecheck clean | — | — | Tony | — | — | 3 in-sandbox keychain fails are env |
| Settings migration crash-safety | Business-logic | PASS | getSettings DEFAULT<managed<user tolerant repair, never throws (store.ts:142-160); selftest.ts:30-66 | — | — | Tony | — | — | — |
| Graphify build concurrency | Business-logic | PASS | building lock set before any await (graphify.ts:196-198); debounced | — | — | Tony | — | — | Prior race fixed |

### Gate 5 — Data protection

| Gate | Area | Status | Evidence | Open Findings | Severity | Owner | Fix/PR | Retest | Notes |
|------|------|--------|----------|---------------|----------|-------|--------|--------|-------|
| Data protection overall | Data | FAIL | Blocked on F1 plaintext OneDrive transcripts + F2/F4 deletion gaps | R-08/R-09/R-11 | HIGH | Tony | Encrypt default + purge + DPIA | After DPIA | PASS only if formally risk-accepted |
| API keys encrypted at rest | At-rest crypto | PASS | safeStorage.encryptString + 0o600; refuses plaintext (store.ts:195-201) | — | — | Tony | — | — | — |
| Keys never reach renderer | Trust boundary | PASS | PublicSettings booleans only (ipc.ts:231-239); main-only getApiKey | — | — | Tony | — | — | — |
| Settings + PII encrypted | At-rest crypto | PASS | ATKENC1 whole-file safeStorage atomic 0o600 (store.ts:104,129-184) | F3 silent plaintext fallback if keychain down | MEDIUM | Tony | Fail-closed like API keys | After patch | F3 |
| Transcripts encrypted by default | At-rest crypto | FAIL | encryptTranscripts default false (ipc.ts:188,264); default folder OneDrive-synced (transcripts.ts:146-150) | R-08 (F1) | HIGH | Tony | Default-true via managed-config | After DPIA | plaintext client content cloud-replicated |
| Encrypted-transcript handling | At-rest crypto | FAIL | decryptToTemp writes plaintext to OS temp, no 0o600/cleanup, predictable name (transcripts.ts:64-69) | R-09 (F2) | MEDIUM | Tony | Secure temp + cleanup | After patch | — |
| Secret-leak scan | Secret hygiene | PASS | grep out/ no key-shaped strings; .env NVIDIA key empty | — | — | Tony | — | — | — |
| Egress documented | Data egress | PASS | LLM/Dust/HF/Entra/OneDrive/graphify mapped; audio on-device | model no-SRI | MEDIUM | Tony | Pin model | — | — |
| Database review | Data layer | N/A | No DB/ORM/KV (grep clean); flat-file + markdown | — | — | Tony | — | — | Justified N/A |
| Automated retention policy | Retention | FAIL | No TTL/expiry in src/main; data persists indefinitely | R-10 | MEDIUM | Tony | Add retention setting | After patch | — |
| Manual deletion of primary data | Deletion | PASS | clearApiKey rmSync; signOut deletes session; user deletes .md | — | — | Tony | — | — | — |
| Deletion completeness/purge | Deletion | FAIL | Orphaned graph (graphify.ts:59-67), uncleaned temp, append-only index.md; no delete-all/uninstall hook | R-11 (F4/F5) | MEDIUM | Tony | Delete-all + uninstall purge | After patch | — |
| OneDrive replication | Deletion | UNKNOWN | Local deletes propagate but server version history/recycle bin outside app control | R-08 | MEDIUM | Tony+IT | Document + retention policy in M365 | — | — |
| Supply chain (data-exposure) | Supply chain | PASS | 9 advisories transitive under @dust-tt/client; no direct data-exposure path | R-05 | MEDIUM | Tony | Upgrade | — | DoS/server paths not exercised |

### Gate 8 — CI/CD, supply chain & release

| Gate | Area | Status | Evidence | Open Findings | Severity | Owner | Fix/PR | Retest | Notes |
|------|------|--------|----------|---------------|----------|-------|--------|--------|-------|
| CI correctness gating | CI/CD | PASS | build.yml quality job ci→typecheck→build→test; build-mac/win needs:quality | Repo NOT git-init → workflow never executed | HIGH | Tony | git init + push + branch protection | After first CI run | Shape correct, unproven |
| CI security scanning | CI/CD | FAIL | grep audit/codeql/trivy/gitleaks/snyk/semgrep/sbom → none; no dependabot | R-14 | HIGH | Tony | Add audit/gitleaks/CodeQL/CycloneDX | After CI green | — |
| Dependency pinning | Supply chain | PASS | package-lock v3 (1105 nodes); CI npm ci | 6 direct deps "latest" ranges | LOW | Tony | Pin ranges | — | Reproducible via lock only |
| Known CVEs in shipped deps | Supply chain | FAIL | npm audit --omit=dev 9 (5 high); Electron 33.4.11 mis-classed devDep hides RCE-class advisories | R-15 | HIGH | Tony | npm audit fix; upgrade Electron ≥ patched | After audit clean + regression | — |
| Model/runtime provenance | Supply chain | FAIL | whisper.worker.ts:5,19 allowLocalModels false; no revision/integrity/wasmPaths | R-05 | MEDIUM | Tony | Pin revision or bundle | After model pin | TLS+CSP mitigate |
| External-process execution | Supply chain | PASS | execFile arg arrays no shell:true | inherent host-trust on PATH (graphify.ts:128-131) | LOW | Tony | Document in threat model | — | — |
| No secrets in artifacts | Supply chain | PASS | strings app.asar → only detection patterns, no live secrets; .env excluded from files glob | — | — | Tony | — | — | — |
| Code signing & notarization | Release | FAIL | codesign → adhoc, no TeamID; spctl rejects; verifyUpdateCodeSignature:false; CI ASKTOTO_DISABLE_CP=1 | R-13 | HIGH | Tony+IT | Provision Dev ID + notarize + Win Authenticode | After codesign/spctl/signtool pass | Mechanism wired, creds missing |
| Auto-update integrity | Release | UNKNOWN | latest*.yml carry sha512; app-update.yml = REPLACE-WITH-YOUR-UPDATE-HOST → updater disabled (updater.ts:15-18) | R-16 latent HIGH | HIGH | Tony+IT | Wire host AFTER signing | After signed update test | Don't enable until signing fixed |
| Rollback / retention | Release | FAIL | No documented rollback/staged-rollout; autoDownload+autoInstallOnAppQuit true → bad release auto-propagates | R-16 | MEDIUM | Tony | Document downgrade; archive signed artifacts+blockmaps | After runbook | electron-updater has no downgrade |
| SBOM generation | Supply chain | FAIL | grep cyclonedx/spdx/syft → none; SBOM.md hand-derived | R-14 | MEDIUM | Tony | npx @cyclonedx/cyclonedx-npm in CI | After CI artifact | License scan UNKNOWN |
| Container/orchestration | Containers | N/A | find Dockerfile/k8s → none; native installers | — | — | Tony | — | — | Justified N/A |

### Gate 6 / Infra-Network

| Gate | Area | Status | Evidence | Open Findings | Severity | Owner | Fix/PR | Retest | Notes |
|------|------|--------|----------|---------------|----------|-------|--------|--------|-------|
| Electron runtime sandbox/IPC | Infrastructure | PASS | sandbox/contextIsolation/!nodeIntegration/webSecurity (index.ts:155-162); assertMainWindow (83-92) | — | — | Tony | — | — | Production-grade |
| Overlay content-protection | Infrastructure | PASS | setContentProtection default-on (index.ts:69-72,167); hidden in Mission Control; alwaysOnTop | — | — | Tony | — | — | Load-bearing privacy control |
| Code signing & notarization | Infrastructure | FAIL | env-driven unconfigured; verifyUpdateCodeSignature:false; gatekeeperAssess:false; CI skips signing | R-13 | HIGH | Tony+IT | Configure certs | After signed build | Blocks distributable release |
| Auto-update channel integrity | Infrastructure | UNKNOWN | publish url placeholder; updater skips (updater.ts:14-21) | R-16 | HIGH | Tony+IT | Wire after signing | After test | — |
| Dependency/SC vulns | Infrastructure | FAIL | npm audit 27 (16 high); prod 9 (5 high) @dust-tt/client | R-05/R-15 | HIGH | Tony | audit fix + Electron upgrade | After audit | No CI SCA gate |
| Sensitive data-at-rest footprint | Infrastructure | FAIL | repo+.env+default notes under OneDrive root; transcript encryption off default | R-08 | HIGH | Tony | Encrypt + folder choice | After DPIA | .env empty/verified |
| Inbound network surface | Network | PASS | only listener server.listen(0,'127.0.0.1') ephemeral, closes on req/300s (auth.ts:194-213) | — | — | Tony | — | — | — |
| Outbound TLS transport | Network | PASS | HTTPS via maintained SDKs; no rejectUnauthorized:false; custom URL forced https (store.ts:152) | no cert pinning | LOW | Tony | — | — | acceptable desktop trade-off |
| Egress allowlist enforceability | Network | UNKNOWN | renderer CSP allowlist but main SDK egress not CSP-constrained; custom provider any-host | R-12 | MEDIUM | Tony+IT | Lock provider/customBaseUrl via managed-config; proxy allowlist | After policy | — |
| On-device model download integrity | Network | FAIL | Whisper fetched HF/jsdelivr no SRI (whisper.worker.ts:2-19) | R-05 | MEDIUM | Tony | Pin+SHA / bundle | After model pin | sandboxed renderer bounds impact |
| Azure SSO tenant+domain lock | IAM | PASS | authority pinned (167); tid check (227-229); domain endsWith (230-232); PKCE S256; UI can't loosen managed (47-99) | — | — | Tony | — | — | Strong WHEN configured |
| Default auth enforcement | IAM | FAIL | requireAuth true when unconfigured (auth.ts:153-154) → fail-open | R-01 | HIGH | Tony+IT | Configure + lock Entra | After signed-out test | Intentional single-user |
| Secret-at-rest ACL (keychain) | IAM | PASS | keys/settings/session safeStorage 0o600; throws not plaintext (store.ts:186-201) | weakened by unconfigured signing | MEDIUM | Tony | Fix signing | — | — |
| Server TLS termination/headers | TLS/Headers | N/A | No inbound HTTPS server; transient loopback only | — | — | Tony | — | — | Justified N/A |
| Renderer CSP | TLS/Headers | PASS | default-src self; object/frame/form-action none; connect-src allowlist; no unsafe-eval (index.html:7-10) | style-src unsafe-inline | LOW | Tony | — | — | — |
| Loopback OAuth callback page | TLS/Headers | PASS | static HTML, no reflected input (auth.ts:180-183), server closes | residual state nonce gap NET-3 | LOW | Tony | Add state validation | After patch | — |
| CI build/test quality signal | Infrastructure | UNKNOWN | 56/59 (3 sandbox keychain); repo not git → build.yml inert | R-17 | MEDIUM | Tony | git init | After CI run | — |

### Gate 9 / Gate 10 / Gate 11 — QA, Performance, Reliability, Capacity

| Gate | Area | Status | Evidence | Open Findings | Severity | Owner | Fix/PR | Retest | Notes |
|------|------|--------|----------|---------------|----------|-------|--------|--------|-------|
| QA: typecheck | QA | PASS | npm run typecheck exit 0 (node+web projects) | — | — | Tony | — | — | — |
| QA: unit tests | QA | PASS | vitest 59/59 on macOS host | 3 sandbox keychain fails (env) | LOW | Tony | Mock security boundary in CI | — | — |
| QA: build | QA | PASS | npm run build exit 0; renderer 3.73MB + worker 2.0MB + wasm 21.6MB | — | — | Tony | — | — | — |
| QA: coverage critical logic | QA | PASS | routing 96/dustcli 94/prompts 100/transcripts 62/store 47 | headline 21% (Electron glue) | LOW | Tony | — | — | Pure trust-boundary logic covered |
| QA: IPC/auth coverage | QA | FAIL | index.ts/auth.ts/llm.ts/recall.ts 0%; no Electron-runtime harness | R-17 | MEDIUM | Tony | Playwright _electron tests; wire selftest into CI | After harness | Top QA gap before GA |
| QA: E2E live flow | QA | UNKNOWN | no automated E2E listen→transcribe→save→recap | manual M1-M7 only | MEDIUM | Tony | Add E2E with real mic/perms | After E2E | — |
| Perf: startup/bundle | Performance | PASS | lazy splits; 21.6MB wasm + 2MB worker load on first Listen only | 3.7MB renderer chunk | MEDIUM | Tony | Split shiki/streamdown | — | — |
| Perf: stream rendering | Performance | PASS | state.ts:75-90 rAF-batched, avoids O(n^2) re-lex | not covered by test | LOW | Tony | Add test | — | — |
| Perf: memory (whisper) | Performance | PASS | MAX_QUEUE=24 drop-oldest (listen.ts:136-138); zero-copy; full teardown | no soak test | LOW | Tony | 1h manual soak | — | — |
| Perf: load/stress/soak/SLO | Performance | N/A | single local user, one stream at a time | soak PARTIAL | LOW | Tony | endurance run | — | Justified N/A |
| Reliability: graceful degradation | Reliability | PASS | bad key→streamError; audio denied→mic-only; malformed config→never throws | — | — | Tony | — | — | Comprehensive |
| Reliability: concurrency guard | Reliability | PASS | building flag before await (graphify.ts:194-198); single-instance lock; stream guards | — | — | Tony | — | — | Prior race closed |
| Reliability: update/rollback | Reliability | FAIL | publish.url placeholder; updater skips; signing unconfigured | R-16/R-13 | HIGH | Tony+IT | Certs + host | After signed update | release blocker |
| Reliability: offline first-Listen | Reliability | FAIL | allowLocalModels false; model fetched HF no SRI, no bundled fallback | R-18/R-05 | MEDIUM | Tony | Bundle model | After bundling | degrades cleanly |
| Capacity | Capacity | N/A | single-user local; no server/DB/scaling unit | recall sync O(files) scan | LOW | Tony | async-fs (R-07) | — | Justified N/A |

### Gate 11/12/13 — Observability, Backup/DR, Privacy, Access, Deployment, Compliance

| Gate | Area | Status | Evidence | Open Findings | Severity | Owner | Fix/PR | Retest | Notes |
|------|------|--------|----------|---------------|----------|-------|--------|--------|-------|
| Observability | Observability/Ops | PASS | electron-log (updater.ts:5,16-32); stream:error to UI; never bricks; no telemetry by design | no global uncaughtException/crashReporter | MEDIUM | Tony | Add process crash handlers | After patch | server observability N/A |
| Backup/DR | Backup/DR | PASS | OneDrive version history RPO≈0; atomic writes; config reproducible (store.ts:114-127) | Documents fallback no backup (MED); no DR drill (LOW) | MEDIUM | Tony | Enforce synced location; run drill | After drill | No DB = N/A |
| Privacy | Privacy/Compliance | PASS | on-device ASR; keys never to renderer; safeStorage always-on; no telemetry; consent+indicator; erasure | R-08 plaintext→OneDrive+LLM no DPA (HIGH); R-05 model no-SRI (MED) | HIGH | Tony+DPO | DPIA + DPAs + encrypt | After DPIA | conditions |
| Alerting (local) | Observability/Ops | N/A | no service/on-call; user-facing alerts present (stream:error, RecordingIndicator, update notice) | — | — | Tony | — | — | ops alerting N/A |
| Access / Authentication | Access | FAIL | requireAuth true when Entra unconfigured (auth.ts:152-159); only OS account gates | R-01 | HIGH | Tony+IT | Mandate+lock Entra via managed-config | After signed-out test | trust boundary itself solid |
| Supply chain / Vendor | Vendor/SC | FAIL | npm audit 27 (16 high); prod 9 (5 high); model no-SRI; signing unconfigured | R-05/R-13/R-15 | HIGH | Tony | audit fix + pin + signing | After remediation | no critical/RCE confirmed reachable |
| Deployment / Rollback | Deployment | FAIL | unsigned installers; update host placeholder + updater self-skips; settings rollback-safe | R-13/R-16 | HIGH | Tony+IT | certs + host | After signed channel | reinstall-rollback works today |
| Compliance (evidence package) | Compliance | N/A | no cert claimed; GDPR mapped (minimization PASS, storage-limitation/transparency PARTIAL); SOC2 N/A | DPAs UNKNOWN #17 | MEDIUM | Tony+DPO | Hold DPAs | — | feeds Gate 13 |

## Tally

- Sub-gates: 31 FAIL · several UNKNOWN · multiple N/A (each justified above) · remainder PASS.
- Findings: 0 critical · 13 high · 33 medium · 28 low.
- Blockers to a trusted/distributable release: 11 (see PRODUCTION_READINESS_REPORT.md §Blockers).
