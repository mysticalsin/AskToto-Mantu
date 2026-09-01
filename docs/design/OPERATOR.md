---
project: Métis
type: operator-control-plane-contract
owns: Cloudflare-hosted Operator console, device ingest, signed skill packs, client prompt-cache honesty, CRM send board
does-not-own: overlay chrome (Bar / Island / Hide), Overlay 58, leftover Intelligence PR 61, onboarding, installer packing, Fly license-server, cloudflare-proxy AI token proxy, Bklit Studio
ready-to-merge: no
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

## Pixel language

Copy the **density and calm luxury** of OpenPanel (overview metrics, realtime, events, profiles). Do not pixel-clone Shoey commerce. Do not vendor OpenPanel, Bklit, or Studio.

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

## What this is not

| Surface | Job |
| --- | --- |
| `license-server` on Fly | License activate / heartbeat / seats. Keep it there. No prompts. |
| `cloudflare-proxy/` (`metis-cloudflare-proxy`) | AI token proxy. Do not reuse. |
| `aria-intake-llm`, `notebooklm-mcp`, `partner-mcp`, `tco-supabase-keepalive` | Existing Workers. Do not touch. |
| Overlay / Island / Hide / Bar | Frozen. Do not restyle. |
| In-app Operator page | Removed. Do not leave a fake local fleet view. |
| Bklit Studio | Proprietary. Do not copy. |
| OpenPanel Shoey demo | Density reference only. Not a clone. |

New tree: `operator/`. Worker name: `metis-operator`. Account already in use: `tony.walteur@gmail.com`, account id `294885a27b3cc0a1cbe5d0ccbe38de4f`. D1 `metis-operator` id `8eb5a081-594c-407c-9470-6a5aa28b9f7c`.

## Security (hard)

1. **Admin UI + `/v1/admin/*`.** Cloudflare Access. Worker also verifies identity via `ctx.access.getIdentity()` and/or `Cf-Access-Jwt-Assertion` JWKS. If Access did not run, admin routes return 401. No homemade password page. No `LICENSE_ADMIN_TOKEN` for this UI.

2. **Device ingest.** `POST /v1/ingest`, `POST /v1/heartbeat`, `GET /v1/skills/manifest` are not behind Access. HMAC-SHA256: timestamp + nonce + deviceId + body hash, secret `OPERATOR_INGEST_SECRET`. Reject skew greater than 5 minutes. Rate limit per device. Replay nonce window.

3. **Prompts at rest.** AES-GCM with `OPERATOR_PROMPT_KEY` before D1. Decrypt only on an Access-authenticated admin GET. Every reveal is audit-logged (who, when, which ask id).

4. **Never ingest** Listen transcripts, screen captures, audio, API keys, HMAC secrets, or bearer strings. Ask text + metadata only. CRM ingest is id, connector, meeting **hash** (never a filesystem path), status, attempt, lastError, latencyMs, and remote id/URL if the connector returned one. Never the recap body. Confidential actions stay unsent and are not ingested.

5. **No secrets in git, logs, PR bodies, or the Events page.** Wrangler secrets only. Do not commit test private keys. Events HTML must never render a token-shaped string (JWT, `Bearer`, `sk-`, 64-char hex HMAC, long base64). Fail the tests if one appears.

6. **Path split.** Access protects `/` and `/v1/admin/*`. Ingest stays HMAC-only. Do not enable "Protect this Worker" for all traffic.

7. **Keys page.** Show presence / last4 / status only. Never cipher, iv, prompt bodies, ingest secret, skill PEM, or provider keys from the seat.

## Navigation (product sidebar)

Kill the two-level leftover that put **Overview** in the header and **Scale** / **Change** under a **CONSOLE** group with an 80% empty white pane. That mapping is FAIL. There is no second-level detail rail. Scale and Change are Overview widgets, not nav orphans.

The left rail is a real OpenPanel-like product sidebar. Filled sections that map to real Operator hash routes. Search filters the list. Every item has a page.

| Route | Label | What Tony sees |
| --- | --- | --- |
| `#overview` (default) | Overview | KPIs, 24h/7d scale, mix, cost, change heatmap, CRM board, redacted Asks |
| `#realtime` | Realtime | Live seats (last-seen under 2 minutes) and a live event stream |
| `#events` | Events | OpenPanel-style list: event name, profile, property chips, time |
| `#profiles` | Profiles | People: computer/hostname + SSO email. Real ingest only |
| `#map` | Map | Countries choropleth from `request.cf`. Click a country to filter the fleet table |
| `#skills` | Skills | Draft / Approve / Push |
| `#licenses` | Licenses | Seat license status, version, OS. Never a raw license key |
| `#keys` | Keys | Worker secret presence + vault last4/status. Never a secret value |
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

These stay on `#overview`. They are not sidebar children.

1. **KPI strip (real fields only).** Live seats, DAU, WAU (on the DAU card), app versions in field, cache hit rate, estimated cost today and 7d (labeled estimate, list price), pending skill diffs, last index time if a seat reported it. Missing usage is hidden or "not reported". Never a fake $0.

2. **Scale.** Live line of heartbeats and Asks over 24h and 7d. Bar of version mix and OS mix.

