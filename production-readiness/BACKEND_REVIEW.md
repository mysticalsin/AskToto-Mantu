# AskToto — Backend (Main-Process) Review

**Scope:** `src/main/**`, `src/preload/index.ts`, `src/shared/{ipc,providers,routing,prompts}.ts`
**Gate:** Gate 4 (Backend / API)
**Reviewer posture:** Senior main-process engineer, production-readiness blocker.
**Date:** 2026-06-27

> AskToto is a **local Electron desktop app** (macOS + Windows). There is **no inbound server, no
> database, no multi-tenant backend, no cloud infra**. The "backend" under review is the **Electron
> main process** acting as the trust boundary, plus the **outbound** calls it makes to LLM providers
> and to Dust. Cloud/infra gates are marked **N/A with justification** below — they are not faked.

---

## 1. Trust boundary — verified solid

Every privileged action lives behind `ipcMain.handle` in the main process, and **all 32 handlers call
`assertMainWindow(event)` as their first statement** (authoritative count):

```
$ python3 -c "...count ipcMain.handle / assertMainWindow..."
total handlers: 32
assertMainWindow( call sites: 33   # 32 handler calls + 1 function definition
requireAuth() call sites: 15
```

`assertMainWindow` (`src/main/index.ts:83-92`) rejects any sender that is not the main window's top
frame:

```ts
if (event.sender !== win.webContents) throw new Error('IPC denied: sender is not the main window')
const frame = event.senderFrame
if (!frame || frame.parent !== null || frame.url !== win.webContents.getURL())
  throw new Error('IPC denied: not main frame')
```

Window hardening is correct (`createWindow`, `src/main/index.ts:155-182`):
`contextIsolation:true`, `sandbox:true`, `nodeIntegration:false`, `webSecurity:true`,
`setWindowOpenHandler` denies all child windows (https links → `shell.openExternal`),
`will-navigate` is blocked. The preload (`src/preload/index.ts`) exposes only a fixed, typed `toto`
API over `contextBridge` — the renderer cannot reach `ipcRenderer.invoke` with an arbitrary channel.

**Verdict: PASS.** No privileged channel is missing the sender check. See `AUTHORIZATION_MATRIX.md`
for the per-channel table.

---

## 2. Input validation (zod) — PASS

All structured IPC payloads are parsed with zod before use:

| Channel | Schema | Location |
|---|---|---|
| `ask:start` | `AskStartSchema` (incl. base64 image ≤5.5 MB + charset refine) | `index.ts:492`, `ipc.ts:118-134` |
| `settings:setApiKey` | `SetApiKeyPayloadSchema` | `index.ts:402` |
| `settings:clearApiKey` | `ClearApiKeyPayloadSchema` | `index.ts:409` |
| `settings:testApiKey` | `TestApiKeyPayloadSchema` | `index.ts:416` |
| `transcript:save` | `SaveMeetingSchema` | `index.ts:580` |
| `note:save` | `SaveNoteSchema` | `index.ts:589` |
| `settings:set` | `validKeysOnly()` per-field safeParse against `BaseSettingsSchema` | `store.ts:45-54,166` |

Scalar channels coerce defensively (`String(q ?? '')`, `!!on`, `mode === 'settings'`). `provider`
enums are validated against `ProviderIdSchema`, which is kept in compile-time parity with the
`ProviderId` union (`ipc.ts:21-29`). `settings:set` additionally enforces **locked keys** (IT policy)
and persists only sparse user overrides (`store.ts:162-184`).

---

## 3. Path traversal — PASS

`recall:open` is the only channel that turns renderer input into a filesystem path. It is constrained
to the meetings folder via `basename` (`index.ts:644-652`):

```ts
const path = join(folder, basename(String(file ?? ''))) // basename blocks traversal
```

`graphify:related` reduces inputs to `basename` inside `computeRelated` (`graphify.ts:271`).
`path:open` opens a fixed, settings-derived folder (no renderer input). `decryptToTemp` writes only
to `app.getPath('temp')` with a `basename`-derived name (`transcripts.ts:65-69`). The `selftest.ts`
suite explicitly asserts `ProviderIdSchema` rejects `../../etc/passwd` (`selftest.ts:124-135`).

---

## 4. Child-process spawns — PASS (no shell, no untrusted interpolation)

All spawns use `execFile` with an **argv array (no shell)**. None interpolate untrusted renderer data
into a command string:

- **graphify** (`graphify.ts:211`): `execFile(python, [runnerPath(), 'build', '--input', notes, '--out', outDir, '--backend', picked.backend])`. `backend` ∈ {`claude-cli`,`claude`,`openai`} (fixed). The **API key is passed via `GRAPHIFY_API_KEY` env, never argv** (`graphify.ts:212`; `graphify_runner.py` reads `os.environ`), so it can't leak into the process list. PATH is augmented only with **existing** known bin dirs (`graphify.ts:41-45`). A resolved shebang interpreter is regex-validated `^[\w./-]+$` before use (`graphify.ts:98`).
- **dustcli** (`dustcli.ts:31-39`): `execFile('security', ['find-generic-password','-s',service(),'-a',account,'-w'])`. `service()` is env/constant, `account` is a module constant. No renderer input reaches it.
- **meeting-detect mac** (`mac.ts:143`): `execFile('osascript', ['-e', script])` where `script` is built **only from hardcoded constants** (`MAC_NATIVE_APPS`, `MAC_BROWSERS`, `MEETING_KEYWORDS`, `MEETING_URL_PATTERNS`). **User `customMeetingApps` are NOT inlined into the AppleScript** — they are only used by the JS-side `titleLooksLikeMeeting` / CGWindow fallback (`mac.ts:150-164`). This closes the obvious injection vector.
- **meeting-detect win** (`win.ts:44-53`): `execFile('powershell.exe', ['-NoProfile','-NonInteractive','-Command', script])` with **static** scripts; `customMeetingApps` are compared in JS (`nativeWindowMatches`), never injected into PowerShell.

**Verdict: PASS** for command/arg injection across `dustcli`, `graphify`, and `meeting-detect`.

---

## 5. Stream lifecycle (`llm.ts`) — PASS with one MEDIUM (no timeout)

Each provider branch guards against **double-settle** and **abort-as-error**:

- **Anthropic** (`llm.ts:183-218`): `settled`/`aborted` flags; `fail()` returns early if
  `settled||aborted`; `finalMessage().then` guards `if (settled) return`. Abort sets `aborted` so the
  rejected `finalMessage` does not emit `onError`. No path emits both `onDone` and `onError`.
- **Dust** (`llm.ts:115-181`): `settled` flag; `onDone` fired once (guarded) on either
  `agent_message_success` or stream end; `agent_error`/`user_message_error` → guarded `fail`; abort is
  swallowed via `controller.signal.aborted`.
- **OpenAI-compatible** (`llm.ts:221-263`): single linear async fn — exactly one of `onDone`/`onError`
  runs; abort returns silently.

`index.ts` registers each handle in `streams` and deletes it on done/error/cancel (`index.ts:547-568`).

