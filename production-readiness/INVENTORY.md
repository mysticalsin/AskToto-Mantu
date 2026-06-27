# AskToto — Phase 1 Inventory

Local Electron desktop app (macOS + Windows). No server, DB, multi-tenant backend, containers, or
cloud IAM. All "infrastructure" is the user's own machine + the provider APIs their key talks to.
Source root: `src/` (electron-vite: `src/main`, `src/preload`, `src/renderer`, `src/shared`).

## Repository / packaging

| Item | Value | Evidence |
|------|-------|----------|
| VCS | NOT a git repo (no `.git`); not yet initialized | env note + `ls -la` (no `.git`) |
| Package name / version | `asktoto` `0.1.0` | `package.json:2-3` |
| Build tool | electron-vite + Vite 5 + Tailwind v4 | `package.json:8-16`, `electron.vite.config.ts` |
| Packager | electron-builder (dmg, zip, nsis, portable, appx) | `electron-builder.yml:24-64` |
| App id | `com.mantu.asktoto` | `electron-builder.yml:1` |
| On-disk location | Under OneDrive sync root (cloud-sync exposure for repo + `.env`) | cwd path, `.env:1-3` |
| CI | GitHub Actions `Build & Test` (typecheck/build/test + mac/win package) | `.github/workflows/build.yml` |

## OS processes & spawned children

| Process | Role / trust | Spawned from |
|---------|--------------|--------------|
| Main (Electron/Node) | **Trust boundary.** IPC handlers, key store, auth, LLM streams | `src/main/index.ts` |
| Preload | Isolated `contextBridge` → `window.toto` only | `src/preload/index.ts:85` |
| Renderer (Chromium) | React glass UI; `sandbox:true`, `nodeIntegration:false` | `src/main/index.ts:155-162` |
| `whisper.worker.ts` | Web Worker; on-device Whisper ASR (HF transformers) | `listen.ts:92` |
| `whisper-worklet.ts` | AudioWorklet; 16 kHz frame capture | `listen.ts:149-151` |
| `osascript` (child) | macOS meeting detection (AppleScript) | `meeting-detect/mac.ts:143` |
| `powershell.exe` (child) | Windows meeting detection (UI Automation) | `meeting-detect/win.ts:44` |
| `security` (child) | macOS keychain read of Dust CLI session | `dustcli.ts:31` |
| `python` + `graphify_runner.py` (child) | Knowledge-graph extraction over notes | `graphify.ts:211`, `resources/graphify_runner.py` |
| `claude` CLI (probed) | graphify `claude-cli` backend (no API key) | `graphify.ts:125-141` |
| Loopback HTTP server (`127.0.0.1:0`) | Azure AD PKCE redirect catcher (ephemeral, 5-min timeout) | `auth.ts:176-213` |
| Single-instance lock | Prevents 2nd instance | `index.ts:681-689` |

## IPC channels (`src/shared/ipc.ts:32-70`)

All `ipcMain.handle` callbacks call `assertMainWindow(e)` (sender = top frame of main window).
`requireAuth()` = extra Azure-SSO gate (no-op when SSO unconfigured — see ARCHITECTURE/UNKNOWN).

| Channel | Handler | requireAuth? | Notes |
|---------|---------|:---:|-------|
| `settings:get` | `index.ts:377` | no | returns `PublicSettings` (no raw keys) |
| `settings:set` | `index.ts:386` | no | drops locked keys; re-registers shortcuts |
| `settings:setApiKey` | `index.ts:400` | no | writes safeStorage-encrypted key file |
| `settings:clearApiKey` | `index.ts:407` | no | |
| `settings:testApiKey` | `index.ts:414` | no | live provider round-trip |
| `dust:listAgents` | `index.ts:420` | **yes** | |
| `dust:importCli` | `index.ts:427` | **yes** | reads OS keychain, stores Dust token |
| `graphify:status/rebuild/related/openGraph` | `index.ts:595-620` | **yes** | spawns python / opens html |
| `auth:status/signIn/signOut` | `index.ts:437-448` | no | |
| `capture:screen` | `index.ts:450` | **yes** | desktopCapturer screenshot → base64 JPEG |
| `ask:start` | `index.ts:478` | **yes** | starts LLM stream |
| `ask:cancel` | `index.ts:565` | no | aborts stream |
| `audio:arm` | `index.ts:571` | **yes** | arms loopback for one Listen |
| `transcript:save` / `note:save` | `index.ts:577-593` | **yes** | writes markdown to notes folder |
| `folder:pick` / `path:open` | `index.ts:622-635` | pick:no / open:yes | |
| `recall:list/search/open` | `index.ts:636-652` | **yes** | `basename()` blocks path traversal (`:648`) |
| `listening:state` | `index.ts:654` | no | tray recording indicator |
| `window:resize/mode/hide/toggle/quit` | `index.ts:659-678` | no | |
| `permissions:get` | `index.ts:381` | no | |
| Main→renderer sends | `stream:delta/done/error`, `hotkey`, `meeting:detected` | — | one-way events |

