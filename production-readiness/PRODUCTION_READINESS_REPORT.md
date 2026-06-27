# AskToto — Production Readiness Report

App: AskToto v0.1.0 — local Electron desktop overlay (macOS + Windows). Single user, local-first. No server / DB / multi-tenant backend / container / cloud IAM.
Date: 2026-06-27. Author: Orchestrator / Release Manager, consolidating 7 domain audits (45 supporting reports in this folder).

---

## 1. Verdict

### NOT READY for trusted distribution or sensitive-data production.

Carve-out: the app is usable today as a personal, single-user, local tool at the owner's own risk, provided the owner accepts R-13/R-15/R-16 (unsigned, vulnerable-Electron, no update channel) and turns on transcript encryption or moves the notes folder off OneDrive.

Why not READY: the verdict rule requires all gates PASS, zero open critical/high, no UNKNOWN in critical areas (auth / data / signing / release), and complete evidence. AskToto has 0 critical but 13 high findings, 31 FAIL sub-gates, code signing/notarization unconfigured, the update channel disabled, fail-open default auth, a known-vulnerable shipped Electron, and the repo is not even git-initialised (so CI has never run). Several of these are not "risks to accept" — they are unresolved engineering blockers that require human-provisioned credentials and a code change before they can clear.

Why not "READY WITH ACCEPTED RISKS": that verdict would imply the open items are acceptable as-is. An unsigned installer that triggers Gatekeeper/SmartScreen malware warnings, a runtime with published RCE-class advisories, and a fail-open auth posture over client-confidential meeting transcripts are not acceptable to merely accept for a distributed sensitive-data product — they must be fixed. Hence NOT READY, with a precise, time-boxed path to READY below.

Scorecard: 0 critical · 13 high · 33 medium · 28 low · 11 blockers · 31 FAIL sub-gates · 2 UNKNOWN critical areas (prod auth enforcement, auto-update integrity). 3 of 14 master gates PASS, 8 FAIL, 1 N/A (containers), Gate 1 (threat model) PASS new this cycle.

---

## 2. Top risks (the 11 blockers)

1. R-13 — Unsigned / unnotarized installers. Gatekeeper + SmartScreen reject; adhoc signature, no TeamID; win.verifyUpdateCodeSignature:false. (HIGH)
2. R-15 — Shipped Electron 33.4.11 carries RCE-class + ASAR-integrity advisories, hidden by `--omit=dev`. (HIGH)
3. R-16 — No production update/rollback channel; once wired, no signature verification until R-13 is fixed; autoDownload+autoInstall would auto-propagate a bad release. (HIGH)
4. R-14 — No CI security gate (audit/secret-scan/SAST/SBOM) and the repo is NOT git-initialised, so build.yml has never executed and there is no branch protection. (HIGH)
5. R-01 — Fail-open default auth: `requireAuth()` returns true when Entra SSO is unconfigured — no app-level identity gate over keys/capture/transcripts/recall. (HIGH)
6. R-08 — Meeting transcripts stored plaintext by default, saved to a OneDrive-synced folder, and sent to a third-party LLM with no enforced DPA. (HIGH)
7. R-05 — Whisper ONNX model + WASM fetched from HF/jsDelivr with no revision pin / no SRI; plus 5 high transitive prod advisories under @dust-tt/client. (HIGH rollup)
8. R-17 — IPC/auth trust boundary (assertMainWindow/requireAuth) has 0% automated test coverage; selftest.ts not wired into CI. (HIGH)
9. R-02 — Auth enforcement in production is UNKNOWN — no managed-config deployed to prove signed-out users are blocked. (critical-area UNKNOWN)
10. Auto-update integrity — UNKNOWN until a real host is wired AND signing is fixed (latent HIGH). (critical-area UNKNOWN)
11. R-21 — The current `release/` artifacts are stale (full ~200 shiki grammars + dep .map files, 178MB exe) and were not produced by the current source — must rebuild before any ship. (MEDIUM, but a release-correctness blocker)

The single most consequential real-world exposure is R-08 (client-confidential transcripts leaving the device via OneDrive + LLM). The single hardest to wave away is R-13/R-15 (you cannot trust-distribute an unsigned binary on a known-vulnerable runtime).

