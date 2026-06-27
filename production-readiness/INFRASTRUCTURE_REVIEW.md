# AskToto — Infrastructure Review (Gate 6, Infra)

**Scope reality.** AskToto is a LOCAL Electron desktop app (macOS + Windows). There is **no server,
no database, no container/Kubernetes, no cloud IAM, no load balancer, no autoscaling, no VPC**. The
entire "infrastructure" is (a) the **user's own machine** and (b) the **Electron window/runtime
flags** that decide how privileged that machine-local process is. This review covers what actually
exists and marks the cloud-shaped items **N/A with justification**.

Reviewer posture: senior cloud/infra engineer with release-blocking authority.

---

## 1. Cloud / server infrastructure — N/A (justified)

| Domain | Status | Why N/A (evidence) |
|--------|--------|--------------------|
| Compute (VMs / containers / serverless) | N/A | App runs as a local Electron process; `package.json:5` `main: ./out/main/index.js`. No Dockerfile, no k8s manifests anywhere (`find` shows only `src/`, `build/`, `resources/`). |
| Datastore / DB | N/A | State is local files in `app.getPath('userData')` — `settings.json`, `key-*.bin`, `auth-session.bin`, `graph/` (`store.ts:15-17`, `auth.ts:101-103`, `graphify.ts:59-67`). No network DB. |
| Load balancer / ingress / DNS | N/A | No inbound service to balance. Only outbound calls + one transient loopback OAuth server (see NETWORK_SECURITY_REPORT.md). |
| Cloud IAM / VPC / security groups | N/A | No cloud tenancy. Identity is Azure SSO at the app layer only (see IAM_REVIEW.md). |
| Multi-tenant isolation | N/A | Single local user per install (`requestSingleInstanceLock` `index.ts:681`). |
| Secrets manager (Vault/KMS/Secrets Manager) | N/A → replaced by OS keychain | Secrets are encrypted at rest via Electron `safeStorage` (OS keychain), `store.ts:195-201`. |

The real "infrastructure" surface is therefore the **process sandbox + window flags + packaging/signing
+ update channel**, reviewed below.

---

## 2. Electron runtime hardening (the real trust boundary) — PASS

The main process is the trust boundary; the renderer is a sandboxed Chromium. Window is created with:

| Flag | Value | Evidence | Assessment |
|------|-------|----------|------------|
| `sandbox` | `true` | `index.ts:158` | PASS — renderer cannot touch Node. |
| `contextIsolation` | `true` | `index.ts:158` | PASS — preload world isolated. |
| `nodeIntegration` | `false` | `index.ts:159` | PASS. |
| `webSecurity` | `true` | `index.ts:161` | PASS — same-origin + CSP enforced. |
| `backgroundThrottling` | `false` | `index.ts:160` | OK (needed so live transcription keeps running when hidden). |
| Preload surface | `window.toto` only | `preload/index.ts:85`, `contextBridge.exposeInMainWorld` | PASS — no `ipcRenderer` leak. |
| IPC origin guard | every privileged handler calls `assertMainWindow()` | `index.ts:83-92`, called in all 30+ handlers | PASS — rejects subframes/devtools/foreign `webContents`. |
| `setWindowOpenHandler` | deny all; https → `shell.openExternal` | `index.ts:176-179` | PASS — child windows can't inherit the privileged preload. |
| `will-navigate` | prevented for any URL ≠ current | `index.ts:180-182` | PASS — renderer can't be navigated to attacker content. |
| `display-media` handler | audio loopback only, gated on `audioArmed` + main-frame + origin, never video | `index.ts:706-746` | PASS — strong; capture is opt-in per Listen. |

This is a well-hardened Electron baseline. No `nodeIntegration`, no `enableRemoteModule`, no disabled
`webSecurity`. Verified by `grep` — there is no `webSecurity:false`/`nodeIntegration:true` anywhere in `src/`.

---

## 3. Overlay / stealth window flags (the "infrastructure" of a Cluely-style overlay) — PASS

