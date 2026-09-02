---
project: Métis
type: operator-control-plane-contract
owns: Cloudflare-hosted Operator console, device ingest, signed skill packs, client prompt-cache honesty, CRM send board, Tony LLM keys vault, Cloudflare account connect, seat funding signal, Ask routing law
does-not-own: overlay chrome (Bar / Island / Hide), leftover Intelligence PR 94, onboarding, installer packing, Fly license-server, Goldberg Aria, cloudflare-proxy AI token proxy, Bklit Studio
ready-to-merge: no
implemented: keys-write, cloudflare-connect, fundedProviders, cli-first-routing, access-login, shoey-map, v1-use
this-slice: keys-fund-seats
audience: Tony Walteur only. Two emails. Nobody else.
tokens:
  accent: "#2563EB"
  live: "#10B981"
  ok: "#16A34A"
  danger: "#DC2626"
  bg: "#FFFFFF"
  panel: "#FFFFFF"
  hair: "#EDEDED"
  ink: "#18181B"
  ocean: "#BFDBFE"
  land: "#334155"
  land-stroke: "#F8FAFC"
  chart: "#2563EB"
  nav-on: "#F4F4F5"
  pill: "#10B981"
  dark-ocean: "#0B1220"
  dark-land: "#94A3B8"
  dark-land-stroke: "#020617"
typography:
  ui: "Inter, Geist, system-ui, sans-serif"
  mono: "ui-monospace, SFMono-Regular, monospace"
  eyebrows: "uppercase, letter-spaced, 10-11px"
proof:
  demo: "https://demo.openpanel.dev/demo/shoey"
  shots: "shoey-overview.png, shoey-realtime.png, shoey-map.png"
---

# Operator control plane

Tony's ops console. How people use Métis, who is live, what Asks cost, whether prompt cache is hitting, where seats check in, which CRM sends are stuck, and a signed push of a skill to every Mac and Windows seat.

This is not a Settings card. It is not a local analytics page. The product is a Cloudflare Worker named `metis-operator` under `operator/`. The Métis client keeps prompt caching on, and talks to this Worker only when Settings has an Operator URL.

Live URL: `https://metis-operator.tony-walteur.workers.dev/`. This is **Métis Operator** (AI fleet: seats, Asks, heartbeats, tokens, API calls, Listen, devices, countries). It is not a Shoey e-commerce / SEO demo. After Access identity, the in-page product pages are `#overview`, `#realtime`, `#events`, `#sessions`, `#notifications`, `#keys`, `#settings`. Data is real Operator D1 / HMAC ingest only.

## Product law (Tony 8:03–8:05 PM ET, VOID 10:32 PM ET)

**Goal.** Tony holds LLM API keys in Operator. End-user Métis just works. Keep the product in Métis (seats, Asks, licenses, skills, Listen, recap, keys, devices).

**Tony 11:28 PM ET America/Toronto, signed in.** Access login is **PASS**. Full OpenPanel leftover nav is **void**. Do **not** keep SEO, Pages, Insights, Profiles, Groups, Cohorts, Dashboards, References, or any other leftover section in the rail or as a `data-page`. Fail loud if those labels remain.

**Rail (KEEP only, Métis labels, Shoey-like taskbar chrome):** Overview, Realtime, Events, Sessions, Notifications, Keys, Settings. Drop the rest.

**Tony 11:32 PM ET addendum — Overview only.** Exactly **10 real Bklit minis** from live heartbeats. **Not** Unique Seats leftover cards. **Not** on Realtime / Events / Sessions / Notifications.

Copy **page chrome** from Shoey for Realtime / Events / Sessions / Notifications. Fill every page with **live Métis** heartbeats / Asks / CRM. **0 LLM tokens**. No fake dots. `#map` after JWT is Realtime.

**Tony 12:29 AM ET (Bob FAIL).** Realtime click may swap the body and still **FAIL** if the world is blank except a Canada pill. Land masses must paint. Light land fill is the literal `#E5E7EB`. Dark land is charcoal `#3f3f46`. Ocean is white / near-black, not the same gray as land. Charcoal seat dots from `request.cf` only. `window.route('realtime')` must restyle those paths so Tony sees a world, not a label on white.

**P0 hashed SPA + live router.** The 97-byte `METIS_OPERATOR` stub is **void**. The 8611-byte bundle that lacks `Created at` and `#E5E7EB` is also **void**. Unauth `GET /assets/index.js` is **200** `application/javascript`, bytes ≫ 8k, contains `#E5E7EB`, `Created at`, `window.route`, and the seven nav labels. No `SEO` string. Unknown `/assets/client.js` stays **404**. Unauth `GET /` and `GET /keys` stay **302** Cloudflare Access. `GET /health` 200 JSON. Do **not** edit overlay `DESIGN.md`. This file is the Operator design contract.

**Router law.** The hashed JS must parse. After it runs, `window.route` is a function. `route('/')`, `route('realtime')`, `route('events')`, `route('sessions')`, `route('notifications')`, `route('keys')`, and `route('settings')` swap the main body (`[data-page]` hidden). Clicking `#realtime` shows the Realtime map body, not Overview. Hash-only nav with the body stuck on Overview is **FAIL**.

