---
project: Métis
type: operator-control-plane-contract
owns: Cloudflare-hosted Operator console, device ingest, signed skill packs, client prompt-cache honesty, CRM send board, Tony LLM keys vault, Cloudflare account connect, seat funding signal, Ask routing law
does-not-own: overlay chrome (Bar / Island / Hide), leftover Intelligence PR 94, onboarding, installer packing, Fly license-server, Goldberg Aria, cloudflare-proxy AI token proxy, OpenPanel Pages/Funnels, Bklit Studio
ready-to-merge: no
implemented: keys-write, cloudflare-connect, fundedProviders, cli-first-routing
audience: Tony Walteur only. Two emails. Nobody else.
tokens:
  accent: "#7C8CF8"
  ok: "#83C092"
  danger: "#F0717A"
  bg: "#0a0a0b"
  bg-light: "#f4f4f5"
  panel: "#111113"
  panel-light: "#ffffff"
  hair: "rgba(255,255,255,0.10)"
  hair-light: "rgba(15,15,17,0.10)"
  land: "#2a2a2e"
  land-light: "#d4d4d8"
  chart-1: "#1a1a1d"
  chart-2: "#2a2a2e"
  chart-3: "#52525b"
  chart-4: "#a1a1aa"
  chart-5: "#e4e4e7"
typography:
  ui: "Geist, Inter, system-ui, sans-serif"
  mono: "Geist Mono, ui-monospace, SFMono-Regular, monospace"
  eyebrows: "uppercase, letter-spaced, Geist Mono"
---

# Operator control plane

Tony's ops console. How people use Métis, who is live, what Asks cost, whether prompt cache is hitting, where seats check in, which CRM sends are stuck, and a signed push of a skill to every Mac and Windows seat.

This is not a Settings card. It is not a local analytics page. The product is a Cloudflare Worker named `metis-operator` under `operator/`. The Métis client keeps prompt caching on, and talks to this Worker only when Settings has an Operator URL.

Live URL: `https://metis-operator.tony-walteur.workers.dev/`. Hash routes (`#events`, `#profiles`, `#realtime`) are the product pages. Data is real Operator D1 / HMAC ingest only.

## Product law (Tony 8:03–8:05 PM ET)

**Goal.** Tony holds LLM API keys in Operator. End-user Métis just works. Keep the product in Métis (seats, Asks, licenses, skills). OpenPanel-like density and calm luxury, adapted to those Métis nouns. Do not clone OpenPanel Pages or Funnels that are not Métis.

1. **Tony is the source of truth** for cloud provider keys (Anthropic, OpenAI, Gemini, NVIDIA NIM, DeepSeek, MiniMax, and the rest of the vault allowlist). Seats do not store those keys.
2. **Subscription first.** If Claude CLI (Cloud / Cloud Code, provider `claude-cli`) or Codex CLI (`codex-cli`) is connected and working, every user question routes there first. Operator-hosted API keys are fallback after quota or rate limit only.
3. **Dust is retrieval only.** Second brain, Métis published wiki, Spotlight Ref. Never general chat.
4. **CLI auth stays on the seat.** Settings → CLI Integration (`installCli` / `loginCli` / `testCli` / `cliConnected`) is unchanged. CLI kind stays `cli`. No API key. Do not fold CLI tokens into the Operator vault.
5. **Cloudflare is an Operator connection**, not a seat secret. Account ID + API token live in the vault (last4 only). Overview pulls Workers, D1, and analytics for `metis-operator`. Fail loud if the token is missing.

## Pixel language

Copy the **density and calm luxury** of OpenPanel (overview metrics, realtime, events, profiles). Adapt those surfaces to Métis seats, Asks, licenses, and skills. Do not pixel-clone Shoey commerce. Do not vendor OpenPanel, Bklit, or Studio. Do not add OpenPanel Pages or Funnels.

