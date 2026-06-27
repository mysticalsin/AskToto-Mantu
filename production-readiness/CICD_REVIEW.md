# CI/CD Review — AskToto

**Pipeline:** GitHub Actions — `.github/workflows/build.yml` (single workflow, `name: Build & Test`).
**Reviewer:** senior build-release engineer. **Date:** 2026-06-27.
**Important context:** the working tree is **not a git repository** (`ls .git` → absent), so this workflow has **never actually executed** against this repo — it is configured but unproven in practice. Findings below are a static review of the workflow plus local reproduction of each gate.

---

## 1. Workflow structure (verbatim, summarised)

Triggers: `push` and `pull_request` on `main`/`master`.

| Job | Runner | Steps | Gates the release? |
|---|---|---|---|
| `quality` | `ubuntu-latest` | checkout → setup-node@20 (npm cache) → `npm ci` → `npm run typecheck` → `npm run build` → `npm test` | Yes — `build-macos`/`build-windows` declare `needs: quality`. |
| `build-macos` | `macos-latest` | `npm ci` → `npm run dist` (env `ASKTOTO_DISABLE_CP=1`) → `upload-artifact` `release/*` | Packaging only. |
| `build-windows` | `windows-latest` | `npm ci` → `npm run dist:win` → `npm run dist:win:appx` → `upload-artifact` `release/*` | Packaging only. |

---

## 2. Does it gate correctly? (verified locally)

**Yes for correctness gates — each was reproduced and passes:**

```
$ npm run typecheck         → TYPECHECK_EXIT=0   (tsc node + web projects)
$ npm test                  → Test Files 10 passed (10) · Tests 59 passed (59)
```
- `quality` runs `typecheck`, `build`, and `test`, and a non-zero exit on any of them fails the job. Because both packaging jobs declare `needs: quality`, **a typecheck/build/test failure blocks artifact production.** This is the correct shape — PASS.
- The 3 keychain tests (`dustcli.test.ts`) are wrapped in `describe.runIf(isMac)` (`dustcli.test.ts:34`). The `quality` runner is `ubuntu-latest` → `isMac=false` → those 3 are **skipped** in CI, so `npm test` is green on the gating runner. (They only execute on macOS; the gating job is Linux.)

**Verification note:** under this review's sandbox those 3 tests initially failed with `security: …Operation not permitted` (sandbox blocking keychain writes). Re-running outside the sandbox: **59/59 pass**. The failures were an artifact of the review environment, not the code or CI.

---

## 3. Gaps (what a production pipeline must add)

### 3.1 No supply-chain / security scanning — MEDIUM→HIGH
```
$ grep -niE 'audit|codeql|trivy|gitleaks|snyk|semgrep|secret|sbom' .github/workflows/build.yml
→ (only comments about signing; NO scanning steps)
```
- **No `npm audit`** — the pipeline ships without ever checking the 9 prod / 27 total advisories (see SUPPLY_CHAIN_SECURITY_REPORT.md). Add `npm audit --omit=dev --audit-level=high` as a **blocking** step and a full `npm audit` as non-blocking.
- **No secret scanning** (gitleaks/trufflehog). The repo carries a `.env` under OneDrive; a CI secret scan would catch an accidental key commit.
- **No SAST / CodeQL** for the TypeScript/Electron main process (IPC trust boundary).
- **No SBOM generation** (see SBOM.md). Add a CycloneDX export as a build artifact.

### 3.2 Unpinned action versions — LOW (supply-chain hardening)
- Uses floating tags: `actions/checkout@v4`, `actions/setup-node@v4`, `actions/upload-artifact@v4`. Tags are mutable; a compromised tag re-point is a known GitHub-Actions supply-chain vector. **Pin to commit SHAs** and let Dependabot bump them.

### 3.3 Artifacts are unsigned and unattested — HIGH (release integrity)
- `build-macos` sets `ASKTOTO_DISABLE_CP=1` and the comments state signing is skipped unless Apple/Windows certs are added as secrets. So CI produces **adhoc/unsigned** `.dmg`/`.exe` (confirmed locally: `codesign … → Signature=adhoc, TeamIdentifier=not set`; see RELEASE_AND_ROLLBACK_REPORT.md).
- No checksum publication, no `actions/attest-build-provenance` (SLSA), no artifact signing. A downstream consumer cannot verify provenance of the uploaded `release/*`.

### 3.4 Process / governance gaps — LOW/MEDIUM
- **Repo not under version control** → no PR gate is actually enforced today; the workflow is aspirational until `git init` + remote.
- **No `concurrency:` group** → overlapping pushes run redundant/competing builds.
- **No release job** — artifacts are uploaded to the Actions run, never published to the update host (`publish.url` is still the `REPLACE-WITH-…` placeholder), so there is no end-to-end release path. (Intentional pre-release, but a gap for "production".)
- **No caching of electron-builder downloads** beyond npm cache; **no test coverage gate** even though `@vitest/coverage-v8` is installed.
- **No Node version pin in repo** (`engines` absent in `package.json`); CI hard-codes Node 20 — fine, but drift-prone.

---

## 4. Findings (severity-ranked)

1. **HIGH — CI builds & uploads unsigned, unattested artifacts** (`build.yml:35-40,57-61`; signing env-gated). No provenance/signature on `release/*`. Configure signing secrets + add build-provenance attestation before any external distribution.
2. **MEDIUM→HIGH — No dependency/secret/SAST/SBOM scanning in CI** (`grep` shows none). Add blocking `npm audit --omit=dev --audit-level=high`, gitleaks, CodeQL, and a CycloneDX SBOM step.
3. **MEDIUM — Pipeline is unproven: repo is not git-initialised**, so the workflow has never run and no branch protection enforces it. `git init` + push + require `quality` to pass on PRs.
4. **LOW — Floating action tags** (`@v4`) unpinned to SHA — supply-chain hardening.
5. **LOW — No `concurrency` control, no coverage gate, no `engines` pin.**

**Gate verdict:** correctness gating (typecheck/build/test) **PASS**; security/supply-chain gating **FAIL**; artifact integrity **FAIL**.
