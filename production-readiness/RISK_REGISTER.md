# AskToto — Risk Register

App: AskToto v0.1.0 — local Electron desktop overlay (macOS + Windows), single user, local-first.
Date: 2026-06-27. Consolidates findings from 7 domain audits. Severity: CRITICAL (data exposure / auth bypass / RCE / secret-in-artifact / data-loss) · HIGH (serious exploitable weakness or missing authz on an important action) · MEDIUM (real but limited) · LOW (hardening/polish).

Finding totals: 0 critical · 13 high · 33 medium · 28 low. Blockers to a trusted/distributable sensitive-data release: 11.

Likelihood × Impact scored for the stated target deployment ("production with sensitive data, distributed to others"). For the personal single-user local build several HIGHs drop to MEDIUM (noted in Context).

## Top risks (HIGH / blocker)

| ID | Risk | Severity | Likelihood | Evidence (file:line) | Status | Owner | Mitigation / Fix | Accept? |
|----|------|----------|-----------|----------------------|--------|-------|------------------|---------|
| R-01 | Fail-open auth: no identity gate unless Entra SSO is explicitly configured | HIGH | High | auth.ts:152-154 (requireAuth returns true when !configured) | OPEN | Tony + IT | Ship managed-config azure.{clientId,tenantId,allowedDomain}+locked; add build flag to fail-closed when configured:false | Single-user: yes. Sensitive-data prod: NO — must configure+lock Entra |
| R-08 | Meeting transcripts plaintext by default, saved to OneDrive-synced folder, and egress to third-party LLM without enforced DPA | HIGH | High | ipc.ts:188,264; transcripts.ts:146-150,202,257 | OPEN | Tony + DPO | encryptTranscripts default-true via managed-config; first-save cloud-sync warning; point notes folder outside OneDrive; sign DPAs; cover in DPIA | NO for sensitive data unless DPIA risk-accepts |
| R-13 | Production artifacts unsigned / not notarized; Gatekeeper + SmartScreen reject; keychain ACL weakened | HIGH | High (certain) | electron-builder.yml:32 gatekeeperAssess:false, :47 verifyUpdateCodeSignature:false; codesign→adhoc; spctl rejects; CI ASKTOTO_DISABLE_CP=1 | OPEN | Tony + IT | Provision Apple Developer ID + notarization (CSC_LINK/APPLE_*) + Windows Authenticode/Azure Trusted Signing; verify with codesign/spctl/stapler + signtool | NO — distribution blocker |
| R-15 | Shipped Electron 33.4.11 carries RCE-class & ASAR-integrity advisories, hidden by --omit=dev (mis-classed as devDependency) | HIGH | Medium | package.json:38 (electron ^33.2.0 → locked 33.4.11) | OPEN | Tony | Upgrade Electron to a patched major; run IPC/BrowserWindow regression; reclassify electron as production for audit | NO — known-RCE runtime |
| R-16 | No production update/rollback channel; auto-update lacks signature verification (latent once host wired) | HIGH | Medium | electron-builder.yml:69 publish.url=REPLACE-WITH...; updater.ts:15-26 skip + autoDownload/autoInstallOnAppQuit true | OPEN | Tony + IT | Wire a real HTTPS host AFTER signing; set verifyUpdateCodeSignature:true; archive prior signed artifacts+blockmaps for downgrade; validate one signed update | NO — do not enable until signing fixed |
| R-14 | No CI supply-chain/security gate (audit/secret-scan/SAST/SBOM) and repo is NOT git-initialised so build.yml has never run | HIGH | High | grep audit/codeql/trivy/gitleaks/snyk/semgrep/sbom .github/workflows/build.yml → none; repo not git | OPEN | Tony | git init + push + branch protection; add blocking `npm audit --omit=dev --audit-level=high`, gitleaks, CodeQL, CycloneDX SBOM | NO — release-engineering blocker |
| R-05 | On-device Whisper ONNX model + WASM fetched from HF/jsDelivr with no revision pin / no SRI; plus 5 high transitive prod advisories | HIGH (rollup) | Medium | whisper.worker.ts:2-19 (allowLocalModels false, no revision/integrity/wasmPaths); npm audit --omit=dev = 9 (5 high) | OPEN | Tony | Pin model revision+SHA or bundle weights+WASM locally; `npm audit fix`; upgrade/override @dust-tt/client transitive deps | Partial — TLS+CSP+sandbox bound it to MEDIUM in practice |
| R-17 | IPC/auth trust boundary (assertMainWindow/requireAuth) has zero automated test coverage; selftest.ts not wired into CI | HIGH | Medium | index.ts:83-92,376-679 & auth.ts:152-155 at 0% coverage | OPEN | Tony | Playwright `_electron` (or electron-mocha) tests: assertMainWindow rejects subframe/foreign senders; requireAuth blocks privileged handlers when Entra configured + signed out; wire selftest.ts into CI on macos-latest | NO before GA — top QA gap |

