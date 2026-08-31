# Métis 1.8.1 security gate — 10-control audit

**Product:** Métis (AskToto-Mantu), Electron desktop note-taking / second-brain app plus Fly license server and Cloudflare AI proxy.
**Scope:** desktop main + renderer IPC, local data, license-server HTTP, Cloudflare Worker, Graph/Outlook, MCP. Overlay chrome, island geometry, onboarding, PR 58, identity card, Intelligence dashboards, and latency/time-saved work are frozen and were not used as evidence or as a place to hide findings.
**Method:** static review of current `main` (`ebb909d`). This document is the Phase 1 verdict. It was written before the Phase 2 patches in this PR.
**Date:** 2026-08-31.
**Reviewer stance:** hard gate before 1.8.1 DMG / native Mac / Windows EXE. Friendly checkbox theater is a fail.
**Post-fix score (same PR):** 8/10 Present, 2 N/A. Phase 1 text below is the pre-patch verdict. The live score is in "Post-fix score (this PR)".

Attack surface that actually exists:

- Packaged Electron main process + sandboxed renderer. Notes live on the local disk (meetings folder / OneDrive sync), not in a cloud database this product owns.
- Optional phone-home license server (`license-server/`, Fly / Caddy).
- Optional Cloudflare Worker (`cloudflare-proxy/`) that holds the Cloudflare account token.
- Outbound Microsoft Graph (calendar, transcripts), user-configured MCP (BidStack / Plane / ClickUp), Dust, and LLM providers.

There is **no** Postgres, Supabase, or multi-tenant SQL. Inventing RLS for a database that is not there would be fiction.

---

## 1. Rate limiting on the API (public and authenticated)

**Status:** Partial

**Evidence:**

| Surface | Control | File + symbol |
|---|---|---|
| `POST /activate`, `POST /heartbeat` | 20 req/min per `IP\|licenseKey`, in-process | `license-server/lib/app.mjs` `makeRateLimit` / `RL_MAX` |
| `POST /deactivate` | **None** | `createApp` route at `app.post('/deactivate'` |
| `GET /health`, `GET /metrics` | None (metrics is token-gated) | `createApp` |
| `/admin/*` | Failed-auth lockout only (10 / 15 min / IP), not a volume cap | `makeAdminLockout` / `requireAdmin` |
| Cloudflare Worker `POST /v1/chat/completions` | **None at the Worker.** Auth + comment that AI Gateway *may* rate-limit if the operator set one | `cloudflare-proxy/src/index.ts` `fetch` |
| Graph / Outlook | 10s timeout, Microsoft's own throttle. No client-side cap | `src/main/calendar.ts` |
| MCP | 15s connect / 30s call + SSRF guards. No request-rate cap | `src/main/mcp/mcpClient.ts` |
| Local HTTP (OAuth loopback, fm-runtime) | Bind `127.0.0.1` only. Rate limit N/A for a public listener that is not public | `src/main/auth.ts`, `src/main/mcp/clickupOAuth.ts` |
| LLM providers | Client backoff / demotion on 429 | `src/main/llm/exhaustion.ts`, `provider-health.ts` |
| SSO sign-in | Single-flight + exponential backoff | `src/main/auth.ts` `signInBackoffRemainingMs` |
| `license:activate` IPC | No local cap. A compromised renderer can hammer the remote `/activate` | `src/main/index.ts` `IPC.licenseActivate` |

**Risk if missing:** Anyone who learns a license key can spam `/deactivate` with guessed `machineId`s and free seats (griefing / activation churn). A leaked Worker URL + `METIS_PROXY_KEY` spends the operator's Cloudflare balance until an account-level limit (if any) hits. A renderer loop can burn Graph/MCP quotas.

**Recommended fix:** Apply the same limiter to `/deactivate`. Add a Worker-side per-key (and unauthenticated-IP) cap that 429s before the account token is used. Cap outbound `license:activate`, `mcpPush` / `mcpTestConnection`, and `calendarToday` in main. Do not put a limiter on the capture / `saveTranscript` path.

---

## 2. Keys and secrets server-side only

**Status:** Present (residual: optional disclosed embedded keys)

**Evidence:**

