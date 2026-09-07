# metis-operator

Tony's fleet control plane. How people use Métis, who is live, what Asks cost, whether prompt
cache is hitting, which questions should sharpen a skill, and a signed push of that skill to
every seat.

This Worker is **not** the AI token proxy (`cloudflare-proxy/`, Worker `metis-cloudflare-proxy`).
It is **not** the Fly license server. Prompts never go to Fly.

The admin console is for Tony only. Electron devices never see Access; they HMAC-sign every
request.

**Hard rules, never violated:**

- Access is email-code only, allowlist `tony.walteur@gmail.com` and `twalteur@amaris.com`. No
  homemade password form. Unauthenticated console GET is a 302 to Access. Unauthenticated
  `/v1/admin/*` is 401 JSON.
- Never enable **Protect this Worker**. That would lock every Mac and Windows seat out, along with
  every automated smoke check.
- Prompt text is ciphertext only in D1; Reveal is audited. IP addresses are never stored. Vault
  secrets show last 4 characters only, never the full value, in any JSON or HTML response.
- No fake data anywhere. An empty state names why it is empty; a real zero is shown as a zero, a
  missing value is shown as "not reported," never silently substituted with either.
- Approve without Push does nothing to a seat. Retry on a failed CRM send never auto-sends.
  Drafts never apply on the client.
- No merge into another console, no packing, no Latest feed. This is the only Worker allowed to
  deploy independently as `metis-operator`.

## Architecture

```
Métis desktop seat                    metis-operator Worker                    D1 (SQLite)
------------------              --------------------------              -----------------
heartbeat every ~60s   --HMAC-->  verify sig, rate limit,     --write-->  seats, pulses,
Ask (typed/screen)     --HMAC-->  decrypt/encrypt Ask text,   --write-->  asks, events,
Listen / Recap         --HMAC-->  upsert seat, insert event,  --write-->  sessions, crm_sends,
CRM push               --HMAC-->  materialize session,        --write-->  vault_keys, audit,
skill manifest poll    --HMAC-->  serve signed skill packs    <--read---  issued_licenses,
                                                                           groups, tiers,
Tony's browser         --Access-> resolve identity (JWT or    --read/--   integrations, ...
                                  minted session cookie),      write-->
                                  render/serve the admin
                                  console and JSON API
```

- **Desktop seat.** Every Métis install is a "seat," identified by a stable `deviceId`. It never
  authenticates with Cloudflare Access; instead every request it makes to `/v1/*` (except the
  console, which it never calls) carries an HMAC signature over a canonical string, proving it
  holds `OPERATOR_INGEST_SECRET` without ever sending that secret over the wire.