R-01, R-08, R-13, R-15, R-16, R-14, R-17 and the four sub-items of R-05 (model SRI, Electron, signing, update channel re-counted across domains) are the basis for the "11 blockers" headline. The 13 "high" findings reported by the domain audits map onto R-01/R-05/R-08/R-13/R-14/R-15/R-16/R-17 (several were raised independently by more than one domain — e.g. signing appears in supply-release, infra-network, privacy-ops-dr, and qa-perf).

## Medium risks

| ID | Risk | Severity | Evidence | Status | Owner | Mitigation |
|----|------|----------|----------|--------|-------|------------|
| R-02 | Auth gate enforcement in prod unverified (UNKNOWN until managed-config deployed) | MEDIUM | auth.ts:152-155 | OPEN | Tony+IT | Deploy + verify signed-out blocks privileged IPC |
| R-03 | Glass contrast fails WCAG 1.4.3 AA (~2.9:1 < 4.5:1) in default state | MEDIUM | --glass-fill rgba(26,0,51,0.44); white text | OPEN | Tony | Raise fill opacity / add scrim behind text |
| R-04 | No Electron permission request/check handler → default-grant of permission classes | MEDIUM | grep: no setPermissionRequestHandler in src/main | OPEN | Tony | Deny-by-default handler, allow only mic/screen when expected |
| R-06 | LLM stream has no timeout → hung provider leaks Map entry + AbortController + stuck spinner | MEDIUM | llm.ts:123-180,221-263 | OPEN | Tony | AbortSignal.timeout / SDK timeout ceiling |
| R-07 | Synchronous fs on IPC thread (recall list/search; transcript writes) blocks UI on large OneDrive folders | MEDIUM | recall.ts:51-88 | OPEN | Tony | fs.promises / worker thread |
| R-09 | decryptToTemp leaks plaintext to OS temp (predictable name, no 0o600, no cleanup) | MEDIUM | transcripts.ts:64-69; index.ts:650 | OPEN | Tony | Random name, 0o600, delete on close |
| R-10 | No automated retention/TTL; data persists indefinitely | MEDIUM | no expiry logic in src/main | OPEN | Tony | Add retention setting + purge job |
| R-11 | Deletion incomplete: orphaned graph, uncleaned temp, append-only index.md; no delete-all / uninstall hook | MEDIUM | graphify.ts:59-67,237 | OPEN | Tony | "Delete all data" action + uninstall purge |
| R-12 | Main-process SDK egress not allowlist-constrained; custom provider can reach any HTTPS host | MEDIUM | llm.ts; store.ts:152 | OPEN | Tony+IT | Lock provider/customBaseUrl via managed-config; org proxy allowlist |
| R-18 | Offline first-Listen fails — model fetch required, no bundled fallback | MEDIUM | whisper.worker.ts:5 | OPEN | Tony | Bundle model OR clear offline UX |
| R-19 | F3 silent plaintext fallback for settings/PII when keychain unavailable (unlike API keys which fail-closed) | MEDIUM | store.ts safeStorage fallback path | OPEN | Tony | Fail-closed like API keys |
| R-20 | No global uncaughtException/unhandledRejection/crashReporter handler in main | MEDIUM | grep src/ → none | OPEN | Tony | Add process-level crash handlers |
| R-21 | Stale release/ artifacts (full ~200 shiki grammars + dep .map; exe 178MB) not produced by current source | MEDIUM | release/ asar list | OPEN | Tony | Rebuild before ship; prune files glob |
| R-22 | Documents fallback notes folder has no backup (only OneDrive-synced location is protected) | MEDIUM | transcripts.ts:148 | OPEN | Tony | Enforce synced/backed-up location |
| R-23 | Startup renderer chunk ~3.6–3.7MB (markdown/shiki not lazy) | MEDIUM | out/renderer index.js | OPEN | Tony | Split shiki/streamdown |
| R-24 | DPAs with LLM provider / Microsoft / HF / Dust unconfirmed | MEDIUM | COMPLIANCE_MAPPING.md #17 | OPEN | Tony+DPO | Hold + register DPAs |