- Product sidebar, not a two-level leftover. One filled rail. Hash-routed pages. Search filters the rail.
- Light and dark both ship. Default follows `prefers-color-scheme`. Toggle persists in `localStorage`.
- Geist Sans + Geist Mono. Uppercase letter-spaced eyebrows.
- Hairline cards. Monochrome charts (`--chart-1` through `--chart-5`). Color is the exception: mint online, danger on Failed, accent `#7C8CF8` for live dots and primary actions.
- KPI strip is 3-up on Overview. Big number, tiny mono sublabel, axis-free sparkline.
- Map is a flat choropleth. No basemap tiles. No country labels. 5-step gray scale. **No repeating horizontal band artifacts** (strip date-line slivers from Natural Earth paths before paint).
- CRM send statuses are **dashboard filter chips** on Overview (paste order: pending, failed, success, in-progress, in-review, expired, submitted). Not a StatusDemo grid.
- No Unsplash. No demo people. No placeholder visitors. No sample map dots. Empty states say there is no ingest yet.

Copy is original Métis. Never identify as AI. No emoji as icon. User-facing sentences stay free of em dashes except the Profiles missing-field placeholder (`—`).

Windows has no notch. Overlay chrome stays frozen. The in-app Settings row is a power field plus Open Operator in the system browser.

## Who this is for

Tony only. Cloudflare Access allowlist:

- `tony.walteur@gmail.com`
- `twalteur@amaris.com`

Regular users never see this console.

Live `workers.dev` does not wrap `/` in a Cloudflare Access redirect today. The Worker itself must serve the login HTML so Tony can open the console. Access JWT remains a valid second identity path. Do not weaken the allowlist.

## What this is not (explicit non-goals)

This slice implements the keys vault, Cloudflare connect, and CLI-first routing law. No pack. No version bump. Overlay chrome stays frozen.

| Surface | Job |
| --- | --- |
| Overlay chrome (Bar / Island / Hide) | Frozen. Do not restyle. Do not edit those files from an Operator slice. |
| Leftover Intelligence PR 94 | Out of scope. Do not merge or restyle that leftover. |
| Installer packing / Electron / version | Do not pack EXE/DMG. Do not bump app version. |
| `license-server` on Fly | License activate / heartbeat / seats. Keep it there. No prompts. No keys. |
| Goldberg Aria / onboarding music | Frozen. Do not retarget. |
| `cloudflare-proxy/` (`metis-cloudflare-proxy`) | Existing AI token proxy. Do not reuse. Do not put CF tokens or LLM keys there. |
| `aria-intake-llm`, `notebooklm-mcp`, `partner-mcp`, `tco-supabase-keepalive` | Existing Workers. Do not touch. |
| In-app Operator page | Removed. Do not leave a fake local fleet view. |
| OpenPanel Pages / Funnels / Shoey commerce | Density reference only. Not a clone. Not Métis nouns. |
| Bklit Studio | Proprietary. Do not copy. |
| Settings CLI Integration | Keep `installCli` / `loginCli` / `testCli` / `cliConnected`. Do not fold CLI tokens into the vault. |
| Seat-stored Tony cloud keys | Forbidden under the new law. Seats keep CLI sessions and local/on-device only. |
| Dust as general chat | Forbidden. Retrieval only (second brain, published wiki, Spotlight Ref). |

New tree: `operator/`. Worker name: `metis-operator`. Account already in use: `tony.walteur@gmail.com`, account id `294885a27b3cc0a1cbe5d0ccbe38de4f`. D1 `metis-operator` id `8eb5a081-594c-407c-9470-6a5aa28b9f7c`.

## Routing law (must stay in DESIGN)

All user questions (typed Ask, screen Ask, live suggest that is a user question) follow this table. Dust is never a row in this table.