Path strip in the shipped JS is exactly `location.pathname.replace(/^\//, '')`. Regex literal: slash, caret, backslash, slash, slash. Meaning: at start of string, a single `/`. Replace with `''`. A syntax/parse test must compile the shipped JS (`new Function`) so this regex cannot regress. Do not document, comment, or test any other pathname-replace spelling.

Content is Métis, not sneakers. Real data only. No fake keys, no stub map, no shoe SKUs (`/products/sneakers` and commerce sample rows are forbidden).

1. **Tony is the source of truth** for cloud provider keys (Anthropic, OpenAI, Gemini, NVIDIA NIM, DeepSeek, MiniMax, and the rest of the vault allowlist). Seats do not store those keys.
2. **Subscription first.** If Claude CLI (Cloud / Cloud Code, provider `claude-cli`) or Codex CLI (`codex-cli`) is connected and working, every user question routes there first. Operator-hosted API keys are fallback after quota or rate limit only.
3. **Dust is retrieval only.** Second brain, Métis published wiki, Spotlight Ref. Never general chat.
4. **CLI auth stays on the seat.** Settings → CLI Integration (`installCli` / `loginCli` / `testCli` / `cliConnected`) is unchanged. CLI kind stays `cli`. No API key. Do not fold CLI tokens into the Operator vault.
5. **Cloudflare is an Operator connection**, not a seat secret. Connect is a **login redirect** (`/cloudflare/connect` → `dash.cloudflare.com/login`). Not Account ID + token paste. last4 only in the vault. Overview pulls Workers, D1, and analytics for `metis-operator`. Fail loud if the token is missing.

## Pixel language (Shoey chrome, Métis nouns)

Pixel-clone **Shoey page chrome** on Realtime / Events / Sessions / Notifications. On **Overview only**, the 10 Bklit minis. Do not paint shoe SKUs or sample visitors. Do not ship Unique Seats leftover cards on Realtime.

**Sidebar (white, ~185px, hairline `#EDEDED` right border) — Shoey taskbar chrome, Métis labels only:**

- Workspace selector: Métis (not Shoey) + chevron.
- **KEEP:** Overview, Realtime, Events, Sessions, Notifications, Keys, Settings. Keys is a first-class rail item (add / rotate / revoke last4).
- **MUST GO (fail loud):** SEO, Pages, Insights, Profiles, Groups, Cohorts, Dashboards, References, Create report, Ask AI, and any other leftover OpenPanel / e-commerce section.
- Optional “Back to workspace” = Access sign-out.

**Overview (Tony 11:32 PM ET — Bklit mini-10 only):**

- Header toolbar stays Shoey-like: Last 7 days, Day, Filters, search, live count, Private.
- **Exactly 10 mini cards.** Compact Bklit stat-card chrome. **0 LLM tokens.** No model call. No generated copy. No full chart gallery (no large Unique-seats area, no Scale/Change dump, no extra chart studio).
- Required Métis numbers (heartbeat / Ask / CRM ingest only). Missing ingest = **not reported**, never `0` as a fake.

| # | Card | Bklit chrome | Real source |
| --- | --- | --- | --- |
| 1 | Unique sessions | `stat-card-area-01` | WAU seats |
| 2 | Sessions / day | `stat-card-line-01` | DAU seats |
| 3 | Live now | gauge or live-line | Heartbeat inside `ONLINE_MS` |
| 4 | Time saved | ring | **not reported** until HMAC field exists |
| 5 | Tokens | area | Sum of reported Ask tokens |
| 6 | API calls | line | Ask count |
| 7 | Listen minutes | area | **not reported** until listen minutes ingest |
| 8 | Recaps | line | `mode=recap` + recap events |
| 9 | CLI vs Operator-key asks | ring | `claude-cli` / `codex-cli` vs vault LLM ids |
| 10 | Countries | `stat-card-choropleth-01` | `request.cf` seats only. No sample dots |

- Extra **chips** under the 10 (not more KPI cards): Mac vs Windows, cost by provider, CRM fail rate, version mix, session duration, meetings. Live · 30 min stays on Realtime.
- Fake forbidden: sample visitors, invented sessions, fake Listen clock, fake `$0`, sample dots, shoe pageviews.
- Do not add SEO / Pages / Insights.

**Realtime + map (match `shoey-realtime.png` and `shoey-map.png`):**

- Top-left card: “Unique seats last 30 min” + large count + blue bars.
- Left activity stream: real events (`listen`, `ask`, `recap`, `session_start` if ingested, skill). “just now” / relative time. Browser / OS / device icons from real seat fields only.
- Right ~60% of the main pane: **visible** world. Light: land `#E5E7EB`, ocean `#FFFFFF`, land stroke `#9CA3AF`. Dark: land charcoal `#3f3f46`, ocean `#0a0a0b`. Charcoal **seat** dots from `request.cf` only. Green country **pills**. A Canada label on a blank ocean is **FAIL**. No GPS. No IP. No sample dots.
- Bottom three tables: Geo, Referrals, Paths. Columns **Events** / **Sessions** with inline blue bars. Never Views/Sess on this page. Never `/products/sneakers`.
- Dense **11–12px** type. Blue accent `#2563EB`. `#map` after JWT **is** this Realtime board, not a login card and not a choropleth-tab cut.