- Provider keys never cross IPC. Renderer sees `hasKeys` booleans only (`src/main/index.ts` `publicSettings`, `src/main/store.ts`).
- Dust refresh tokens, MCP bearers, Graph tokens stay in the main process (`dust-secret-store.ts`, `mcp/mcpSecrets.ts`, `auth.ts` MSAL cache). Encrypted at rest (`src/main/secrets.ts` AES-GCM; OS keychain / DPAPI wrap of `secret-key.bin` when available).
- Cloudflare **account** token (`CLOUDFLARE_API_TOKEN`) is a Wrangler secret, not in the desktop app (`cloudflare-proxy/src/index.ts` `Env`).
- No `NEXT_PUBLIC_*`. Not a Next.js app.
- License model is phone-home, not asymmetric signing. There is **no** license private key in the client and **no** public verify key to ship. Validity is decided by the server (`src/main/license.ts`, `license-server/lib/license.mjs` `generateLicenseKey`). That is the correct split for this product.
- `.env` / embed dirs are gitignored (`.gitignore`). CI embeds keys only from GitHub secrets.

**Residual (documented, not a hidden leak):**

- Optional installer-embedded `METIS_PROXY_KEY` (`src/main/embedded-cloudflare-key.ts`) and Cahê Kimi key (`src/main/cahe-embedded-key.ts`) are recoverable from `asar`. The code and `docs/CLOUDFLARE.md` call this out: scoped label, revocable, never the operator's own key. Still a live credential if an embed build is shipped.
- `METIS_WORKER_URL` (`src/shared/ipc.ts`) is a public endpoint, not a secret.

**Risk if missing:** Account-token theft from a downloaded DMG; renderer XSS reading keys; license signing key extraction. Those paths are closed for the account token and for user keys.

**Recommended fix:** Keep the disclosed-embed rule. Do not add new live secrets to the package. Rotate embed keys on a schedule. No Phase 2 code change required for this control beyond not introducing new client secrets.

---

## 3. RLS on every table with user data

**Status:** N/A

**Evidence:** Repo-wide search of `*.ts` / `*.js` / `*.mjs` / `*.sql` found **no** `CREATE TABLE`, `postgres`, `supabase`, or production SQLite. Notes, brain JSON, and transcripts are files under the user-chosen `meetingsFolder` (`src/main/recall.ts`, `src/main/transcripts.ts`). Future `sqlite-vec` is mentioned only in `docs/asktoto-architecture.md`.

Actual access control for local user data:

| Store | Where | Control |
|---|---|---|
| Meetings / brain | `meetingsFolder` (often OneDrive) | OS user + IPC `requireAuth` + `basename()` path guards |
| Encrypted transcripts | Same folder, `ATKENC2` | Device-bound key via `secrets.ts` / `safeStorage` |
| API keys / MCP / Dust | `<userData>/key-*.bin` | AES-GCM; keychain-wrapped KEK when available; mode `0o600` |
| Auth session / MSAL | `<userData>` | Cleared on sign-out (`auth.ts`) |
| Audit log | `<userData>/logs/audit.log` | Mode `0o600`; hash chain (`logger.ts`) |
| Managed org policy | `/Library/.../Métis`, `%ProgramData%\Métis` | Root/admin-owned; Windows ACL trust probe (`win-security.ts`) |

This is a single-user desktop app. "RLS on every table" does not apply. Claiming it would be a lie.

**Risk if missing:** N/A for a cloud DB. Residual: anyone who can read the OS user profile (backup, second account, malware) can read unencrypted meetings if `encryptTranscripts` is off; encrypted meetings still need the device keychain.

**Recommended fix:** None for RLS. Keep encryption-default-on. Do not add a cloud notes DB in this ship.

---

## 4. Env files not committed

**Status:** Present

**Evidence:**

- `.gitignore` ignores `.env` and `.env.local` (lines 9–10), plus `build/cahe-kimi.local.json` and `build/cloudflare-embed/*`.
- Tracked env-shaped files are examples only: `.env.example`, `license-server/deploy/.env.example`.
- `git log --all --full-history --diff-filter=A` for `.env` / `.env.*` (excluding examples): **empty**.
- Filename scan of added history for `*.pem`, `*.p12`, `id_rsa`, `credentials.json`, `secrets.json`: **empty**.
- `.gitleaks.toml` allowlists test fixtures and docs; CI also runs a product-specific prefix scan (`.github/workflows/build.yml`).