| Order | Condition | Route | Notes |
| --- | --- | --- | --- |
| 1 | `claude-cli` connected **and** working (`cliConnected['claude-cli']` true, live `testCli` / session probe ok) **and** it is the last-clicked CLI | Claude CLI (Cloud / Cloud Code subscription) | Kind `cli`. No API key. Subscription. |
| 1 | `codex-cli` connected **and** working **and** it is the last-clicked CLI | Codex CLI subscription | Kind `cli`. No API key. Subscription. |
| 2 | Primary CLI hit quota or rate limit, and the **other** CLI is connected and working | The other CLI | Last-clicked stays first. The sibling is next fallback. |
| 3 | Both CLIs missing, disconnected, or both quota / rate-limit exhausted | Operator-hosted API keys (funded providers) | Anthropic, OpenAI, Gemini, NVIDIA NIM, DeepSeek, MiniMax, and any other vault-active provider. Seat never holds the raw key. |
| 4 | No funded Operator provider answers | Honest fail | Do not silently invent a Dust chat. Do not pull a leftover seat-stored Tony key. |

**Last-clicked.** If both CLIs are connected, the CLI the user last activated in Settings → CLI Integration is primary. Connecting or clicking Connect on a card is last-clicked. The other connected CLI is the next fallback. Then Operator API keys.

**Fallback trigger.** Leave the subscription path only after a classified quota hit or rate limit (429 / spent Pro or Max / Codex usage cap). Transport blips, cancel, and credential-reject on CLI are not "use Operator keys now" unless the session is no longer working.

**TODAY vs this law.** TODAY `providerPriority` defaults to `api`, `cliPrimary` prefers Claude then Codex (fixed order), and Métis Local can outrank CLI for some in-scope modes. The new law is subscription-first for every user question when a CLI is connected and working. Local / on-device is not a bypass of a working CLI for those questions. Dust is not a chat fallback.

**Dust (never general chat).**

| Allowed | Forbidden |
| --- | --- |
| Second brain retrieval | Dust as the active chat provider for a typed or screen Ask |
| Métis published wiki | Dust as failover when CLI or Operator keys fail |
| Spotlight Ref (locked agent) | Dust as a row on `#keys` vault "add an LLM" |

**CLI Integration (do not fold).** Keep the existing Settings flow: `installCli` → `loginCli` → `testCli` → persist `cliConnected`. Kind stays `cli`. No API key field. CLI auth tokens stay on the seat keychain / CLI session. They are not vault rows. They are not Operator-issued grants.

## Keys vault contract

### TODAY

- D1 table `vault_keys` exists (`id`, `provider`, `label`, `last4`, `cipher`, `iv`, `status`, `created_at`, `created_by`, `rotated_at`, `revoked_at`).
- Store exposes `listVaultMeta()` only (provider, label, last4, status).
- **No write / rotate / revoke API.** No admin POST. Cipher and iv never leave D1.
- `#keys` shows Worker secret **presence** (ingest HMAC, prompt key, skill signing) plus an empty vault line: **"No provider keys stored on Operator. Seats keep their own keys."**
- Seats store Tony's cloud API keys locally. Operator does not fund them.

### NEW

Operator is the source of truth for Tony's provider keys. `#keys` is where Tony adds APIs and connections (LLM keys + Cloudflare), not a presence-only table.

| Actor | May hold | Must not hold |
| --- | --- | --- |
| Operator D1 `vault_keys` | AES-GCM ciphertext + iv + last4 + status | Plaintext key after the write returns |
| Operator admin UI (`#keys`) | last4, provider, label, status, created/rotated/revoked | Full secret, cipher, iv |
| Events / HTML / ingest | Provider id, last4, status | Token-shaped strings, `sk-`, `nvapi-`, CF tokens, grants |
| Seat main process | Operator-issued **short-lived use** (memory, not disk) | Tony's raw cloud API keys |
| Seat renderer | Funded-provider list (ids only) | Raw key, grant, CF token, CLI token |
| Seat Settings | CLI session via `cliConnected`; local / on-device | Anthropic / OpenAI / Gemini / NIM / DeepSeek / MiniMax / etc. cloud keys |

**Allowlist of vault providers (LLM).** `anthropic`, `openai`, `gemini`, `nvidia`, `deepseek`, `minimax`, plus other cloud `ProviderId`s that take an API key (`qwen`, `kimi`, `openrouter`, `groq`, `mistral`, `grok`, `custom`). Not `claude-cli`. Not `codex-cli`. Not `dust`. Not `local`.