---

## 3. What was fixed (confirmed closed since the prior audit)

- buildGraph concurrency race — `building` lock now set synchronously before any await (graphify.ts:194-198); scheduleRebuild debounces and skips when encrypted. Verified PASS.
- Windows-path handling gaps — previously flagged, now resolved (basename-based path handling; selftest path-traversal assertions pass).
- prefers-reduced-motion — global `@media (prefers-reduced-motion: reduce)` now zeroes animation/transition durations (styles.css:422-429), covering spinner/shimmer/pulse/fade. The prior "spinner ignores reduced-motion" note is RESOLVED.
- .env secret — NVIDIA key value emptied (0 chars); .env gitignored and excluded from the electron-builder files glob; `strings app.asar` shows no live secrets.

No new code was changed in this orchestration cycle; the only deliverables produced are the documentation set in this folder.

---

## 4. What was tested (evidence)

- `npm run typecheck` → exit 0 (both TS projects clean).
- `npx vitest run` → 59/59 on a real macOS host (10 files). In the command sandbox, 3 dustcli keychain tests fail only because `security add-generic-password` is blocked ("Operation not permitted") — re-ran 4/4 PASS unsandboxed; environment limitation, not a defect.
- `npm run build` → exit 0; renderer 3.73MB, whisper.worker 2.0MB, ort-wasm 21.6MB.
- `npm audit --omit=dev` → 9 (5 high); full tree 27 (16 high); 0 critical.
- Signing/release state re-verified: codesign adhoc, spctl rejects, verifyUpdateCodeSignature:false, publish.url placeholder, updater self-disabled, Electron 33.4.11 locked, not a git repo.
- Coverage: routing 96% / dustcli 94% / prompts 100% / transcripts 62% / store 47%; trust-boundary glue (index.ts/auth.ts/llm.ts/recall.ts) at 0% — the top QA gap (R-17).

Not tested (UNKNOWN): live E2E listen→transcribe→save→recap (needs real mic + Screen Recording perms + HF model download), documented as manual matrix M1–M7 in QA_TEST_PLAN.md; production auth enforcement (no managed-config deployed); a real signed update.

---

## 5. Remaining findings (by severity)

- Critical: 0.
- High (13, mapped to R-01, R-05, R-08, R-13, R-14, R-15, R-16, R-17; several raised by multiple domains): fail-open auth, plaintext transcripts → cloud + LLM, unsigned/unnotarized artifacts, no signed update channel, vulnerable shipped Electron, no CI SCA/SBOM gate + not git-init, model no-SRI + 5 high transitive advisories, 0% trust-boundary test coverage.
- Medium (33): no stream timeout (R-06), sync-fs on IPC thread (R-07), decryptToTemp leak (R-09), no retention (R-10), incomplete deletion/purge (R-11), egress not allowlist-constrained (R-12), offline first-Listen (R-18), settings plaintext fallback (R-19), no crash handler (R-20), stale release artifacts (R-21), Documents fallback no backup (R-22), startup chunk weight (R-23), DPAs unconfirmed (R-24), no permission handler (R-04), AA contrast (R-03), and the long tail in the domain reports.
- Low (28): meta-only CSP, missing aria-labels, no Escape handler, OAuth state nonce gap, asar .map leak, key-fragment echo in errors, no soak/DR drill, "latest" dep ranges, etc.

Full detail with file:line in RISK_REGISTER.md and the domain reports indexed in EVIDENCE_INDEX.md.

---

## 6. Required human approvals / decisions

These cannot be resolved by code alone — they need a person with credentials or authority:

1. Apple Developer ID certificate + notarization credentials (CSC_LINK, APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, team ID) — Tony / Mantu IT. Unblocks R-13 on macOS.
2. Windows code-signing — an Authenticode cert or Azure Trusted Signing account + a Windows signing runner — Tony / Mantu IT. Unblocks R-13 on Windows.
3. git init + push to a hosted remote + branch protection (required reviews, required CI checks) — Tony. Unblocks R-14 (CI has never run).
4. Decision on Azure SSO enforcement for sensitive-data use: will the deployment mandate + lock Entra via machine-wide managed-config (fail-closed), or is fail-open accepted for single-user only? — Tony / IT. Resolves R-01/R-02.
5. DPIA sign-off for transcript handling, plus DPAs with the chosen LLM provider, Microsoft (OneDrive/Entra), Hugging Face, and Dust — Tony / DPO. Resolves R-08/R-24 risk-acceptance.
6. A real HTTPS update host (S3 / Azure Blob / static server) — to be wired only AFTER 1+2 are done — Tony / IT. Resolves R-16.