**Sessions** clones Shoey `/sessions` chrome and lists real seats in the **Seat details table** (below). Missing fields are `—`, never invented people. Empty fleet is an empty card. No `defaultServers`. No Frankfurt fake IPs.

**Notifications** clones Shoey `/notifications` chrome and lists real failed CRM sends and pending skill diffs only. Empty = honest empty. Never fake alerts.

**Empty leftovers.** Do not ship Dashboards / Insights / Pages / SEO / Profiles / Groups / Cohorts / References pages. Settings beyond Keys stays a short Keys fund-seats note. Never fake rows.

Light SaaS default (white cards, `#EDEDED` borders, ~8px radius). Inter-like sans. Color is blue charts + green live. Overlay chrome stays frozen.

Copy is original Métis. Never identify as AI. No emoji as icon. User-facing sentences stay free of em dashes except the Sessions missing-field placeholder (`—`).

Windows has no notch. The in-app Settings row is a power field plus Open Operator in the system browser.

## Who this is for

Tony only. Cloudflare Access allowlist (Worker + Zero Trust policy, both required):

- `twalteur@amaris.com`
- `tony.walteur@gmail.com`

Regular users never see this console. Ultron and curl are not a browser password form. They must see a **302 to Cloudflare Access login**, then a JWT.

## Login / Cloudflare Access (required before first visual)

Access login **ships with** the Shoey visual. Unauthenticated console GET is Cloudflare Access, not a homemade email+password card. Keys / fund-seats stay last4 after JWT. Do not block DESIGN + first visual on a Keys polish if Access + Overview / Realtime visual can ship.

### Worker law (must ship)

Unauthenticated **GET** of any console path must **302** to Cloudflare Access login. Not 404 JSON `{ok:false,error:not found}`. Not `text/html` with `data-login="1"`. Not a self-hosted email+password card. Not a second password. Not `OPERATOR_ADMIN_PASSWORD` as a fallback.

Console GET paths (exact, plus any later console path added to the Worker):

| Path | Notes |
| --- | --- |
| `/` | Overview / console shell |
| `/keys` | Path Ultron hits. Must 302 when unauth. After JWT, Settings / Keys (last4, fund seats) |
| `/licenses` | Same. Honest licenses table after JWT |
| `/devices` | Same (fleet / Profiles) |
| `/map` | Same. After JWT this is the Shoey Realtime map (seats, green pills) |
| `/cloudflare` | Same |
| `/overview` `/events` `/profiles` `/realtime` `/macos` `/windows` `/skills` `/dashboards` `/insights` `/pages` `/seo` `/sessions` `/groups` `/cohorts` `/settings` `/references` `/notifications` | Hash-equivalent paths. Same 302 / same console after JWT |

**302 Location** (Worker builds this; do not enable "Protect this Worker" for all traffic):

```
{TEAM_DOMAIN}/cdn-cgi/access/login/{hostname}?redirect_url={urlencoded original URL}&next={urlencoded path}
```

`TEAM_DOMAIN` is `https://<team>.cloudflareaccess.com`. `hostname` is the request host (`metis-operator.tony-walteur.workers.dev`). `next` is the original path (`/keys`). `redirect_url` is the original absolute URL.

Prove (tests + live curl, no follow):

| Request | Must be |
| --- | --- |
| Unauth `GET /keys` | **302**. `Location` contains `login` and `next=/keys` (or `redirect_url` with `/keys`, or a Cloudflare Access login URL) |
| Unauth `GET /` | **302**. Not HTML password form. No `data-login="1"`. No `type="password"` card |
| Unauth `POST /v1/admin/keys` | **401** JSON `{ok:false,error:Access required}`. Not 404 |
| `GET /health` | **200** JSON. Open. Not Access |
| `GET /assets/operator-<hash>.js` and `.css` | **200** real hashed SPA (`content-length` ≫ 97, Shoey Overview / Realtime / Events). **Not** Access 302. **Not** the 97-byte stub. Edge Bypass + Worker must not 302. Unknown asset names **404** (fail loud). |
| `HEAD /` | May 401 JSON. Do not require HTML |

After Access JWT is present (`Cf-Access-Jwt-Assertion`, or `ctx.access.getIdentity()` when the edge already wrapped the request):

1. Verify JWT against `{TEAM_DOMAIN}/cdn-cgi/access/certs` (RS256) and `POLICY_AUD`.
2. Allow only `twalteur@amaris.com` and `tony.walteur@gmail.com`. Any other email is 401.
3. Then serve the existing console HTML (or `/v1/admin/*` JSON). Do not open the console unauthenticated.

**Fail loud if Access is misconfigured.** No homemade form as fallback.

