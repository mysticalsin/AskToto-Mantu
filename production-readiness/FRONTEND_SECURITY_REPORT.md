# Frontend / Renderer Security Report — AskToto

**Scope:** Electron renderer trust posture (contextIsolation / sandbox / nodeIntegration / webSecurity),
Content-Security-Policy, navigation hardening (`setWindowOpenHandler` / `will-navigate`), markdown/code HTML
injection sinks (`dangerouslySetInnerHTML`), client-side secret/token storage, source-map exposure in the
packaged build, permission handling, and renderer supply chain.
**Reviewer posture:** senior Electron-security engineer, block-a-bad-release.
**Date:** 2026-06-27 · **Commit state:** not a git repo (no SHA).

This is a LOCAL desktop app: no server / DB / cloud IAM / LB. Those are **N/A** and justified inline.

---

## Verdict (Gate 3 — Frontend security sub-area)

**PASS with conditions.** The renderer core is hardened correctly (full context isolation + sandbox,
strict CSP, no remote navigation, no client-side secrets, no app source-map leakage, single
`dangerouslySetInnerHTML` sink fed only by escaped shiki output). Two MEDIUM hardening gaps
(no `setPermissionRequestHandler`; whisper model fetched with no integrity/SRI) and packaging hygiene
(stale release artifacts + bundled third-party `.map` files) keep this from a clean PASS.

---

## Findings

### F1 — No `setPermissionRequestHandler` / `setPermissionCheckHandler` (MEDIUM)
- **Evidence:** `grep -rn "setPermissionRequestHandler\|setPermissionCheckHandler" src/main/` → **no matches.**
  Only `session.defaultSession.setDisplayMediaRequestHandler(...)` exists (`src/main/index.ts:706-746`).
- **Impact:** With no permission handler, Electron's default behavior auto-approves permission classes
  (notifications, geolocation, pointerLock, media getUserMedia, etc.) for the renderer origin. The renderer
  loads only trusted local content under a strict CSP with no remote navigation, so practical exploitability
  is low — but Electron's own security checklist (item 5) requires an explicit deny-by-default handler.
- **Fix:** Add `session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(false))` and a
  matching `setPermissionCheckHandler` returning `false`, allow-listing only what the app actually needs
  (it captures audio via the display-media handler, which is independent of this).

### F2 — Whisper/ONNX model fetched at runtime with no integrity pinning / SRI (MEDIUM, known)
- **Evidence:** `src/renderer/src/lib/whisper.worker.ts:2-21` — `@huggingface/transformers` `pipeline(...)` with
  `env.allowLocalModels = false`; model `Xenova/whisper-tiny` is fetched on first Listen.
  CSP `connect-src` permits `https://huggingface.co https://cdn.jsdelivr.net https://*.hf.co`
  (`src/renderer/index.html`). No hash/SRI/version-pin on the downloaded weights or wasm.
- **Impact:** A compromised/poisoned HF or jsDelivr asset (TLS protects transit, not origin integrity) would
  load an attacker-chosen ONNX graph into the wasm runtime. Blast radius is constrained by the wasm sandbox,
  but transcript integrity and ONNX-runtime CVE exposure are real.
- **Fix:** Pin the model revision (`{ revision: '<sha>' }`), validate a known file hash before use, or vendor
  the model into `extraResources` and load locally. This is the previously-documented "Whisper CDN no-SRI" gap.

### F3 — Packaged `.map` files + stale release artifacts ship third-party source (LOW–MEDIUM)
- **Evidence:** `electron-builder.yml` excludes only `'!out/**/*.map'`. The packaged
  `release/mac-arm64/AskToto.app/.../app.asar` still contains dependency maps, e.g.
  `/node_modules/@anthropic-ai/sdk/api-promise.js.map` and many others (`asar list` output). The same asar
  also contains the **full ~200-grammar shiki set** (`/out/renderer/assets/abap-*.js`, `ada-*.js`,
  `apache-*.js`, …) which the **current** source no longer produces — the current `out/renderer/assets/` has
  only 16 files (`ls out/renderer/assets | wc -l` → 16). The release was packaged **before** the shiki trim.