**Risk if missing:** Live keys in git history survive forever and appear in every clone / asar-adjacent checkout.

**Recommended fix:** Do not rewrite history (nothing to rewrite). Keep both scanners. Operators must never commit a filled `.env`.

---

## 5. User input validated and sanitized (IPC args, file paths, SQL, markdown/HTML, MCP URLs)

**Status:** Partial

**Evidence:**

- IPC payloads: Zod schemas in `src/shared/ipc.ts`. Handlers use `.parse` / `.safeParse` (`setApiKey`, `mcpPush`, `licenseActivate`, brain mutations, `parakeetFeed` length cap).
- File paths: `basename()` on meeting files (`src/main/recall.ts` `deleteMeeting`, `index.ts` `recallOpen` / `recallExportPlain`). MCP connection ids constrained so they cannot target `../../secret-key` (`ipc.ts`, `mcpSecrets.ts`). ASR `asr-model://` uses `realpathSync` + `isInsideResourceBase`.
- SQL: none. No injection surface.
- MCP URLs: SSRF block for cloud metadata, link-local, DNS check, `redirect: 'error'` (`mcpClient.ts`). Push endpoint is read from **saved** settings, not the renderer (`IPC.mcpPush`).
- Markdown: title/recap/speaker sanitizers (`recall.ts`, `transcripts.ts`). Cloud egress runs `redactSecrets` when enabled (`src/shared/redact.ts`).
- Settings write boundary strips license fields, `mcpConnections`, `clickupClientId` (`settings-write-boundary.contract.test.ts`).

**Gaps:**

- `IPC.askStart` outer catch forwards `e.message` to the renderer (`src/main/index.ts`). A Zod failure or internal throw can ship schema paths / internals into the UI.
- `POST /admin/restore` returns `err.message` on `store.replaceAll` throw (`license-server/lib/app.mjs`).
- Shiki `dangerouslySetInnerHTML` on model-produced code (`CodeBlock.tsx`) is trusted-output, not arbitrary user HTML. Residual XSS if a model is coerced.

**Risk if missing:** Path traversal out of the meetings folder; SSRF to cloud metadata via MCP; renderer seeing stack-adjacent validation text; restore errors leaking store internals.

**Recommended fix:** Generic ask-start and restore errors. Keep Zod. Do not weaken existing schema tests.

---

## 6. No fully public tables by default

**Status:** N/A

**Evidence:** There are no cloud tables. License store is a JSON file on the Fly volume (`license-server/lib/store.mjs`), reachable only via authenticated admin routes or the key-as-credential public API. `/health` is public but is not a table. `/metrics` 404s unless `METRICS_TOKEN` is set.

**Risk if missing:** N/A. Residual reconnaissance: public `/health` currently returns `licenseCount` (see item 9).

**Recommended fix:** None for "tables". Strip `licenseCount` from public health.

---

## 7. Auth on protected routes / IPC

**Status:** Partial

**Evidence:**

**License server**

- `/admin/*` API: bearer `LICENSE_ADMIN_TOKEN`, SHA-256 + `timingSafeEqual` (`requireAdmin`, `bearerMatches`). 503 if unset.
- `/admin/ui` and `/admin` redirect: **no auth**. Static HTML that prompts for the token and stores it in `localStorage` (`license-server/admin/index.html`). The APIs behind it are gated. Physical access or XSS on that origin equals the admin password in a text file.
- `/activate`, `/heartbeat`, `/deactivate`: license key is the credential. Correct for this model. `/deactivate` is still a privileged seat mutation without a volume cap (item 1).
- `/metrics`: separate bearer, or 404.

**Desktop IPC**

- Sandbox + `contextIsolation` + no `nodeIntegration` on every window (`index.ts`, `intelligence.ts`).
- `assertMainWindow` binds sender + top frame + URL (`index.ts`). Intelligence window pinned by pathname (`isIntelligenceSender`).
- Most privileged handlers call `requireAuth()` (`src/main/auth.ts`). Sticky / managed-config enforcement exists (hardening backlog, shipped).