| Condition | Console GET | `/v1/admin/*` |
| --- | --- | --- |
| `TEAM_DOMAIN` unset / not `https://*.cloudflareaccess.com` | **503** `{ok:false,error:"Cloudflare Access is misconfigured: TEAM_DOMAIN is unset"}` | 401 Access required (API stays 401, not 404) |
| JWT present, `POLICY_AUD` unset | **503** `{ok:false,error:"Cloudflare Access is misconfigured: POLICY_AUD is unset"}` | 503 same |
| JWT present, verify fail / wrong AUD | 401 Access required | 401 |
| JWT email not allowlisted | 401 Access required | 401 |
| No JWT, `TEAM_DOMAIN` set | **302** Access login | 401 |

Machine auth is unchanged. Do not put CLI tokens in the vault. Do not invent a second password.

| Path | Auth |
| --- | --- |
| `POST /v1/ingest` `POST /v1/heartbeat` `GET /v1/skills/manifest` `POST /v1/use` | HMAC only. Not Access. Not JWT |
| `GET /health` | Open 200 |
| `GET /assets/operator-<hash>.*` | Open 200 real JS/CSS. Not Access. Worker must not 302. Stubs 404 |
| `GET/POST /v1/admin/*` | Access JWT / `getIdentity()` + allowlist. Unauth = 401 JSON |

Do **not** enable Zero Trust **"Protect this Worker"** on `metis-operator` for all traffic. That wraps HMAC ingest and locks seats.

### Zero Trust app Tony must have

Account `294885a27b3cc0a1cbe5d0ccbe38de4f` started this slice with Access **not enabled**. The org and apps were created from the Operator slice (API). Tony still completes login in a browser (One-time PIN to one of the two emails). The Worker 302s and verifies JWT. It does not keep a password form.

**A. Zero Trust org (done)**

| Field | Value |
| --- | --- |
| Name | `Métis` |
| Auth domain / team | `tony-walteur` |
| `TEAM_DOMAIN` | `https://tony-walteur.cloudflareaccess.com` |
| Session | `24h` |
| IdP | One-time PIN (`One-time PIN`) |

If Tony later changes the team name, he must set Worker `TEAM_DOMAIN` to `https://<that-team>.cloudflareaccess.com` and redeploy. Unset team = Worker 503, not a password form.

**B. Self-hosted applications (done)**

Hostname-wide Allow would wrap HMAC ingest. So the layout is: one Allow app on the hostname, plus **more-specific Bypass** apps for machine paths. `/v1/admin*` is Bypass at the edge so the Worker can return **401 JSON** (not a CF login HTML). Do **not** click Protect this Worker.

| App | Domain | Policy |
| --- | --- | --- |
| `Métis Operator` | `metis-operator.tony-walteur.workers.dev` | Allow, emails `twalteur@amaris.com` + `tony.walteur@gmail.com` |
| `Métis Operator health` | `…/health` | Bypass everyone |
| `Métis Operator ingest` | `…/v1/ingest` | Bypass everyone |
| `Métis Operator heartbeat` | `…/v1/heartbeat` | Bypass everyone |
| `Métis Operator use` | `…/v1/use` | Bypass everyone. HMAC broker. Never a raw vault secret |
| `Métis Operator skills manifest` | `…/v1/skills/manifest` | Bypass everyone |
| `Métis Operator admin API` | `…/v1/admin` | Bypass everyone (Worker JWT + allowlist) |
| `Métis Operator assets` | `…/assets` (prefix: `/assets` and `/assets/*`) | Bypass everyone. Static JS/CSS. Not a login gate |

**C. Policy (Allow, Tony emails only)**

| Field | Value |
| --- | --- |
| Policy name | `Tony only` |
| Action | Allow |
| Include | Emails: `twalteur@amaris.com`, `tony.walteur@gmail.com` |
| Require / Exclude | Empty. No other emails. No `Everyone`. No `@amaris.com` domain-wide |
| Identity | One-time PIN. Those two emails must receive the PIN |

**D. Bind AUD on the Worker**

`TEAM_DOMAIN` is a Wrangler `vars` value (`https://tony-walteur.cloudflareaccess.com`). `POLICY_AUD` is the **Métis Operator** application audience. Bind it as a Worker secret. Do not commit `POLICY_AUD`.

```
TEAM_DOMAIN=https://tony-walteur.cloudflareaccess.com
POLICY_AUD=<aud from the Métis Operator app>
```

**E. Forbidden**

- Do not click **Protect this Worker** on `metis-operator`.
- Do not put `OPERATOR_ADMIN_PASSWORD` back as a login. The secret may remain bound; the Worker must not read it for a session cookie.
- Do not put CLI tokens in the vault.
- Do not drop the Bypass apps on ingest, `/health`, or `/assets`.
- Do not 302 `/assets` or `/assets/*` from the Worker. Hashed SPA files stay 200 JS/CSS unauthenticated so the browser can hydrate after Access on `/`. Do not ship the `METIS_OPERATOR` stub.

## What this is not (explicit non-goals)

This slice ships the **hashed SPA** after Access. P0 is the real `/assets/operator-<hash>.js` + CSS, not Access bypass. Keys vault / Cloudflare connect / CLI-first routing already exist. Keys last4 / fund-seats stay required so devices spend dashboard keys after CLI quota. Full Shoey destination polish is Wed 10:00am. Overlay leftover stays Wed 10am. No pack. No version bump. Overlay chrome stays frozen. **0 LLM tokens** to render Overview, Realtime, or Events.

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
| Shoey commerce sample (sneakers, fake visitors) | Forbidden. Chrome is cloned; rows are Métis ingest only. |
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