---

## 7. 30 / 60 / 90 hardening plan

### Next 30 days — clear the distribution blockers
- git init, push, enable branch protection; make build.yml actually run (R-14).
- Add CI security gate: `npm audit --omit=dev --audit-level=high` (blocking), gitleaks, CodeQL, and CycloneDX SBOM (`npx @cyclonedx/cyclonedx-npm`) attached per release (R-14).
- Provision + wire Apple Developer ID + notarization and Windows signing; produce one signed+notarized build and re-verify with codesign/spctl/stapler + signtool (R-13).
- Upgrade Electron off 33.4.11 to a patched major; reclassify electron as a production dependency for audit; run an IPC/BrowserWindow regression pass (R-15).
- `npm audit fix` for the non-breaking qs/path-to-regexp/router chain; upgrade/override @dust-tt/client transitive deps (R-05).
- Rebuild `release/` from current source so artifacts match (R-21).
- Decision + DPIA kickoff for R-08; if sensitive-data, set encryptTranscripts default-true via managed-config and/or move notes off OneDrive.

### 31–60 days — close the trust-boundary and data gaps
- Decide and implement auth posture: ship managed-config (azure.{clientId,tenantId,allowedDomain}+locked) and add a build flag to fail-closed when configured:false; deploy to one machine and prove signed-out blocks privileged IPC (R-01/R-02).
- Add the IPC/auth test harness (Playwright `_electron` or electron-mocha): assertMainWindow rejects subframe/foreign senders; requireAuth blocks privileged handlers when Entra is configured + signed out; wire selftest.ts into CI on macos-latest (R-17).
- Pin the Whisper model revision + SHA or bundle weights+WASM locally; this also fixes offline first-Listen (R-05/R-18).
- Wire the real update host with verifyUpdateCodeSignature:true; validate one signed update end-to-end; archive prior signed artifacts + blockmaps for downgrade; document the rollback procedure (R-16).
- Add stream timeouts (AbortSignal.timeout), move recall fs to fs.promises/worker, secure decryptToTemp (random name + 0o600 + cleanup), add global uncaughtException/unhandledRejection/crashReporter (R-06/R-07/R-09/R-20).

### 61–90 days — polish, compliance, durability
- Fix WCAG AA contrast (opaque glass token / scrim), add the deny-by-default permission handler, add missing aria-labels + Escape handler (R-03/R-04, LOW a11y).
- Implement retention/TTL and a "Delete all data" + uninstall-purge action; clean orphaned graph and append-only index.md (R-10/R-11).
- Sign + register DPAs; finalize the DPIA; document sub-processors (R-24).
- Lock provider/customBaseUrl via managed-config + org proxy allowlist for enterprise egress control (R-12).
- Run a DR restore drill and a ≥1h Whisper soak test; record evidence (R-22, R-L8/R-L9).
- Split the startup renderer chunk (shiki/streamdown lazy) (R-23).

---

## 8. Path to a READY verdict

AskToto flips to READY (for trusted, distributed, sensitive-data use) when: every master gate is PASS or justified-N/A; the 11 blockers are closed (signed+notarized build re-verified, Electron upgraded, CI security gate live on a git-initialised repo with branch protection, model pinned/bundled, trust-boundary tests in CI, a signed update validated); R-08 is either remediated or formally risk-accepted in a signed DPIA with DPAs in place; R-01 is resolved by a deployed+locked Entra managed-config (or explicitly scoped to single-user); and the two UNKNOWN critical areas (prod auth enforcement, auto-update integrity) are proven by test. Realistically a 30–60 day path given the human-credential dependencies in §6.

Until then: NOT READY for distribution; usable as a personal local tool at the owner's accepted risk.
