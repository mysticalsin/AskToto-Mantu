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

## Operator (Tony 6 Sep 2026 — Overview · Licenses · Keys)

Separate surface from overlay chrome. Worker `operator/`, live host
`https://metis-operator.tony-walteur.workers.dev/`. **Cloudflare Access stays**
(302 + email-code only; two Tony emails). No homemade password form.

This slice is a **thin Operator tip**: Generate license on Overview + Licenses,
platform keys after a seat activates that string in Métis Identity. Do not
merge the 476-file Keys-gateway stack. Ultron green-lit Operator-only
`wrangler` / API deploy to `metis-operator`. No pack. No merge. No Latest.
EXE/DMG/Native → Latest only after Bob QA + Ultron approve.

### Feel (LIVE rail + Licenses)

Ops console. Dark-first two-theme. Geist + Geist Mono. Hairline cards,
uppercase mono eyebrows, one blue accent. Access chip in the rail. LIVE
count in the top bar. No purple-gradient hero.

Rail matches live workers.dev plus Licenses:

`Overview · Realtime · Events · Sessions · Licenses · Notifications · Keys · Settings`

| Token | Hex / value | Role |
| --- | --- | --- |
| `accent` | `#2563EB` | Primary actions, nav count, live map dots |
| `live` / `ok` | `#10B981` / `#16A34A` | Access chip, active license, funded |
| `danger` | `#DC2626` | Revoke, fail-loud empty |
| `bg` / `panel` | `#0a0a0b` / `#111113` | Page + card (light: `#FFFFFF`) |
| `ink` / `ink2` | `rgba(255,255,255,0.94)` / `0.55` | Title / secondary |
| type | Geist 12/13, Mono 10 uppercase eyebrows | Dense ops |

Signature: the **once-string**. After Generate, a mono license (`METIS-OP-1.…`)
in a hairline strip with Copy. Shown once. last4 only after reload. Never a
secret in HTML.

### Overview `#overview` — Shoey bar, Métis content (Fable 6 Sep 2026)

Source of truth for chrome: WebsiteCloner Shoey OpenPanel
(`…/WebsiteCloner`, demo `/demo/shoey` + `/demo/shoey/overview`).
Parity is **layout and density**, not pageviews. Every number is a Métis
seat, heartbeat, license, recap, or D1 ask. Never Unique Visitors,
sneakers, or invented people.

Job: Tony reads the fleet in one glance, sees who is on and where, and
can mint a license without leaving the page.

```
┌ rail: Métis · Access ──────────┐  Overview                     LIVE n
│ Overview  Realtime  Events     │  ┌ Live seats │ Time saved │ Value ┐
│ Sessions  Licenses             │  │     2      │   45 min   │ $1.20 │
│ Notifications  Keys  Settings  │  └─────────────────────────────────┘
└────────────────────────────────┘  ┌ Activity (dense) ┐ ┌ Places ──┐
                                    │ live · city · os │ │ Cities   │
                                    │ ask  · provider  │ │ Regions  │
                                    │ seen · license   │ │Countries │
                                    └──────────────────┘ │ [corner  │
                                    ┌ People ──────────┐ │  map]    │
                                    │ host · city · id │ └──────────┘
                                    └──────────────────┘
                                    ┌ Install → works + Generate ───┐
                                    └───────────────────────────────┘
```

#### 1) Glance KPI row (exactly three)

| Card | Source | Empty |
| --- | --- | --- |
| **Live seats** | Real seats with `last_seen` &lt; 2 min | `0` + “heartbeat &lt; 2 min” |
| **Time saved** | Recap / listen events via `timeSavedFromMeetings` | `0 min` + “no recaps ingested” |
| **Value** | D1 ask cost today, else 7d (`formatUsdEstimate`) | `not reported` — never `$0` |

No 8-card KPI wall. No Unique sessions / pageviews. Numbers are large
(28–32px), eyebrow mono, one spark on Live only.

#### 2) Places — corner map + Top lists (Shoey)