**Cloudflare is a connection row**, same vault table, provider `cloudflare-account`. Connect is a login redirect. It is not an LLM chat key and not the existing seat `cloudflare` AI Gateway provider.

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
- **Tony 10:14 PM ET.** After `#keys` add (last4 only in UI, AES-GCM at rest), every seat heartbeat must include that provider in `fundedProviders`. Devices just work. Ask uses Operator-hosted keys only AFTER Claude/Codex CLI quota or rate limit. Dust is retrieval only. Never CLI tokens in the vault. Prove: unauth `POST /v1/admin/keys` 401; identity `GET /` is `text/html` 200 with add/rotate/revoke; heartbeat lists `fundedProviders` after a key is stored.
- When the routing table reaches order 3, the seat requests a **short-lived use** from Operator over HMAC (`POST /v1/use` or equivalent). Operator decrypts the vault row in Worker memory, performs or brokers the provider call, and returns tokens/stream to the seat. The renderer never sees the grant or the raw key.
- Seats must not persist those cloud API keys in Settings / keystore. Existing seat-stored Tony keys are a migration debt for a later implement slice, not a feature.
- Fail closed if Operator cannot issue a use (vault empty, revoked, identity wrong, HMAC fail). Honest error. No leftover seat key.

**At rest.** AES-GCM in D1 (`cipher` + `iv`). Wrangler secret `OPERATOR_VAULT_KEY` (32-byte key, base64), separate from `OPERATOR_PROMPT_KEY`. Decrypt only inside an Access-authenticated write/rotate or an HMAC-authenticated use. Every write / rotate / revoke is audit-logged (who, when, key id, provider, last4). Never log the secret.

## Cloudflare connect contract

Tony connects Cloudflare **on Operator**, not on a seat.

| Field | Where | UI |
| --- | --- | --- |
| Connect | GET `/cloudflare/connect` | **302 login redirect** to `dash.cloudflare.com/login`. Not Account ID + token paste. |
| Callback | GET `/cloudflare/callback` | 303 `/#keys` after Cloudflare login |
| API token | Vault row `cloudflare-account`, AES-GCM | last4 only. Never a paste field. |
| Token on a seat | Forbidden | — |

**Pull into Overview** (range-aware, same calm charts as the KPI strip), scoped to this product:

- Workers: `metis-operator` (and the list of Workers on that account, named honestly).
- D1: `metis-operator` (`8eb5a081-594c-407c-9470-6a5aa28b9f7c`).
- Analytics: requests, errors, CPU for `metis-operator`.

**Fail loud.** If the Cloudflare token is missing or revoked, Overview does **not** paint a quiet $0 / 0-request chart. Show an explicit error: "Cloudflare token missing. Connect it on Keys." Same for a 401/403 from the Cloudflare API. Empty ingest (no seats) is a different empty state and must not be reused for a missing token.

**Do not** put CF account tokens on seats. Do not reuse `cloudflare-proxy/` or the seat `cloudflare` AI Gateway key (`METIS_PROXY_KEY`) as this connection. Do not scrape OpenPanel hosting metrics.

**Admin API.** Same `/v1/admin/keys` write as above with `provider: "cloudflare-account"`. Overview reads a derived, token-free summary (`requests`, `errors`, `cpuMs`, `range`, `worker: "metis-operator"`) from `/v1/admin/dashboard`. Dashboard JSON never includes the CF token or last4 of it on a chart payload; last4 stays on `#keys`.

## Security (hard)

1. **Admin UI (console GET paths).** Unauthenticated GET of `/`, `/keys`, `/licenses`, `/devices`, `/map`, `/cloudflare`, and the other console paths **302**s to Cloudflare Access login (`TEAM_DOMAIN/cdn-cgi/access/login/{host}?redirect_url=…&next={path}`). Not a homemade email+password card. Not 404 JSON. Not `OPERATOR_ADMIN_PASSWORD`. After `Cf-Access-Jwt-Assertion` (or `ctx.access.getIdentity()`) and allowlist (`twalteur@amaris.com`, `tony.walteur@gmail.com`), serve the existing console HTML. Fail loud (503) if `TEAM_DOMAIN` is unset, or if a JWT is present and `POLICY_AUD` is unset. Do not open the console unauthenticated. No `LICENSE_ADMIN_TOKEN`.

   **JSON 401** (`{"ok":false,"error":"Access required"}`) is for `/v1/admin/*` (and other `/v1/*` admin JSON) when identity is missing. Ingest still requires HMAC; a missing Access JWT does not unlock ingest. Unauth `POST /v1/admin/keys` is 401, not 404.