**Ungated privileged-adjacent handlers:**

| Handler | Why it matters |
|---|---|
| `listeningState` | Resets Dust conversation, can `prewarmDustConversation` with the Dust key, resets speaker session. No `requireAuth`. |
| `askResetContext` | Resets Dust conversation + idle clock. No `requireAuth`. |
| `askCancel` | Aborts in-flight streams. Lower privilege; still ungated. |
| `licenseActivate` / `licenseGate` | Intentional (license vs SSO deadlock). Acceptable. Must be rate-limited (item 1). |

**Risk if missing:** On an SSO-enforced machine, a compromised renderer that cannot pass `requireAuth` can still start/stop listening side effects and prewarm Dust. Admin UI token in `localStorage` is operator-machine risk.

**Recommended fix:** `requireAuth()` on `listeningState` and `askResetContext` (and `askCancel` for consistency). Do not gate `licenseActivate` behind SSO. Document admin `localStorage` residual; do not rebuild admin auth in this ship.

---

## 8. Production errors do not leak stack traces, paths, SQL

**Status:** Partial

**Evidence:**

- License-server unhandled errors: `{ ok: false, error: 'internal_error' }` only; stack goes to stderr (`createApp` final `app.use`).
- Cloudflare Worker: upstream bodies re-stated, never relayed (`mapUpstreamFailure`). Fetch errors are not stringified (account token in the message).
- MCP to renderer: `classifyError()` (`mcpClient.ts`).
- Graph: consent / null, no stack to UI (`calendar.ts`).
- Crash dumps: `redactSecrets` before persist (`index.ts` boot/fatal path).

**Leaks:**

- `askStart` catch: raw `Error.message` to `IPC.streamError`.
- `/admin/restore` 400: `message: err.message`.
- Zod `details: flatten()` on license-server 400s (field names, not secrets). Acceptable for an operator API; do not copy that pattern to public `/activate`.

No SQL exists to leak.

**Risk if missing:** Schema paths, file paths, or restore internals in the overlay or in an HTTP client.

**Recommended fix:** Constant strings for those two catch paths. Keep stderr full-detail for operators.

---

## 9. Admin / debug endpoints locked or disabled in production

**Status:** Partial

**Evidence:**

- Packaged DevTools: `devToolsEnabled()` is `!isPackagedBuild() || devEnv('ASKTOTO_DEVTOOLS') === '1'`, and `devEnv` returns `undefined` when packaged (`src/main/dev-env.ts`). DevTools are **off** in shipped builds. Comments in `index.ts` overstate the env escape hatch.
- `ASKTOTO_DEBUG_RENDERER`, `ASKTOTO_DISABLE_CP`: ignored when packaged.
- `?demo=` query is renderer UI seed (`App.tsx`). No demo passwords.
- License admin API: locked as in item 7. Admin **page** is public HTML.
- `GET /health` (license): unauthenticated; returns `version`, `uptimeSeconds`, **`licenseCount`**.
- Cloudflare `/health`: unauthenticated; returns `{ ok, service, configured }` only. Fine.
- Diagnostics export: `requireAuth`, excludes `settings.json`, meetings, `.brain/` (`IPC.diagnosticsExport`).

**Risk if missing:** Public `licenseCount` is fleet reconnaissance. A public admin shell plus a guessed/leaked token is the whole license business. DevTools in a shipped build would collapse the IPC sender story.

**Recommended fix:** Drop `licenseCount` from public `/health` (counts already live on `/metrics` behind a token). Align DevTools comments with `dev-env.ts`. Do not add a packaged DevTools backdoor.

---

## 10. Logging / monitoring for attacks

**Status:** Partial

**Evidence:**

**What exists**

- Tamper-evident audit log, metadata only, explicit "NEVER pass secrets or transcript content" (`src/main/logger.ts` `auditLog`, `AuditEvent`).
- Auth: `auth.signin_failed` (coarse category), `auth.denied` (email/domain), no tokens (`auth.ts` `coarseSignInFailure`).
- Key events log provider id / source, not the key (`key.set`).
- License-server `audit.jsonl` records admin actions including license keys (operator log, by design).
- Discord webhooks truncate keys (`webhooks.mjs` `truncateKey`).

