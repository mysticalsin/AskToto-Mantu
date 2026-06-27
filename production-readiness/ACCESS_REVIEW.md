# AskToto — Access Review

Scope: who/what can reach privileged actions and sensitive data in AskToto 0.1.0. There is **no cloud
IAM, no RBAC, no multi-tenant backend** — access control is (a) the OS user account, (b) the Electron
trust boundary, and (c) optional Microsoft Entra SSO. Evidence = `file:line`.

Date: 2026-06-27.

---

## 1. Identities / principals

| Principal | Authentication | Authorization scope |
|-----------|----------------|---------------------|
| OS user account | OS login | Owns `userData/*` and the notes folder; root of all access (safeStorage is bound to this account) |
| Signed-in Entra user (optional) | Azure AD PKCE, tenant + domain locked | Gates privileged IPC via `requireAuth()` *when configured* |
| Renderer (Chromium) | n/a — **untrusted** | Only `window.toto` bridge; no keys, no Node, sandboxed |
| IT / admin | machine-wide managed-config (admin-writable path) | Can preset + **lock** settings, set tenant lock |

## 2. Trust-boundary enforcement (verified)

Every privileged `ipcMain.handle` runs two checks:

- `assertMainWindow(e)` — sender must be the main window's top frame, URL-matched; rejects subframes /
  devtools (`index.ts:83-92`).
- `requireAuth()` — extra Entra gate on ask/capture/save/recall/dust/graphify (`auth.ts:152-155`).

Privileged channels requiring auth (from `INVENTORY.md`, re-verified): `dust:listAgents`,
`dust:importCli`, `graphify:*`, `capture:screen`, `ask:start`, `audio:arm`, `transcript:save`,
`note:save`, `recall:list/search/open`, `path:open`. Key isolation: renderer only ever receives
`PublicSettings` (`hasKeys` booleans), never raw keys (`index.ts:110-127`, `store.ts:312-316`).

## 3. The auth posture gap (central finding)

`requireAuth()` returns **true** when Entra SSO is not configured (`auth.ts:152-159`). This is the
intended dev/single-user default, but for "production with sensitive data" it means there is **no
application-level authentication** — the only gate is the OS account.

For a genuinely single-user local tool that is acceptable (the OS login *is* the access control). For a
managed enterprise rollout where per-user attribution is required, SSO must be turned on and locked:

- Provision an Entra app registration (`AZURE_CLIENT_ID` / `AZURE_TENANT_ID` / `ASKTOTO_ALLOWED_DOMAIN`)
  via env or machine-wide managed-config (`auth.ts:16-22,85-99`).
- Machine policy overrides per-user and the in-app UI, so the tenant lock cannot be loosened locally
  (`auth.ts:48-58,80-99`; `store.ts:78-98`).
- Lock keys with the `locked` array in managed-config (`store.ts:67-98`, `build/managed-config.example.json`).

## 4. OS-level access (hardware / data)

| Resource | Gate | Evidence |
|----------|------|----------|
| Microphone | macOS TCC / Windows privacy | `platform-perms.ts:19-32` |
| Screen recording (capture + system audio) | macOS Screen Recording / Windows per-app | `platform-perms.ts:34-36`, `index.ts` displayMedia handler |
| Accessibility (meeting detect) | macOS AX; Windows not required | `platform-perms.ts:39-49` |
| System-audio loopback | granted only when `audioArmed`, main frame, audio-only | `index.ts:706-746` |
| Dust CLI keychain | OS keychain allow prompt via `security` | `dustcli.ts` |

## 5. Findings

| Sev | Title | Evidence | Fix |
|-----|-------|----------|-----|
| HIGH | No app-level authentication when Entra SSO unconfigured (default) | `auth.ts:152-159` | For sensitive/enterprise deployments, mandate SSO via machine-wide managed-config; document that OS login is the only gate otherwise |
| LOW | No Entra app registration shipped (SSO needs org provisioning) | `auth.ts:16-22`; `UNKNOWN_ITEMS.md #14` | IT provisions client/tenant; validate domain+tenant lock live |
| LOW | Managed-config admin path relies on OS file permissions for integrity | `store.ts:78-83` | Ensure the admin path is root/Administrators-writable only on deployed machines |

## 6. Justified N/A

- **RBAC / roles / least-privilege policies**: N/A — single user; the only "role" split is end-user vs
  IT-admin (managed-config), which is enforced by OS file permissions, not an IAM system.
- **Multi-tenant isolation / row-level security**: N/A — no shared datastore; one user, one machine.
- **Service-account / key-rotation infrastructure**: N/A — the only secrets are the user's own provider
  keys, rotated by clearing/re-entering them (`store.ts:204-207`).

## 7. Gate note

Feeds the access/authn gate (and Gate 13 privacy). Local access controls (trust boundary, OS account,
optional locked SSO) are **verified present**; the HIGH finding above is the condition for an enterprise
sensitive-data release.
