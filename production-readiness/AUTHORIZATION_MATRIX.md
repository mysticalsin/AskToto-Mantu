# AskToto — Authorization Matrix (IPC channel × guard)

**Gate:** Gate 4 (Backend / API)
**Source of truth:** `src/main/index.ts` `registerIpc()` (lines 376-679), `src/main/auth.ts`,
`src/shared/ipc.ts`. **Date:** 2026-06-27

There is no inbound HTTP API and no RBAC roles (single local user). "Authorization" = the two
main-process gates every handler must pass:

- **`assertMainWindow(e)`** (`index.ts:83-92`) — sender must be the **main window's top frame**.
- **`requireAuth()`** (`auth.ts:152-155`) — true when Azure SSO unconfigured **or** user signed in.

Authoritative counts (`python3` over `index.ts`): **32 `ipcMain.handle` handlers**, **33
`assertMainWindow(` call sites** (32 handler calls + the function definition), **15 `requireAuth()`
call sites**. **Every one of the 32 handlers calls `assertMainWindow` as its first statement.**

Legend: ✅ present · ⬜ absent (by design — see note) · — n/a

| # | Channel (`IPC.*`) | line | assertMainWindow | requireAuth | zod / coercion | Sensitivity & notes |
|---|---|---|:--:|:--:|---|---|
| 1 | `settings:get` | 377 | ✅ | ⬜¹ | — | Returns `PublicSettings` (profile PII + contextDocs; **never raw keys**) |
| 2 | `permissions:get` | 381 | ✅ | ⬜ | — | OS permission status only |
| 3 | `settings:set` | 386 | ✅ | ⬜¹ | `validKeysOnly` safeParse + locked-keys | Persists sparse overrides |
| 4 | `settings:setApiKey` | 400 | ✅ | ⬜¹ | `SetApiKeyPayloadSchema` | Writes safeStorage-encrypted key |
| 5 | `settings:clearApiKey` | 407 | ✅ | ⬜ | `ClearApiKeyPayloadSchema` | Deletes a key file |
| 6 | `settings:testApiKey` | 414 | ✅ | ⬜¹ | `TestApiKeyPayloadSchema` | Outbound provider call |
| 7 | `dust:listAgents` | 420 | ✅ | ✅ | — | Dust API call (uses stored token) |
| 8 | `dust:importCli` | 427 | ✅ | ✅ | — | Spawns `security` to read Dust keychain |
| 9 | `auth:status` | 437 | ✅ | ⬜² | — | Reports SSO/sign-in state |
| 10 | `auth:signIn` | 441 | ✅ | ⬜² | — | Starts PKCE + loopback listener |
| 11 | `auth:signOut` | 445 | ✅ | ⬜² | — | Clears session |
| 12 | `capture:screen` | 450 | ✅ | ✅ (throws) | — | Screenshot → base64 (sensitive) |
| 13 | `ask:start` | 478 | ✅ | ✅ (streamError) | `AskStartSchema` | LLM call; key + prompt + image |
| 14 | `ask:cancel` | 565 | ✅ | ⬜³ | `String` coercion via map | Aborts caller's own in-flight stream |
| 15 | `audio:arm` | 571 | ✅ | ✅ (return) | `!!on` | Arms system-audio loopback |
| 16 | `transcript:save` | 577 | ✅ | ✅ (throws) | `SaveMeetingSchema` | Writes transcript to disk |
| 17 | `note:save` | 586 | ✅ | ✅ (throws) | `SaveNoteSchema` | Writes note to disk |
| 18 | `graphify:status` | 595 | ✅ | ✅ (safe default) | — | Read-only status |
| 19 | `graphify:rebuild` | 601 | ✅ | ✅ (throws) | — | Spawns python runner |
| 20 | `graphify:related` | 607 | ✅ | ✅ (safe default) | `String` + `basename` | Reads graph.json |
| 21 | `graphify:openGraph` | 613 | ✅ | ✅ (return '') | — | Opens fixed graph.html |
| 22 | `folder:pick` | 622 | ✅ | ⬜¹ | — | Native dir dialog; sets meetingsFolder |
| 23 | `path:open` | 632 | ✅ | ✅ (return '') | — | Opens fixed meetings folder |
| 24 | `recall:list` | 636 | ✅ | ✅ (return []) | — | Lists saved meetings |
| 25 | `recall:search` | 640 | ✅ | ✅ (return []) | `String(q ?? '')` | Keyword search over transcripts |
| 26 | `recall:open` | 644 | ✅ | ✅ (return '') | `String` + **`basename`** | **Path-traversal blocked** |
| 27 | `listening:state` | 654 | ✅ | ⬜³ | `!!on` | Tray recording indicator |
| 28 | `window:resize` | 659 | ✅ | ⬜³ | shape access | UI geometry |
| 29 | `window:mode` | 663 | ✅ | ⬜³ | `=== 'settings'` | UI geometry |
| 30 | `window:hide` | 667 | ✅ | ⬜³ | — | UI |
| 31 | `window:toggle` | 671 | ✅ | ⬜³ | — | UI |
| 32 | `window:quit` | 675 | ✅ | ⬜³ | — | Quits app |