**Gaps**

- License-server rate-limit 429s are silent (no stderr line, no audit event).
- Admin 401s are silent except the HTTP status.
- `assertMainWindow` denials throw to the renderer and are **not** audited.
- Generic (non-Discord) webhooks send the **full** `licenseKey` via `licenseEventView`.
- No desktop event for "outbound license/MCP/Graph rate-limit hit".
- No SIEM forwarder. Local file only. Acceptable for a desktop app; the Fly service should at least print attack-shaped lines.

**Risk if missing:** Seat-flood and admin brute-force leave no trail. A Slack/n8n webhook that was supposed to be "ours" becomes a license-key dump. Tokens in logs would be a separate, worse failure; that one is currently avoided.

**Recommended fix:** Log rate-limit and admin-auth failures without keys/tokens/serials. Audit IPC sender denials (sampled, so a flood cannot fill the disk). Truncate keys on generic webhooks unless an operator opt-in is set. Do not log transcripts.

---

## Summary score

| # | Control | Status |
|---|---|---|
| 1 | Rate limiting | Partial |
| 2 | Secrets server-side only | Present |
| 3 | RLS / local access control | N/A |
| 4 | Env files not committed | Present |
| 5 | Input validation | Partial |
| 6 | No public tables | N/A |
| 7 | Auth on protected routes / IPC | Partial |
| 8 | Production errors | Partial |
| 9 | Admin / debug locked | Partial |
| 10 | Attack logging | Partial |

**Fully in place: 2 / 10.** N/A counted separately: 2 (items 3 and 6).

This is below the 8/10 gate. Shipping 1.8.1 on this score would be a process failure, not a documentation failure.

---

## Highest-risk gaps (priority)

1. **Unauthenticated `/deactivate` with no rate limit** — seat griefing with a stolen or guessed key + machine ids.
2. **Cloudflare Worker has no request cap** — leaked proxy key equals unbounded spend.
3. **Generic license webhooks emit full keys** — one mis-aimed Slack/Zapier URL dumps activatable credentials.
4. **`listeningState` / `askResetContext` skip `requireAuth`** — SSO wall is not the real gate for Dust prewarm / conversation reset.
5. **`askStart` and `/admin/restore` leak `Error.message`** — internals to UI / HTTP client.
6. **Public `/health.licenseCount`** — free reconnaissance.
7. **Rate-limit and IPC-deny events are not recorded** — you cannot investigate the attacks item 1 describes.

Lower but real: admin token in `localStorage`; in-process limiters die if the license server is ever horizontally scaled; optional asar-embedded keys.

---

## Tonight's action plan (score < 8)

Same PR, no overlay/onboarding/identity/latency files, no network on the capture path, never auto-send.

1. Rate-limit `/deactivate` with the existing `makeRateLimit` instance. Add a burst test.
2. Worker-side fixed-window limiter (per hashed key after auth; per IP for unauthenticated). 429 before the account token is used. Tests in `cloudflare-proxy/src/index.test.ts`.
3. Truncate `licenseEventView` keys the same way Discord already does. Opt-in `LICENSE_WEBHOOK_FULL_KEYS=1` for an operator-owned receiver that truly needs the raw key. Extend `ops.test.mjs`.
4. Remove `licenseCount` from `GET /health`. Keep it on token-gated `/metrics`. Update the health test to assert absence.
5. Generic restore error. Generic `askStart` catch message.
6. `requireAuth()` on `listeningState`, `askResetContext`, `askCancel`.
7. Main-process outbound cap for `license:activate`, MCP test/save/push, `calendarToday`. Never on `saveTranscript` / `parakeetFeed` / `armAudio`.
8. Attack logs: license-server stderr on 429 / admin 401 (IP + route, no key/token). Desktop `security.rate_limited` and `security.ipc_denied` audit events, metadata only.

Re-score after the patches. READY TO MERGE stays **no** until Devon reviews this document and the fixes.

---

## Phase 2 remediations (same PR, after this document)

Shipped on this branch. Capture / `saveTranscript` / `parakeetFeed` / `armAudio` were not given a limiter.