| Flag | Evidence | Purpose / assessment |
|------|----------|----------------------|
| `setAlwaysOnTop(true,'screen-saver')` | `index.ts:165` | Overlay floats above other apps. Expected. |
| `setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true})` | `index.ts:166` | Follows the user across spaces/fullscreen. Expected. |
| `setContentProtection(...)` | `index.ts:167`, toggled on settings change `index.ts:389` | **Privacy control**: hides the window from screen-capture / screen-share. Default comes from `getSettings().contentProtection` (`index.ts:69-72`). Can be disabled by env `ASKTOTO_DISABLE_CP` (dev/CI only — set in CI `build.yml`). PASS, but see Finding INF-3. |
| `setHiddenInMissionControl?.(true)` | `index.ts:168` | Hides from macOS Mission Control. Expected. |
| `frame:false, transparent:true, skipTaskbar:true, fullscreenable:false` | `index.ts:144-154` | Frameless glass overlay; not in taskbar/dock. |
| `app.dock?.hide()` + `LSUIElement:true` | `index.ts:702`, `electron-builder.yml` `extendInfo` | Agent/menubar app — no dock icon. |
| `requestSingleInstanceLock()` | `index.ts:681-689` | PASS — prevents a second instance racing the same userData/keys. |

Content protection is the load-bearing privacy control for an overlay that can render meeting
transcripts and AI answers on top of a shared screen. It is **on by default** and re-applied whenever
settings change. The only way to disable it is the user's own setting or the `ASKTOTO_DISABLE_CP` env
(documented as dev/screenshot only).

---

## 4. Packaging, code signing & notarization — **FAIL (blocks a distributable production release)**

| Item | Status | Evidence |
|------|--------|----------|
| Packager targets | dmg, zip, nsis, portable, appx | `electron-builder.yml:27-78` |
| `asar:true` | OK (source not loose on disk) | `electron-builder.yml` |
| macOS `hardenedRuntime:true` + entitlements | configured | `electron-builder.yml`, `build/entitlements.mac.plist` |
| Entitlements granted | `cs.allow-jit`, `cs.allow-unsigned-executable-memory`, `device.audio-input` | `build/entitlements.mac.plist` |
| **Code signing** | **NOT configured** — env-driven (`CSC_LINK`/`CSC_KEY_PASSWORD`, `APPLE_ID`…), no certs in repo/CI | `electron-builder.yml` comments; `build.yml` says "Signing is skipped on CI unless you add your Apple/Windows cert as a secret". |
| `gatekeeperAssess:false` (mac) | reduces local Gatekeeper assess at build | `electron-builder.yml` |
| `verifyUpdateCodeSignature:false` (win) | **disables update signature verification** | `electron-builder.yml` |

**Why this blocks release:** with signing unconfigured the produced dmg/exe are **unsigned/unnotarized**
→ Gatekeeper ("damaged / unidentified developer") and Windows SmartScreen warnings, and — combined with
§5 — the auto-updater cannot verify publisher authenticity. `verifyUpdateCodeSignature:false` further
means a swapped Windows update binary would not be rejected on signature grounds. The two
`allow-jit`/`allow-unsigned-executable-memory` entitlements are *required* by transformers.js WASM/JIT
but they grant RWX memory, weakening hardened-runtime guarantees (Finding INF-2).

---

## 5. Auto-update channel — **FAIL / UNKNOWN (not production-wired)**

| Item | Evidence | Assessment |
|------|----------|------------|
| Updater | `electron-updater`, `updater.ts:1-34` | Only runs when packaged. |
| Publish host | `https://REPLACE-WITH-YOUR-UPDATE-HOST/asktoto` (placeholder) | `electron-builder.yml` `publish:` |
| Guard | `updater.ts:14-21` skips if `app-update.yml` contains `REPLACE-WITH` | Good fail-safe — won't error every launch. |
| Behaviour when wired | `autoDownload:true`, `autoInstallOnAppQuit:true` | `updater.ts:25-26` |

The update host is a placeholder, so **today there is no update path** (skipped). When wired, integrity
of updates depends entirely on code signing (currently off, §4) and TLS to a static host. Until a real
**HTTPS** host + signing are configured, the update channel is not production-ready. UNKNOWN until a
real host is provisioned; FAIL if shipped with `autoInstallOnAppQuit` against an unsigned artifact.

---

## 6. Host machine / data-at-rest footprint — MEDIUM concern

