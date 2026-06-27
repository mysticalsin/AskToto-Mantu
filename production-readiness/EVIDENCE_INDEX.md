# AskToto — Evidence Index

App: AskToto v0.1.0 — local Electron desktop overlay. Date: 2026-06-27.
Index of every deliverable in `production-readiness/` plus the key command evidence and source file:line citations underpinning the gate decisions. All paths absolute under `/Users/tony/Library/CloudStorage/OneDrive-MantuGroup/Documents/TEST/AskToto/`.

## 1. Orchestrator deliverables (this cycle)

| File | Purpose |
|------|---------|
| production-readiness/PRODUCTION_READINESS_REPORT.md | Executive report: verdict, top risks, fixed/tested, remaining findings, approvals, 30/60/90 plan |
| production-readiness/RELEASE_GATE_MATRIX.md | All 14 master gates + full sub-gate matrix with file:line evidence |
| production-readiness/THREAT_MODEL.md | STRIDE-per-asset, trust boundaries, attack trees, N/A justifications |
| production-readiness/RISK_REGISTER.md | R-01..R-24 + LOW tail, severity/likelihood, owners, risk-acceptance ledger |
| production-readiness/SECURITY_REVIEW.md | Consolidated security verdict, strengths, weaknesses by category, verification log |
| production-readiness/EVIDENCE_INDEX.md | This file |

## 2. Domain audit reports (supporting)

### Frontend / Electron
| File | Covers |
|------|--------|
| production-readiness/FRONTEND_SECURITY_REPORT.md | Renderer trust boundary, CSP, nav hardening, injection sinks, secrets, source maps, permission handler (F1), model SRI (F2) |
| production-readiness/ACCESSIBILITY_REPORT.md | WCAG: keyboard, names, contrast (FAIL 1.4.3), reduced-motion, live regions |
| production-readiness/UX_REVIEW.md | Onboarding, core journeys, loading/empty/error, destructive confirmations |
| production-readiness/FRONTEND_PERFORMANCE_REPORT.md | rAF batching, code-splitting, bundle weight, artifact freshness |

### Main / Backend
| File | Covers |
|------|--------|
| production-readiness/BACKEND_REVIEW.md | assertMainWindow/requireAuth, zod, path traversal, child-process injection, stream lifecycle, async-fs, error leak |
| production-readiness/AUTHORIZATION_MATRIX.md | Per-channel assertMainWindow + requireAuth matrix |
| production-readiness/BUSINESS_LOGIC_REVIEW.md | Settings migration crash-safety, graphify concurrency |
| production-readiness/API_SECURITY_REPORT.md | Inbound surface (N/A server) + OAuth loopback |
| production-readiness/DATABASE_REVIEW.md | No-DB justification, flat-file integrity |

### Data protection / Privacy
| File | Covers |
|------|--------|
| production-readiness/DATA_PROTECTION_REPORT.md | At-rest crypto, keys-never-to-renderer, transcripts plaintext (F1), temp leak (F2), egress map |
| production-readiness/DATA_FLOW.md | Data-flow diagram and egress endpoints |
| production-readiness/DATA_RETENTION_AND_DELETION.md | Retention (none), deletion completeness (F4/F5), OneDrive replication |
| production-readiness/PRIVACY_REVIEW.md | On-device ASR, consent, telemetry-absent, erasure, residual policy risks |
| production-readiness/COMPLIANCE_MAPPING.md | GDPR principle mapping, SOC2 N/A, sub-processor/DPA gaps |

