# AskToto — Architecture & Trust Boundary

Electron app with the standard 4-layer split. **The trust boundary is the main process.** The
renderer is treated as untrusted (it renders model output and any text on screen); every privileged
action crosses into main via a contextBridge + `ipcMain.handle` gate.

## Layers

| Layer | Path | Runtime | Trust |
|-------|------|---------|-------|
| Main | `src/main/*` | Node + Electron, full OS access | **Trusted** — owns keys, FS, child processes, network |
| Preload | `src/preload/index.ts` | Isolated world, `contextBridge` | Bridge only; exposes `window.toto` (no `ipcRenderer`, no Node) |
| Renderer | `src/renderer/src/*` | Chromium, `sandbox:true` | **Untrusted** — React UI, Whisper worker; no keys, no Node |
| Shared | `src/shared/*` | Imported by both | Pure: zod IPC schemas, provider table, routing, prompts |

## Trust-boundary enforcement

| Control | Implementation | Evidence |
|---------|----------------|----------|
| Sender verification | `assertMainWindow(e)` — sender must be the main window's **top frame**, URL-matched; rejects subframes/devtools | `index.ts:83-92` |
| Auth gate | `requireAuth()` on privileged handlers (ask, capture, save, recall, dust, graphify) | `auth.ts:152-155` |
| Key isolation | Renderer gets `PublicSettings` (booleans `hasApiKey`/`hasKeys` only); raw keys never serialized out | `index.ts:110-127`, `ipc.ts:231-239` |
| Input validation | zod parse at every boundary (`AskStartSchema`, `SaveMeetingSchema`, `SetApiKeyPayloadSchema`, `ProviderIdSchema`) | `index.ts:402,409,492,580`; `ipc.ts` |
| Path-traversal block | `recall:open` uses `basename()` before join | `index.ts:648` |
| Nav / popup lockdown | `will-navigate` cancelled; `setWindowOpenHandler` denies child windows, opens https externally | `index.ts:176-182` |
| Loopback media gate | `setDisplayMediaRequestHandler` grants `audio:'loopback'` ONLY when `audioArmed`, main frame, origin-matched, audio-only (never video) | `index.ts:706-746` |
| Injection guard | Untrusted modes (suggest/summary/recap/vision) append `INJECTION_GUARD` to system prompt | `personas.ts:70-77`, `prompts.ts:51` |

## BrowserWindow security flags (`index.ts:139-167`)

| Flag | Value | Purpose |
|------|-------|---------|
| `contextIsolation` | true | isolate preload from page |
| `sandbox` | true | renderer in OS sandbox |
| `nodeIntegration` | false | no Node in renderer |
| `webSecurity` | true | enforce same-origin/CSP |
| `backgroundThrottling` | false | keep overlay responsive |
| `frame` / `transparent` | false / true | frameless glass overlay |
| content protection | `setContentProtection(on)` (default on; env-disable for dev) | hide from screen capture |
| always-on-top / all-workspaces / hidden-in-mission-control | set | overlay behavior |
| `app.dock.hide()` (mac) + `skipTaskbar` | yes | menubar/tray-only app |

## Configuration precedence

- Settings: `DEFAULT_SETTINGS` < machine+user `managed-config.json` (live org policy) < user `settings.json` overrides; locked keys reject user edits (`store.ts:142-184`).
- Azure SSO config: env > machine managed-config > per-user managed-config > in-app Settings (org lock can't be loosened from UI) (`auth.ts:85-99`).

## Component diagram (text)

```
                         ┌─────────────────────────── USER MACHINE ───────────────────────────┐
                         │                                                                     │
  ┌──────────────┐  IPC  │  ┌────────── RENDERER (Chromium, sandbox) ──────────┐               │
  │ Global       │ events│  │ React glass UI (Bar/Panel/Settings/Recall)        │               │
  │ shortcuts/   │◀──────┼──│   ├─ useListen → AudioWorklet → whisper.worker ───┼─▶ HF CDN      │
  │ Tray/Poller  │       │  │   │     (on-device Whisper ASR, model fetch)       │   (no SRI)   │
  └──────┬───────┘       │  └───────────────┬───────────────────────────────────┘               │
         │               │                  │ window.toto (contextBridge, preload)               │
         │               │   ═══════════════╪═══════════ TRUST BOUNDARY ═══════════════          │
         ▼               │                  ▼  ipcMain.handle + assertMainWindow + requireAuth    │
  ┌────────────────────────── MAIN (Node, trusted) ─────────────────────────────────┐           │
  │ index.ts  ── store.ts (safeStorage keys/settings)   auth.ts (MSAL ─┐)            │           │
  │   │         personas/prompts  llm.ts (streams)      transcripts.ts │            │           │
  │   ├─ desktopCapturer (screenshot)                   recall.ts      │            │           │
  │   ├─ meeting-detect → osascript / powershell / desktopCapturer     │            │           │
  │   ├─ graphify.ts → python graphify_runner.py + local `claude` CLI  │            │           │
  │   └─ dustcli.ts → `security` (read Dust keychain)                  │            │           │
  └───────┬─────────────┬──────────────┬──────────────┬───────────────┼────────────┘           │
          │             │              │              │               │                         │
   notes folder   userData/*.bin   temp decrypt   loopback HTTP   localhost:port                │
   (OneDrive)     (encrypted)                      127.0.0.1      (PKCE redirect)                │
          └─────────────────────────────────────────────────────────────────────────────────────┘
                  │                │                │                     │
                  ▼                ▼                ▼                     ▼
            Provider APIs     Dust API        Microsoft Entra      electron-updater host
        (Anthropic/OpenAI/…)  (dust.tt)   (login.microsoftonline)  (REPLACE-WITH placeholder)
```