**Cloudflare is a connection row**, same vault table, provider `cloudflare-account` (Account ID + API token). See Cloudflare connect. It is not an LLM chat key and not the existing seat `cloudflare` AI Gateway provider.

**Admin API (identity required: the two Tony emails).**

| Method | Path | Body (write) | Response |
| --- | --- | --- | --- |
| `GET` | `/v1/admin/keys` | — | `{ vault: [{ id, provider, label, last4, status, createdAt, rotatedAt, revokedAt }], ingestBound, promptBound, skillBound, vaultBound }` last4 only |
| `POST` | `/v1/admin/keys` | `{ provider, label, secret }` or `{ provider: "cloudflare-account", accountId, token }` | `{ ok, id, last4, status }` never echo `secret` / `token` |
| `POST` | `/v1/admin/keys/:id/rotate` | `{ secret }` or `{ token }` | `{ ok, id, last4, status }` |
| `POST` | `/v1/admin/keys/:id/revoke` | `{}` | `{ ok, id, status: "revoked" }` |

UI on `#keys`: add / rotate / revoke. Show last4 (`··abcd`). Never a paste-back of the secret. Worker secret presence rows (ingest / prompt / skill) stay as bound/missing. The empty-state copy **"Seats keep their own keys" is retired.** New empty copy: "No provider keys on Operator yet. Add an API or Cloudflare here so seats can be funded."

**Seat funding (no raw key on the seat).**

- Heartbeat and/or a dedicated HMAC admin-to-seat payload tells the seat `fundedProviders: ProviderId[]` (ids Operator can pay for right now). Never a secret.
- When the routing table reaches order 3, the seat requests a **short-lived use** from Operator over HMAC (`POST /v1/use` or equivalent). Operator decrypts the vault row in Worker memory, performs or brokers the provider call, and returns tokens/stream to the seat. The renderer never sees the grant or the raw key.
- Seats must not persist those cloud API keys in Settings / keystore. Existing seat-stored Tony keys are a migration debt for a later implement slice, not a feature.
- Fail closed if Operator cannot issue a use (vault empty, revoked, identity wrong, HMAC fail). Honest error. No leftover seat key.

**At rest.** AES-GCM in D1 (`cipher` + `iv`). Wrangler secret `OPERATOR_VAULT_KEY` (32-byte key, base64), separate from `OPERATOR_PROMPT_KEY`. Decrypt only inside an Access/session-authenticated write/rotate or an HMAC-authenticated use. Every write / rotate / revoke is audit-logged (who, when, key id, provider, last4). Never log the secret.

## Cloudflare connect contract

Tony connects Cloudflare **on Operator**, not on a seat.

| Field | Where | UI |
| --- | --- | --- |
| Account ID | Vault row `cloudflare-account` | Shown as-is (not a secret) |
| API token | Same row, AES-GCM | last4 only |
| Token on a seat | Forbidden | — |

**Pull into Overview** (range-aware, same calm charts as the KPI strip), scoped to this product:

- Workers: `metis-operator` (and the list of Workers on that account, named honestly).
- D1: `metis-operator` (`8eb5a081-594c-407c-9470-6a5aa28b9f7c`).
- Analytics: requests, errors, CPU for `metis-operator`.

**Fail loud.** If the Cloudflare token is missing or revoked, Overview does **not** paint a quiet $0 / 0-request chart. Show an explicit error: "Cloudflare token missing. Connect it on Keys." Same for a 401/403 from the Cloudflare API. Empty ingest (no seats) is a different empty state and must not be reused for a missing token.

**Do not** put CF account tokens on seats. Do not reuse `cloudflare-proxy/` or the seat `cloudflare` AI Gateway key (`METIS_PROXY_KEY`) as this connection. Do not scrape OpenPanel hosting metrics.

**Admin API.** Same `/v1/admin/keys` write as above with `provider: "cloudflare-account"`. Overview reads a derived, token-free summary (`requests`, `errors`, `cpuMs`, `range`, `worker: "metis-operator"`) from `/v1/admin/dashboard`. Dashboard JSON never includes the CF token or last4 of it on a chart payload; last4 stays on `#keys`.