3. **Cost.** Stacked area of cache read vs write vs uncached tokens. Table by provider and mode. Missing usage = not reported, never $0 fake.

4. **Change.** Timeline of skill draft / approve / push / rollout, who (Tony email), when, version. Heatmap over 17 weeks. Empty cells are quiet days.

5. **Asks.** Redacted list. Click-to-reveal + audit.

6. **CRM landing.** Packed table plus KPI (landed today, fail rate, retries, dead letters). Funnel by connector. Seven status chips filter real ingest. Failed and Expired show Retry. Tony Retry (Access only) sets `retry_requested`. **Never auto-send.**

Copy is **Submitted**, never Submited. No `bg-orange-50`. No Unsplash.

## Geo and identity ingest

On each HMAC heartbeat (and Ask ingest), the Worker attaches geo from `request.cf`. The client body may send `seatHash`, `os`, `appVersion`, optional `lastIndexAt`, optional `hostname`, and optional `ssoEmail`. The Worker ignores client `lat`, `lon`, `country`, `city`, and `ip`.

`hostname` is `os.hostname()` from the seat, sanitized (letters, digits, dot, hyphen, underscore; max 64). `ssoEmail` is `authStatus().email` when the seat is signed in, sanitized as an email (max 120). Do not invent either field. Do not store provider keys on the seat. Do not send the ingest secret, skill PEM, or API keys.

## Client (Métis)

Prompt caching is always on for supported cloud APIs.

- Anthropic: last stable system block with `cache_control: { type: 'ephemeral', ttl: '1h' }`. On 400, retry default ephemeral and record `ttl: '5m'`.
- OpenAI cloud only: `prompt_cache_key = metis:${mode}:${skillLockHash}` and an explicit breakpoint. On 400, retry once without those fields.
- Local / llama / Dust / CLI: `cache: 'n/a'`.
- Prefix byte-stability: two `buildSystem` calls in one session with different transcripts must produce identical cached-prefix bytes.

When Settings has an Operator URL:

- Heartbeat about every 60s while the app is up. No coordinates. Include hostname and SSO email when known.
- After each Ask: metrics always; prompt text only if the Ask-text toggle is on.
- After an explicit CRM / MCP write (`crm-note`, `create_task`, `update_deal`, `log_note`, ClickUp, BidStack/Polo, Plane): HMAC ingest with status, attempt, latency, meeting hash, remote id if any. Confidential writes never enqueue and never ingest.
- Heartbeat response may include `retry: string[]` for ids Tony marked Retry. The seat processes those ids only. Local `pushQueue` backoff still applies to the original failed user send.
- Poll skill manifest on launch and every 6 hours. Verify ed25519. Apply overlay only if signature and hash match.

`METIS_OPERATOR_URL` may prefill the URL. Do not leave a local-only analytics page.

## Quality bar (do not break X while improving Y)

Tony 6:17 PM ET. After **every** Operator change, run the Operator tests **and** prove these four contracts still hold. A green sidebar or map is not enough if login, overlay chrome, map ingest, or Events redaction moved.

| Contract | Still true |
| --- | --- |
| Overlay chrome | Island / Hide / Bar files are frozen. Do not edit them from an Operator slice. |
| Login | Cloudflare Access only. Allowlist stays `tony.walteur@gmail.com` and `twalteur@amaris.com`. `/` and `/v1/admin/*` are 401 without identity. No homemade password page. |
| Map data | Unique devices by country from Cloudflare `request.cf` only. Client `lat` / `lon` / `country` / `city` / `ip` are ignored. No GPS. No IP in the UI. No sample dots. Empty world if no devices. |
| Token-free events | `#events` never renders a token-shaped string (JWT, `Bearer`, `sk-`, 64-char hex HMAC, long base64). Tests fail if one appears. |

If a map or sidebar fix would require touching overlay chrome, **stop and report**. Do not mix slices.

Gate: `npm run test:operator:quality-bar` (`scripts/operator-quality-bar.mjs`). That script (1) fails if this Operator slice also edits a frozen overlay path, (2) runs the existing Island/Hide chrome unit tests, (3) runs `npm run test:operator` (login, map contract, token-free events), (4) probes live `/` is still 401 Access required. `npm run test:operator` alone is the Worker unit suite and is what CI already chains.

Frozen overlay chrome (do not edit from this product):

- `src/shared/overlay-chrome.ts` and its test
- `src/renderer/src/components/OverlayChromePicker.tsx` and its test
- `src/renderer/src/components/OverlayPeek.tsx` and its test
- `src/renderer/src/lib/overlay-motion.ts` and its test
- `src/renderer/src/lib/overlay-autohide.ts` and its test
- `src/main/overlay-placement.contract.test.ts`
- `src/main/island/` (geometry, hover hit, cursor watch, mac hide/island proofs)

## Ready to merge

**READY TO MERGE: no.** CI must be green. Overlay chrome stays frozen. Do not pack EXE/DMG. Do not bump app version. Do not merge from this change. Deploy the Worker with wrangler so the live `workers.dev` host shows the new UI. Devon still opens Access as Tony on a Mac before any merge.