| Gap | Fix |
|---|---|
| `/deactivate` unthrottled | Same `makeRateLimit` instance as activate/heartbeat |
| Worker spend | Per-hashed-key 60/min and unauthenticated-IP 30/min; 429 before the account token is used |
| Generic webhook keys | `licenseEventView` truncates unless `LICENSE_WEBHOOK_FULL_KEYS=1` |
| Public `licenseCount` | Removed from `GET /health` |
| `askStart` / restore leaks | Constant error strings |
| Ungated listening/ask IPC | `requireAuth()` on `listeningState`, `askResetContext`, `askCancel` |
| Renderer can hammer outbound HTTP | `security-limits.ts` on license activate, MCP test/save/push, Graph calendar |
| Silent attacks | License-server stderr on 429 / admin 401 / lockout (IP + route). Desktop `security.rate_limited` and `security.ipc_denied` (sampled) |
| Settings cache served the wrong profile | Cache key includes settings path; admin-policy snapshot includes path + inode |

**Post-fix fully in place after the first patch set: 3/10** (items 2, 4, 8). N/A still 2.

---

## Phase 2b remediations (same PR — close the remaining Partials)

Capture / ASR still never call `denyIfLimited`. Overflow on the live path is `takeHotPath`: same-tick drop, no wait.

| Gap | Fix | Tests |
|---|---|---|
| Capture / save / ASR / arm uncapped | Token bucket in `security-limits.ts` (`takeHotPath`). asr-feed 40/20s⁻¹, save-transcript 8/0.5s⁻¹, capture-screen 6/0.25s⁻¹, arm-audio 10/1s⁻¹. Drop overflow; never block captions | `security-limits.test.ts`, `security-audit-10.contract.test.ts` |
| Path / HTML / SQL / MCP leftovers | Shared `safeMeetingBasename()` on meeting-file IPC + `appendDebrief`. Shiki HTML through `sanitizeShikiHtml`. Contract: no sqlite/postgres in `src/main`. MCP refuses `data:` / `javascript:` | `meeting-path.test.ts`, `sanitize-html.test.ts`, `transcripts.test.ts`, `mcpClient.test.ts`, contract file |
| Ungated disk/network IPC | `requireAuth()` on `localPrewarm`, `prewarmCapture`, `rendererCrash`, `updateCheck` / `updateDownload` / `updateInstall`. `license:activate` stays ungated (deadlock) | contract file |
| Admin bearer in `localStorage` | `POST/GET/DELETE /admin/session` sets `metis_admin_session` httpOnly, SameSite=strict, Secure on HTTPS, 12h. `requireAdmin` accepts cookie **or** Bearer. Admin UI uses `credentials: 'same-origin'` only | `license-server/server.test.mjs` |
| Worker limiter per-isolate | Best-effort Cache API (`caches.default`) with in-memory fallback; injectable cache for Node tests | `cloudflare-proxy/src/index.test.ts` |
| Raw IPs in attack logs | License-server stderr uses `ip_hash=` (SHA-256 prefix). No tokens / serials / keys | `license-server/server.test.mjs` |
| asar-embedded product keys | Still residual, not a FAIL. One-command rotation: `npm run rotate:embedded-keys` | `scripts/rotate-embedded-keys.test.ts`, `docs/security/EMBEDDED-KEY-ROTATION.md` |

Packaged DevTools remain off (`devEnv` returns undefined when packaged). No change to overlay / onboarding / identity / Intelligence / latency / ASR engines.

---

## Post-fix score (this PR)