2. **Device ingest.** `POST /v1/ingest`, `POST /v1/heartbeat`, `GET /v1/skills/manifest`, `POST /v1/use` are not behind Access. HMAC-SHA256: timestamp + nonce + deviceId + body hash, secret `OPERATOR_INGEST_SECRET`. Reject skew greater than 5 minutes. Rate limit per device. Replay nonce window. `POST /v1/use` decrypts the vault row in Worker memory, brokers the provider call, and returns answer text only. Never a raw vault secret, cipher, iv, last4, or grant. Screenshots are rejected. Fail closed if Operator cannot issue a use.

3. **Prompts at rest.** AES-GCM with `OPERATOR_PROMPT_KEY` before D1. Decrypt only on an Access-authenticated admin GET. Every reveal is audit-logged (who, when, which ask id).

4. **Never ingest** Listen transcripts, screen captures, audio, API keys, HMAC secrets, or bearer strings. Ask text + metadata only. CRM ingest is id, connector, meeting **hash** (never a filesystem path), status, attempt, lastError, latencyMs, and remote id/URL if the connector returned one. Never the recap body. Confidential actions stay unsent and are not ingested.

5. **No secrets in git, logs, PR bodies, or the Events page.** Wrangler secrets only. Do not commit test private keys. Events HTML must never render a token-shaped string (JWT, `Bearer`, `sk-`, 64-char hex HMAC, long base64). Fail the tests if one appears.

6. **Path split.** Browser console GET is Access 302 or the console. `/v1/admin/*` stays API (JSON, Access JWT required). Ingest stays HMAC-only. Do not enable "Protect this Worker" for all traffic (that would lock seats). Live first paint: `curl -sI GET /` and `GET /keys` are **302** to Access login, not an HTML password form, not 404 JSON. `GET /health` stays 200. `POST /v1/admin/keys` without identity stays 401 JSON.

7. **Keys page.** Show presence / last4 / status only. Never cipher, iv, prompt bodies, ingest secret, skill PEM, raw provider keys, CF tokens, or short-lived use grants. Admin write/rotate/revoke is allowed; the HTML and JSON responses still last4-only.

8. **Vault at rest.** AES-GCM in D1. Allowlist stays the two Tony emails. No tokens in events, HTML, ingest, heartbeat, or dashboard charts. `OPERATOR_VAULT_KEY` is Wrangler-only.

9. **Seats.** Heartbeat/admin payload may list `fundedProviders`. Never a raw cloud API key, CF token, or CLI token. Renderer never echoes a grant.

10. **CLI tokens.** Stay on the seat CLI session. Kind `cli`. Not vault rows. Not Operator secrets.

## Navigation (Shoey sidebar — mirror labels)

Kill the two-level leftover (Overview in the header, Scale / Change under CONSOLE). Kill the slim Métis rail (Analytics: Overview / Realtime / Events / Profiles / Map · Fleet · Ops). Tony 10:32 voided that cut.

The left rail keeps Shoey taskbar chrome and Métis labels only. Every KEEP item has a page. Destinations without ingest yet are honest empty, never fake rows.

| Route | Label | What Tony sees |
| --- | --- | --- |
| `#overview` (default) | Overview | Exactly 10 Bklit mini KPI cards from live heartbeats. No Unique Seats leftover cards |
| `#realtime` | Realtime | Shoey Realtime: 30-min unique seats, blue bars, stream, **visible** world `#E5E7EB` + charcoal dots + green pills, Geo / Referrals / Paths |
| `#events` | Events | Shoey table: Created at · Name · Profile · Country · OS · Browser. Token-free. Real ingest |
| `#sessions` | Sessions | Seat details table from live heartbeats. Never invented visitors |
| `#notifications` | Notifications | Shoey chrome. Failed CRM / pending skill diffs. Honest empty otherwise |
| `#keys` | Keys | last4 add / rotate / revoke. Cloudflare login redirect (not Account ID + token paste). Seats never hold raw keys |
| `#settings` | Settings | Keys fund-seats note + Theme. No second password |
| `#map` | (alias) | Same Realtime body. `window.route('map')` highlights Realtime |

MUST GO (fail loud if a data-nav or data-page remains): dashboards, insights, pages, seo, profiles, groups, cohorts, references. No Create report. No Ask AI.

`#macos` / `#windows` remain hash filters on Sessions, not extra rail labels.

Section eyebrow on the rail: **Métis**. No Analytics leftover groups. No Fleet. No Ops. No CONSOLE. The rail is Shoey taskbar chrome with Métis labels only.

## Events

`#events` **is** `https://demo.openpanel.dev/demo/shoey/events/events` (Tony 10:39 PM ET refine). Token-free. **0 LLM tokens** to render.

Layout matches that Shoey Events table: title, Events tab only (no Conversions / Stats leftover), green live count from real rows, search, then **Created at · Name · Profile · Country · OS · Browser**. Created at is relative (`just now`). Profile is hostname or SSO email, else `—`. Country is city · ISO from `request.cf` / seat. OS only when the seat reported it. Browser is `—` unless a seat sent one (Electron usually has none). Never invent Chrome or Safari.

Do **not** edit overlay `DESIGN.md`. This file is the Operator contract.

Sources are real ingest only: heartbeat, ask, crm, rating, skill draft/approve/push, listen/recap when a seat sent that kind.