### Supply chain / Release
| File | Covers |
|------|--------|
| production-readiness/SUPPLY_CHAIN_SECURITY_REPORT.md | npm audit, model provenance, external-process exec, secrets-in-artifacts |
| production-readiness/CICD_REVIEW.md | build.yml correctness gate, missing SCA/SAST/SBOM, git-init gap |
| production-readiness/SBOM.md | Hand-derived CycloneDX-style inventory (141 prod / 964 dev / 1104 total) |
| production-readiness/RELEASE_AND_ROLLBACK_REPORT.md | Signing, notarization, auto-update integrity, rollback/retention |
| production-readiness/CONTAINER_SECURITY_REPORT.md | Container/orchestration N/A justification |
| production-readiness/VENDOR_AND_THIRD_PARTY_REVIEW.md | @dust-tt/client, MS, HF, Dust vendor posture |
| production-readiness/ASSET_REGISTER.md | Asset inventory + sensitivity |
| production-readiness/INVENTORY.md | Full component/dependency inventory |

### Infra / Network / IAM
| File | Covers |
|------|--------|
| production-readiness/INFRASTRUCTURE_REVIEW.md | Electron sandbox, content-protection, signing, data-at-rest footprint |
| production-readiness/NETWORK_SECURITY_REPORT.md | Inbound surface, outbound TLS, egress allowlist, model download integrity |
| production-readiness/TLS_AND_HEADERS_REPORT.md | Server TLS N/A, renderer CSP, OAuth callback page |
| production-readiness/IAM_REVIEW.md | Azure SSO tenant/domain lock, default auth posture, keychain ACL |
| production-readiness/ACCESS_REVIEW.md | Access/authentication posture |

### QA / Performance / Reliability / Capacity
| File | Covers |
|------|--------|
| production-readiness/QA_TEST_PLAN.md | Manual matrix M1–M7, E2E plan |
| production-readiness/QA_TEST_RESULTS.md | typecheck/unit/build/coverage results |
| production-readiness/COVERAGE_REPORT.md | v8 coverage per module, trust-boundary 0% gap |
| production-readiness/FLAKY_TEST_REGISTER.md | Sandbox keychain test flakiness |
| production-readiness/PERFORMANCE_REPORT.md | Startup/bundle, stream rendering, worker memory |
| production-readiness/RELIABILITY_REPORT.md | Graceful degradation, concurrency, update/rollback, offline first-Listen |
| production-readiness/CAPACITY_PLAN.md | Single-user capacity N/A + local-resource cliffs |

### Operations / Observability / DR
| File | Covers |
|------|--------|
| production-readiness/OBSERVABILITY_REPORT.md | electron-log, user-facing errors, no-telemetry, crash-handler gap |
| production-readiness/ALERTING_REPORT.md | User-facing alerts present, ops alerting N/A |
| production-readiness/OPERATIONS_RUNBOOK.md | Day-2 operations |
| production-readiness/DEPLOYMENT_RUNBOOK.md | Build + distribute steps |
| production-readiness/ROLLBACK_RUNBOOK.md | Reinstall-prior-version rollback |
| production-readiness/INCIDENT_RESPONSE_RUNBOOK.md | IR procedure |
| production-readiness/BACKUP_RESTORE_REPORT.md | OneDrive version history, atomic writes, restore |
| production-readiness/DISASTER_RECOVERY_PLAN.md | DR strategy, RPO/RTO |
| production-readiness/BUSINESS_CONTINUITY_PLAN.md | BCP |
| production-readiness/UNKNOWN_ITEMS.md | Open UNKNOWNs incl. DPA register #17 |

## 3. Key command evidence (re-run this cycle, real outputs)