| # | Control | Status |
|---|---|---|
| 1 | Rate limiting | **Present** — license `/activate` `/heartbeat` `/deactivate`; Worker per-key + unauth-IP (memory + Cache API); desktop outbound `denyIfLimited`; live path `takeHotPath` (non-blocking). Residual: license limiter is in-process (single Fly instance). Worker cache is colo-local, not a global store. |
| 2 | Secrets server-side only | **Present** — residual: disclosed, revocable asar-embedded product keys. Rotation is `npm run rotate:embedded-keys`. Not operator live secrets. |
| 3 | RLS / local access control | **N/A** |
| 4 | Env files not committed | **Present** |
| 5 | Input validation | **Present** — Zod + `safeMeetingBasename` + MCP scheme/SSRF + Shiki allow-list. Residual: sanitizer is Shiki-shaped, not a general HTML rewriter. No SQL exists. |
| 6 | No public tables | **N/A** |
| 7 | Auth on protected routes / IPC | **Present** — remaining disk/network handlers gated. Documented exception: `license:activate` / `license:gate` (SSO deadlock). Window chrome stays ungated on purpose. |
| 8 | Production errors | **Present** |
| 9 | Admin / debug locked | **Present** — httpOnly session cookie; Bearer still works for CLI. Admin HTML shell is public (no secrets). Packaged DevTools off. Residual: in-memory sessions (single instance). |
| 10 | Attack logging | **Present** — license 429 / admin 401 / lockout with hashed IP; desktop `security.rate_limited` / `security.ipc_denied` (sampled). Residual: no SIEM forwarder; Worker limiter durability is Cache API best-effort. |

**Fully in place: 8 / 10.** N/A counted separately: 2 (items 3 and 6).

READY TO MERGE stays **no** until Devon reviews this document and the fixes. Pack / 1.8.1 stays last.

---

## Extra: XSS / imports / payment webhooks

Senior review of three high-risk issues. Written against this branch, then patched on the same PR. Overlay / onboarding / identity / Intelligence / latency / ASR engines were not used as a place to hide findings.

### 1. XSS

**Status (pre-fix): Partial**

**Evidence:**

| Sink | What it does | File + symbol |
|---|---|---|
| Answer markdown | Streamdown (`rehype-sanitize` + `rehype-harden` + `rehype-raw`). Model text, notes, recaps. | `src/renderer/src/components/Markdown.tsx` `Markdown` |
| Shiki code | `dangerouslySetInnerHTML` after `sanitizeShikiHtml` | `CodeBlock.tsx` `Block` |
| Recap PDF | `recapMarkdownToHtml` escapes text; hidden `data:text/html` window. **No CSP on the generated document** | `transcripts.ts` `recapMarkdownToHtml`, `index.ts` `IPC.recapPdf` |
| Calendar join | Graph `joinUrl` painted as `<a href>` with `target=_blank`. **No scheme allow-list** | `calendar.ts` `toEvent`, `AgendaView.tsx` `EventRow` |
| Admin dashboard | `innerHTML` of operator fields, every value through `escapeHtml` | `license-server/admin/index.html` |
| CSP | Meta CSP on overlay, decoder, Intelligence. `script-src` has no `unsafe-inline`. Packaged DevTools off | `src/renderer/index.html`, `decoder.html`, `intelligence/index.html` |
| Navigation | `will-navigate` pinned; `setWindowOpenHandler` opens `https:` only | `index.ts` `createWindow` |
| webview | None | repo grep |

**Risk if missing:** A coerced model fence or a Graph-supplied `javascript:` join URL runs in the privileged renderer. Recap PDF HTML without CSP is a second document that only the escaper protects.

**Exact fix:** `safeHref()` allow-list (`http`/`https`/`mailto`) on markdown `<a>` and Graph `joinUrl`. CSP `script-src 'none'` on recap HTML. Contract: only CodeBlock uses `dangerouslySetInnerHTML`; no `webviewTag`.

**Status (post-fix): Present.** Residual: Streamdown still parses raw HTML then sanitizes (their stack, not ours). Admin UI still assigns `innerHTML` after `escapeHtml` (operator origin).

---

### 2. File uploads / imports

**Status (pre-fix): Partial**

**Evidence:**

| Control | Present? | File + symbol |
|---|---|---|
| Native picker, path never crosses IPC | Yes — opaque token | `import-audio.ts` `pickAudioFile` / `consumePickedAudio` |
| Max size 500 MB | Yes | `MAX_SOURCE_BYTES` |
| Size/mtime re-check | Yes | `consumePickedAudio` |
| Extension filter | Yes, plus **"All files"** | `AUDIO_EXTENSIONS` |
| Magic bytes / MIME | **No** — ffmpeg saw whatever the user picked | `ffmpeg-decoder.ts` `startFfmpegDecode` |
| Output name | Generated `stamp-slug.md` or opaque hex. Original filename is title text only (`humanizeFilename` → `slug`) | `transcripts.ts` `saveMeeting` |
| Store location | User meetings folder, not `resources/` / asar | `ensureMeetingsFolder` |
| Execute the file | No `shell.openPath` / `exec` on the source | `IPC.importAudioStart` |
| AV | No | N/A for a desktop importer |

