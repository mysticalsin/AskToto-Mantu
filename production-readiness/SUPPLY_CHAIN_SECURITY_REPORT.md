# Supply-Chain Security Report — AskToto

**Scope:** third-party dependency risk, model/artifact provenance, external-process execution, secret-in-artifact checks for the AskToto Electron desktop app.
**Reviewer role:** senior DevSecOps / supply-chain engineer (release-blocking authority).
**Date:** 2026-06-27 · **App version:** 0.1.0 · **Commit:** N/A (repo is not git-initialised).

All evidence below is real command output or `file:line` from the working tree.

---

## 1. Executive summary

| Dimension | Verdict |
|---|---|
| Dependencies pinned (lockfile) | PASS — `package-lock.json` present, `lockfileVersion: 3`, 1105 locked packages; CI uses `npm ci` (enforces lock). |
| Known CVEs in shipped deps | FAIL — `npm audit --omit=dev` = 9 vulns (5 high, 4 moderate); plus Electron 33.4.11 (the shipped runtime, mis-classified as devDependency) carries several high advisories that the prod audit does not surface. |
| Secrets in build artifacts | PASS — no live secret material found in `app.asar`; `.env` is gitignored and excluded from the package `files` glob. |
| Model / runtime provenance | FAIL (MEDIUM) — Whisper ONNX model + onnxruntime WASM fetched at runtime from HF/jsDelivr with no revision pin and no SRI/integrity. |
| External process execution | PASS (note) — `execFile` (arg arrays, no shell) used for `python`/`claude`/`security`; resolves binaries from `PATH`, an inherent host-trust dependency. |
| CI supply-chain gates | FAIL — no `npm audit`, no secret scan, no SAST, no SBOM, no pinned action SHAs (see CICD_REVIEW.md). |

**Release recommendation: BLOCK** until (a) the high-severity prod-shipped advisories are triaged/remediated, (b) Electron is upgraded off 33.x, and (c) the model fetch is pinned. None are individually catastrophic for a single-user local app, but the combination plus unsigned artifacts (see RELEASE_AND_ROLLBACK_REPORT.md) is below a production bar.

---

## 2. Dependency inventory & pinning

**Evidence:**
```
$ python3 -c "import json;d=json.load(open('package-lock.json'));print(d['lockfileVersion'], len(d['packages']))"
lockfileVersion: 3 · total locked packages: 1105

$ npm audit --omit=dev --json | (metadata.dependencies)
{"prod":141,"dev":964,"optional":168,"peer":72,"total":1104}
```

- `package.json` declares **7 runtime (`dependencies`)**: `@anthropic-ai/sdk ^0.106.0`, `@azure/msal-node ^5.3.0`, `@dust-tt/client ^1.2.4`, `electron-log ^5.4.4`, `electron-updater ^6.8.9`, `openai ^6.45.0`, `zod ^3.23.8`. All renderer/build deps are in `devDependencies` and bundled by Vite at build time (documented in `package.json` `comment` field).
- **Pinning posture:** ranges use caret (`^`) in `package.json`, but `package-lock.json` is committed and `npm ci` (used in `.github/workflows/build.yml:21,46,67`) installs the exact locked tree. This is acceptable pinning for reproducible builds. There is **no `engines` field** (`grep engines package.json` → none), so Node is unpinned in `package.json`; CI pins Node 20 via `actions/setup-node`.
- **No dependency-update automation:** no `.github/dependabot.yml`, no `renovate.json`. Advisories will not be surfaced automatically.

---

## 3. Known vulnerabilities (`npm audit`)

### 3.1 Full tree (all deps)
```
$ npm audit
27 vulnerabilities (11 moderate, 16 high)   # 0 critical, 0 low-as-counted
```

### 3.2 Production-shipped only (`--omit=dev`)
```
$ npm audit --omit=dev
9 vulnerabilities (4 moderate, 5 high)       # 0 critical
```

**Prod-shipped vulnerable packages** (all transitive under the one direct dep `@dust-tt/client@1.2.4`, except the MCP SDK):

