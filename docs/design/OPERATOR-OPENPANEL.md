---
project: Métis
type: operator-openpanel-visual-contract
owns: Métis Operator #map visual clone of OpenPanel Shoey Realtime, adapted to seats / Listen / recap / skills / Keys
does-not-own: overlay chrome (Bar / Island / Hide), leftover Intelligence PR 94, onboarding, appearance PR 98, Listen PR 99, ClickUp PR 97, Goldberg Aria, installer packing, Fly license-server, cloudflare-proxy, OpenPanel Pages/SEO/Groups/Cohorts/Dashboards/Insights/Reports builder, Shoey commerce copy
supersedes: OPERATOR.md "Map is a flat choropleth / do not pixel-clone Shoey" for the #map page chrome only
ready-to-merge: no
implemented: map-shoey-realtime
audience: Tony Walteur only. Two emails. Nobody else.
reference:
  live-operator: "https://metis-operator.tony-walteur.workers.dev/#map"
  live-shoey: "https://demo.openpanel.dev/demo/shoey"
  shoey-realtime: "realtime.png — THIS is the Map target"
  shoey-overview: "overview.png — density, KPI cards with sparklines, tabbed tables"
  shoey-events: "events.png — event chips"
  shoey-profiles: "profiles.png — identified profiles"
tokens:
  bg: "#f4f4f5"
  panel: "#ffffff"
  hair: "#E5E7EB"
  ink: "#18181b"
  ink-muted: "rgba(24,24,27,0.62)"
  ink-faint: "rgba(24,24,27,0.42)"
  bar-blue: "#3B82F6"
  map-dot: "#1e3a5f"
  map-label: "#0F766E"
  land: "#E5E7EB"
  volume: "#E5E7EB"
  live-green: "#22C55E"
  accent: "#7C8CF8"
  ok: "#83C092"
  danger: "#F0717A"
typography:
  ui: "Geist, Inter, system-ui, sans-serif"
  mono: "Geist Mono, ui-monospace, SFMono-Regular, monospace"
---

# Operator × OpenPanel (Shoey Realtime → #map)

