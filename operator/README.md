# metis-operator

Tony's fleet control plane. How people use Métis, who is live, what Asks cost, whether prompt cache is hitting, which questions should sharpen a skill, and a signed push of that skill to every seat.

This Worker is **not** the AI token proxy (`cloudflare-proxy/`, Worker `metis-cloudflare-proxy`). It is **not** the Fly license-server. Prompts never go to Fly. Existing Workers stay untouched:

- `metis-cloudflare-proxy`
- `aria-intake-llm`
- `notebooklm-mcp`
- `partner-mcp`
- `tco-supabase-keepalive`

New Worker name: `metis-operator`. Cloudflare account already in use: `tony.walteur@gmail.com`, account id `294885a27b3cc0a1cbe5d0ccbe38de4f`.

The admin UI is for Tony only. Unauthenticated GET of `/`, `/keys`, `/licenses`, `/devices`, `/map`, `/cloudflare`, and the other console paths **302**s to Cloudflare Access login. Only two emails can pass the JWT allowlist. Electron devices never see Access; they HMAC-sign ingest.

Do not enable **Protect this Worker** for all traffic. That would lock the Mac and Windows clients out.

Do not wrangler deploy from CI with secrets.

## Path split (hard)

| Path | Who | Auth |
| --- | --- | --- |
| `/` `/keys` `/licenses` `/devices` `/map` `/cloudflare` and other console paths | Tony in a browser | Unauth GET **302** to `{TEAM_DOMAIN}/cdn-cgi/access/login/{host}?redirect_url=…&next={path}`. Console after Access JWT (`Cf-Access-Jwt-Assertion` / `getIdentity()`) and allowlist. 503 if `TEAM_DOMAIN` is unset. |
| `/v1/admin/*` | Tony in a browser | Access JWT + allowlist. JSON 401 if missing. Includes `/v1/admin/dashboard`, `/v1/admin/keys` write/rotate/revoke, and CRM retry. |
| `POST /v1/ingest` | Métis desktop | HMAC only. Not Access. |
| `POST /v1/heartbeat` | Métis desktop | HMAC only. Not Access. |
| `POST /v1/use` | Métis desktop | HMAC only. Not Access. Brokers a funded Ask. Never returns a raw vault secret. |
| `GET /v1/skills/manifest` | Métis desktop | HMAC only. Not Access. |
| `GET /health` | Anyone | Open. Says whether secrets are bound, never what they are. |

If identity is missing on `/v1/admin/*`, the Worker returns JSON 401 even when a valid ingest HMAC is present. Unauth `POST /v1/admin/keys` is 401, not 404. Browser GET `/` is Access 302, not an HTML password form. No `LICENSE_ADMIN_TOKEN`.

## Secrets (Wrangler only)

Never put these in git, logs, PR bodies, or `wrangler.jsonc`.

| Secret | What it is |
| --- | --- |
| `OPERATOR_INGEST_SECRET` | HMAC-SHA256 shared with each Métis seat (Settings → Privacy → Ingest secret, or `METIS_OPERATOR_INGEST_SECRET`). |
| `OPERATOR_PROMPT_KEY` | 32-byte AES-GCM key, base64. Encrypts Ask text before D1. |
| `OPERATOR_SKILL_PRIVATE_KEY` | Ed25519 PKCS8 PEM (or base64 of that PEM). Signs skill packs. The public half is committed in `src/main/operator-skill-key.ts`. |
| `OPERATOR_VAULT_KEY` | 32-byte AES-GCM key, base64. Encrypts LLM API keys and the Cloudflare account token in D1. Separate from `OPERATOR_PROMPT_KEY`. |

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

`TEAM_DOMAIN` is a Wrangler var (`https://tony-walteur.cloudflareaccess.com`) so unauth console GET can 302 before the Access app exists. After Tony enables Zero Trust and creates **Métis Operator**, set the AUD:

```sh
npx wrangler@4 secret put POLICY_AUD
```

If the team name is not `tony-walteur`, set `TEAM_DOMAIN` to `https://<team>.cloudflareaccess.com`. Unset team = Worker 503, not a password form. Exact Zero Trust app + policy: `docs/design/OPERATOR.md`.

## D1

```sh
cd operator
npx wrangler@4 d1 create metis-operator
```