Send-only channels (main → renderer, no handler, not authorizable): `stream:delta`, `stream:done`,
`stream:error`, `hotkey`, `meeting:detected` (`ipc.ts:49-69`).

---

## Notes on the `requireAuth`-absent (⬜) channels

**¹ Settings/key/folder pre-auth (channels 1, 3, 4, 6, 22).** These are intentionally reachable before
sign-in because the **SSO configuration itself** (`azureClientId/TenantId/AllowedDomain`) is entered
through `settings:set`, and the settings UI must render via `settings:get` to do it. Consequence: a
process that already controls the trusted main-window renderer can, pre-auth, **read profile PII +
imported contextDocs** (`settings:get`) and **write keys/folder**. Given `assertMainWindow` + sandbox +
contextIsolation, the only way to reach these is to already be the trusted renderer, so the practical
risk is low — but for "production with sensitive data" treat the **pre-auth readability of profile
PII/contextDocs as a LOW posture item**: ideally gate `settings:get`'s PII fields behind `requireAuth`
while keeping the SSO-config fields readable.

**² Auth lifecycle (channels 9-11).** Gating sign-in/sign-out/status on `requireAuth` would be circular.
Correctly ungated.

**³ UI/no-op channels (14, 27-32).** These move/hide/quit the window, toggle a tray label, or abort the
caller's **own** stream by id (`streams.get(id)?.abort()`). No data exposure, no privileged side effect
beyond the local window. Acceptable ungated.

---

## Enforcement caveat (the one that actually matters for prod)

`requireAuth()` returns **true when SSO is unconfigured** (`auth.ts:152-155`). So in a default build
with no `managed-config.json` / env, **all the ✅ requireAuth gates above evaluate to "allowed"**. The
matrix is correct *as written*, but its protective value is only realized once an admin deploys the
machine-wide `managed-config.json` (`store.ts:78-83`, admin-only write path) or sets
`AZURE_CLIENT_ID/AZURE_TENANT_ID/ASKTOTO_ALLOWED_DOMAIN`. **Release blocker for sensitive-data
deployments:** ship that managed config so the identity gate is live. Until then, mark the
"auth enforced" gate **UNKNOWN/at-risk**, not PASS.

---

## Matrix gate summary

| Gate | Status | Evidence |
|---|---|---|
| Origin check on 100% of handlers | **PASS** | 32/32 `assertMainWindow` |
| Identity check on data/privileged channels | **PASS** | 15 `requireAuth` sites cover all data handlers |
| Identity check ungated only where justified | **PASS** | notes ¹²³ |
| Identity gate actually **enforced** in prod | **UNKNOWN** | depends on deployed managed-config / env |
| Pre-auth PII exposure via `settings:get` | **LOW finding** | profile/contextDocs readable before sign-in |