## Security (hard)

1. **Admin UI (`/` and hash routes).** First paint is never JSON. An unauthenticated browser GET of `/` (including `/#events`, `/#profiles`, `/#realtime`) serves the Operator **login HTML** (email + password). Allowlist stays `tony.walteur@gmail.com` and `twalteur@amaris.com`. Password is the Wrangler secret `OPERATOR_ADMIN_PASSWORD`. Successful login sets an HttpOnly session cookie (HMAC over email + expiry, signed with that secret). The console HTML (sidebar, map, events, profiles, realtime) loads only after Access identity **or** a valid session. Cloudflare Access JWT (`ctx.access.getIdentity()` / `Cf-Access-Jwt-Assertion`) still counts as identity when present. Do not open the console unauthenticated. No `LICENSE_ADMIN_TOKEN`.

   **JSON 401** (`{"ok":false,"error":"Access required"}`) is only for API/JSON requests when identity is missing: `Accept: application/json` (and no HTML), or any `/v1/*` path (admin APIs and ingest). Ingest still requires HMAC; a missing Access session does not unlock ingest.

2. **Device ingest.** `POST /v1/ingest`, `POST /v1/heartbeat`, `GET /v1/skills/manifest` are not behind Access. HMAC-SHA256: timestamp + nonce + deviceId + body hash, secret `OPERATOR_INGEST_SECRET`. Reject skew greater than 5 minutes. Rate limit per device. Replay nonce window. A later implement slice may add HMAC `POST /v1/use` for short-lived funded Asks; that path stays HMAC-only and must never return a raw vault secret.

3. **Prompts at rest.** AES-GCM with `OPERATOR_PROMPT_KEY` before D1. Decrypt only on an Access-authenticated admin GET. Every reveal is audit-logged (who, when, which ask id).

4. **Never ingest** Listen transcripts, screen captures, audio, API keys, HMAC secrets, or bearer strings. Ask text + metadata only. CRM ingest is id, connector, meeting **hash** (never a filesystem path), status, attempt, lastError, latencyMs, and remote id/URL if the connector returned one. Never the recap body. Confidential actions stay unsent and are not ingested.

5. **No secrets in git, logs, PR bodies, or the Events page.** Wrangler secrets only. Do not commit test private keys. Events HTML must never render a token-shaped string (JWT, `Bearer`, `sk-`, 64-char hex HMAC, long base64). Fail the tests if one appears.

6. **Path split.** Browser `/` is the login or the console. `/v1/admin/*` stays API (JSON, identity required). Ingest stays HMAC-only. Do not enable "Protect this Worker" for all traffic (that would hide login and lock seats). Live first paint: `curl GET /` returns `text/html` login, not JSON Access required. `GET /health` stays 200. `GET /v1/admin/*` without identity stays 401 JSON.

7. **Keys page.** Show presence / last4 / status only. Never cipher, iv, prompt bodies, ingest secret, skill PEM, raw provider keys, CF tokens, or short-lived use grants. Admin write/rotate/revoke is allowed; the HTML and JSON responses still last4-only.

8. **Vault at rest.** AES-GCM in D1. Allowlist stays the two Tony emails. No tokens in events, HTML, ingest, heartbeat, or dashboard charts. `OPERATOR_VAULT_KEY` is Wrangler-only.

9. **Seats.** Heartbeat/admin payload may list `fundedProviders`. Never a raw cloud API key, CF token, or CLI token. Renderer never echoes a grant.

10. **CLI tokens.** Stay on the seat CLI session. Kind `cli`. Not vault rows. Not Operator secrets.

## Navigation (product sidebar)

Kill the two-level leftover that put **Overview** in the header and **Scale** / **Change** under a **CONSOLE** group with an 80% empty white pane. That mapping is FAIL. There is no second-level detail rail. Scale and Change are Overview widgets, not nav orphans.