| Package | Version | Severity | Advisory (representative) |
|---|---|---|---|
| `@dust-tt/client` (direct) | 1.2.4 | HIGH (via deps) | Pulls the vulnerable server stack below. |
| `path-to-regexp` | 8.2.0 | HIGH | ReDoS via sequential optional groups — GHSA-j3q9-mxjg-w52f |
| `express` | 5.1.0 | HIGH | transitive (router/qs/body-parser chain) |
| `router` | — | HIGH | depends on vulnerable `path-to-regexp` |
| `@modelcontextprotocol/sdk` | 1.17.1 | HIGH | ReDoS (GHSA-8r9q-7v3j-jr4g); cross-client data leak (GHSA-345p-7cg4-v4c7); no DNS-rebinding protection by default (GHSA-w48q-cv73-mx4w) |
| `qs` | 6.14.0 | MODERATE | arrayLimit/comma DoS — GHSA-6rw7-vpxm-498p, GHSA-q8mj-m7cp-5q26 |
| `body-parser` | — | MODERATE | DoS on urlencoded — GHSA-wqch-xfxh-vrr4 |
| `express-rate-limit` | — | MODERATE | transitive |
| `ajv` | — | MODERATE | ReDoS via `$data` — GHSA-2g4f-4pwh-qvx6 |

**Reachability note (do not over-state):** `express`/`router`/`path-to-regexp`/`body-parser`/`qs` are **server-side** code paths inside the `@dust-tt/client` package. AskToto uses the client as an HTTP *client* to Dust, not as a server, so these DoS gadgets are likely never on a reachable path — but they are *shipped bytes* in the main-process `node_modules` and would flag any client/SBOM scan. The MCP SDK advisories (cross-client data leak / DNS rebinding) only matter if AskToto runs an MCP server/transport; verify usage before downgrading severity.

### 3.3 Electron — the shipped runtime mis-classified as `devDependency`
```
$ python3 ... package-lock.json → electron: 33.4.11
$ grep '"electron"' package.json → devDependencies: "electron": "^33.2.0"
```
Electron is in `devDependencies`, so **`npm audit --omit=dev` does NOT report it** — but Electron *is* the runtime that ships inside every `.dmg`/`.exe`. The full audit lists numerous Electron advisories whose fixed versions are **above 33.x**, e.g.:
- ASAR Integrity Bypass via resource modification — GHSA-vmqv-hx8q-j7mg (fixed `<35.7.5`)
- Use-after-free in WebContents permission callbacks / PowerMonitor / offscreen paint — GHSA-8337-3p73-46f4, GHSA-jjp3-mq3x-295m, GHSA-532v-xpq5-8h95 (fixed `<38.8.6` / `<39.8.1`)
- Renderer command-line switch injection — GHSA-9wfr-w7mm-pc7f (fixed `<38.8.6`)

**Finding (HIGH):** the production app runs Electron 33.4.11 with known high-severity, RCE-class and integrity-bypass advisories. `--omit=dev` understates real attack surface because Electron is bundled by electron-builder, not by npm dependency class. **Upgrade Electron to a patched major (≥39.x line) before production.**

### 3.4 Remediation
- `npm audit fix` is offered for the `qs`/`path-to-regexp`/`router` chain (non-breaking) — apply and re-test.
- Electron requires a deliberate major upgrade + regression pass (BrowserWindow/IPC behaviour). Track as a release blocker.
- Add `npm audit --omit=dev` (and a full audit, non-blocking) to CI (see CICD_REVIEW.md).

---

## 4. Model & runtime artifact provenance (Whisper)

**Code:** `src/renderer/src/lib/whisper.worker.ts`
```
2  import { pipeline, env } from '@huggingface/transformers'
4  // Fetch models from the HF hub (no local model files bundled).
5  env.allowLocalModels = false
19 asr = await pipeline('automatic-speech-recognition', msg.model || 'Xenova/whisper-tiny', { dtype: 'q8' })
```
**Caller:** `src/renderer/src/lib/listen.ts:179` → `postMessage({ type: 'init', model: 'Xenova/whisper-tiny' })`.

**Findings:**
- `@huggingface/transformers@3.8.1` (the *library*) is pinned and lock-verified (`integrity: sha512-tsTk4zVjImqdqjS8/A…`) — good. The risk is the **runtime artifacts** it fetches, not the library.
- On first **Listen**, the library downloads the `Xenova/whisper-tiny` ONNX weights (q8) **and** the `onnxruntime-web` WASM from the Hugging Face Hub / jsDelivr CDN. CSP (`src/renderer/index.html:9`) explicitly allows `https://huggingface.co https://cdn.jsdelivr.net https://*.hf.co` in `connect-src`.
- **No revision pin:** the model id has no `@revision`, so it resolves to the mutable `main` branch — the served weights can change without notice.
- **No SRI / no integrity / no `wasmPaths`:** `grep -E "revision|integrity|allowRemoteModels|wasmPaths|onnxruntime" src/renderer/src/lib/` → *no matches*. The WASM runtime is also fetched remotely (no local `wasmPaths`), and runs under `script-src 'wasm-unsafe-eval'`.

