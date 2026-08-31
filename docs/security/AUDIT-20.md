# Métis 1.8.1 security gate — 20-control checklist

**Product:** Métis (AskToto-Mantu). Electron local note-taker + Fly license server + Cloudflare AI proxy + Graph/MCP.
**Scope:** desktop main + renderer IPC, local files, `license-server/` HTTP, `cloudflare-proxy/` Worker. Overlay chrome, island geometry, onboarding, identity card, latency / time-saved, starfield, orbs, pill, and Brain PRs are frozen and were not used as evidence or as a place to hide findings.
**Method:** Tony's 20-point list, mapped onto this product. Reuses `docs/security/AUDIT-10.md`. No invented cloud DB. No CAPTCHA on the overlay. No fake anon key.
**Date:** 2026-08-31.
**Reviewer stance:** honest N/A. Checkbox theater is a fail.
**Post-fix score (same PR):** 15/15 applicable Present, 5 N/A. Phase-1 text below is the pre-patch verdict. Live score is at the bottom.

Attack surface that actually exists:

- Packaged Electron main + sandboxed renderer. Notes live on disk (`meetingsFolder`), not in a cloud database this product owns.
- Optional phone-home license server (`license-server/`, Fly / Caddy).
- Optional Cloudflare Worker (`cloudflare-proxy/`) that holds the Cloudflare account token.
- Outbound Microsoft Graph, user-configured MCP, Dust, LLM providers.

There is **no** Postgres, Supabase, or multi-tenant SQL. Items 3, 4, and 13 are N/A for that reason, not because they were skipped.

---

## 1. Hide API keys

**Status:** Present (residual: disclosed asar-embed product keys)

**Evidence:**

| Surface | Control | File + symbol |
|---|---|---|
| Provider keys | Never cross IPC. Renderer sees `hasKeys` booleans | `src/main/index.ts` `publicSettings`, `src/main/store.ts` `hasKeysMap` |
| Preload | `setApiKey` / `clearApiKey` / `testApiKey`. No `getApiKey` | `src/preload/index.ts` |
| Dust / MCP / Graph | Stay in main. Encrypted at rest | `dust-secret-store.ts`, `mcp/mcpSecrets.ts`, `auth.ts`, `secrets.ts` |
| Worker account token | Wrangler secret | `cloudflare-proxy/src/index.ts` `Env.CLOUDFLARE_API_TOKEN` |
| License model | Phone-home. No signing private key in the client | `src/main/license.ts`, `license-server/lib/license.mjs` |

**Residual:** installer-embedded `METIS_PROXY_KEY` (`embedded-cloudflare-key.ts`) and Cahê Kimi (`cahe-embedded-key.ts`) are recoverable from `asar`. Documented, scoped, revocable. Not the operator's Cloudflare account token. Rotation: `npm run rotate:embedded-keys`.

**Risk if missing:** Account-token theft from a DMG; renderer XSS reading keys.

**Exact fix:** none. Do not add new live secrets to the package.

---

## 2. Purge Git secrets

**Status:** Present

**Evidence:**

- `.gitignore` ignores `.env`, `.env.local`, `build/cahe-kimi.local.json`, `build/cloudflare-embed/*`.
- Tracked env-shaped files are examples only: `.env.example`, `license-server/deploy/.env.example`.
- `git log --all --full-history --diff-filter=A` for `.env` / `.env.local` / `.env.production`: **empty**.
- `.gitleaks.toml` + CI prefix scan + digest-pinned gitleaks (`.github/workflows/build.yml` Security job).

Reuse AUDIT-10 item 4. History empty is Present, not a promise to rewrite.

**Risk if missing:** Live keys survive in every clone.

**Exact fix:** none. Operators must never commit a filled `.env`.

---

## 3. Use public DB key

**Status:** N/A