The left rail is a real OpenPanel-like product sidebar. Filled sections that map to real Operator hash routes. Search filters the list. Every item has a page.

| Route | Label | What Tony sees |
| --- | --- | --- |
| `#overview` (default) | Overview | OpenPanel density: KPI strip + range, calm charts. Live seats / DAU / Asks (not visitors/sessions). Scale, Mix, Cost, Change, Asks, CRM stay as widgets. Cloudflare Worker/D1/analytics for `metis-operator` when connected; fail loud if the token is missing |
| `#realtime` | Realtime | Live seats (last-seen under 2 minutes) and a live event stream |
| `#events` | Events | OpenPanel-style list: event name, profile, property chips, time. Token-free |
| `#profiles` | Profiles | People: computer/hostname + SSO email. Real ingest only |
| `#map` | Map | Countries choropleth from `request.cf`. Click a country to filter the fleet table |
| `#skills` | Skills | Draft / Approve / Push |
| `#licenses` | Licenses | Seat license status, version, OS. Never a raw license key |
| `#keys` | Keys | Tony adds LLM APIs and Cloudflare. Write / rotate / revoke. last4 only. Not a presence-only table. No CLI tokens |
| `#macos` | macOS | Darwin seats only |
| `#windows` | Windows | Windows seats only |

Section eyebrows on the rail: **Analytics** (Overview, Realtime, Events, Profiles, Map), **Fleet** (macOS, Windows, Licenses), **Ops** (Skills, Keys). The rail is full. No empty white slab.

## Events

`#events` is a live event list in the spirit of `https://demo.openpanel.dev/demo/shoey/events/events`.

Each row: **name**, **profile** (hostname or SSO email, else `—`), **properties as chips**, **time**.

Sources are real ingest: heartbeat, ask, crm, rating, skill draft/approve/push. Property chips are safe metadata only (mode, os, country, cache badge, connector, status, app version).

**Token-free.** The renderer drops any value that looks like a token, API key, HMAC secret, JWT, or bearer string. Tests fail if a token-shaped string is present in the Events HTML.

Empty list: "No events yet." Never sample commerce events.

## Profiles

`#profiles` identifies people. Do not invent people.

- **Computer / hostname** from the seat heartbeat (`hostname` on ingest).
- **SSO email** from the seat session (`ssoEmail` on ingest) when the Métis seat is signed in. Expected values when Tony's seat sends them: `twalteur@amaris.com`, `tony.walteur@gmail.com`.
- If a field is missing, show the em-dash placeholder `—`. Never a fake name, never a fabricated email, never a demo visitor.

## Realtime

`#realtime` in the spirit of `https://demo.openpanel.dev/demo/shoey/realtime`. Live seats and a live event stream from D1. Poll `/v1/admin/dashboard` while the page is open. No sample dots. No invented sessions.

## Map

Choropleth of unique devices by country. Live-ish dots only from Cloudflare `request.cf` (country, city, lat/long). **No GPS from the Electron app. No raw IP in the UI.** Store country ISO + optional city. Empty map if no heartbeats, not a fake world of sample users.

Natural Earth 110m country paths include date-line slivers that paint as gray horizontal bands (notably a Russia leftover across Canada and a Fiji leftover across the southern ocean). Strip those subpaths (full-width, near-zero height) before SVG paint. Tests fail if a repeating horizontal band artifact remains.

Click a country to filter the fleet table on that page. Caption: unique devices by country from Cloudflare `request.cf`. No GPS. No IP.

## Overview widgets (not nav)

These stay on `#overview`. They are not sidebar children. OpenPanel visitors / sessions map to **live seats / DAU / Asks**. Do not add OpenPanel Pages or Funnels. Do not leave Scale or Change as empty nav orphans.

| OpenPanel noun | Métis widget | Nav? |
| --- | --- | --- |
| Visitors / sessions | Live seats, DAU, Asks on the KPI strip | No. Overview only |
| Range + calm charts | Same density: range control, axis-free sparklines, monochrome | No |
| Pages | Do not clone | — |
| Funnels | Do not clone. CRM funnel-by-connector stays a Métis CRM widget | No |
| Realtime / Events / Profiles / Map | Keep as their own hash routes | Yes (see nav table) |