**Token-free.** The renderer drops any value that looks like a token, API key, HMAC secret, JWT, or bearer string. Tests fail if a token-shaped string is present in the Events HTML.

Empty list: "No events yet." Never sample commerce events.

## Profiles

`#profiles` identifies people. Do not invent people.

- **Computer / hostname** from the seat heartbeat (`hostname` on ingest).
- **SSO email** from the seat session (`ssoEmail` on ingest) when the Métis seat is signed in. Expected values when Tony's seat sends them: `twalteur@amaris.com`, `tony.walteur@gmail.com`.
- If a field is missing, show the em-dash placeholder `—`. Never a fake name, never a fabricated email, never a demo visitor.

## Realtime

`#realtime` **is** `https://demo.openpanel.dev/demo/shoey/realtime` (proof: `shoey-realtime.png`, `shoey-map.png`). Layout is not optional.

1. Unique seats last 30 min (sentence-case title + large count + blue bars from real heartbeat buckets).
2. Activity stream from D1 (`listen`, `ask`, `recap`, skill, CRM). Relative time. OS / browser / device icons only when the seat reported them.
3. World: **visible** Shoey land `#E5E7EB` on white ocean `#FFFFFF` (dark: charcoal `#3f3f46` on `#0a0a0b`). Land stroke `#9CA3AF` so continents read at a glance. Charcoal seat dots from `request.cf` only. Green country pills. A pill with no land is **FAIL**. No sample dots.
4. Bottom three tables: Geo, Referrals (CRM / Listen / connectors), Paths (modes / skills / use cases).

Poll `/v1/admin/dashboard` while the page is open. No sample dots. No invented sessions. No shoe paths.

`#map` after Access identity **is** this Realtime board (`data-page="realtime"`). `/map` and `#map` highlight Realtime in the rail. Do not paint a second choropleth-tab page.

## Map (seats, not a stub)

Unique seats by country from Cloudflare `request.cf` (country, city, lat/long). **No GPS from the Electron app. No raw IP in the UI.** Store country ISO + optional city. Empty map if no heartbeats, not a fake world of sample users.

Paint like Shoey and make it **readable**: light land `#E5E7EB`, white ocean, charcoal dots, green pills. Dark theme uses charcoal land. Do not use `#E5E7EB` land on `#F5F5F5` ocean (that is the washed-out scribble). Do not use `vector-effect: non-scaling-stroke` on world land (0.45px strokes vanish). Still strip Natural Earth date-line slivers (Russia leftover across Canada, Fiji leftover across the southern ocean) before SVG paint. Tests fail if a repeating horizontal band artifact remains. Shipped `/assets/index.js` must contain the `#E5E7EB` land fill so curl proof cannot lie.

Click a country / pill to filter Geo + the fleet table. Caption: unique seats by country from Cloudflare `request.cf`. No GPS. No IP.

## Seat details table

Sessions and the Realtime fleet details read like the 21st.dev ServerManagementTable (shadcn card, numbered rows, hover lift, in-card overlay). Port the **visual language** only. Do **not** ship `defaultServers`, Frankfurt fake IPs, or due dates in 2027. Do **not** stand up a greenfield Next.js app.

Empty fleet: empty card. No sample dots.

| ServerManagementTable field | Métis heartbeat field | Notes |
| --- | --- | --- |
| No | row index `01`… | Display only |
| Server / name | `hostname` (computer) | `—` if missing |
| OS circle | `os` | `darwin` → mac, `win32` / `windows` → windows, `linux` → linux |
| Location (flag + city) | `request.cf` `city` + `country` | Worker attaches geo. Never client GPS |
| Identity | `ssoEmail` or last-seen hostname | Never a raw key, grant, or ingest secret |
| IP | none | Operator does not store IP. Show `—`. Never invent an address |
| Due date / last seen | `last_seen` | Heartbeat timestamp |
| CPU meter | heartbeat freshness, or Listen minutes when ingested | **Not** fake CPU. Missing Listen = freshness only |
| Status pill | derived from `last_seen` | **Active** inside `ONLINE_MS` (2 min). **Paused** inside 30 min. **Inactive** older |
| License | `license` on the seat | `—` if missing |
| Row overlay | last seen, OS, version, country, recent heartbeat / ask events | Real ingest. Never fake logs |

Card chrome: `border-border/30` analog (`1px` hairline), `bg-card` analog (`--panel`), rounded. Hover lifts the row. Click opens an in-card overlay. `prefers-reduced-motion` skips the lift. Light and dark theme restyle this table.

## Overview (Bklit mini-10 only)

`#overview` is **exactly 10** Bklit mini KPI cards from live heartbeats (Tony 11:32 PM ET). Not Unique Seats leftover cards. Not the old Shoey 8-up gallery. Not SEO / Pages / Insights. Extra Métis chips may sit under the 10. They must not appear on the four Shoey pages.

**Render law.** Overview, Realtime, and Events are D1 + `request.cf` HTML. **Spend 0 LLM tokens.** No model, no generated sentences, no invented dots or numbers. If a field was never ingested, the tile says **not reported** (never `0` pretending to be a measurement).

