# Software Bill of Materials (SBOM) — AskToto

**Component:** AskToto `0.1.0` (`com.mantu.asktoto`) — Electron desktop app.
**Generated:** 2026-06-27 by the release review, **derived from `package-lock.json` (`lockfileVersion: 3`)**.
**Tooling note:** there is **no SBOM tooling configured** in the repo (no CycloneDX/Syft/SPDX in `package.json` or CI). This is a hand-derived, human-readable SBOM from the committed lockfile. For a machine-readable, signable SBOM, run `npx @cyclonedx/cyclonedx-npm --output-file sbom.cdx.json` (or `syft dir:.`) and attach it to each release artifact — recommended as a CI step (see CICD_REVIEW.md §3.1).

---

## 1. Inventory totals (evidence)

```
$ python3 -c "import json;d=json.load(open('package-lock.json'));print(d['lockfileVersion'], len(d['packages']))"
lockfileVersion 3 · 1105 locked package nodes (1 root + 1104 dependencies)

$ npm audit --omit=dev --json → metadata.dependencies
{"prod":141, "dev":964, "optional":168, "peer":72, "total":1104}
```

| Category | Count |
|---|---|
| Total locked dependency nodes | 1104 |
| Production (shipped in app) | 141 |
| Dev / build-time only | 964 |
| Optional | 168 |
| Peer | 72 |
| Direct runtime deps (`dependencies`) | 7 |
| Direct dev deps (`devDependencies`) | 24 |

**Distribution note:** only `dependencies` (and their transitive prod tree) are bundled by electron-builder into the app's main-process `node_modules`. All renderer/`devDependencies` are bundled by Vite at build time into `out/` (not shipped as `node_modules`). **Exception:** `electron@33.4.11` is listed under `devDependencies` but its runtime *is* the shipped binary — treat it as a production component for vulnerability purposes (see SUPPLY_CHAIN_SECURITY_REPORT.md §3.3).

---

## 2. Direct runtime dependencies (shipped) — provenance & license

| Package | Range | Locked version | Role | Notes |
|---|---|---|---|---|
| `@anthropic-ai/sdk` | ^0.106.0 | 0.106.0 | LLM provider (Claude) | HTTPS to `api.anthropic.com`. |
| `@azure/msal-node` | ^5.3.0 | 5.3.0 | Azure AD / Entra SSO (`auth.ts`) | Optional, domain-locked auth. |
| `@dust-tt/client` | ^1.2.4 | 1.2.4 | Dust agent client | **Pulls vulnerable transitive server stack** (express/router/path-to-regexp/qs/body-parser, MCP SDK) — 5 high / several moderate advisories. |
| `electron-log` | ^5.4.4 | 5.4.4 | Logging | Used by updater. |
| `electron-updater` | ^6.8.9 | 6.8.9 | Auto-update (`updater.ts`) | Update integrity depends on code signing (see RELEASE_AND_ROLLBACK_REPORT.md). |
| `openai` | ^6.45.0 | 6.45.0 | OpenAI-compatible providers | HTTPS to provider hosts (CSP-pinned). |
| `zod` | ^3.23.8 | 3.25.76 | IPC schema validation (`src/shared/ipc.ts`) | Trust-boundary input validation. |

---

## 3. Direct build/dev dependencies (not shipped as node_modules, but in the supply chain)

| Package | Locked | Risk note |
|---|---|---|
| `electron` | **33.4.11** | **Shipped runtime** — known high advisories (use-after-free, ASAR integrity bypass); upgrade to a patched major. |
| `electron-builder` | 25.1.8 | Packs the app; pulls vulnerable `app-builder-lib`→`@electron/rebuild`→`node-tar`/`node-gyp` chain (high `tar` path-traversal advisories) — **build-time only**. |
| `@huggingface/transformers` | 3.8.1 | Library pinned & integrity-locked; **fetches Whisper ONNX model + WASM at runtime with no SRI** (see SUPPLY_CHAIN_SECURITY_REPORT.md §4). |
| `electron-vite` / `vite` | 2.3.0 / 5.4.21 | Build tooling; `vite`/`esbuild` dev-server advisories are dev-only (not in production path). |
| `@vitejs/plugin-react`, `@tailwindcss/vite`, `tailwindcss` | 4.7.0 / 4.3.1 / 4.3.1 | Build-time CSS/JSX. |
| `react`, `react-dom` | 18.3.1 | Renderer UI (bundled into `out/`). |
| `@base-ui-components/react` | 1.0.0-rc.0 | **Pre-release (RC) version pinned via `latest`** — release-candidate in production UI; pin to a stable release. |
| `streamdown`, `lucide-react`, `geist`, `@fontsource/inter` | 2.5.0 / 1.21.0 / 1.7.2 / 5.2.8 | Pinned via `latest` in `package.json` (resolved in lock) — `latest` ranges are non-reproducible on fresh installs; pin explicit versions. |
| `shiki` | 4.3.0 | Syntax highlighting. |
| `typescript`, `@types/*`, `playwright`, `vitest`, `@vitest/coverage-v8` | — | Dev/test only. |

**Reproducibility caveat:** six direct deps use `"latest"` in `package.json` (`@base-ui-components/react`, `@fontsource/inter`, `geist`, `lucide-react`, `streamdown`, `tailwindcss`). The committed `package-lock.json` makes installs reproducible **today**, but `latest` means a deleted lockfile or `npm update` silently floats these — pin to explicit semver before production.

---

## 4. Native / non-npm components in the shipped artifact

| Component | Source | Provenance control |
|---|---|---|
| Electron runtime (Chromium + Node) | `electron@33.4.11` | npm, lock-integrity verified. Known advisories — upgrade. |
| `resources/graphify_runner.py` (5.2 KB) | repo (`extraResources`) | In-tree, reviewed; spawned via `execFile` (no shell). |
| Host `python` / `claude` / `graphify` binaries | end-user `PATH` | **Not in SBOM — resolved at runtime** (`graphify.ts`). Host-trust dependency. |
| Whisper `Xenova/whisper-tiny` ONNX weights + `onnxruntime-web` WASM | HF Hub / jsDelivr CDN at first Listen | **Not bundled, no revision pin, no SRI** — provenance gap (see SUPPLY_CHAIN_SECURITY_REPORT.md §4). |

---

## 5. Findings

1. **MEDIUM — No machine-readable SBOM is generated or published.** Add a CycloneDX export (`@cyclonedx/cyclonedx-npm`) to CI and attach `sbom.cdx.json` to every release for downstream verification.
2. **MEDIUM — Six direct deps use `"latest"` ranges** (`package.json`), non-reproducible without the lockfile; one (`@base-ui-components/react@1.0.0-rc.0`) is a pre-release in production UI. Pin explicit stable versions.
3. **LOW/INFO — Runtime-fetched model + host-resolved CLI binaries are outside the static SBOM**; document them as runtime supply-chain components.
4. **(Cross-ref) HIGH — Vulnerable shipped components** (Electron 33.x; `@dust-tt/client` transitive stack) are catalogued here and detailed in SUPPLY_CHAIN_SECURITY_REPORT.md.

**License posture:** not formally audited in this pass (no license-scanner output available). Recommend running `license-checker`/CycloneDX license enrichment before distribution to confirm no copyleft conflicts in the shipped 141-package prod tree. Marked **UNKNOWN** pending that scan.