1. **KPI strip (real fields only).** Live seats, DAU, WAU (on the DAU card), Asks, app versions in field, cache hit rate, estimated cost today and 7d (labeled estimate, list price), pending skill diffs, last index time if a seat reported it. Range like OpenPanel (24h / 7d / 30d). Missing usage is hidden or "not reported". Never a fake $0.

2. **Scale.** Live line of heartbeats and Asks over the selected range. Stays a widget.

3. **Mix.** Bar of version mix and OS mix. Stays a widget.

4. **Cost.** Stacked area of cache read vs write vs uncached tokens. Table by provider and mode. Missing usage = not reported, never $0 fake.

5. **Change.** Timeline of skill draft / approve / push / rollout, who (Tony email), when, version. Heatmap over 17 weeks. Empty cells are quiet days. Stays a widget.

6. **Asks.** Redacted list. Click-to-reveal + audit.

7. **CRM landing.** Packed table plus KPI (landed today, fail rate, retries, dead letters). Funnel by connector. Seven status chips filter real ingest. Failed and Expired show Retry. Tony Retry (Access only) sets `retry_requested`. **Never auto-send.**

8. **Cloudflare (when connected).** Requests, errors, CPU for `metis-operator`. Fail loud if the token is missing. Not a Scale/Change nav item.

Copy is **Submitted**, never Submited. No `bg-orange-50`. No Unsplash.

## Geo and identity ingest

On each HMAC heartbeat (and Ask ingest), the Worker attaches geo from `request.cf`. The client body may send `seatHash`, `os`, `appVersion`, optional `lastIndexAt`, optional `hostname`, and optional `ssoEmail`. The Worker ignores client `lat`, `lon`, `country`, `city`, and `ip`.

`hostname` is `os.hostname()` from the seat, sanitized (letters, digits, dot, hyphen, underscore; max 64). `ssoEmail` is `authStatus().email` when the seat is signed in, sanitized as an email (max 120). Do not invent either field. Do not store Tony's cloud provider keys on the seat. Do not send the ingest secret, skill PEM, API keys, CF tokens, or use grants.

Heartbeat **response** (HMAC, not Access) may include `retry: string[]` and `fundedProviders: ProviderId[]`. Never a secret, last4, or grant in that JSON.

## Client (Métis)

Prompt caching is always on for supported cloud APIs.

- Anthropic: last stable system block with `cache_control: { type: 'ephemeral', ttl: '1h' }`. On 400, retry default ephemeral and record `ttl: '5m'`.
- OpenAI cloud only: `prompt_cache_key = metis:${mode}:${skillLockHash}` and an explicit breakpoint. On 400, retry once without those fields.
- Local / llama / Dust / CLI: `cache: 'n/a'`.
- Prefix byte-stability: two `buildSystem` calls in one session with different transcripts must produce identical cached-prefix bytes.

When Settings has an Operator URL:

- Heartbeat about every 60s while the app is up. No coordinates. Include hostname and SSO email when known. Read `fundedProviders` from the response. Never persist a raw key from Operator.
- After each Ask: metrics always; prompt text only if the Ask-text toggle is on. Route per the routing table (CLI subscription first when connected and working; Operator keys only after quota / rate limit).
- After an explicit CRM / MCP write (`crm-note`, `create_task`, `update_deal`, `log_note`, ClickUp, BidStack/Polo, Plane): HMAC ingest with status, attempt, latency, meeting hash, remote id if any. Confidential writes never enqueue and never ingest.
- Heartbeat response may include `retry: string[]` for ids Tony marked Retry. The seat processes those ids only. Local `pushQueue` backoff still applies to the original failed user send.
- Poll skill manifest on launch and every 6 hours. Verify ed25519. Apply overlay only if signature and hash match.
- Dust stays retrieval (second brain, published wiki, Spotlight Ref). Do not route general chat to Dust.
- CLI Integration stays `installCli` / `loginCli` / `testCli` / `cliConnected`. Last-clicked CLI is primary when both are connected.

