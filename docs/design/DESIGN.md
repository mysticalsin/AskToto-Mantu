---
project: Métis
type: design-system-contract
basis: reverse-engineered Cluely v2.1.19 (see DESIGN-SPEC.md)
colors:
  bg-page: "transparent"           # window is transparent; only glass surfaces paint
  glass-fill: "rgba(20,20,22,0.55)"  # dark translucent panel base
  glass-fill-strong: "rgba(16,16,18,0.72)"
  glass-border: "rgba(255,255,255,0.12)"
  glass-border-soft: "rgba(255,255,255,0.08)"
  tint-black: "rgba(0,0,0,0.19)"   # #00000030 observed in Cluely
  text-primary: "rgba(255,255,255,0.95)"
  text-secondary: "rgba(255,255,255,0.55)"
  text-muted: "rgba(255,255,255,0.38)"
  accent: "#7C8CF8"                 # Métis single accent (indigo) — NOT Cluely's
  accent-soft: "rgba(124,140,248,0.16)"
  danger: "#F0717A"
  ok: "#83C092"
typography:
  ui: "Geist, -apple-system, system-ui, sans-serif"
  body: "Inter, -apple-system, system-ui, sans-serif"
  mono: "Geist Mono, ui-monospace, SFMono-Regular, monospace"
  scale: { xs: 11, sm: 12, base: 13, md: 14, lg: 16, xl: 20 }  # px; chrome is small/dense
  weight: { regular: 400, medium: 500, semibold: 600 }
radius: { sm: 8, md: 12, lg: 16, xl: 20, pill: 9999 }
spacing: 4px-scale                  # 4,8,12,16,20,24
elevation:
  glass: "0 8px 32px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.06)"
  bar: "0 6px 24px rgba(0,0,0,0.40)"
blur: { bar: 24px, panel: 24px, subtle: 8px }   # backdrop-blur (Cluely: sm/md/2xl/[8px])
motion:
  ease: "cubic-bezier(0.22, 1, 0.36, 1)"   # spring-ish ease-out
  panel-in: "180ms"
  hover: "120ms"
  reduced-motion: respected
---

# Métis Design Contract

## Surfaces (the ONLY visible elements — page is transparent)
1. **Pill bar** — centered, docked near top of screen. Height ~38–44px. `radius.pill`.
   Glass fill + `glass-border` hairline + `blur.bar` + `elevation.bar`. Contents L→R:
   Métis constellation mark · "Ask anything" input (grows) · **Listen** toggle · **Capture** btn ·
   timer (when listening) · Settings gear · Hide (chevron). Buttons are `radius.pill` ghost
   pills, hover → `glass-border-soft` fill, active → `accent-soft`.
2. **Answer / Transcript panel** — drops below the bar, width **690px** (matches Cluely),
   max-height ~670px, `radius.lg`, `glass-fill-strong` + `blur.panel` + `elevation.glass`.
   Scrollable. Two modes: ANSWER (streamed markdown via streamdown) · LISTEN
   (live transcript left/right speaker + AI Suggestions cards).
3. **Settings** — compact 320–360px glass card (API key, model, hotkeys, audio source, toggles).

## Rules (from §6.2 + Cluely fidelity)
- ONE accent (`accent`). Everything else is white-alpha on dark glass.
- Content is king; chrome recedes. Dense, small type. No heavy borders — hairlines only.
- Every interactive el: hover + focus-visible ring (`accent`) + reduced-motion fallback.
- States on every async surface: idle / loading (shimmer) / streaming / empty / error.
- Drag region: the bar background is `-webkit-app-region: drag`; inputs/buttons `no-drag`.
- Pixel target: side-by-side with Cluely, a stranger can't tell which is which (minus brand).

## Anti-slop (do NOT)
- No purple-gradient hero, no generic card-in-card-in-card, no emoji UI, no rounded-3xl everything,
  no drop-shadow on text, no 6-line text wraps. Match Cluely's restraint.

## Brand mark
Métis = five-star constellation-M glyph (own SVG), dots + thin connectors, `text-primary`.
NOT Cluely's logo. Wordmark "Métis" in Geist medium, tracking-tight.

## Operator — Shoey OpenPanel bar, Métis seats (Fable lock 6 Sep 2026)

**Process.** Write this section first. Then UI. Do not invent chrome
that is not named here. Do not ship OpenPanel nouns.

Required bar: WorldMap + LiveFeed + GeoTable with Cities / Regions /
Countries. Corner map on overview (original placement). Activity
richness matching Shoey density. Personalize to Métis: live seats from
heartbeats, email / hostname / device / city, licenses, time saved,
value. Never generic pageviews.

