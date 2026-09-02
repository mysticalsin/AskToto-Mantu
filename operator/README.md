# metis-operator

Tony's fleet control plane. How people use Métis, who is live, what Asks cost, whether prompt cache is hitting, which questions should sharpen a skill, and a signed push of that skill to every seat.

This Worker is **not** the AI token proxy (`cloudflare-proxy/`, Worker `metis-cloudflare-proxy`). It is **not** the Fly license-server. Prompts never go to Fly. Existing Workers stay untouched:

- `metis-cloudflare-proxy`
- `aria-intake-llm`
- `notebooklm-mcp`
- `partner-mcp`
- `tco-supabase-keepalive`

New Worker name: `metis-operator`. Cloudflare account already in use: `tony.walteur@gmail.com`, account id `294885a27b3cc0a1cbe5d0ccbe38de4f`.

The admin UI is Access-gated. Only two emails can open it. Electron devices never see Access; they HMAC-sign ingest.

Do not enable **Protect this Worker** for all traffic. That would lock the Mac and Windows clients out.

Do not wrangler deploy from CI with secrets.

## Path split (hard)

| Path | Who | Auth |
| --- | --- | --- |
| `/` | Tony in a browser | Cloudflare Access, then the Worker checks identity |
| `/v1/admin/*` | Tony in a browser | Same Access + Worker identity check. Includes `/v1/admin/dashboard` and CRM retry. |
| `POST /v1/ingest` | Métis desktop | HMAC only. Not Access. |
| `POST /v1/heartbeat` | Métis desktop | HMAC only. Not Access. |
| `GET /v1/skills/manifest` | Métis desktop | HMAC only. Not Access. |
| `GET /health` | Anyone | Open. Says whether secrets are bound, never what they are. |

If Access is missing on an admin route, the Worker returns 401 even when a valid ingest HMAC is present. There is no password page and no `LICENSE_ADMIN_TOKEN`.

The Worker never answers a 3xx and never answers HTML on a device path. If a seat sees a 302 on `/v1/heartbeat`, `/v1/ingest`, or `/v1/skills/manifest`, Cloudflare Access is wrapping that path at the edge, before the Worker runs. The seat fetches with `redirect: 'manual'`, refuses the Access login page, and logs `[operator] <path> is behind Cloudflare Access`. Fix the Access app (next sections); there is nothing to fix in the Worker.

## Secrets (Wrangler only)

Never put these in git, logs, PR bodies, or `wrangler.jsonc`.

| Secret | What it is |
| --- | --- |
| `OPERATOR_INGEST_SECRET` | HMAC-SHA256 shared with each Métis seat (Settings → Privacy → Ingest secret, or `METIS_OPERATOR_INGEST_SECRET`). |
| `OPERATOR_PROMPT_KEY` | 32-byte AES-GCM key, base64. Encrypts Ask text before D1. |
| `OPERATOR_SKILL_PRIVATE_KEY` | Ed25519 PKCS8 PEM (or base64 of that PEM). Signs skill packs. The public half is committed in `src/main/operator-skill-key.ts`. |

Generate locally, then `secret put` (hidden prompt, not a shell argument):

```sh
openssl rand -base64 32          # OPERATOR_INGEST_SECRET
openssl rand -base64 32          # OPERATOR_PROMPT_KEY (must decode to 32 bytes)
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
```

Optional Access JWT fallback vars (after you create the Access app):

```sh
npx wrangler@4 secret put TEAM_DOMAIN
npx wrangler@4 secret put POLICY_AUD
```

`TEAM_DOMAIN` looks like `https://<team>.cloudflareaccess.com`. `POLICY_AUD` is the Access application AUD.

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

This VM does not create a live Access hostname. After deploy, set Access by hand (next section).

## Cloudflare Access (admin paths only)

Zero Trust → Access → Applications → Add an application → Self-hosted.

An Access application on a domain with path `/` (or an empty path) protects the whole hostname. There is no way to protect exactly `/` and leave `/v1/ingest` open inside one application. The device paths are opened with a second application whose policy action is **Bypass**; Access applies the most specific path match first.

1. Application name: `Métis Operator`. Session duration: short (for example 24 hours).
2. Domain: the Worker hostname (`metis-operator.<subdomain>.workers.dev`) **or** a custom hostname you attach later. Leave the path empty (whole hostname).
3. Policy: action **Allow**, identity One-time PIN or Google, include only these two emails:
   - `tony.walteur@gmail.com`
   - `twalteur@amaris.com`
4. Second application, name `Métis Operator devices`, same hostname, one entry per public path: `/v1/ingest`, `/v1/heartbeat`, `/v1/skills/manifest`, `/health`. Policy: action **Bypass**, include **Everyone**. Those paths stay HMAC-only on the Worker.
5. Do not add other emails. Do not use "Protect this Worker" on the Worker itself (that wraps every route with no bypass).

Check from a shell with no cookies. The device paths must answer JSON, never `302`:

```sh
curl -sS -o /dev/null -w '%{http_code} %{content_type}\n' https://metis-operator.<subdomain>.workers.dev/health
curl -sS -o /dev/null -w '%{http_code} %{content_type}\n' -X POST https://metis-operator.<subdomain>.workers.dev/v1/heartbeat
```

Expected: `200 application/json` for `/health`, `401 application/json` for an unsigned heartbeat. A `302` on either means the Bypass application is missing or its path does not match.

The Worker also calls `ctx.access.getIdentity()` and, if `TEAM_DOMAIN` + `POLICY_AUD` are set, verifies `Cf-Access-Jwt-Assertion` against the team JWKS. A request that never passed Access is 401.

## Métis client

Settings → Privacy:

- **Operator URL** (https). Empty by default. `METIS_OPERATOR_URL` may prefill.
- **Ingest secret**. Same value as `OPERATOR_INGEST_SECRET`. `METIS_OPERATOR_INGEST_SECRET` may prefill.
- **Send Ask text for skill improvement**. Off by default, even with a URL set. Off sends metrics only. Question text is personal data; an admin can lock this key in `managed-config.json`.
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