**MEDIUM — no per-stream timeout.** The OpenAI and Dust branches set no request timeout. A provider
that accepts the connection but never streams or closes leaves the `streams` Map entry and the open
`AbortController` alive indefinitely (slow resource leak; the renderer's spinner also hangs). The
Anthropic SDK has internal timeouts; the other two do not. *Fix:* pass an `AbortSignal.timeout(...)` (or
the SDK `timeout` option) and reject after a ceiling (e.g. 120 s) so hung streams self-clean.

---

## 6. Async-fs on the main thread — FAIL (known MEDIUM, confirmed)

`recall.ts` reads the entire transcript corpus **synchronously on the IPC/main thread**:

- `searchMeetings` (`recall.ts:60-88`) calls `readdirSync` then `readSavedFile` (→ `readFileSync`,
  `transcripts.ts:20-26`) for **every** `.md` file, plus a full lowercase + `split` per term. With a
  large OneDrive-synced meetings folder this blocks the main process → UI jank / unresponsive overlay.
- `listMeetings` (`recall.ts:51-57`) reads + parses frontmatter of every file synchronously.
- `transcripts.ts` writes (`writeFileSync`/`appendFileSync`/`renameSync`) and `store.ts getSettings`
  (`readFileSync` on every call) are also sync, but small/fast — lower impact.

*Fix:* move `recall` list/search to `fs.promises` (or a worker), and cache `getSettings` between
writes. This is the previously-deferred medium; it remains open.

---

## 7. Error handling / secret hygiene — PASS (one LOW caveat)

- **No stack traces** are sent to the renderer — handlers forward only `e.message`
  (`index.ts:558-561`, `llm.ts:13`, `store.ts:260`).
- **Keys never reach the renderer.** `PublicSettings` exposes only `hasApiKey`/`hasKeys` booleans
  (`index.ts:110-127`, `ipc.ts:230-239`). Keys are stored via `safeStorage` (`store.ts:201`), settings
  encrypted at rest with the `ATKENC1` marker (`store.ts:104,130-140`), file mode `0o600`, atomic
  temp+rename. Verified no `console.log` prints key/token variables (`grep` returned none).
- **LOW — own-key echo in provider errors.** `onError`/`testApiKey` forward the provider SDK's raw
  message verbatim (`llm.ts:260`, `store.ts:259-262`). Some providers echo a redacted key fragment
  (e.g. OpenAI `Incorrect API key sk-…`). Because AskToto is single-user/local, this only ever surfaces
  the user's **own** key to their own UI — not a cross-tenant exposure — but a redaction pass would be
  tidier.
- **LOW — verbose third-party logging.** `new DustAPI(..., console)` (`llm.ts:127`, `store.ts:227,278`)
  passes `console` as the SDK logger. I inspected `@dust-tt/client` — `this._logger` is used only for
  `.error(...)`/`.log(...)` of error objects (e.g. `{error:e},"Failed processing event stream"`), **not
  the Authorization header**, so this is noise-to-stdout, not a token leak. Prefer a quiet/redacting
  logger anyway.

---

## 8. Auth gate posture (production with sensitive data)

`requireAuth()` (`auth.ts:152-155`) returns **true when Azure SSO is unconfigured** (dev/single-user).
With sensitive data (transcripts, profile PII, provider keys, Dust OAuth token), shipping without a
configured tenant means **no identity gate** — every data handler is reachable by anyone at the machine.
This is by design for single-user, but for "production with sensitive data" it is a **posture gap**: the
release should ship a deployed `managed-config.json` (admin path, `store.ts:78-83`) that sets
`AZURE_CLIENT_ID/TENANT_ID/ALLOWED_DOMAIN` so `requireAuth` actually enforces. The OAuth flow itself is
sound: PKCE S256 public client, loopback `127.0.0.1` random-port listener, single request, 5-min
timeout, tenant + domain checks on the id-token claims (`auth.ts:174-241`).

---

## 9. Build / release plumbing notes

- `loadDotEnv` runs **only in dev** (`index.ts:700`, `if (!app.isPackaged)`) — production never reads a
  stray `.env`. Confirmed `.env` `NVIDIA_API_KEY` is **empty** (rotate-and-removed as documented).
- **LOW — unsigned auto-update path.** `updater.ts` is inert today (publish URL is the
  `REPLACE-WITH-...` placeholder, `electron-builder.yml:69`, so `initAutoUpdate` early-returns). But
  `win.verifyUpdateCodeSignature:false` (`electron-builder.yml:47`) plus unconfigured signing means
  that **once an update host is set with unsigned builds**, a compromised host could push unsigned
  updates. Gate this behind real code-signing before enabling updates.
- `typecheck` passes clean; `vitest` is **59/59 green outside the sandbox** (the 3 `dustcli.test.ts`
  failures seen in-sandbox are the macOS keychain write `security add-generic-password` being blocked by
  the command sandbox — confirmed PASS 4/4 when re-run unsandboxed).

---

## Gate summary (Backend)

| Gate | Status | Evidence |
|---|---|---|
| `assertMainWindow` on every privileged channel | **PASS** | 32/32 handlers |
| `requireAuth` on data/privileged channels | **PASS** | 15 sites; UI/settings/auth ungated by design |
| zod IPC payload validation | **PASS** | all structured payloads parsed |
| Path traversal (recall:open / openPath) | **PASS** | `basename` guard |
| Child-process injection | **PASS** | `execFile` argv, no shell, key via env |
| Stream double-settle / abort | **PASS** | per-branch flags |
| Stream timeout / resource cleanup | **FAIL** | no timeout on OpenAI/Dust streams |
| Async-fs off main thread | **FAIL** | sync reads in `recall.ts` list/search |
| Error/secret leak to renderer | **PASS** | message-only, keys never exposed |
| Auth enforced for sensitive-data prod | **UNKNOWN** | depends on deployed managed-config |
| Inbound server / DB / rate-limit | **N/A** | no inbound server, no DB (justified) |