Tony 10:05 PM ET: live `#map` does **not** look like [OpenPanel Shoey](https://demo.openpanel.dev/demo/shoey). He wants a **visual clone** of Shoey Realtime, adapted to Métis Operator nouns (seats / Listen / recap / skills / Keys), not sneakers.

This file is the pixel and data contract for that clone. [`OPERATOR.md`](OPERATOR.md) stays the product / security / routing / keys law. This file wins on `#map` chrome when the two disagree.

**No UI until this file exists on the branch.** First commit is this document. Then implement. Then `wrangler deploy` so `https://metis-operator.tony-walteur.workers.dev/#map` matches.

**READY TO MERGE: no.** Clock: live Worker tonight. Do not pack. Do not merge. Do not bump `1.8.3`.

## Why the current Map fails

The live page is a dark ops card: Land / Analytics / Graticule / Hatch tabs over a gray choropleth and a fleet table. That is a toy globe. Shoey Realtime is a **light SaaS** page:

1. Left: unique count last 30 minutes + 30 one-minute bars + a live activity stream.
2. Right: a large light vector world map with dark-blue city dots and teal country/city count labels.
3. Bottom: three equal tables — Geo / Referrals / Paths — with flags or brand marks and gray volume bars.

Until `#map` has those three regions, it is not done.

## Pixel language (Light SaaS)

Copy Shoey Realtime's **density and calm**, not Shoey commerce copy.

- White cards on `#f4f4f5`. Hairline borders `#E5E7EB` (1px). Subtle radius (8–12px). No L-corner card ticks. No hatch. No graticule tab. No land/analytics toggle.
- Geist Sans + Geist Mono. Titles small and muted. Values large, dark, high-contrast. No uppercase letter-spaced eyebrows on the Map hero (those stay on Overview widgets).
- Blue (`#3B82F6`) for the 30-minute bars. Teal (`#0F766E`) for map count labels. Dark navy (`#1e3a5f`) for seat dots. Mint for live. Danger for Failed. Accent `#7C8CF8` only for primary actions and the live header chip.
- Volume bars: a light-gray track under the numeric cell, width = value / column max. Never a fake 100% bar on an empty row.
- Light is the Map default. Global theme toggle may still persist; `#map` must still read as Shoey in light. Dark theme on Map is allowed only if the same structure holds (count + bars + stream | map | three tables) — not a fallback to the old globe tabs.
- No Unsplash. No demo people. No placeholder visitors. No sample map dots. No sneakers, `/products/sneakers`, eBay, or "Unique visitors" copy.
- No emoji as chrome icons. ISO flag glyphs (regional-indicator or a tiny circular SVG keyed to ISO) are country marks only. OS marks are small vector logos or a two-letter OS chip (`mac` / `win` / `lin`), not emoji.

## Information architecture (do not invent nav)

Keep the existing Operator rail. Do **not** add OpenPanel leftovers.

| Section | Items | Status |
| --- | --- | --- |
| Analytics | Overview, Realtime, Events, Profiles, Map | Keep |
| Fleet | macOS, Windows, Licenses | Keep |
| Ops | Skills, Keys | Keep |

**Forbidden nav (never add, never leave empty):** Pages, SEO, Groups, Cohorts, Dashboards, Insights, Reports builder, Funnels, Scale, Change, Console leftover.

Two-level sidebar chrome may stay **if** `#map` itself feels like Shoey Realtime. If after the Map clone the page still reads as a toy globe, replace the Map page chrome first (this file). Do not invent a second rail.

`#realtime` stays its own hash (live seats + stream). `#map` is the Shoey Realtime **layout**. Do not delete `#realtime`. Do not rename `#map` to `#realtime`. Tony opens `#map`.

## #map layout (bind these test ids)

The Map page is one `data-page="map"` section. Three regions, always present in the HTML (empty states inside, never omitted):

```
[ data-map-live ]          [ data-map-world ]
  unique seats 30 min        light vector world
  30 one-minute bars         blue dots + teal labels
  activity stream

[ data-map-geo ]  [ data-map-referrals ]  [ data-map-paths ]
```

| Test hook | Shoey region | Métis content |
| --- | --- | --- |
| `data-map-live` | Left unique-count card + activity | Unique **seats** last 30 min (real pulses / last_seen). Big number. 30 blue bars (one per minute). Stream of seat events under it. |
| `data-map-world` | Right world map | Light-gray land (`#E5E7EB`). No tiles. Seat dots from `request.cf` lat/lon. Teal labels = country or city **seat counts**, not pageviews. |
| `data-map-geo` | Bottom Geo table | Country / city of seats. Columns: place, Events, Seats. Flag mark + volume bars. |
| `data-map-referrals` | Bottom Referrals table | Real mix only: LLM **provider** from Asks if any exist, else **macOS vs Windows** (and Linux if present) from seats. Never fake Google/Instagram referrers. |
| `data-map-paths` | Bottom Paths table | Real mix only: **skill ids** from Asks/packs if any exist, else **event kinds** (`ask`, `recap`, `skill`, `listen` when ingested). Never `/products/sneakers`. |

Caption under the map (honest, not Shoey): unique seats by country/city from Cloudflare `request.cf`. No GPS from the app. No IP.

Click a country (path `data-iso`) still filters the Geo table and may filter the stream. Do not drop that.

## Noun mapping (adapt, do not fake)

| Shoey | Métis | Source of truth |
| --- | --- | --- |
| Unique visitors last 30 min | Unique **seats** last 30 min | Distinct `device_id` with a pulse or `last_seen` in `[now-30m, now]` |
| 30-min activity bars | 30 one-minute bars | Count of pulses (heartbeat + ask) per minute. Empty minutes are a zero-height or hairline bar, not invented traffic |
| Live activity (`session_start`, `add_to_cart`, path) | Seat events: **listen / ask / recap / skill** | Real `events` / audit / CRM / ask ingest. Computer name, OS, country. Never token strings |
| Map dots | Seat lat/lon | Cloudflare `request.cf` only. Client `lat`/`lon`/`country`/`city`/`ip` ignored |
| Map labels (`72 Brazil`) | Country/city **seat counts** | Unique devices per country; city label when a city has ≥1 seat. Not pageviews |
| Geo Events / Sessions | Events / Seats | Events = stored events from that geo. Seats = unique devices |
| Referrals (Google, Instagram) | Provider mix **or** OS mix | Asks.provider if any Asks exist; else seat.os. Real counts only |
| Paths (`/products/sneakers`) | Skills or event kinds | Ask `skill_id` if present; else event `kind` mapped below |
| Unique Visitors / Sessions / Pageviews KPIs | Only if Overview is touched: seats, Listen minutes, recaps, CRM pushes, Keys funded, live now | Real numbers. Missing Listen minutes → `not reported` or hidden. Never `$0` fake, never `55K` sample |

### Activity name map (honest)

Display names on the stream and Paths table. Do not invent rows that D1 does not have.

| Stored `kind` / source | Shown as | When it exists |
| --- | --- | --- |
| `ask` | `ask` | Ask ingest |
| `crm` | `recap` | CRM send ingest (recap push). Still never auto-send |
| `rating` | `rating` | Rating ingest |
| skill draft / approve / push (audit or proposal) | `skill` | Skills ops |
| `heartbeat` | omit from the Map stream | Too noisy for Shoey-density activity. Pulses still feed the 30-min count and bars |
| `listen` | `listen` | Only if a seat later ingests a listen event. Do not synthesize Listen minutes or listen rows from heartbeats |

Profile column: computer / hostname, else SSO email, else `—`. OS chip from the seat. Country mark from `request.cf`. Relative time (`just now`, `1 minute ago`).

**Never** render a token-shaped string on Map, Events, or the stream (JWT, `Bearer`, `sk-`, 64-char hex HMAC, long base64). Same redaction as `#events`.

## World map (not a toy globe)

- Reuse Natural Earth 110m paths already in `operator/src/world-paths.ts`.
- **Keep** date-line sliver stripping (`stripMapBands`). Tests still fail on repeating horizontal bands.
- Default paint: all land `#E5E7EB` (Shoey light vector). Do **not** ship Land / Analytics / Graticule / Hatch tabs on `#map`. Those four panes are retired on this page.
- Dots: one circle per seat with lat/lon. Class `dot`. Dark navy fill. No sample dots when `map.empty`.
- Labels: teal pill + count + place name, leader line optional. Cluster: if several cities share a country, a country label (`N Brazil`) plus city labels when a city has a count. Labels are seat counts.
- Empty world: "No heartbeats yet. The map stays empty until a seat checks in." plus "not sample dots". No fake Brazil / Australia markers.

Overview may keep a small choropleth widget if it already has one. `#map` is the Shoey Realtime surface.

## Overview (only if you touch it)

If this slice edits `#overview` KPI chrome, steal Shoey density: a horizontal strip of small cards, big number, sparkline, hairline card.

Required real fields (do not invent):

| Card | Value |
| --- | --- |
| Seats | Distinct devices ever (or DAU if the strip needs a range — label it) |
| Listen minutes | Real listen duration if ingested; else `not reported` / hidden |
| Recaps | CRM success count (or CRM rows). Label recaps / CRM, not pageviews |
| CRM pushes | CRM attempted or submitted. Never auto-send |
| Keys funded | Count of vault rows with `status=active` (not revoked). last4 never on the KPI |
| Live now | Seats with `last_seen` under 2 minutes |

Keep Scale / Mix / Cost / Change / Asks / CRM as Overview **widgets**. Cloudflare fail-loud stays: "Cloudflare token missing. Connect it on Keys."

If this slice does **not** need Overview to prove `#map`, leave Overview KPI copy as-is. Do not restyle Overview as a side quest.

## Events and Profiles (steal chips, not sneakers)

`events.png` / `profiles.png` are density references.

- `#events`: name chip (ask / recap / skill / listen / rating), profile (hostname or email), property chips, relative time. Token-free. Empty: "No events yet."
- `#profiles`: identified seats. Computer name + SSO email. Missing = `—`. Tabs may stay Identified-only if Anonymous / Power users would be empty leftover nav. Do not add fake people.

Do not clone Shoey "Paginate through your events, conversions and overall stats" or "If you haven't called identify…".

## Data contract (no fake analytics)

All Map numbers come from Operator D1 / HMAC ingest already defined in `OPERATOR.md`.

- Unique seats 30 min: count distinct `device_id` in pulses since `now - 30min`, else distinct seats with `last_seen` in that window if pulses are empty.
- Bars: 30 buckets, 60s each, pulse counts (`heartbeat` + `ask`).
- Stream: last ~30 non-heartbeat events, newest first, redacted.
- Geo: group seats by country + city. Events column from `events` (or pulses if events are empty for that geo). Seats column = unique devices.
- Referrals: `mix(ask.provider)` if any Ask has a provider; else `mix(seat.os)` mapped to `macOS` / `Windows` / `Linux`.
- Paths: `mix(ask.skill_id)` if any Ask has a skill; else `mix(event.kind)` after the activity name map (skip `heartbeat`).
- Map dots / labels: existing `dashboard.map.dots` and `dashboard.map.countries`, plus city aggregates from seats.

Do not add OpenPanel pageview ingest. Do not scrape Shoey. Do not seed demo dots.

## Security and product law (unchanged)

This visual clone does **not** relax `OPERATOR.md`:

1. Login GET `/` stays `text/html` 200 with `data-login="1"`. HEAD `/` may 401. `/health` 200. `/v1/admin/*` without identity stays 401 JSON.
2. Allowlist: `tony.walteur@gmail.com`, `twalteur@amaris.com`.
3. Keys last4 only. Cipher / iv / secret / CF token / grant never in HTML or dashboard JSON.
4. Cloudflare missing → Overview fail loud. Not a quiet $0 chart.
5. Never auto-send CRM. Never put CLI tokens (`claude-cli`, `codex-cli`) in the vault.
6. Never ingest Listen transcripts, screen captures, audio, or raw keys. Ask text + metadata only.
7. Overlay chrome frozen. Do not touch appearance PR 98, Listen PR 99, ClickUp PR 97, leftover Intelligence PR 94, Aria.
8. Config is `operator/wrangler.jsonc`. D1 `metis-operator` `8eb5a081-594c-407c-9470-6a5aa28b9f7c`. Worker `metis-operator`.
9. Do not pack. Do not merge. Do not bump `1.8.3`.

## Tests (must exist before deploy)

| Test | Must prove |
| --- | --- |
| Map page structure | Authenticated console HTML contains `data-page="map"`, `data-map-live`, `data-map-world`, `data-map-geo`, `data-map-referrals`, `data-map-paths`. Unique-seats 30 min label (not "Unique visitors"). Three tables present even when empty. |
| Map is not a toy globe | `#map` HTML does **not** contain Land / Analytics / Graticule / Hatch tab chrome (`data-map="land"` etc.). |
| Login HTML | Unauthenticated GET `/` is 200 `text/html` with `data-login="1"`. JSON 401 only for `Accept: application/json` or `/v1/*`. |
| Map data | `request.cf` only. Client geo ignored. Empty world, no sample dots, no sneakers / Unique Visitors sample numbers. Band slivers still stripped. |
| Token-free | Map stream + Events never render token-shaped strings. |
| Nav | Rail stays the existing Analytics / Fleet / Ops ids. No Pages / SEO / Groups / Cohorts / Dashboards / Insights. |

Quality bar (`npm run test:operator:quality-bar`) still runs overlay freeze, Operator vitest, and live `/` + `/health` + `/v1/admin/dashboard` probes.

## Deploy

`cd operator && npx wrangler@4 deploy` using `operator/wrangler.jsonc`.

If this VM is wrangler-unauthed, same path as PR 96: minify the Worker bundle and PUT via the Cloudflare Workers API with `keep_bindings: ["secret_text"]` so existing Wrangler secrets stay (`OPERATOR_ADMIN_PASSWORD`, `OPERATOR_INGEST_SECRET`, `OPERATOR_PROMPT_KEY`, `OPERATOR_SKILL_PRIVATE_KEY`, `OPERATOR_VAULT_KEY`). Do not rewrite secrets. Do not drop the D1 binding.

Prove live after deploy:

- `GET /` → 200 `text/html` `data-login="1"`
- `GET /health` → 200
- Authenticated or source-proven `#map` HTML contains the five `data-map-*` hooks

HEAD `/` may 401. Ignore HEAD.

## Out of scope

- Overlay Y, Listen PR 99, ClickUp PR 97, appearance PR 98, Aria, Intelligence leftover 94
- Packing, version bump, merge
- `POST /v1/use` broker, migrating leftover seat-stored Tony keys
- Cloning Shoey Pages / SEO / Groups / Cohorts / Dashboards / Insights / Reports builder
- Inventing Listen minutes, sneakers paths, or referral brands
