# AskToto — IAM Review (Gate 6, Identity & Access)

**Scope reality.** No cloud IAM, no roles/policies/STS, no multi-tenant directory to administer. Identity
in AskToto is: (1) an **optional Azure AD (Entra) SSO gate** that ties usage to a Mantu account, and
(2) **OS keychain ACLs** that protect secrets at rest. Both are app-local. Cloud-IAM constructs are
**N/A (justified)** and the two real mechanisms are reviewed in depth.

---

## 1. Cloud IAM constructs — N/A (justified)

| Construct | Status | Why N/A |
|-----------|--------|---------|
| Roles / policies / RBAC / ABAC | N/A | Single local user per install; no server to authorize against. The only "role" notion is "signed-in Mantu user vs not". |
| Service accounts / workload identity | N/A | No backend workloads. |
| STS / temporary credentials / assume-role | N/A | No cloud APIs assumed. The Dust token is an OAuth bearer minted by Dust's own CLI (see §4). |
| MFA / conditional access policy engine | N/A in-app → **delegated to Entra** | When SSO is configured, MFA/Conditional Access are enforced by the org's Entra tenant during the `login.microsoftonline.com` flow, not by AskToto. |
| Privileged access management / break-glass | N/A | No privileged cloud surface. |
| Key rotation policy (cloud KMS) | N/A → see §5 | Secrets are OS-keychain-encrypted blobs; rotation = user re-enters key. |

---

## 2. Azure AD (Entra) SSO gate — design — PASS (when configured)

`auth.ts` implements a tenant- and domain-locked Entra sign-in (MSAL public client + PKCE).

| Control | Evidence | Assessment |
|---------|----------|------------|
| Authority pinned to org tenant | `auth.ts:167` `authority: https://login.microsoftonline.com/${tenantId}` | PASS — not `/common`; sign-in is tenant-scoped. |
| Tenant check on token | `auth.ts:227-229` rejects if `claims.tid !== cfg.tenantId` | PASS — defense-in-depth even if authority were loosened. |
| Domain lock | `auth.ts:230-232` rejects unless `email.endsWith('@'+allowedDomain)` | PASS — only `@mantu.com`-style accounts pass. |
| PKCE | `auth.ts:170-171, 202-204` `S256` | PASS. |
| Scopes | `User.Read openid profile email` (`auth.ts:173`) | PASS — least-privilege, read-only identity. |
| Session persisted encrypted | `auth.ts:122-131` `safeStorage.encryptString`, `mode 0o600` | PASS. |
| Session invalidation on config change | `auth.ts:136-137` drops session if `domain` no longer matches | PASS. |
| Sign-out wipes session file | `auth.ts:247-254` `rmSync(sessionPath())` | PASS. |

**Config precedence (anti-tamper) — PASS, good design.** `readConfig()` resolves in order: env →
machine-wide managed-config (admin path) → per-user managed-config → in-app Settings
(`auth.ts:85-99`; admin path read **before** the per-user file in `readManagedAzure` `auth.ts:47-60`).
So an IT-deployed machine policy (`/Library/Application Support/AskToto/managed-config.json` on macOS,
`%ProgramData%\AskToto\…` on Windows) **cannot be loosened from the UI**, while the Settings fallback
keeps SSO self-serve when no policy is deployed. The `locked` array (`store.ts:94-98`) lets IT freeze
keys so users can't override them.

---

## 3. Auth enforcement at the trust boundary — PASS mechanism, **but HIGH posture gap by default**

`requireAuth()` (`auth.ts:152-155`) is called by every privileged main-process handler before doing
work — verified across `index.ts` (e.g. `askStart` 484, `captureScreen` 452, `saveTranscript` 579,
`recall*` 638-646, `dustListAgents` 422, `graphify*` 597-616, `armAudio` 573). This is the correct
trust boundary: the renderer `SignInWall` is cosmetic; main-process `requireAuth()` is authoritative.

**The gap:** `requireAuth()` returns **`true` when SSO is _not configured_** (`auth.ts:153-154`,
`!s.configured || s.signedIn`). In the default/single-user posture (no `AZURE_*` env, no managed-config,
no in-app Azure fields) **there is no identity gate at all** — anyone who can launch the binary can use
the screen capture, transcription, note recall, and the user's stored provider keys. This is
*intentional* for dev/single-user, but for "production with sensitive data" (meeting transcripts,
profile PII, provider keys) it means **access control is opt-in and off unless an admin configures
Entra + locks it via managed-config**. Finding IAM-1.