| Shoey chrome | Métis field (real only) | Fake forbidden |
| --- | --- | --- |
| Unique visitors | Unique sessions = unique seats in the 7-day window | Sample 55K visitors |
| Sessions | Sessions / day = unique seats last 24h | Invented sessions |
| Pageviews | API calls = Ask count | Shoe pageviews |
| Pages per session | Duration = median Ask `total_ms` when reported | Invented ratio / fake 18s |
| Bounce rate | CRM fail rate when attempted > 0 | Fake 28.6% |
| Session duration | Time saved = **not reported** until HMAC ingest exists | Fake saved minutes |
| Revenue | Tokens (sum of reported Ask tokens) or cost estimate | Fake `0 $` / fake 0 tokens |
| Live · 30 min | Unique seats last 30 minutes (also the live-now header dot) | Sample live 159 |
| Refs table | CRM / Listen / recap / connectors | heroku.com / eBay sample |
| Pages table | Modes / skills / use cases / API paths | `/products/sneakers` |

Range like Shoey (Last 7 days / Day). Missing usage is hidden or "not reported". Never a fake $0.

1. **KPI strip (real fields only).** The eight cards above. Sparklines are blue bars, not monochrome 3-up. Extra strip under the fold: Live now (2 min), Meetings (CRM meeting hash / success), Listen minutes (**not reported**), Recap count, CLI asks vs Operator-key asks, country map from `request.cf`. Pending skill diffs and last index stay available on Insights / Change below the fold.

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
| Login | Unauth GET `/` and `/keys` (and the other console paths) are **302** to Cloudflare Access login (`Location` has `login` + `next` or an Access login URL). Allowlist stays `twalteur@amaris.com` and `tony.walteur@gmail.com`. No homemade password form. Unauth `POST /v1/admin/keys` is 401 JSON. `/health` is 200. Authenticated HTML `script-src`s `/assets/operator-<hash>.js`. Unauth GET of that hashed JS/CSS is **200** real chrome (≫ 97 bytes), not Access HTML and not the stub. Console never loads unauthenticated. Fail loud (503) if `TEAM_DOMAIN` is unset. |
| Map data | Unique devices by country from Cloudflare `request.cf` only. Client `lat` / `lon` / `country` / `city` / `ip` are ignored. No GPS. No IP in the UI. No sample dots. Empty world if no devices. |
| Token-free events | `#events` never renders a token-shaped string (JWT, `Bearer`, `sk-`, 64-char hex HMAC, long base64). Tests fail if one appears. |
| Routing | Connected working CLI is first for every user question. Other CLI next if both connected (last-clicked primary). Operator API keys only after quota or rate limit. Dust is retrieval only. |
| Keys last4 | `#keys` and `/v1/admin/keys` never echo a secret, cipher, iv, CF token, or grant. UI last4 only. Seats are not told they keep Tony's cloud keys. |
| CLI not in vault | `claude-cli` / `codex-cli` stay kind `cli`. Settings CLI Integration unchanged. No CLI token in `vault_keys`. |
| Cloudflare fail-loud | Overview Worker/D1/analytics for `metis-operator` errors visibly when the token is missing. No CF token on seats. |
| Shoey chrome + Métis nouns | Rail is Overview / Realtime / Events / Sessions / Notifications / Keys / Settings only. Overview is exactly 10 Bklit mini cards + chips. Realtime / Events / Sessions / Notifications stay Shoey page chrome. No SEO / Pages / Insights leftovers. No shoe SKUs. No sample visitors. |

If a map or sidebar fix would require touching overlay chrome, **stop and report**. Do not mix slices.

Gate: `npm run test:operator:quality-bar` (`scripts/operator-quality-bar.mjs`). That script (1) fails if this Operator slice also edits a frozen overlay path, (2) runs the existing Island/Hide chrome unit tests, (3) runs `npm run test:operator` (Access 302 login, map contract, token-free events), (4) probes live `/` and `/keys` are 302 to Access login, `/health` is 200, `/v1/admin/dashboard` and `POST /v1/admin/keys` are 401 JSON. `npm run test:operator` alone is the Worker unit suite and is what CI already chains.

Frozen overlay chrome (do not edit from this product):

- `src/shared/overlay-chrome.ts` and its test
- `src/renderer/src/components/OverlayChromePicker.tsx` and its test
- `src/renderer/src/components/OverlayPeek.tsx` and its test
- `src/renderer/src/lib/overlay-motion.ts` and its test
- `src/renderer/src/lib/overlay-autohide.ts` and its test
- `src/main/overlay-placement.contract.test.ts`
- `src/main/island/` (geometry, hover hit, cursor watch, mac hide/island proofs)

## Ready to merge

**READY TO MERGE: no.** Live router + hashed SPA still P0 after the 11:39 PM ET walk. Overlay leftover stays Wed 10am. No pack. No merge. Ultron tests before stamp. Do not pack EXE/DMG. Do not bump app version (`1.8.3` stays). Goldberg Aria stays frozen.

Migrating leftover seat-stored Tony cloud keys stays a later slice. `POST /v1/use` is live: HMAC, vault decrypt in Worker memory, brokered completion, text only. Seats never persist a raw Operator key or CF token.