| Item | Evidence | Assessment |
|------|----------|------------|
| Repo + `.env` live under OneDrive sync root | cwd `…/OneDrive-MantuGroup/…/AskToto`; `.env` present, gitignored | The project tree (incl. `.env`) is **cloud-synced to OneDrive**. `.env` here has only empty/placeholder values (`NVIDIA_API_KEY=` empty, two model-name vars) — verified `sed`-redacted — so no live secret is currently synced, but the pattern is fragile. |
| Meeting notes folder | defaults into a notes folder that "may sync to OneDrive" (project brief; `transcripts.ts` writes markdown) | Transcripts/PII can be **synced to the cloud by OneDrive**, outside AskToto's control. Mitigated by on-demand transcript encryption (`transcripts.ts writeSaved`), which is **off by default**. Finding INF-4. |
| Secrets at rest | `key-*.bin`, `settings.json` (ATKENC1), `auth-session.bin` — `safeStorage`-encrypted, `mode 0o600` | `store.ts:104-201`, `auth.ts:122-131` | PASS (see IAM_REVIEW.md). |

---

## 7. CI / build infrastructure — PARTIAL

`.github/workflows/build.yml`: `quality` job (typecheck + build + `npm test`) gates `build-macos` and
`build-windows` packaging jobs; artifacts uploaded. Reasonable. Gaps: (a) no `npm audit`/SCA step in CI
(supply-chain regressions land silently — see Finding INF-1); (b) signing secrets not present so CI
artifacts are unsigned; (c) the repo is **not a git repository** (env note + no `.git`) so the workflow
is currently inert until the project is initialized and pushed.

---

## Findings (Infrastructure)

- **INF-1 (HIGH) — Vulnerable transitive dependencies, no SCA gate.** `npm audit`: **27 vulns total
  (16 high, 11 moderate, 0 critical)**; production-only subset **9 (5 high)**, concentrated in
  `@dust-tt/client`'s bundled Express stack (`path-to-regexp` ReDoS GHSA-j3q9-mxjg-w52f /
  GHSA-27v5-c462-wpq7, `qs` DoS, `express`/`router`). Build tooling (`electron-builder`→`tar`/`cacache`)
  adds more. No `npm audit` step in CI. *Fix:* `npm audit fix`, pin/upgrade `@dust-tt/client`, add an
  audit/SCA gate to `build.yml`.
- **INF-2 (HIGH) — Unsigned, unnotarized artifacts + update-signature verification disabled.** Signing
  is env-driven and unconfigured; `verifyUpdateCodeSignature:false` (win); `gatekeeperAssess:false`.
  Distributing this yields Gatekeeper/SmartScreen warnings and an unverifiable update channel. *Fix:*
  provision Apple Developer ID + notarization and a Windows Authenticode/Azure Trusted Signing cert as
  CI secrets; set `verifyUpdateCodeSignature:true`.
- **INF-3 (MEDIUM) — Hardened-runtime weakened by RWX entitlements.** `cs.allow-jit` +
  `cs.allow-unsigned-executable-memory` (`build/entitlements.mac.plist`) grant writable-executable
  memory (needed for transformers.js WASM/JIT) but enlarge the exploit surface. *Fix:* document the
  trade-off; if on-device Whisper is later removed, drop both entitlements.
- **INF-4 (MEDIUM) — Sensitive transcripts/keys under OneDrive cloud sync.** The app tree (`.env`) and
  the default notes folder live under a OneDrive-synced path; transcript encryption is off by default.
  Meeting PII can leave the device via OneDrive. *Fix:* default `encryptTranscripts` on for sensitive
  deployments, or steer the notes folder outside the sync root; never place a populated `.env` under sync.
- **INF-5 (LOW) — Auto-update host is a placeholder.** No production update path today; integrity
  depends on §4. *Fix:* provision an HTTPS update host and re-test after signing is enabled.

## Gate verdict — Infrastructure
**Electron runtime hardening: PASS.** **Packaging/signing + update channel: FAIL** (unsigned, update
verification off, placeholder host). Cloud-infra domains: N/A (justified). Overall infra gate = **FAIL
until signing + a real update host are configured**; the runtime sandbox itself is production-grade.