- **HMAC.** Canonical string: `${ts}.${nonce}.${deviceId}.${sha256Hex(body)}` (see
  `src/shared/operator-hmac.ts`, shared byte for byte between the Worker's WebCrypto
  implementation and Electron's `node:crypto` one). Headers: `x-metis-ts`, `x-metis-nonce`,
  `x-metis-device`, `x-metis-sig` (hex HMAC-SHA256). A timestamp more than 5 minutes off now is
  rejected. A nonce is accepted once; it is only consumed after the signature itself verifies, so
  an attacker who does not hold the secret cannot burn a real seat's nonce. Per-route, per-device
  rate limits: heartbeat 5/min, ingest 60/min, use 120/min, manifest 5/min; a 429 is returned once
  a bucket is exceeded.
- **Worker.** `src/index.ts` dispatches every request: the public `/health`, the HMAC-signed `/v1/*`
  device routes, and the Access-gated console and `/v1/admin/*` JSON routes (`src/routes/registry.ts`
  holds the route table; auth, HMAC, CSRF and structured request logging stay in `index.ts`). Every
  admin HTML and JSON response carries `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY` (see `src/http.ts`); HTML additionally
  carries a CSP (`script-src 'self'`, plus a per-request nonce for the one inline script that still
  ships until the client bundle fully replaces it). Every admin `POST` is checked against
  `Sec-Fetch-Site`/`Origin` and refused with `403 {code:'csrf'}` on a cross-site attempt.
- **D1.** SQLite at the edge. Prompt bodies are AES-GCM ciphertext only; there is no plaintext Ask
  column. Geo is country ISO plus optional city and lat/lon from Cloudflare's own `request.cf`,
  never the seat's raw IP.
- **Access.** Cloudflare Zero Trust gates the console and `/v1/admin/*` for a browser. The Worker
  also accepts a self-minted session cookie (HMAC-signed, HKDF-derived from `OPERATOR_PROMPT_KEY`
  unless `OPERATOR_SESSION_SECRET` is set) so a signed-in session survives an Access cookie expiry
  mid-session without a silent stale render; absolute session lifetime is 12 hours.

### Path split (hard)

| Path | Who | Auth |
| --- | --- | --- |
| `/`, and the other console paths | Tony in a browser | Unauthenticated GET is a 302 to `{TEAM_DOMAIN}/cdn-cgi/access/login/{host}?redirect_url=...`. After the Access JWT (or a still-valid minted session cookie) and the two-email allowlist. 503 if `TEAM_DOMAIN` is unset. |
| `/v1/admin/*` | Tony in a browser | Same identity check as the console; JSON 401 (never a redirect) when missing. |
| `POST /v1/ingest` | Métis desktop | HMAC only. Not Access. |
| `POST /v1/heartbeat` | Métis desktop | HMAC only. Not Access. |
| `POST /v1/use` | Métis desktop | HMAC only. Not Access. Brokers a funded Ask; never returns a raw vault secret. |
| `POST /v1/ask` | Métis desktop | HMAC only. Not Access. SSE stream (`delta` / `done` / `error`). Same seat + vault rules as `/v1/use`. |
| `GET /v1/skills/manifest` | Métis desktop | HMAC only. Not Access. Empty body, so the signed hash is `sha256Hex("")`. |
| `GET /v1/integrations` | Métis desktop | HMAC only. Not Access. |
| `GET /health` | Anyone | Open. Says whether secrets are bound, never what they are. |
| `/assets/*` | Anyone | Open. Public console chrome (hashed JS/CSS, the world map SVG). Access must never wrap these. |

If identity is missing on `/v1/admin/*`, the response is JSON 401 even when a valid ingest HMAC is
present on the same request. Unauthenticated `POST /v1/admin/keys` is 401, not 404. Browser
`GET /` is an Access 302, never a homemade HTML password form. There is no `LICENSE_ADMIN_TOKEN`.

## Security

`OPERATOR_INGEST_SECRET` is one shared secret for the whole fleet, not one per device. Any seat
that has been configured with the Operator URL and that secret can sign a request under any device
id it chooses; the HMAC proves the caller knows the shared secret, not which physical machine it is
running on. This is mitigated three ways, not eliminated: the device id format check
(`DEVICE_ID_RE` in `src/hmac.ts`) rejects anything shaped like an attack rather than a real seat id
before the signature is even checked, a device still needs Tony's Approve or an active issued
license before vault keys or connectors work for it, and every mutation and every seat action lands
in the audit trail so an impersonated device id is visible after the fact. Per-device secrets, so
one compromised install could never sign as another, are future work, not shipped today.

A connector set to direct delivery mode hands its decrypted credential to every seat entitled by
tier or group, not to one seat, and any of those seats can hold that credential in memory once it
is delivered. For that reason direct mode should be scoped to a narrow group with a real reason to
need it, never left open to a whole tier, and it is off by default. Brokered mode is the default:
the credential stays in the Worker, which proxies the call on the seat's behalf, so a connector
credential is never sent to a device at all.

## Data model (D1)

One row per concept, ciphertext where the plan calls for it, no plaintext Ask text anywhere. Full
column list: `schema.sql` (fresh install) plus `schema-alter.sql` (columns and tables added since,
applied idempotently by the migration runner, see below).

| Table | What it holds |
| --- | --- |
| `seats` | One row per device: hostname, SSO email, OS, app version, license state, approval, last-seen geo. `approval` is never overwritten by an ingest upsert once set. |
| `asks` | One row per Ask: ciphertext prompt (`prompt_cipher`/`prompt_iv`), provider/model, token and cache counts, latency, outcome, rating. No plaintext question column exists. |
| `pulses` | Lightweight per-device activity ticks (heartbeat, ask, recap) that session materialization and the realtime bar charts read from. |
| `events` | The Events page's source of truth: one row per heartbeat, ask, recap, listen, rating, crm, vault, license, or seat action, with a redacted `detail` string only (never a secret-shaped one). 30-day retention. |
| `sessions` | One seat's pulses grouped into a session (gap under 2 minutes closes it), maintained by the ingest path and a daily cron. |
| `vault_keys` | Encrypted LLM provider keys and the Cloudflare account token. `last4` is the only plaintext fragment ever returned. A rotation marks the prior active row of the same provider `superseded`. |
| `crm_sends` | One row per CRM push attempt: status, connector, retry count, latency, remote id/url once delivered. Retry never auto-sends; it only flips status back to pending. |
| `nonces` | One-shot HMAC nonces, pruned after their replay window. |
| `rate_limits` | Per-device sliding-window counters for the HMAC routes. |
| `proposals` | Draft skill-pack diffs: evidence, rationale, status (pending, approved, rejected, pushed). |
| `packs` | Signed, pushed skill packs (ed25519 signature over `{skillId, version, sha256, body}`). |
| `audit` | Every admin mutation and every Reveal, with actor, action, and (once P0.3 lands the full traceability set) `request_id` and `route`. 365-day retention. |
| `issued_licenses` | Operator-minted license tokens: `jti`, hashed key, expiry, revoked flag, and (Groups, section 9c) which group/tier/member it was issued to and which device activated it. |
| `groups` / `group_members` | Named groups of seats (by email or device id) with a tier, for license issuance and entitlement resolution. |
| `tiers` | Entitlement sets per tier (`metis`, `metis-light`, ...), editable from Settings; a heartbeat response carries the resolved `tier` and `entitlements` for the requesting seat. |
| `integrations` / `integration_grants` | One credential per CRM/MCP connection, scoped to tiers or groups, and an audit trail of every credential delivery to a seat. |

## API reference

### Admin JSON (`/v1/admin/*`, Access-gated, JSON everywhere)

Every `POST` is method-checked, JSON-only, CSRF-checked, and returns `{ ok, ... }` on success or
`{ ok: false, error, code? }` on failure.

| Route | Purpose |
| --- | --- |
| `GET /v1/admin/dashboard` | Full console payload (secrets stripped). |
| `GET /v1/admin/realtime.geo.json` | Geo rows and region rollups for the Realtime map and table. |
| `GET /v1/admin/health.json` | Platform health for Settings: bindings, Access config, D1 schema status via `PRAGMA table_info`, worker version. |
| `GET /v1/admin/audit.json` | Audit log rows, filterable. |
| `GET /v1/admin/export.csv?table=...` | CSV export for traceability tables. |
| `GET/POST /v1/admin/keys`, `.../rotate`, `.../revoke` | Vault key CRUD. Add never uses a raw prompt; last4 only in the response. |
| `GET /v1/admin/summary` | Small scalar KPI set. |
| `GET /v1/admin/asks`, `GET /v1/admin/asks/:id` | Redacted list; single-row Reveal is audited and returns plaintext only for that one call. |
| `POST /v1/admin/skills/draft`, `.../:id/(approve\|reject\|push)` | Skill-pack review flow. Approve without Push does nothing to a seat. |
| `POST /v1/admin/crm/:id/retry` | Flips a failed/expired CRM send back to pending. Never auto-sends. |
| `POST /v1/admin/licenses/generate` | Mints an Operator license; the token string is shown once. |
| `GET /v1/admin/licenses/issued`, `GET /v1/admin/licenses` | Issued and seat-facing license views. |
| `POST /v1/admin/licenses` , `.../:id/(approve\|revoke)` | Seat approval and license revoke actions, audited. |

Groups, Tiers, Sessions, and Events have their own dedicated admin JSON routes per plan section
9c; check `src/routes/registry.ts` for the exact, current set as those land, since this file is a
snapshot and that module is the live source of truth.

### HMAC device routes (`/v1/*`, no Access)

| Route | Method | Body |
| --- | --- | --- |
| `POST /v1/heartbeat` | POST | `{ seatHash, os, appVersion, hostname?, ssoEmail?, license?, licenseId?, lastIndexAt?, path? }`. Response: `{ ok, retry: string[], fundedProviders, approved, tier, entitlements }` (and, once integrations land, `integrationsVersion`). |
| `POST /v1/ingest` | POST | Ask, rating, listen/recap, or crm events, shaped per `event` field. GET is rejected (405 or 401), never processed. |
| `POST /v1/use` | POST | Brokers a funded Ask through a stored provider key. Never returns the raw key. |
| `POST /v1/ask` | POST | HMAC SSE Ask. Portal-funded CF default `@cf/deepseek-ai/deepseek-v4-flash-0731`. Never returns the raw key. |
| `GET /v1/skills/manifest` | GET | No body. Returns `{ ok, skills: [{ skillId, version, sha256, signed }] }`. |
| `GET /v1/integrations` | GET | HMAC only. Not Access. Returns CRM/MCP connections the seat's tier/group is entitled to (credentials for approved/licensed seats); every fetch audited. Cloudflare Access must Bypass this path (same as heartbeat). |

`GET /health` (open, no auth): `{ ok, service: "metis-operator", configured }` today.
`configured` is true once both `OPERATOR_INGEST_SECRET` and `OPERATOR_PROMPT_KEY` are bound. A
`version` field (the deployed `OPERATOR_VERSION`) and D1 reachability are part of the P4.0
enterprise-readiness gate; confirm `/health`'s exact current shape in `src/index.ts` before relying
on a field this document does not list. It also reports `schema` (D1 schema status), `lastIngestAt`
(the newest seat or ask activity) and `lastCronAt` (the timestamp of the newest `platform.heartbeat`
audit row, i.e. when the retention cron last actually ran) - never a secret or a binding value.

## Seat contract

A seat that wants full functionality sends, on every heartbeat:

```json
{
  "seatHash": "...",
  "os": "darwin",
  "appVersion": "1.8.5",
  "hostname": "...",
  "ssoEmail": "user@company.com",
  "license": "licensed",
  "licenseId": "...",
  "lastIndexAt": 1735689600000,
  "path": "/"
}
```

Every field except `seatHash`, `os`, and `appVersion` is optional; a seat that omits `hostname` or
`ssoEmail` simply shows less in Sessions and Overview, it is never treated as an error. The
desktop client never sends: raw prompt-free telemetry it was not asked to, screen captures, audio,
Listen transcripts, or API keys. Overlays applied from a pushed skill pack live in
`userData/skills-overrides` with `lock.json`; the shipped skill stays in place if the overlay file
is missing or its lock does not match the pack's signature.

## Deploy, migrate, backup, rotate, incident response

Full step-by-step procedures live in **`docs/operator/RUNBOOKS.md`**. Summary:

- **Deploy.** `node operator/scripts/deploy.mjs --env staging`, confirm, then
  `node operator/scripts/deploy.mjs --env production`. Refuses a dirty git tree, typechecks and
  tests first, builds the client and world bundles, stamps `OPERATOR_VERSION`/`OPERATOR_BUILT_AT`,
  runs migrations before code, deploys, then runs the post-deploy smoke
  (`operator/scripts/smoke.mjs`). `--dry-run` prints the full plan without touching anything.
  Rollback: `npx wrangler@4 rollback [--env staging]`.
- **Migrate.** `node operator/scripts/migrate.mjs --remote [--env staging]`, idempotent,
  statement by statement.
- **Backup and restore.** `node operator/scripts/backup.mjs [--env staging]` exports D1 to
  `operator/backups/` (gitignored). D1 Time Travel covers most recovery needs without a file at
  all; `--restore <file> --yes` covers a full re-seed.
- **Rotate a secret.** `npx wrangler@4 secret put <NAME> [--env staging]`. See the runbook's table
  for exactly what breaks per secret while the fleet catches up.
- **Local dev without Access.** `npm run dev:operator` (`wrangler dev --local` from `operator/`),
  then `node operator/scripts/dev-session.mjs --prompt-key <value>` to mint a console session
  cookie locally, printed as a `Cookie:` header line, for Playwright or curl to use directly. Never
  prints the secret itself.
- **Incident response.** Read logs by `cf-ray` request id (`npx wrangler@4 tail`), roll back code
  first, disable a seat (Revoke in Sessions/Licenses), revoke a license (Revoke in Licenses). Full
  detail in the runbook.

## Secrets (Wrangler only)

Never put these in git, logs, PR bodies, or `wrangler.jsonc`.

| Secret | What it is |
| --- | --- |
| `OPERATOR_INGEST_SECRET` | HMAC-SHA256 shared with each Métis seat (Settings, Privacy, Ingest secret, or `METIS_OPERATOR_INGEST_SECRET`). |
| `OPERATOR_PROMPT_KEY` | 32-byte AES-GCM key, base64. Encrypts Ask text before D1. Also the fallback source for the session-signing secret. |
| `OPERATOR_SESSION_SECRET` | Optional. When set, signs the console session cookie instead of deriving from `OPERATOR_PROMPT_KEY`, so the two can rotate on independent schedules. |
| `OPERATOR_SKILL_PRIVATE_KEY` | Ed25519 PKCS8 PEM (or base64 of that PEM). Signs skill packs. The public half is committed in `src/main/operator-skill-key.ts`. |
| `OPERATOR_VAULT_KEY` | 32-byte AES-GCM key, base64. Encrypts LLM API keys and the Cloudflare account token in D1. Separate from `OPERATOR_PROMPT_KEY`. |
| `POLICY_AUD` | The Access application's audience tag, once Tony creates the Zero Trust app. |
| `CF_OAUTH_CLIENT_ID` / `CF_OAUTH_CLIENT_SECRET` | Optional. Only needed for the Keys page's Cloudflare account connect flow. |

Generate locally, then `secret put` (hidden prompt, not a shell argument):

```sh
openssl rand -base64 32          # OPERATOR_INGEST_SECRET
openssl rand -base64 32          # OPERATOR_PROMPT_KEY (must decode to 32 bytes)
openssl rand -base64 32          # OPERATOR_VAULT_KEY (must decode to 32 bytes)
openssl genpkey -algorithm Ed25519 -out skill.pem
# public JWK x, for resources/operator/pubkey.json on a production build:
node -e "const {createPrivateKey,createPublicKey}=require('crypto');const fs=require('fs');const pub=createPublicKey(createPrivateKey(fs.readFileSync('skill.pem')));console.log(pub.export({format:'jwk'}).x)"
```

```sh
cd operator
npx wrangler@4 login
npx wrangler@4 secret put OPERATOR_INGEST_SECRET
npx wrangler@4 secret put OPERATOR_PROMPT_KEY
npx wrangler@4 secret put OPERATOR_SKILL_PRIVATE_KEY
npx wrangler@4 secret put OPERATOR_VAULT_KEY
```

`TEAM_DOMAIN` is a Wrangler var (`https://tony-walteur.cloudflareaccess.com`), not a secret, so an
unauthenticated console GET can 302 before the Access app even exists. After Tony enables Zero
Trust and creates **Métis Operator**, set the AUD:

```sh
npx wrangler@4 secret put POLICY_AUD
```

If the team name is not `tony-walteur`, set `TEAM_DOMAIN` to `https://<team>.cloudflareaccess.com`.
An unset team means the Worker returns 503, never a password form. Exact Zero Trust app and
policy: `docs/design/OPERATOR.md` and `docs/operator/RUNBOOKS.md`.

### Connectors: OAuth registration

Six connector kinds authenticate over OAuth 2.0 instead of a static credential (`operator/src/
connectors/catalog.ts`'s `oauth` config, `operator/src/connectors/oauth.ts`). Each needs its own
one-time app registration with the vendor, then two Worker secrets named `OAUTH_<KIND>_CLIENT_ID`
and `OAUTH_<KIND>_CLIENT_SECRET`. A kind's catalog tile flips from "Needs OAuth" to ready the moment
both are bound - no redeploy required.

The redirect URI is fixed and identical for every vendor (only the callback route, never a
per-connector path):

| Environment | Redirect URI to paste into the vendor's app registration |
| --- | --- |
| production | `https://metis-operator.tony-walteur.workers.dev/v1/admin/connectors/oauth/callback` |
| staging | `https://metis-operator-staging.tony-walteur.workers.dev/v1/admin/connectors/oauth/callback` |

**Google Drive** (authorization-code, PKCE) - [Google Cloud Console](https://console.cloud.google.com/apis/credentials) > Create Credentials > OAuth client ID > Web application. Paste the redirect URI above. Scope requested: `https://www.googleapis.com/auth/drive.file` (only files Métis itself creates or opens - broaden in `catalog.ts` if the fleet needs to read files it did not create).

```sh
npx wrangler@4 secret put OAUTH_GOOGLEDRIVE_CLIENT_ID
npx wrangler@4 secret put OAUTH_GOOGLEDRIVE_CLIENT_SECRET
```

**Zoho CRM** (authorization-code) - [Zoho API Console](https://api-console.zoho.com/) (or the regional equivalent, e.g. `api-console.zoho.eu`) > Add Client > Server-based Applications, not Self Client. Paste the redirect URI above. Scopes ticked: `ZohoCRM.modules.ALL`, `ZohoCRM.settings.ALL`. The drawer additionally asks for the data centre (`accounts.zoho.com`, `.eu`, `.in`, `.com.au`, `.jp`, `.com.cn`, or `zohocloud.ca`) per connection - it must match the console the app was registered in.

```sh
npx wrangler@4 secret put OAUTH_ZOHO_CLIENT_ID
npx wrangler@4 secret put OAUTH_ZOHO_CLIENT_SECRET
```

**Salesforce** (client-credentials, per-connection app) - Setup > App Manager > New Connected App > enable OAuth, check "Client Credentials Flow", assign a run-as user. No redirect URI is used by this grant. The drawer collects the org's My Domain URL, the Connected App's consumer key (client id), and its consumer secret (vault-encrypted as this connection's credential - never plain `config_json`). Scope requested: `api`.

```sh
npx wrangler@4 secret put OAUTH_SALESFORCE_CLIENT_ID
npx wrangler@4 secret put OAUTH_SALESFORCE_CLIENT_SECRET
```

**Microsoft Dynamics 365 / SharePoint / Microsoft Teams** (client-credentials, one Azure AD app registration per vendor) - [Microsoft Entra admin center](https://entra.microsoft.com/) > App registrations > New registration > Certificates & secrets > New client secret. Grant the app the API permission it needs (Dataverse `user_impersonation` as an application permission for Dynamics; `Sites.Read.All`/`Files.ReadWrite.All` for SharePoint; `Chat.Read.All`/`ChannelMessage.Read.All` for Teams, all as **Application** permissions, then **Grant admin consent**). No redirect URI is used by this grant. The drawer collects the Microsoft Entra tenant id, the app's client id, and its client secret (vault-encrypted); Dynamics additionally collects the organization URL (`https://yourorg.crm.dynamics.com`), used to build the token request's scope.

```sh
npx wrangler@4 secret put OAUTH_DYNAMICS365_CLIENT_ID
npx wrangler@4 secret put OAUTH_DYNAMICS365_CLIENT_SECRET
npx wrangler@4 secret put OAUTH_SHAREPOINT_CLIENT_ID
npx wrangler@4 secret put OAUTH_SHAREPOINT_CLIENT_SECRET
npx wrangler@4 secret put OAUTH_MICROSOFTTEAMS_CLIENT_ID
npx wrangler@4 secret put OAUTH_MICROSOFTTEAMS_CLIENT_SECRET
```

Every OAuth-obtained token is stored the same way a static API key is: AES-GCM encrypted with
`OPERATOR_VAULT_KEY`, last4 only ever leaving the Worker. An authorization-code connection's access
token is refreshed automatically (`oauth.ts#refreshOAuthToken`) once it is within 5 minutes of
expiry; a refresh failure is recorded on the connection (visible as "failing" in the console) and
never deletes the row - the admin sees exactly what broke instead of the connector silently
vanishing.

## D1 setup (first time only)

```sh
cd operator
npx wrangler@4 d1 create metis-operator
```

Paste the printed `database_id` into `wrangler.jsonc`. Then apply the schema with the migration
runner rather than a raw `d1 execute` (it is idempotent and safe to re-run):

```sh
node scripts/migrate.mjs --remote
node scripts/migrate.mjs --local
```

## Environments

| Environment | Worker name | D1 database | URL |
| --- | --- | --- | --- |
| production | `metis-operator` | `metis-operator` | `https://metis-operator.tony-walteur.workers.dev` |
| staging | `metis-operator-staging` | `metis-operator-staging` | `https://metis-operator-staging.tony-walteur.workers.dev` |

Both share the same Access team and the same two-email allowlist. Deploy staging first for any
change that touches D1 schema, HMAC verification, or Access identity resolution; see the runbook.

## Cloudflare Access (console and admin API only)

1. Team `tony-walteur`, `TEAM_DOMAIN=https://tony-walteur.cloudflareaccess.com`.
2. Self-hosted app **Métis Operator** on `metis-operator.tony-walteur.workers.dev` (Allow, the two
   Tony emails only).
3. Bypass policies on `/health`, `/v1/ingest`, `/v1/heartbeat`, `/v1/use`, `/v1/skills/manifest`,
   `/v1/integrations`, and `/assets/*` (keep in sync with `ACCESS_BYPASS_PATHS` in
   `operator/src/access.ts`). Leave `/v1/admin/*` to the Worker's own 401 JSON, do not wrap it a
   second time.
4. One-time PIN identity provider. Do not click **Protect this Worker**.
5. Bind `POLICY_AUD` (the Métis Operator app's AUD) as a Worker secret.

The Worker 302s an unauthenticated console GET to
`{TEAM_DOMAIN}/cdn-cgi/access/login/{host}?redirect_url=...`, then verifies the Access JWT (or a
still-valid minted session cookie) against the two-email allowlist. A missing `TEAM_DOMAIN` is
503, never a homemade form.

## Métis client (Settings, Privacy)

- **Operator URL** (https). Empty by default. `METIS_OPERATOR_URL` may prefill.
- **Ingest secret.** Same value as `OPERATOR_INGEST_SECRET`. `METIS_OPERATOR_INGEST_SECRET` may
  prefill.
- **Send Ask text for skill improvement.** Default on once a URL is set. Off sends metrics only.
- **Open Operator.** System browser. Tony signs in with Access.

While the app is up and both URL and secret are set: a heartbeat about every 60 seconds; after
each typed or screen Ask, metrics always and question text only if the toggle is on, never Listen
transcripts, screen captures, audio, or API keys; a skill manifest poll on launch and every 6
hours, applying an overlay only when its ed25519 signature and sha256 match, never a draft, never
an approved-but-not-pushed pack.

## Skill packs

Push (never Approve alone) writes a signed pack: `base64url(JSON).base64url(ed25519)`. Payload is
`{ skillId, version, sha256, body }`. Clients verify with the bundled public key. Humanizer stays
in every mode; Recruiting stays interviewer-of-record; Interview stays candidate-side. A draft
never auto-applies.

## Tests

From the repo root:

```sh
npm run test:operator
npx tsc --noEmit -p operator/tsconfig.json
npx tsc --noEmit -p operator/client/tsconfig.json
npx vitest run --config operator/scripts/vitest.config.ts   # deploy/smoke/backup/dev-session
```

`npm test` (root) chains `test:operator`; `npm run typecheck` (root) chains both `tsc` calls
above. Neither the operator suite nor the scripts contract tests deploy anything or need Wrangler
secrets.

## CI

`.github/workflows/build.yml`'s `operator` job runs on every push and every pull request into
`main`/`master`, independently of the Electron app's `quality`/`security`/packaging jobs: rebuilds
the client bundle (and the world bundle, once `build-world.mjs` lands) and fails the build if the
committed generated file drifts from a fresh one, typechecks both operator tsconfigs, and runs the
operator test suite plus the scripts contract tests. It never deploys; deploys are run by hand by
Tony (see above), because CI holds no Cloudflare auth or secrets for this Worker.