**Real risk (MEDIUM, supply-chain/MITM):** a compromised HF repo, a malicious CDN cache, or a TLS-MITM on first-run could serve (a) a poisoned ONNX model that yields manipulated transcripts feeding the LLM prompt, or (b) a malicious `onnxruntime` WASM that executes in the renderer. **Mitigations already present:** HTTPS/TLS to all hosts, a strict CSP that limits `connect-src` hosts, and a hardened renderer (`contextIsolation` on, `sandbox` on, `nodeIntegration` off). These reduce but do not eliminate the model-swap/MITM vector.

**Recommended fixes (in priority order):**
1. Pin an immutable revision: `pipeline(..., model, { revision: '<commit-sha>' })`.
2. Bundle the model + onnxruntime WASM locally (`env.allowRemoteModels = false`, set `env.backends.onnx.wasm.wasmPaths` to a packaged path) — removes the network dependency entirely and is the elegant fix for a desktop app.
3. If remote fetch must stay, verify a known-good SHA-256 of the downloaded weights before first use.

---

## 5. External-process execution (build & runtime)

- `src/main/graphify.ts` spawns `python` (the interpreter that can `import graphify`), `which`/`where`, `uv`, and the local `claude` CLI via `execFile` (`graphify.ts:2,11,75,88,108,136,211`) — **arg arrays, no `shell:true`**, so no shell-injection surface. It resolves these binaries from `PATH` / well-known install dirs (`graphify.ts:128-131`). This is an **inherent host-trust dependency**: AskToto will execute whatever `claude`/`python3`/`graphify` resolve to on the user's machine. Acceptable for a local single-user tool, but note it in the threat model.
- `resources/graphify_runner.py` (5.2 KB) is shipped as `extraResources` (`electron-builder.yml`) and executed by the resolved interpreter.
- `src/main/dustcli.ts:31` calls the macOS `security` tool (`execFile`, arg array) to read the Dust CLI keychain session — no shell, throwaway-service tests confirm the path (`dustcli.test.ts`).

No `exec`/`spawn` with `shell:true` and no string concatenation into a shell was found.

---

## 6. Secrets in build artifacts

```
$ strings release/.../app.asar | grep -iE 'nvapi-|sk-ant-|sk-or-|gsk_|API_KEY=[A-Za-z0-9]'
→ only provider-detection patterns: keyHint:"sk-ant-", keyPattern:"^nvapi-", … (NOT secret values)
```
- **No live secret material** is embedded in `app.asar` (mac or win). The only matches are provider key-*prefix* hints used for auto-detecting which provider a pasted key belongs to.
- `.env` (480 B) contains `NVIDIA_API_KEY=` (empty — already removed/rotated per the in-file note) plus non-secret model-name overrides. It is `gitignored` (`.gitignore:7`) and **excluded from packaging** — the `files` glob in `electron-builder.yml` is `out/**/*` + `package.json` only, and `.env` lives at repo root, not in `out/`.
- **Caveat (documented in `.env` itself):** the repo is under OneDrive, so `.gitignore` does not stop cloud sync of `.env`. Currently harmless (no live secret), but operationally fragile — keep it empty and rely on the encrypted in-app store (`store.ts` ATKENC1 / Electron `safeStorage`).

**Verdict: PASS** — no secret-in-artifact today.

---

## 7. Findings (severity-ranked)

1. **HIGH — Shipped Electron 33.4.11 carries known RCE-class & ASAR-integrity advisories** (`package.json:38`, full `npm audit`). Mis-classified as devDependency, so prod audit hides it. Fix: upgrade Electron to a patched major + regression test.
2. **HIGH — 5 high-severity advisories in prod-shipped deps** under `@dust-tt/client@1.2.4` + `@modelcontextprotocol/sdk@1.17.1` (`npm audit --omit=dev`). Triage reachability; apply `npm audit fix`; bump `@dust-tt/client`.
3. **MEDIUM — Whisper model + onnxruntime WASM fetched at runtime with no revision pin and no SRI/integrity** (`whisper.worker.ts:5,19`). Model-swap/MITM risk; mitigated by TLS + CSP + sandbox. Fix: pin revision or bundle locally.
4. **MEDIUM — No supply-chain gates in CI** (no `npm audit`, no secret scan, no SBOM; no dependabot/renovate). See CICD_REVIEW.md.
5. **LOW — Runtime executes host-resolved `claude`/`python` binaries** (`graphify.ts`). `execFile` (no shell) limits this to a host-trust dependency; document in threat model.