(Plus ~13 further MEDIUMs itemised across the domain reports — auto-record countdown default, 6 "latest" dep ranges, no cert pinning, OneDrive server-side recycle bin, MCP-SDK reachability verification, etc. — see source reports for the long tail.)

## Low risks (hardening — representative)

| ID | Risk | Evidence | Mitigation |
|----|------|----------|------------|
| R-L1 | CSP delivered via meta only (no header defense-in-depth); style-src unsafe-inline | index.html:7-10 | Add header CSP if a server is ever introduced |
| R-L2 | 2 bespoke Trash buttons title-only, no aria-label | Settings.tsx:483,1260 | Add aria-label |
| R-L3 | No Escape-to-close handler | renderer | Add Escape handler |
| R-L4 | OAuth callback page residual `state` nonce gap (NET-3) | auth.ts:180-183 | Validate state nonce |
| R-L5 | 3rd-party node_modules .map files leak into asar | release asar | Prune electron-builder files glob |
| R-L6 | Provider error may echo a fragment of the user's own key | index.ts error path | Redact key-shaped substrings |
| R-L7 | "New meeting" discards unsaved transcript on failed save without confirm | App.tsx | Confirm before discard |
| R-L8 | No DR restore drill performed | BACKUP_RESTORE_REPORT.md | Run one restore drill, record evidence |
| R-L9 | No soak/endurance test for Whisper worker memory | PERFORMANCE_REPORT.md | 1h manual Listen soak |
| R-L10 | 6 direct deps use "latest" ranges (incl. @base-ui-components/react@1.0.0-rc.0) | package.json | Pin exact versions |

(28 LOW findings total across the domain reports; the above are the representative/load-bearing ones.)

## Risk-acceptance ledger (requires a human signature)

| Risk | Decision needed | Decider | Default if unsigned |
|------|-----------------|---------|---------------------|
| R-08 plaintext transcripts → OneDrive + LLM egress | Risk-accept via DPIA, OR enforce encryption + folder + DPA | Tony + DPO | BLOCK sensitive-data release |
| R-01 fail-open auth | Accept for single-user, OR mandate+lock Entra for sensitive data | Tony + IT | BLOCK enterprise sensitive-data release |
| R-13 unsigned artifacts | Must fix (cannot be "accepted") before distribution | Tony + IT | BLOCK distribution |
| R-15 vulnerable Electron | Must upgrade before distribution | Tony | BLOCK distribution |
| R-12 custom-provider any-host egress | Accept, OR lock via managed-config + proxy | Tony + IT | Accept for single-user |

## Notes on the personal single-user build

For Tony's own local use today, the genuinely usable posture is: keys are encrypted, content protection is on, the trust boundary is solid, and the app works. The HIGHs that drop in that context are R-01 (OS account is an acceptable single gate), R-08 (if Tony points the notes folder off OneDrive or turns on encryptTranscripts), and R-12. The HIGHs that do NOT drop even for personal use are R-13/R-15/R-16 — an unsigned, known-vulnerable, no-update-channel binary is a real risk to the owner regardless of multi-tenancy. That distinction drives the verdict in PRODUCTION_READINESS_REPORT.md.