`METIS_OPERATOR_URL` may prefill the URL. Do not leave a local-only analytics page.

## Quality bar (do not break X while improving Y)

Tony 6:17 PM ET (login, overlay, map, events) plus Tony 8:03–8:05 PM ET (routing, keys, Cloudflare). After **every** Operator change, run the Operator tests **and** prove these contracts still hold. A green sidebar or map is not enough if login, overlay chrome, map ingest, Events redaction, keys last4, or routing law moved.

| Contract | Still true |
| --- | --- |
| Overlay chrome | Island / Hide / Bar files are frozen. Do not edit them from an Operator slice. |
| Login | Browser GET `/` without identity is `text/html` email+password login. Allowlist stays `tony.walteur@gmail.com` and `twalteur@amaris.com`. Password is `OPERATOR_ADMIN_PASSWORD`. JSON 401 only for `Accept: application/json` or `/v1/*`. Console never loads unauthenticated. |
| Map data | Unique devices by country from Cloudflare `request.cf` only. Client `lat` / `lon` / `country` / `city` / `ip` are ignored. No GPS. No IP in the UI. No sample dots. Empty world if no devices. |
| Token-free events | `#events` never renders a token-shaped string (JWT, `Bearer`, `sk-`, 64-char hex HMAC, long base64). Tests fail if one appears. |
| Routing | Connected working CLI is first for every user question. Other CLI next if both connected (last-clicked primary). Operator API keys only after quota or rate limit. Dust is retrieval only. |
| Keys last4 | `#keys` and `/v1/admin/keys` never echo a secret, cipher, iv, CF token, or grant. UI last4 only. Seats are not told they keep Tony's cloud keys. |
| CLI not in vault | `claude-cli` / `codex-cli` stay kind `cli`. Settings CLI Integration unchanged. No CLI token in `vault_keys`. |
| Cloudflare fail-loud | Overview Worker/D1/analytics for `metis-operator` errors visibly when the token is missing. No CF token on seats. |
| No Pages / Funnels | Rail stays Métis (seats, Asks, licenses, skills). Scale / Mix / Cost / Change / Asks / CRM stay Overview widgets. |

If a map or sidebar fix would require touching overlay chrome, **stop and report**. Do not mix slices.

Gate: `npm run test:operator:quality-bar` (`scripts/operator-quality-bar.mjs`). That script (1) fails if this Operator slice also edits a frozen overlay path, (2) runs the existing Island/Hide chrome unit tests, (3) runs `npm run test:operator` (login, map contract, token-free events), (4) probes live `/` is `text/html` login, `/health` is 200, `/v1/admin/dashboard` is 401 JSON. `npm run test:operator` alone is the Worker unit suite and is what CI already chains.

Frozen overlay chrome (do not edit from this product):

- `src/shared/overlay-chrome.ts` and its test
- `src/renderer/src/components/OverlayChromePicker.tsx` and its test
- `src/renderer/src/components/OverlayPeek.tsx` and its test
- `src/renderer/src/lib/overlay-motion.ts` and its test
- `src/renderer/src/lib/overlay-autohide.ts` and its test
- `src/main/overlay-placement.contract.test.ts`
- `src/main/island/` (geometry, hover hit, cursor watch, mac hide/island proofs)

## Ready to merge

**READY TO MERGE: no.** Keys write/rotate/revoke, Cloudflare connect + fail-loud Overview, heartbeat `fundedProviders`, and CLI-first last-clicked routing are implemented. Overlay chrome stays frozen. Goldberg Aria stays frozen. Do not pack EXE/DMG. Do not bump app version. Do not merge from this change until Devon opens the live Worker as Tony on a Mac.

`POST /v1/use` (Operator-brokered provider calls) and migrating leftover seat-stored Tony cloud keys stay a later slice. Heartbeat lists funded providers only. Seats never persist a raw Operator key or CF token.