There is also **no local session re-auth / inactivity lock and no token-expiry enforcement** on the
persisted session: `Session.at` is stored (`auth.ts:239`) but never checked for age, so a saved session
is honored indefinitely until the domain config changes or the user signs out (`authStatus` `auth.ts:133-145`
does not expire it). Finding IAM-2.

---

## 4. Dust identity / token handling — PASS with note

- **Attribution:** Dust messages carry the signed-in user's identity (`username/fullName/email`,
  `origin:'api'`) so usage is attributable in the workspace (`llm.ts:79-98`, `dustContext`).
- **Token import:** `importDustCliSession()` reads the **Dust CLI's** keychain items
  (`service: 'dust-cli'`, accounts `access_token`/`workspace_sid`/`region`) via the macOS `security`
  tool (`dustcli.ts:19-75`). Reading another app's keychain item triggers a **one-time macOS "allow
  access" prompt** — i.e. the OS keychain ACL is the access control, and the user must consent. The
  imported bearer is then re-stored under AskToto's own `safeStorage` (`index.ts:432`). PASS.
- **Token nature:** short-lived OAuth bearer; expiry handled by re-import (`dustcli.ts:14-17`). No
  refresh-token storage in AskToto. Acceptable.
- macOS-only path (`dustcli.ts:56-60`); Windows users paste a key. OK.

---

## 5. Secret-at-rest ACL (the real "IAM" for keys) — PASS

| Secret | Storage | ACL / protection | Evidence |
|--------|---------|------------------|----------|
| Provider API keys | `key-<provider>.bin` | `safeStorage.encryptString` (OS keychain-derived key) + `mode 0o600`; throws if encryption unavailable (won't write plaintext) | `store.ts:186-201` |
| Settings (context docs, profile PII, Azure config) | `settings.json` w/ `ATKENC1` marker | whole-file `safeStorage` encryption; atomic write `0o600` | `store.ts:104-184` |
| Auth session | `auth-session.bin` | `safeStorage` encryption, `0o600` | `auth.ts:122-131` |
| Keys exposed to renderer? | **No** | only `hasKeys` booleans cross the bridge | `store.ts:312-316`, `index.ts:118-126` |

The encryption key lives in the OS keychain (macOS) / DPAPI (Windows) with an ACL bound to the app, so
another local user account cannot trivially read the blobs. **Caveat (ties to INF-2):** on macOS the
`safeStorage`/keychain ACL strength depends on the app's code-signing identity; **with signing
unconfigured** the app's identity is weaker and the keychain ACL is effectively path/binary-based,
which a co-resident process could attempt to impersonate. Closing the signing gap (INF-2) hardens this
ACL. Finding IAM-3.

---

## Findings (IAM)

- **IAM-1 (HIGH for sensitive-data production) — No identity gate unless SSO is explicitly configured.**
  `requireAuth()` returns `true` when Entra is unconfigured (`auth.ts:153-154`); the default build ships
  with no access control over capture, transcripts, recall, and stored keys. *Fix:* for sensitive
  deployments, ship a managed-config with `azure.{clientId,tenantId,allowedDomain}` and add
  `provider`/SSO keys to the `locked` array; consider a build-time flag that makes `configured:false`
  **fail-closed** (block use) instead of fail-open.
- **IAM-2 (MEDIUM) — No session expiry / inactivity re-auth.** Persisted session is honored indefinitely;
  `Session.at` is recorded but never validated (`auth.ts:133-145, 239`). *Fix:* enforce a max session
  age / idle timeout and re-run `signIn()` when exceeded.
- **IAM-3 (MEDIUM) — Keychain ACL strength depends on unconfigured code signing.** `safeStorage` ACL is
  weakened by the unsigned-app identity (see INF-2). *Fix:* configure Developer ID / Authenticode
  signing so the keychain ACL binds to a stable signed identity.

## Gate verdict — IAM
**SSO mechanism (tenant + domain lock, PKCE, anti-tamper precedence): PASS when configured.**
**Secret-at-rest ACL: PASS** (with signing caveat). **Default enforcement posture: FAIL for
sensitive-data production** — auth is fail-open until an admin configures and locks Entra. Cloud-IAM
constructs: N/A (justified). IAM gate = **conditional PASS only when deployed with Entra configured and
locked via managed-config; otherwise FAIL (fail-open)**.