Overview **Places** is a **corner** widget (`data-geo-corner`), never
full-bleed. Left: Top lists tabs **Cities / Regions / Countries**.
Right: mini choropleth (`data-geo-widget`). City rows are Shoey
`{ country, city, count, unique_sessions, avg_duration }` from
`request.cf` on heartbeat. No client GPS. No IP. Regions empty until the
next heartbeat writes `cf.region`.

Realtime `#realtime` is **WorldMap + LiveFeed + GeoTable** (full map,
city/country pills). Overview Places stays a **corner**. Same city JSON.

`GET /v1/admin/realtime.geo.json` (Access) returns
`{ ok:true, geo:[{ country, city, count, unique_sessions, avg_duration }] }`.
City required. Country-only seats are dropped. Unauth **401**.

#### 3) Activity — usable, Métis-dense

`data-overview-activity`. Feed is seats, not pageviews:

- `live` / `seen` from last heartbeat (city, device, OS, license)
- `heartbeat` / `ask` / `recap` / `listen` / `crm` from D1
- issued-license last4 never as a secret; chips only

When the fleet has seats, Activity is **not** an empty card. If nobody
is inside the 2-min window, show last-seen rows so the page is not
sparse. Token-shaped values stay redacted.

#### 4) People — live E2E

`data-overview-people`. Compact rows: computer, city, device, SSO, OS,
license, live/idle. Heartbeat `{ hostname, email, licenseId }` +
`request.cf.{country,city,region}` must land here. Live pill only when
`last_seen` &lt; 2 min. Idle last-seen still lists so People is not `0`
while the Mac is closed.

Generate license stays on Overview **and** `#licenses`. Same form:
duration 1 / 7 / 30 / 90 / 365 → POST `/v1/admin/licenses/generate` →
once-string. Unauth **401** `{ ok:false, error:"Access required" }`.
Empty seat table must not hide the form.

Cloudflare / Gateway / Scale / Mix stay off this glance. Keys and
Settings own Cloudflare.

### Licenses `#licenses`

Hero is Generate (eyebrow + duration + primary). Issued table under it
(last4, duration, expiry, active/revoked). Seat approve/revoke table is
second. Fail-loud if D1 seats are empty; generator still visible.

### Places (Overview corner + Realtime)

Heartbeats write `request.cf` city + region + country. Never client GPS.
Never IP.

**Overview Places** (`data-geo-corner`): Top lists **Cities / Regions /
Countries** with Shoey columns (count, unique_sessions, avg_duration) +
**corner** CountryMap (`data-geo-widget`). Not full-bleed.

**Realtime** (`#realtime`):

```
┌ WorldMap (data-world-map) · city dots + country pills · LIVE n ┐
└────────────────────────────────────────────────────────────────┘
┌ LiveFeed (data-live-feed) ┐ ┌ GeoTable City/Regions/Countries ┐
│ heartbeat · city · seat  │ │ country city count sessions avg │
└──────────────────────────┘ └─────────────────────────────────┘
┌ People with city ─────────────────────────────────────────────┐
```

Geo JSON: `GET /v1/admin/realtime.geo.json` → city rows only. Sessions
list city + device. People shows last-seen when the 2-min window is
empty. No Shoey SKUs. No sneakers.

### Keys `#keys`

LLM vault add (last4 only) stays. **Cloudflare · AI Gateway** is Log in to
Cloudflare → `/cloudflare/connect` OAuth → auto-provision. No Account ID +
token paste as the happy path. CF Access already wraps the console.

### Seat path (Identity)

Tony copies the once-string. Seat: Métis → Settings → Identity / License →
Activate. Valid `METIS-OP-1` HMAC token + not expired → licensed. Heartbeat
sends `license: licensed` + `licenseId` (jti). Worker funds vault keys.
Revoke still wins. ATK- / Fly JWS stay closed (`LICENSE_ACTIVATION_OPEN`
stays false). No personal API key paste for this path.

Full product law: [`OPERATOR.md`](OPERATOR.md).
