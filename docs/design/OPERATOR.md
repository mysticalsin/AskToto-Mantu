---
project: Métis
type: operator-control-plane-contract
owns: Cloudflare-hosted Operator console, device ingest, signed skill packs, client prompt-cache honesty, CRM send board
does-not-own: overlay chrome (Bar / Island / Hide), Overlay 58, leftover Intelligence PR 61, onboarding, installer packing, Fly license-server, cloudflare-proxy AI token proxy, Bklit Studio
ready-to-merge: no until CI is green and Devon opens Access as Tony and sees a real or honestly empty map
audience: Tony Walteur only. Two emails. Nobody else.
tokens:
  accent: "#7C8CF8"
  ok: "#83C092"
  danger: "#F0717A"
  bg: "#0a0a0b"
  panel: "#111113"
  hair: "rgba(255,255,255,0.10)"
  land: "#2a2a2e"
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

Tony's packed ops console. One page. Not a marketing site. How people use Métis, who is live, what Asks cost, whether prompt cache is hitting, where seats check in, which CRM sends are stuck, and a signed push of a skill to every Mac and Windows seat.

This is not a Settings card. It is not a local analytics page. The product is a Cloudflare Worker named `metis-operator` under `operator/`. The Métis client keeps prompt caching on, and talks to this Worker only when Settings has an Operator URL.

## Pixel language

Rebuild the density and chrome of the public Bklit blocks/charts look inside Operator. Do not vendor `@bklit` npm. Do not copy Studio (`ui.bklit.com/studio`). Do not clone the marketing site.

- Near-black canvas, radial-dot grid, 1px hairline cards with crop-mark corners.
- Geist Sans + Geist Mono. Uppercase letter-spaced eyebrows.
- Default chart palette is monochrome (`--chart-1` through `--chart-5`). Color is the exception: mint trend/online, danger on Failed, one brand accent `#7C8CF8` for live dots and primary actions.
- Chart-type tabs: solid light pill on the active tab.
- KPI strip is 3-up. Big number, tiny mono sublabel, axis-free sparkline that bleeds to the card edge.
- Map is a flat gray choropleth. No basemap tiles. No country labels. 5-step gray scale. Variants: land, analytics, graticule, hatch. Dark theme is the default.
- Change activity is a GitHub-style contribution heatmap.
- CRM send is a 7-status funnel used as **filters** on the real board, not a demo grid.
- No Unsplash. No demo people. No placeholder visitors. Empty states say there is no ingest yet.

Copy is original Métis. No em dashes in user-facing strings. Never identify as AI. No emoji as icon.

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

New tree: `operator/`. Worker name: `metis-operator`. Account already in use: `tony.walteur@gmail.com`, account id `294885a27b3cc0a1cbe5d0ccbe38de4f`.

## Security (hard)

1. **Admin UI + `/v1/admin/*`.** Cloudflare Access. Worker also verifies identity via `ctx.access.getIdentity()` and/or `Cf-Access-Jwt-Assertion` JWKS. If Access did not run, admin routes return 401. No homemade password page. No `LICENSE_ADMIN_TOKEN` for this UI.

2. **Device ingest.** `POST /v1/ingest`, `POST /v1/heartbeat`, `GET /v1/skills/manifest` are not behind Access. HMAC-SHA256: timestamp + nonce + deviceId + body hash, secret `OPERATOR_INGEST_SECRET`. Reject skew greater than 5 minutes. Rate limit per device. Replay nonce window.

3. **Prompts at rest.** AES-GCM with `OPERATOR_PROMPT_KEY` before D1. Decrypt only on an Access-authenticated admin GET. Every reveal is audit-logged (who, when, which ask id).

4. **Never ingest** Listen transcripts, screen captures, audio, or API keys. Ask text + metadata only. CRM ingest is title + status + connector. Never the recap body.

5. **No secrets in git, logs, or PR bodies.** Wrangler secrets only. Do not commit test private keys.

6. **Path split.** Access protects `/` and `/v1/admin/*`. Ingest stays HMAC-only. Do not enable "Protect this Worker" for all traffic.

## Console sections

One ops console. Packed, still readable.

1. **KPI strip (real fields only).** Live seats (last-seen under 2 minutes), DAU, WAU (on the DAU card), app versions in field, cache hit rate, estimated cost today and 7d (labeled estimate, list price), pending skill diffs, last index time if a seat reported it. Missing usage is hidden or "not reported". Never a fake $0.

2. **Scale.** Live line of heartbeats and Asks over 24h and 7d. Bar of version mix and OS mix.

3. **Cost.** Stacked area of cache read vs write vs uncached tokens. Table by provider and mode. Missing usage = not reported, never $0 fake.

4. **Change management.** Timeline of skill draft / approve / push / rollout, who (Tony email), when, version. App version adoption. Heatmap of that activity over 17 weeks. Empty cells are quiet days.

5. **MAP.** Choropleth of unique devices by country. Live-ish dots only from Cloudflare `request.cf` (country, city, lat/long). **No GPS from the Electron app. No raw IP in the UI.** Store country ISO + optional city. Empty map if no heartbeats, not a fake world of sample users.

6. **Asks.** Redacted list. Click-to-reveal + audit.

7. **Skills.** Draft / Approve / Push. Approve does not publish. Push signs a pack. Never auto-apply a draft.

8. **CRM send.** Seven statuses are filters: Pending, In progress, In review, Submitted, Success, Failed, Expired. The board is real ingest rows. Explicit Retry on Failed asks the seat to confirm again. **Never auto-send.**

## Geo ingest

On each HMAC heartbeat (and Ask ingest), the Worker attaches geo from `request.cf`. The client body may send `seatHash`, `os`, `appVersion`, and optional `lastIndexAt`. The Worker ignores client `lat`, `lon`, `country`, `city`, and `ip`.

## Client (Métis)

Prompt caching is always on for supported cloud APIs.

- Anthropic: last stable system block with `cache_control: { type: 'ephemeral', ttl: '1h' }`. On 400, retry default ephemeral and record `ttl: '5m'`.
- OpenAI cloud only: `prompt_cache_key = metis:${mode}:${skillLockHash}` and an explicit breakpoint. On 400, retry once without those fields.
- Local / llama / Dust / CLI: `cache: 'n/a'`.
- Prefix byte-stability: two `buildSystem` calls in one session with different transcripts must produce identical cached-prefix bytes.

When Settings has an Operator URL:

- Heartbeat about every 60s while the app is up. No coordinates.
- After each Ask: metrics always; prompt text only if the Ask-text toggle is on.
- After a CRM push attempt: status + title + connector. No recap body.
- Poll skill manifest on launch and every 6 hours. Verify ed25519. Apply overlay only if signature and hash match.

`METIS_OPERATOR_URL` may prefill the URL. Do not leave a local-only analytics page.

## Ready to merge

**READY TO MERGE: no** until CI is green and Devon can open Access as Tony and see a real map or an honestly empty map, not demo data.

Do not wrangler deploy from CI with secrets. Overlay chrome stays frozen. Do not pack installers. Do not merge until that Mac show.