Paste the printed `database_id` into `wrangler.jsonc` (replace `REPLACE_AFTER_D1_CREATE`). Then:

```sh
npx wrangler@4 d1 execute metis-operator --file=schema.sql --remote
npx wrangler@4 d1 execute metis-operator --file=schema.sql --local
```

If this D1 already exists from an earlier Operator draft, also apply `schema-alter.sql` (new seat geo columns, `pulses`, `crm_sends`). Skip any `ALTER` that already landed.

Prompt bodies are ciphertext only. The schema has no plaintext Ask column. Geo is country ISO + optional city + optional lat/lon from Cloudflare `request.cf` on the Worker. Never store IP. The Electron client does not send coordinates.

The hosted console is a packed dark ops page: 3-up KPI sparklines, scale/cost charts, a choropleth of unique devices, a change heatmap, a CRM send board (seven statuses are filters; Retry on Failed never auto-sends), redacted Asks, and Draft / Approve / Push. Empty map if no heartbeats. No sample visitors.

## Deploy

```sh
cd operator
npx wrangler@4 deploy
```

`wrangler deploy` prints the `*.workers.dev` URL. Put that URL in Métis Settings → Privacy → Operator URL on each seat, plus the same ingest secret. Do not pack installers from this change.

Zero Trust org `tony-walteur` and the Access apps are created. Tony completes One-time PIN in a browser. Exact table: `docs/design/OPERATOR.md`.

## Cloudflare Access (console + admin API only)

1. Team `tony-walteur` → `TEAM_DOMAIN=https://tony-walteur.cloudflareaccess.com`.
2. Self-hosted app **Métis Operator** on `metis-operator.tony-walteur.workers.dev` (Allow, two Tony emails).
3. Bypass apps on `/health`, `/v1/ingest`, `/v1/heartbeat`, `/v1/use`, `/v1/skills/manifest`, and `/v1/admin` (Worker returns 401 JSON on admin).
4. One-time PIN IdP. Do not click **Protect this Worker**.
5. Bind `POLICY_AUD` (Métis Operator AUD) as a Worker secret.

The Worker 302s unauth console GET to `{TEAM_DOMAIN}/cdn-cgi/access/login/{host}?redirect_url=…&next={path}`, then verifies `Cf-Access-Jwt-Assertion` / `ctx.access.getIdentity()` against the two Tony emails. Missing `TEAM_DOMAIN` is 503, not a homemade form.

## Métis client

Settings → Privacy:

- **Operator URL** (https). Empty by default. `METIS_OPERATOR_URL` may prefill.
- **Ingest secret**. Same value as `OPERATOR_INGEST_SECRET`. `METIS_OPERATOR_INGEST_SECRET` may prefill.
- **Send Ask text for skill improvement**. Default on once a URL is set. Off sends metrics only.
- **Open Operator**. System browser. Tony signs in with Access.

While the app is up and both URL and secret are set:

- Heartbeat about every 60 seconds.
- After each typed/screen Ask: metrics always; question text only if the toggle is on. Never Listen transcripts, screen captures, audio, or API keys.
- Skill manifest on launch and every 6 hours. Overlay applies only when the ed25519 signature and sha256 match. Drafts never apply. Approve without Push does nothing on the client.

Overlays land in `userData/skills-overrides` with `lock.json`. The shipped skill stays if the overlay is missing or the lock does not match.

## HMAC (devices)

Canonical string:

```
${ts}.${nonce}.${deviceId}.${sha256Hex(body)}
```

Headers: `x-metis-ts`, `x-metis-nonce`, `x-metis-device`, `x-metis-sig` (hex HMAC-SHA256). Timestamp skew greater than 5 minutes is rejected. Nonces are one-shot inside a 10 minute window. Per-device rate limit is 90 requests per minute.

GET `/v1/skills/manifest` uses an empty body (hash of `""`).

## Skill packs

Push (not Approve) writes a signed pack: `base64url(JSON).base64url(ed25519)`. Payload is `{ skillId, version, sha256, body }`. Clients verify with the bundled public key.

Humanizer stays in every mode. Recruiting stays interviewer-of-record. Interview stays candidate-side. Never auto-apply a draft.

## Tests

From the repo root:

```sh
npm run test:operator
```

CI runs this via `npm test`. The suite does not deploy and does not need Wrangler secrets.