### Sources (chrome vs numbers)

Chrome / density / placement — WebsiteCloner Shoey OpenPanel. Compare
every section, not only realtime:

- App: `/Users/tony/Library/CloudStorage/OneDrive-MantuGroup/Documents/Chief of Staff/Apps Source/WebsiteCloner`
- Live compare: `http://localhost:3112/demo/shoey/realtime` plus
  `/overview` `/events` `/sessions` and the other rail pages
- Visual refs (Totos-Mac): `/Users/tony/dev/metis-repro/shoey-ref/overview.png`
  (paired TopLists, device/events tables with inline bars, Countries /
  Regions / Cities + **corner** world map) and
  `…/shoey-ref/realtime.png` (full WorldMap, city/country pills, LIVE
  count, LiveFeed)

Numbers — Métis D1 only: heartbeats, seats, licenses, recaps, asks,
CRM. **Never** Unique Visitors, pageviews, sneakers, referrers, or
invented people.

Live host: `https://metis-operator.tony-walteur.workers.dev/`.
**Cloudflare Access stays** (302 + email-code; `tony.walteur@gmail.com`
+ `twalteur@amaris.com`). Thin Worker tip only. Do not merge fat
PR151. Generate license stays P0.
EXE/DMG/Native → Latest only after Bob QA + Ultron approve.

### Shoey → Métis dictionary (do not ship the left column)

| Shoey / OpenPanel | Métis Operator |
| --- | --- |
| Unique visitors / pageviews | Live seats (heartbeat &lt; 2 min) |
| Unique visitors last 30 min | Seats last 30 min (`last_seen`) |
| Sessions / day | Real seats last seen 24h |
| Duration / time on site | Seat first_seen → last_seen · recap minutes |
| Top pages / referrers / sources | Top devices (hostname · city · live) |
| Top events (screen_view) | Top event kinds: live / seen / heartbeat / ask / recap / listen / crm |
| Countries / Regions / Cities | `request.cf` city · region · country on heartbeat |
| Live visitors (5 min) | People: hostname, SSO email, device, city, license |
| Events / LiveFeed | Heartbeat presence + HMAC ingest (ask / recap / listen / crm) |
| Revenue | Value = D1 ask cost (`not reported`, never `$0`) |
| Session duration | Time saved = `timeSavedFromMeetings` recaps |
| Profile | Hostname, else SSO email, else em dash (never invented) |
| Browser / brand | Device id (8) + OS + app version |
| Notifications feed | Pending seats · CRM fail · skill diffs (real D1) |

### Feel + rail

Ops console. Dark-first two-theme. Geist + Geist Mono. Hairline cards,
uppercase mono eyebrows, one blue accent `#2563EB`. Access chip in the
rail. LIVE count in the top bar. Dense 12px rows, 6–8px padding, inline
bars, relative time on feeds. No purple-gradient hero. No SKUs.

Rail (LIVE + Licenses, no leftover Users/Map):

`Overview · Realtime · Events · Sessions · Licenses · Notifications · Keys · Settings`

| Token | Hex / value | Role |
| --- | --- | --- |
| `accent` | `#2563EB` | Primary actions, nav count, live map dots |
| `live` / `ok` | `#10B981` / `#16A34A` | Access chip, active license, funded |
| `danger` | `#DC2626` | Revoke, fail-loud empty |
| `bg` / `panel` | `#0a0a0b` / `#111113` | Page + card (light: `#FFFFFF`) |
| `ink` / `ink2` | `rgba(255,255,255,0.94)` / `0.55` | Title / secondary |
| type | Geist 12/13, Mono 10 uppercase eyebrows | Dense ops |

Signature: the **once-string**. After Generate, a mono license
(`METIS-OP-1.…`) in a hairline strip with Copy. Shown once. last4 after
reload. Never a secret in HTML.

### Overview `#overview` — Mission Control glance

Job: Tony reads the fleet in one glance and can mint a license.
**PORT** `shoey-ref/overview.png` (WebsiteCloner `/demo/shoey`): two
equal columns, then Métis People + Generate. Not a vague card stack.

```
┌ Live seats │ Time saved │ Value ─────────────────────────────────┐
┌ Devices (tabs Devices/OS) ──┐ ┌ Events (search + count bars) ───┐
│ search · Seats · Live bars  │ │ search · Count bars             │
└─────────────────────────────┘ └─────────────────────────────────┘
┌ Places table (own card) ────┐ ┌ Map (own CORNER card) ──────────┐
│ Countries / Regions / Cities│ │ choropleth — not full-bleed     │
│ search · Seats · Sess bars  │ │                                 │
└─────────────────────────────┘ └─────────────────────────────────┘
┌ Activity (Shoey LiveFeed density) ──────────────────────────────┐
┌ People: host · email · city · device · license · live/idle ─────┐
┌ Install → works + Generate license ─────────────────────────────┐
```