- **Impact:** No *AskToto* proprietary source is exposed (see F4 — the app's own renderer build has zero maps),
  but third-party maps + dead grammar chunks bloat the artifact (portable `.exe` is 178 MB) and the shipped
  artifacts do not reflect current code.
- **Fix:** Broaden the glob to `'!**/*.map'`; rebuild `release/` from current source before signing/shipping.

### F4 — App's own source maps are NOT exposed (PASS / informational)
- **Evidence:** `find out -name "*.map"` → **none**; no `sourcemap` key in `electron.vite.config.ts`
  (Vite prod default is `false`). The renderer bundles (`out/renderer/assets/index-*.js`, etc.) ship with no
  adjacent `.map`. Proprietary renderer/business logic is not recoverable from the package.

### F5 — Renderer trust boundary correctly configured (PASS)
- **Evidence:** `src/main/index.ts:155-162` — `sandbox: true`, `contextIsolation: true`,
  `nodeIntegration: false`, `webSecurity: true`. No `nodeIntegrationInWorker`,
  `nodeIntegrationInSubFrames`, `enableRemoteModule`, `webviewTag`, `allowRunningInsecureContent`, or
  `experimentalFeatures` anywhere (`grep` → no matches). Preload exposes a single frozen `window.toto` API
  surface via `contextBridge.exposeInMainWorld` (`src/preload/index.ts:85`); no `ipcRenderer`/`require`/
  `process` leak to the page (`grep -rn "require(\|process\.\|node:" src/renderer/` → none).

### F6 — Content-Security-Policy is strict (PASS, with notes)
- **Evidence:** `src/renderer/index.html` meta CSP:
  `default-src 'self'; base-uri 'self'; object-src 'none'; form-action 'none'; frame-src 'none';`
  `script-src 'self' 'wasm-unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:;`
  with a `connect-src` allow-list of named provider hosts (no wildcard `https:`).
- **Strengths:** no `script-src 'unsafe-inline'`, no `unsafe-eval` (only `wasm-unsafe-eval`, needed by ONNX),
  `object-src 'none'`, `frame-src 'none'`, `base-uri 'self'`, `form-action 'none'`.
- **Notes (LOW):** (a) `style-src 'unsafe-inline'` is required by Tailwind/React inline styles — acceptable but
  it weakens style-injection defense. (b) CSP is delivered only via meta tag; there is **no** defense-in-depth
  header (`grep -rn "onHeadersReceived\|Content-Security-Policy" src/main/` → none). For `file://`-loaded
  content the meta CSP is honored, so this is hardening, not a hole.

### F7 — Navigation / window-open hardening (PASS)
- **Evidence:** `src/main/index.ts:176-182` — `setWindowOpenHandler` returns `{ action: 'deny' }` for every
  URL and only `shell.openExternal`s `https://` links; `will-navigate` calls `e.preventDefault()` for any URL
  other than the current document. Model-output links and `target="_blank"` anchors
  (`Settings.tsx`, `Onboarding.tsx`, all with `rel="noopener noreferrer"`) cannot navigate or spawn a
  preload-bearing child window.

### F8 — Single `dangerouslySetInnerHTML` sink is safe (LOW / documented)
- **Evidence:** Only one occurrence: `src/renderer/src/components/CodeBlock.tsx:115`,
  `dangerouslySetInnerHTML={{ __html: html }}` where `html` is produced by shiki
  `highlighter.codeToHtml(code, …)` (`CodeBlock.tsx:74`). Shiki HTML-escapes the source text and emits only
  `<span style="color:…">` nodes — no attacker-controlled markup survives. Markdown body is rendered by
  `streamdown@2.5.0` (`src/renderer/src/components/Markdown.tsx`), which builds a react-markdown AST (no raw
  HTML passthrough); `pre`/`code`/`table` are overridden by trusted components.
- **Residual:** the sink is fed LLM output. It is currently safe because shiki escapes; keep it that way —
  never pass un-highlighted model text through `__html`.

### F9 — No client-side secrets / token storage in the renderer (PASS)
- **Evidence:** `grep -rn "localStorage\|sessionStorage\|indexedDB" src/` → **none.** API keys never cross the
  bridge: `publicSettings()` exposes only `hasApiKey`/`hasKeys` booleans (`src/main/index.ts:110-127`); keys
  are read main-side via `getApiKey` only inside `ipcMain.handle(IPC.askStart…)` (`index.ts:497`). Renderer
  `setApiKey` sends the key one-way to main, which returns only `{ hasKeys }` (`preload/index.ts:39-44`).

### F10 — `npm audit` flags renderer-irrelevant but bundled main-process deps (MEDIUM, supply chain)
- **Evidence:** `npm audit --omit=dev` → **9 vulnerabilities (4 moderate, 5 high)**, all transitive under
  `@dust-tt/client` (`path-to-regexp` ReDoS GHSA-j3q9-mxjg-w52f, `qs` DoS GHSA-6rw7-vpxm-498p, `router`).
  These run in the **main** process HTTP client, not the renderer. `npm audit fix` is available.
- **Impact:** DoS-class only; reachability depends on whether the Dust client exercises those code paths.
  Listed here because it surfaced in the security sweep; primary owner is the supply-chain gate.

### F11 — DevTools not explicitly disabled in production (LOW)
- **Evidence:** no `devTools: false` in `webPreferences` (`src/main/index.ts:155-162`); no menu/accelerator
  opens devtools (`grep -rn "openDevTools" src/main/` → none).
- **Impact:** minor; a local user could still attach devtools to inspect the trusted renderer. Single-user
  local app → low. Consider `devTools: !app.isPackaged`.

---

## N/A domains (justified)
- **Server/API auth, CORS, rate limiting, session cookies** — N/A: no server; renderer talks only to the main
  process over IPC and to provider HTTPS APIs via vendor SDKs (main side).
- **Web XSS via DOM URLs / `window.open` / `location` sinks** — verified absent
  (`grep -rn "window.open\|location.href\|location.assign\|\.innerHTML\|eval(\|new Function" src/renderer/`
  → none beyond the audited CodeBlock sink).
- **Multi-tenant data isolation** — N/A: single local user.

## Commands run (evidence)
`grep` sweeps for the patterns above · `npm audit --omit=dev` · `find out -name "*.map"` ·
`asar list release/mac-arm64/AskToto.app/Contents/Resources/app.asar` · `ls out/renderer/assets`.