**Evidence:** No Supabase, no Postgres, no `NEXT_PUBLIC_*`, no anon key. Not a Next.js app. Repo search of `src/main` has no SQL client (AUDIT-10 contract + this PR's contract).

**Risk if missing:** N/A. Inventing a public anon key would *create* the risk this item exists to contain.

**Exact fix:** none. Do not add a fake anon key.

---

## 4. Enable row-level security

**Status:** N/A

**Evidence:** Notes, brain JSON, transcripts are files under the user-chosen `meetingsFolder` (`recall.ts`, `transcripts.ts`). Future `sqlite-vec` exists only in `docs/asktoto-architecture.md`.

Local access control that *does* exist (not RLS):

| Store | Control |
|---|---|
| Meetings / brain | OS user + `requireAuth` + `safeMeetingBasename()` |
| Encrypted transcripts | `ATKENC2` + device-bound key (`secrets.ts` / `safeStorage`) |
| API keys | AES-GCM files, mode `0o600` |
| License store | JSON on the Fly volume; admin bearer / session or license-key-as-credential |

This is a single-user desktop app. "RLS on every table" does not apply.

**Risk if missing:** N/A for a cloud DB. Residual: anyone who can read the OS profile can read unencrypted meetings if `encryptTranscripts` is off.

**Exact fix:** none. Do not add a cloud notes DB in this ship.

---

## 5. Encrypt sensitive data

**Status:** Present

**Evidence:**

- `encryptTranscripts` defaults **true** (`src/shared/ipc.ts` `BaseSettingsSchema` / `DEFAULT_SETTINGS`).
- Transcript + settings blobs use `ATKENC2` (`transcripts.ts` `ENC_MARKER_V2`, `store.ts` `readUserRaw`).
- Secrets backend: AES-256-GCM, 12-byte IV, 16-byte tag (`secrets.ts` `encryptSecret`). Keychain / DPAPI wrap of `secret-key.bin` when available.

Default-on for new installs and for legacy installs that never opted out. Explicit `encryptTranscripts: false` on disk is respected.

**Risk if missing:** Meetings and provider keys readable from a copied `userData` folder.

**Exact fix:** none.

---

## 6. Enforce server-side auth

**Status:** Present

**Evidence:**

| Surface | Control | File + symbol |
|---|---|---|
| License admin API | Bearer or httpOnly session | `license-server/lib/app.mjs` `requireAdmin` |
| Public license POSTs | License key is the credential | `POST /activate` `/heartbeat` `/deactivate` |
| Desktop privileged IPC | `requireAuth()` | `src/main/auth.ts`, `index.ts` |
| Listening / ask / prewarm / updater | Gated (AUDIT-10 Phase 2/2b) | `IPC.listeningState`, `askStart`, `askResetContext`, `localPrewarm`, `updateInstall` |

**Documented exception:** `IPC.licenseActivate` / `IPC.licenseGate` stay ungated so license enforcement cannot deadlock behind SSO. Rate-limited (`security-limits.ts` `'license-activate'`).

**Risk if missing:** A compromised renderer on an SSO machine reaches Dust / disk / network.

**Exact fix:** none. Do not gate `license:activate` behind SSO.

---

## 7. Lock record access

**Status:** Present

**Evidence:** OS user isolation. Meeting-file IPC uses `safeMeetingBasename()` (`src/main/meeting-path.ts`) on recall / export / delete / debrief. MCP connection ids cannot target `../../secret-key`. ASR `asr-model://` is `realpathSync` + `isInsideResourceBase`. Not multi-tenant RLS.

**Risk if missing:** Path traversal out of the meetings folder.

**Exact fix:** none.

---

## 8. Block field tampering

**Status:** Present

**Evidence:**

- IPC payloads: Zod in `src/shared/ipc.ts` (`.parse` / `.safeParse` on ask, keys, license, MCP, brain, import).
- Settings write boundary strips `licenseKey`, `licenseValid`, seat/expiry fields, `mcpConnections`, `clickupClientId` (`index.ts` `IPC.settingsSet`). Contract: `settings-write-boundary.contract.test.ts`.
- Per-key persist: `store.ts` `validKeysOnly()`.

Residual: hot-path ASR feeds use `Float32Array` + length cap, not Zod. Correct for typed PCM. Not a missing write-boundary.

**Risk if missing:** Renderer writes a valid license or plants an MCP URL.

**Exact fix:** none.

---

## 9. Secure session cookies

**Status:** Present

**Evidence:** License admin `metis_admin_session` — `HttpOnly`, `SameSite=Strict`, `Secure` when `req.secure` or `x-forwarded-proto=https`, 12h (`app.mjs` `sessionCookieLine`). Desktop auth is MSAL cache in main, not cookies. Do not invent Electron cookies.

**Risk if missing:** XSS on the admin origin reads the bearer (the old `localStorage` path). Closed.

**Exact fix:** none.

---

## 10. Hash passwords

**Status:** N/A

**Evidence:** No user password database. Desktop sign-in is Entra/MSAL (`auth.ts` `signIn`). No bcrypt/argon in `src/`. Admin credential is an env bearer compared as SHA-256 + `timingSafeEqual` (`app.mjs` `bearerMatches`). Worker proxy key: SHA-256 digest compare (`cloudflare-proxy/src/index.ts` `secretsMatch`).

**Risk if missing:** N/A. A fake password hasher would be theater.

**Exact fix:** none. Do not add a user password table.

---

## 11. Rate limit login

**Status:** Present

**Evidence:**

| Surface | Limit | File + symbol |
|---|---|---|
| `/activate` `/heartbeat` `/deactivate` | 20/min per `IP\|licenseKey` | `app.mjs` `makeRateLimit` |
| Admin brute-force | 10 failures / 15 min / IP | `makeAdminLockout` |
| SSO sign-in | Exponential backoff, 60s cap | `auth.ts` `signInBackoffRemainingMs` |
| Desktop `license:activate` | 10/min | `security-limits.ts` |
| Worker | 60/min hashed key; 30/min unauth IP | `consumeRateBucket` |

Capture / ASR / save stay `takeHotPath` (non-blocking). Never `denyIfLimited`.

**Risk if missing:** Seat griefing; SSO spray; Worker spend.

**Exact fix:** none. Keep.

---

## 12. Add bot protection

**Status:** N/A

**Evidence:** Desktop app is not a public web form. No Turnstile, CAPTCHA, or CF challenge in this repo. License public POSTs are already rate-limited (item 11). Worker has no bot-fight; AI Gateway is an optional operator env (`CF_AI_GATEWAY_ID`), not a challenge widget.

**Risk if missing:** Automated `/activate` spray. Rate-limit is the control that exists for that.

**Exact fix:** none. Do not bolt Turnstile onto the overlay. Do not add a CAPTCHA widget to Métis.

---

## 13. Parameterize queries

**Status:** N/A

**Evidence:** No SQL in production. Contract: `src/main` has no `better-sqlite3` / `sqlite3` / `pg.Pool` / `postgres` / `CREATE TABLE` (`security-audit-10.contract.test.ts`, reused here). License store is JSON (`license-server/lib/store.mjs`).

**Risk if missing:** N/A. There is no query string to inject.

**Exact fix:** none. Do not add sqlite to `src/main` in this ship.

---

## 14. Validate all input

**Status:** Present

**Evidence:** Zod IPC (item 8). License-server Zod on activate/heartbeat/deactivate/admin bodies (`app.mjs`). MCP URLs: scheme + SSRF + `redirect: 'error'` (`mcpClient.ts`). Meeting names: `safeMeetingBasename()`. Import: magic bytes (item 16).

**Risk if missing:** Path traversal, SSRF, schema internals in the UI.

**Exact fix:** none. Keep. AUDIT-10 already closed the `askStart` / restore `Error.message` leaks.

---

## 15. Escape user content

**Status:** Present

**Evidence:** Streamdown `rehype-sanitize` + `rehype-harden` (`Markdown.tsx`). `safeHref()` on markdown `<a>` and Graph `joinUrl` (`safe-url.ts`, `calendar.ts`, `AgendaView.tsx`). Shiki HTML through `sanitizeShikiHtml` before the only `dangerouslySetInnerHTML` (`CodeBlock.tsx`). Recap HTML: `escapeHtml` + CSP `script-src 'none'` (`transcripts.ts` `recapMarkdownToHtml`). Admin UI: `escapeHtml` before `innerHTML`. No `webviewTag`.

Reuse AUDIT-10 Extra §1.

**Risk if missing:** Graph `javascript:` or a coerced fence runs in the renderer.

**Exact fix:** none. Keep.

---

## 16. Restrict file uploads

**Status:** Present

**Evidence:** Native picker; path never crosses IPC. 500 MB cap. `sniffMediaFile()` / `isAudioOrVideoMagic()` before queue and before ffmpeg spawn when the file exists (`import-magic.ts`, `import-audio.ts`, `ffmpeg-decoder.ts`). Generated dest names (`saveMeeting`). No `shell.openPath` on the source. No public multipart HTTP.

Reuse AUDIT-10 Extra §2.

**Risk if missing:** HTML/PE renamed `.mp3` reaches ffmpeg (parser-RCE class).

**Exact fix:** none. Keep. Residual: a crafted *valid* media file can still hit ffmpeg bugs. No AV shipped.

---

## 17. Trim API responses

**Status:** Present

**Evidence:**

- `publicSettings()` exposes `hasKeys` booleans, never provider tokens (`index.ts`, `store.ts` `hasKeysMap`).
- `GET /health` returns `{ ok, version, uptimeSeconds }`. **No `licenseCount`** (`app.mjs`; `server.test.mjs`).
- Worker `/health`: `{ ok, service, configured }`. Upstream bodies re-stated, never relayed (`mapUpstreamFailure`). Response headers synthesized (`content-type` + `cache-control` + item-18 headers).
- Activate success: company/seat metadata, not raw activation rows (`license.mjs` `successPayload`).

`licenseKey` in settings is the value the user typed; it is not a provider API token. Renderer never sees Dust/MCP/Graph/Cloudflare account tokens.

**Risk if missing:** Fleet reconnaissance (`licenseCount`); token leak through Worker error bodies.

**Exact fix:** none.

---

## 18. Add security headers

**Status (pre-fix):** Partial

**Evidence:**

| Surface | Headers present? | File + symbol |
|---|---|---|
| Overlay / decoder / Intelligence HTML | CSP **meta** (renderer, not an HTTP surface) | `src/renderer/index.html`, `decoder.html`, `intelligence/index.html` |
| Recap HTML | CSP `script-src 'none'` | `transcripts.ts` `recapMarkdownToHtml` |
| license-server Express | **None** — no Helmet, no HSTS / nosniff / frame-deny | `createApp()` |
| Caddy | **None** — `reverse_proxy` only | `license-server/deploy/Caddyfile` |
| Fly | `force_https = true` (redirect, not response headers) | `license-server/fly.toml` |
| Cloudflare Worker | `content-type` + `cache-control` only | `jsonResponse`, streaming `Response` |

Adding HSTS to overlay HTML is a fake win. The HTTP surfaces that browsers and admin tabs actually hit were missing the headers this item names.

**Risk if missing:** Admin UI clickjacked. MIME sniffing on JSON/HTML. No HSTS on the license origin after the first HTTPS hop.

**Exact fix:** `X-Content-Type-Options: nosniff` + `X-Frame-Options: DENY` on every license-server and Worker response. `Strict-Transport-Security: max-age=31536000; includeSubDomains` when the request is HTTPS (Express: `req.secure` or `x-forwarded-proto=https`; Worker: always; Caddy: the TLS site). Do not set HSTS on plain `http://127.0.0.1` test/dev. Do not touch overlay HTML.

**Status (post-fix):** Present. Residual: Caddy implicit HSTS (if any) is no longer the only copy; Express still has to emit HSTS when Fly terminates TLS in front of it.

---

## 19. Force HTTPS

**Status:** Present

**Evidence:**

- Fly: `force_https = true` (`license-server/fly.toml`).
- Caddy: auto-TLS on `:443` (`deploy/Caddyfile`, `docker-compose.prod.yml`).
- `setWindowOpenHandler` opens `https:` only (`index.ts` `createWindow`, `intelligence.ts`).
- MCP: `http:` / `https:` only + cloud-metadata / link-local / DNS SSRF + `redirect: 'error'` (`mcpClient.ts` `validateEndpointUrl`). Local MCP servers are `http://127.0.0.1` on purpose.
- Shipped Worker URL is `https://` (`src/shared/ipc.ts` `METIS_WORKER_URL`).
- OAuth loopback is `http://127.0.0.1:${port}` (`auth.ts` `signIn`, `clickupOAuth.ts`). **Must stay HTTP.** Entra and ClickUp require it.

`normalizeServerUrl` prefixes a bare host with `http://` for LAN/dev. Production operators pass `https://`.

**Risk if missing:** License traffic or window-open on cleartext. Loopback-over-HTTPS would break SSO.

**Exact fix:** none. Do not break loopback. Do not force MCP to https-only (local servers).

---

## 20. Scan dependencies

**Status:** Present

**Evidence:** Quality + Security jobs in `.github/workflows/build.yml`:

- `npm audit --audit-level=critical`
- `node scripts/check-audit.mjs` — HIGH/CRITICAL with the documented `@dust-tt/client` prune carve-out
- Product prefix secret scan (`scripts/ci-secret-scan.contract.test.ts` executes the same regex)
- Digest-pinned gitleaks
- CycloneDX SBOM (evidence, not a gate)
- Contract: `scripts/dependency-cve-gate.contract.test.ts`

Do not chase historic red CI Tony already marked out of bar. The Dust-bundle HIGH is a lockfile false positive; `check-audit.mjs` is the real gate.

**Risk if missing:** Known-vulnerable shipped native deps (the sharp/libvips class).

**Exact fix:** none.

---

## Extra score

| # | Control | Status |
|---|---|---|
| 1 | Hide API keys | **Present** |
| 2 | Purge Git secrets | **Present** |
| 3 | Use public DB key | **N/A** |
| 4 | Enable RLS | **N/A** |
| 5 | Encrypt sensitive data | **Present** |
| 6 | Enforce server-side auth | **Present** |
| 7 | Lock record access | **Present** |
| 8 | Block field tampering | **Present** |
| 9 | Secure session cookies | **Present** |
| 10 | Hash passwords | **N/A** |
| 11 | Rate limit login | **Present** |
| 12 | Add bot protection | **N/A** |
| 13 | Parameterize queries | **N/A** |
| 14 | Validate all input | **Present** |
| 15 | Escape user content | **Present** |
| 16 | Restrict file uploads | **Present** |
| 17 | Trim API responses | **Present** |
| 18 | Add security headers | **Partial** → **Present** (this PR) |
| 19 | Force HTTPS | **Present** |
| 20 | Scan dependencies | **Present** |

**Fully protected: 15 / 15 applicable.** N/A counted separately: 5 (items 3, 4, 10, 12, 13).

Highest-priority gap before the patch: item 18 on license-server / Caddy / Worker. After the patch: residuals only (asar-embed keys, ffmpeg on valid media, Streamdown sanitizer, in-process limiters).

No tonight action plan beyond item 18. Do not add Turnstile, a password hasher, RLS, or a public DB key.

READY TO MERGE stays **no** until Devon reviews this document and the header patch.

---

## Phase 4 remediations (same PR)

| Gap | Fix | Tests |
|---|---|---|
| Express had no HSTS / nosniff / frame-deny | `securityHeaders` middleware in `createApp` | `license-server/server.test.mjs` |
| Worker JSON + stream lacked the same | `securityHeaders()` on `jsonResponse` and the upstream stream `Response` | `cloudflare-proxy/src/index.test.ts` |
| Caddy reverse_proxy only | `header` block on the TLS site | `security-audit-20.contract.test.ts` |

Capture / `saveTranscript` / `parakeetFeed` / `armAudio` still `takeHotPath`, never `denyIfLimited`. Overlay HTML was not given fake HSTS.

---

## Out of scope (frozen)

Overlay chrome, island geometry, onboarding, identity card, Intelligence dashboards, latency / time-saved, starfield, orbs, pill, Brain PRs. Pack and GitHub release stay last. Never auto-send.