| Command | Result | Used for |
|---------|--------|----------|
| `npm run typecheck` | exit 0 (tsconfig.node + tsconfig.web, no diagnostics) | Gate 9 |
| `npx vitest run` | 10 files / 59 tests passed on macOS host | Gate 9 |
| `npm test` (in command sandbox) | 56/59 (3 dustcli keychain fails = `security add-generic-password` "Operation not permitted" — env, not defect) | Gate 9 / FLAKY_TEST_REGISTER |
| `npm run build` | exit 0; renderer 3.73MB + whisper.worker 2.0MB + ort-wasm 21.6MB | Gate 9/10 |
| `npm audit --omit=dev` | 9 vulns (5 high, 4 moderate, 0 critical), all via @dust-tt/client → @modelcontextprotocol/sdk | Gate 4/8, R-05/R-15 |
| `npm audit` (full) | 27 vulns (16 high, 11 moderate, 0 critical) | Gate 8, R-14 |
| `grep node_modules/electron version package-lock.json` | 33.4.11 (locked) | R-15 |
| `codesign --display` on release/mac-arm64/AskToto.app | Signature=adhoc, TeamIdentifier=not set | R-13 |
| `spctl --assess` | Gatekeeper rejects (not notarized) | R-13 |
| `grep verifyUpdateCodeSignature\|gatekeeperAssess\|REPLACE-WITH electron-builder.yml` | verifyUpdateCodeSignature:false (:47), gatekeeperAssess:false (:32), publish.url placeholder (:69) | R-13/R-16 |
| `grep REPLACE-WITH src/main/updater.ts` | updater self-skips when placeholder (updater.ts:15-18); autoDownload/autoInstallOnAppQuit true (:25-26) | R-16 |
| `grep requireAuth src/main/auth.ts` | returns `!s.configured \|\| s.signedIn` (auth.ts:152-154) — fail-open | R-01 |
| `grep -r setPermissionRequestHandler src/main` | none | R-04 |
| `grep -r createServer\|listen src/` | only auth.ts:194 loopback | Network gate |
| `grep -r localStorage\|sessionStorage\|indexedDB src/` | none | FE secrets gate |
| `find . -path ./node_modules -prune -o -name Dockerfile -print` (+compose/k8s) | none | Gate 7 N/A |
| `find out -name '*.map'` | none (app maps not shipped) | FE source-map gate |
| `strings release/**/app.asar \| grep key-prefixes` | only detection patterns (keyHint:"sk-ant-"), no live secrets | No-secrets-in-artifacts gate |
| `ls -la .git` | absent → NOT a git repository | R-14 |
| `wc -l .env` / inspect | NVIDIA_API_KEY empty (0 chars) | Secret hygiene gate |

## 4. Primary source citations (trust-boundary code)

| Control | File:line |
|---------|-----------|
| webPreferences hardening | src/main/index.ts:155-162 |
| assertMainWindow definition + use | src/main/index.ts:83-92, 376-679 |
| requireAuth definition | src/main/auth.ts:152-154 |
| requireAuth use sites | src/main/index.ts:422-646 |
| Azure tenant/domain lock | src/main/auth.ts:167, 227-232 |
| OAuth loopback listener | src/main/auth.ts:194-213 |
| safeStorage key encryption (fail-closed) | src/main/store.ts:186-201 |
| ATKENC1 settings encryption | src/main/store.ts:104, 129-184 |
| getSettings tolerant repair | src/main/store.ts:142-160 |
| PublicSettings booleans only | src/main/index.ts:110-127; src/shared/ipc.ts:231-239 |
| Transcripts default folder + encrypt flag | src/main/transcripts.ts:146-150; src/shared/ipc.ts:188,264 |
| decryptToTemp leak | src/main/transcripts.ts:64-69 |
| LLM stream lifecycle (no timeout) | src/main/llm.ts:115-263 |
| recall sync fs | src/main/recall.ts:51-88 |
| execFile spawns | src/main/graphify.ts:211; src/main/dustcli.ts:31; src/main/meeting-detect/mac.ts:143, win.ts:44 |
| Whisper model fetch (no SRI) | src/renderer/.../whisper.worker.ts:2-19 |
| CSP | index.html:7-10 |
| Navigation hardening | src/main/index.ts:176-182 |
| Content protection | src/main/index.ts:69-72, 167 |
| Updater placeholder/skip | src/main/updater.ts:11-26 |
| electron-builder signing flags | electron-builder.yml:32, 47, 69 |
| CI quality gate | .github/workflows/build.yml |