There is no public multipart HTTP upload. Import recap is markdown written by main after ASR, not an uploaded HTML file.

**Risk if missing:** "All files" + ffmpeg is a parser RCE class. An HTML/PE/PDF renamed to `.mp3` should never reach the decoder. A trusted original filename as a dest path would be path traversal; that dest path already does not exist.

**Exact fix:** `sniffMediaFile()` / `isAudioOrVideoMagic()` on the first 16 bytes. Refuse before the job queues (`consumePickedAudio`) and again before `spawn` (`startFfmpegDecode`) when the source exists. Missing sources still fail at spawn (`ENOENT`) so import-error contracts stay intact. Keep generated meeting names. No AV shipped.

**Status (post-fix): Present.** Residual: a crafted *valid* media file can still hit ffmpeg bugs. Magic bytes stop the wrong type, not a malicious MP4. Optional AV is still optional.

---

### 3. Payment / license webhooks

**Status (pre-fix): N/A** (inbound payment webhooks do not exist — must be proven, not assumed)

**Evidence:**

- No Stripe, Lemon Squeezy, Svix, or inbound `/webhook` route in `license-server/lib/app.mjs`. License-granting POSTs are `POST /activate` (license key is the credential) and `POST /admin/licenses` (admin bearer or session cookie).
- `LICENSE_WEBHOOK_URL` is **outbound only** (`webhooks.mjs` `createWebhooks` `deliver`). The server POSTs to Discord / a generic URL. HMAC `X-AskToto-Signature` is for the *receiver* to verify. Truncating keys is leak control, not inbound signature verify.
- Fly/Caddy terminate TLS and reverse-proxy. They do not grant seats.
- Desktop OAuth loopbacks bind `127.0.0.1` and do not create licenses.

**Risk if missing:** A forged Stripe-shaped POST that fulfilled seats without a signature. That route is not there. Claiming N/A without a 404 test would be theater.

**Exact fix:** No payment provider to wire. Add tests that `POST /webhook`, `/stripe`, `/stripe/webhook`, `/lemon`, `/hooks`, `/hooks/license` return 404 and do not grow the store. Source contract: no `app.post('/webhook|stripe|lemon|hooks')`.

**Status (post-fix): N/A**, proven. If a payment provider is added later, this item becomes Missing until official-library signature verify + idempotency land *before* fulfillment.

---

### Extra score

| # | Control | Status |
|---|---|---|
| 1 | XSS | **Present** |
| 2 | File imports | **Present** |
| 3 | Payment / license webhooks | **N/A** (no inbound payment webhook; 404 proof) |

**Fully protected: 2 / 3.** N/A counted separately: 1.

Highest-priority remaining residuals: ffmpeg parser bugs on real media; Streamdown's sanitizer as the markdown HTML gate; no AV.

No tonight action plan beyond this PR's patches — the two applicable controls are Present, the third is proven N/A. READY TO MERGE stays **no**.

---

## Phase 3 remediations (same PR)

| Gap | Fix | Tests |
|---|---|---|
| Graph / markdown `javascript:` hrefs | `src/shared/safe-url.ts` `safeHref` | `safe-url.test.ts`, `calendar.test.ts`, contract |
| Recap PDF HTML had no CSP | `script-src 'none'` meta on `recapMarkdownToHtml` | `transcripts.test.ts` |
| Import trusted extension only | Magic-byte sniff before queue and before ffmpeg | `import-magic.test.ts`, contract |
| Inbound webhook assumed absent | 404 + store-unchanged + source contract | `license-server/server.test.mjs` |

---

## Out of scope (frozen)

Overlay chrome, island geometry, onboarding, PR 58, identity card PR, Intelligence dashboards, latency / time-saved PRs. Pack and GitHub release stay last. No user-facing copy in this ship claims an AI author.