## LLM providers (`src/shared/providers.ts:37-243`)

14 provider ids, 3 wire protocols (`anthropic` SDK, `openai`-compatible, `dust`). User supplies the
key; AskToto ships none. Tier routing base/think in `routing.ts` + `resolveModelTier`.

| Protocol | Providers |
|----------|-----------|
| anthropic | `anthropic` (default; Opus/Sonnet/Haiku) |
| openai-compatible | `openai`, `nvidia`, `deepseek`, `qwen`, `minimax`, `kimi`, `openrouter`, `groq`, `together`, `fireworks`, `mistral`, `custom` |
| dust | `dust` (routes to user's own Dust agent by sId) |

## Background jobs / timers

| Job | Interval | Source |
|-----|----------|--------|
| Meeting poller | 7 s (gated on `autoStartOnMeeting`) | `index.ts:312-335` |
| graphify auto-rebuild | 20 s debounce after each save | `graphify.ts:231-243` |
| Auto-update check | once per launch (packaged + real host only) | `updater.ts`, `index.ts:753` |

## External integrations / dependencies

| Integration | Purpose | Evidence |
|-------------|---------|----------|
| `@anthropic-ai/sdk` | Claude streaming | `llm.ts:191`, `package.json:20` |
| `openai` | OpenAI-compatible streaming | `llm.ts:221` |
| `@dust-tt/client` | Dust agent conversations | `llm.ts:126`, `store.ts:226` |
| `@azure/msal-node` | Optional Entra SSO (PKCE public client) | `auth.ts:163`, lazy-loaded |
| `@huggingface/transformers` | On-device Whisper ASR; model from HF CDN (no SRI) | `whisper.worker.ts:2,19` |
| `electron-updater` / `electron-log` | Auto-update + logging | `updater.ts` |
| graphify (python) + local `claude` CLI | Notes knowledge graph | `graphify.ts`, `graphify_runner.py` |
| Dust CLI (keytar) via `security` | Import existing Dust session | `dustcli.ts` |
| OneDrive folder | Default transcript notes location | `transcripts.ts:118-150` |

## Secrets & sensitive-data locations (all under `app.getPath('userData')` unless noted)

| Secret / data | Location | Protection | Evidence |
|---------------|----------|-----------|----------|
| Provider API keys | `userData/key-<provider>.bin` | safeStorage-encrypted; `mode 0o600`; throws if keychain unavailable | `store.ts:17,186-202` |
| Provider keys (env) | `ANTHROPIC_API_KEY` etc. (env > file) | process env only | `store.ts:19-34,296-298` |
| Settings + profile PII + context docs | `userData/settings.json` | `ATKENC1` safeStorage-encrypted whole file; atomic write `0o600` | `store.ts:104,129-184` |
| Azure identity/session | `userData/auth-session.bin` | safeStorage-encrypted; `0o600` | `auth.ts:101-131` |
| Managed org policy | `userData/managed-config.json` + machine path | plaintext config (no secrets); admin path wins | `store.ts:78-91` |
| Meeting transcripts / notes | notes folder (default OneDrive `AskToto Meetings/`) | plaintext markdown by default; opt-in `ATKENC1` encryption | `transcripts.ts:39-62,202,257` |
| `index.md` (titles/dates) | notes folder | plaintext; **skipped** when encryption on | `transcripts.ts:204-209,259-263` |
| `.env` | repo root (gitignored) | **OneDrive-synced**; only empty `NVIDIA_API_KEY=` present | `.env`, `.gitignore` |
| Dust OAuth token | imported → stored as `key-dust.bin` | safeStorage-encrypted | `index.ts:432`, `dustcli.ts` |
| Signing certs | env-driven (`CSC_LINK`, `APPLE_*`, `WIN_CSC_*`) | NOT configured (see UNKNOWN) | `electron-builder.yml:5-7,48` |