1. **Glance KPIs (exactly three).** Live seats / Time saved / Value.
   Empty: `0` + “heartbeat &lt; 2 min”; `0 min` + “no recaps ingested”;
   `not reported` (never `$0`).
2. **Paired TopLists** (`data-overview-toplists`). Two equal cards.
   Devices: tabs Devices / OS, search, columns Seats · Live, **full-row
   inline bars**. Events: search, Count, full-row bars. Métis seats, not
   Views / pageviews.
3. **Places + corner map** (`data-geo-corner`). **Two sibling cards**
   (screenshot bottom row): table left, Map card right
   (`data-geo-widget`). Tabs Countries / Regions / Cities. Search.
   Columns Seats · Sess · Avg. Full-row bars. Never a 168px inset and
   never full-bleed.
4. **Activity** (`data-overview-activity`) full width under the 2×2.
   Shoey LiveFeed density: name, profile, city/device/os/license chips,
   relative time. Presence `live` / `seen` when seats exist.
5. **People** (`data-overview-people`). Live pill only if heartbeat
   &lt; 2 min. Last-seen still lists. City from `request.cf`. Missing
   hostname/email = em dash.
6. **Generate** stays on this page and `#licenses`.

### Realtime `#realtime` — full WorldMap

**PORT** `shoey-ref/realtime.png`. Full map first, then a 3-card live
strip (30m seats · Live · Live events), then GeoTable.

```
┌ WorldMap (data-world-map) · city dots + country pills · LIVE n ─┐
└─────────────────────────────────────────────────────────────────┘
┌ Seats 30m ──┐ ┌ Live n ──┐ ┌ Live events (data-live-feed) ─────┐
│ unique seats│ │ pulse    │ │ name · city · os · ago            │
└─────────────┘ └──────────┘ └───────────────────────────────────┘
┌ GeoTable Cities / Regions / Countries (data-realtime-geo) ──────┐
┌ People: host · email · city · device · license ─────────────────┐
```

`GET /v1/admin/realtime.geo.json` (Access):
`{ ok:true, geo:[{ country, city, count, unique_sessions, avg_duration }] }`.
City required. Unauth **401**.

### Events `#events`

Shoey table chrome: Created at · Name · Profile · City · Device · OS.
Search. HMAC ingest only. Token-shaped values dropped. Not page paths.
Profile = hostname/email. City/device/os from seat + chips.

### Sessions `#sessions`

Computer · City · Country · Device · SSO · OS · Version · License ·
Approval · Seen · live/idle. Search by city/device. `usage-import` off.

### Licenses `#licenses` (P0)

Generate first (duration 1 / 7 / 30 / 90 / 365). Issued last4 table.
Seat approve/revoke second. Empty D1 fails loud; form stays visible.
Unauth generate **401** `{ ok:false, error:"Access required" }`.

### Notifications `#notifications`

Shoey feed chrome (title + profile + geo + OS), Métis rows: pending
seats, CRM fail, skill diffs. Columns: Kind · Title · Profile · City ·
OS · When. Real D1. Not Slack/Discord stubs.

### Keys `#keys` / Settings `#settings`

Keys: vault last4 + **Log in to Cloudflare** (`/cloudflare/connect`).
Operator Settings: Access keep + geo law (`request.cf` only). No homemade
password. CF OAuth missing must not block Generate license. Fail loud
on Keys when `CF_OAUTH_CLIENT_ID` / `CF_OAUTH_CLIENT_SECRET` are unset.

Métis client CF provider connect in overlay Settings, if any, lands on
**1.8.5 KineticGrid** tip `b8a677b` — not this thin Worker tip, not
pre-Kinetic, not fat PR151.

### Anti-slop (Operator)

- No Unique Visitors, no sneakers, no `/products/*`, no defaultServers.
- No full-bleed broken geo on Overview.
- No 8-card KPI wall. No invented hostname/email (em dash).
- No pageview nouns on Activity / LiveFeed / Events.
- Overlay chrome (pill bar) is a different surface — do not restyle it
  here.

### Seat path (Identity)

Tony copies the once-string. Seat: Métis → Identity → License →
Activate. Heartbeat `{ license, licenseId }` + city. Worker funds keys
when Approve **or** active jti. Revoke wins. `LICENSE_ACTIVATION_OPEN`
stays false.

Full product law: [`OPERATOR.md`](OPERATOR.md).
