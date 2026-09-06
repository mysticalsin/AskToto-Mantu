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
merge the 476-file Keys-gateway stack. **No Worker deploy** until Devon/Ultron
Mac Hide PASS. No pack. No merge. No Latest.
EXE/DMG/Native → Latest only after Bob QA + Ultron approve.

### Feel (original Métis Operator, not Shoey)

Ops console, not e-commerce. Dark-first two-theme. Geist + Geist Mono.
Hairline cards, uppercase mono eyebrows, one blue accent. Access chip in the
rail. LIVE count in the top bar. No purple-gradient hero. No Bklit / Sessions
nav.

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

### Overview `#overview`

Job: Tony sees how a seat goes from install to platform keys, and can mint a
license without hunting.

```
┌ rail: Métis · Access ──────────┐  Overview          LIVE n
│ Overview  Realtime  Events Map │  ┌ Install → works ─────────────┐
│ Users  macOS  Windows Licenses │  │ Check in → Approve or license│
│ Keys  Notifications Rules …    │  │ → Platform keys              │
└────────────────────────────────┘  │ Duration [30d ▾] [Generate]  │
                                    │ [once-string · Copy]         │
                                    └──────────────────────────────┘
                                    Fleet KPIs (real D1, never $0)
```

Generate license is on Overview **and** `#licenses`. Same form contract:
duration 1 / 7 / 30 / 90 / 365 → POST `/v1/admin/licenses/generate` → show
string. Unauth **401** `{ ok:false, error:"Access required" }`. Empty seat
table must not hide the form.

### Licenses `#licenses`

Hero is Generate (eyebrow + duration + primary). Issued table under it
(last4, duration, expiry, active/revoked). Seat approve/revoke table is
second. Fail-loud if D1 seats are empty; generator still visible.

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
