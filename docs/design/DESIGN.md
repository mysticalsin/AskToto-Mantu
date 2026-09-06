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

## Platform (Fable 5.1)

The one product story is [`METIS-PLATFORM-NORTH-STAR.md`](METIS-PLATFORM-NORTH-STAR.md). Slice
files keep their pixels. The north star keeps install-to-first-Ask, fail-loud security, and
Apple-grade defaults. READY TO MERGE stays no.

Three feelings, in this order:

1. **It just works.** Install, then Ask. Defaults friendly. Power lives in Settings.
2. **It never lies.** Connected means a live session. Latest is a QA+Ultron fact.
3. **It recedes.** Hide until the top edge. Settings never crushed. No white flash.

| Default | Value | Why |
| --- | --- | --- |
| Overlay chrome | Hide | Invisible until intent. |
| Bar rest | Circle (`overlayOrbStyle: 'jakub'`) | Original thinking-orb. Jarvis particles are opt-in. |
| Provider | Cloudflare | One operator endpoint. |
| `providerPriority` | `api` | CLI-first is a live promotion when a CLI session is actually connected. |
| Local AI | off | Weights may warm. They do not preempt. |
| `encryptTranscripts` | true | Fail closed on disk. |
| Operator URL | empty | No phone-home until Tony points the seat. |

Fail loud: a WindowsApps Desktop alias is not Claude Code. A leftover managed pointer is not
installed. `installCli` is not ok until `resolveBin` finds a runnable entry. `cliConnected` is
written only after `connectCliSession` (`live` or `weekly-limit`). Never a billed Connect turn.
Never `--with-tools` on Dust. Never a raw key in the renderer.

Desktop holds R01–R07 on this branch (overlay law, Settings surface, flash, top hover, Bar rest,
CLI install, CLI session). R17 (vault last4) is Operator. Do not implement `#keys` here.

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
3. **Settings** — a real surface, never a leftover bar. Minimum **880×800** at `islandSafeTop`,
   background `#120022`. Tray, dock, hotkey, and IPC all call `applySettingsSurface` first. Never
   Hide 8×2. Never Island peek. Never the live 880×325 Cmd+, crush. Closing Settings
   `leaveSettingsSurface` then parks. Identity pass lives here ([`IDENTITY-CARD.md`](IDENTITY-CARD.md)).
4. **Review / recap** — drops below the bar in the same Panel shell as History / Agenda / Brain.
   Must **fit or scroll**. Never clip. `Panel` is the one overflow-y scroller (`html`/`body`/`#root`
   stay hidden). Cap is screen-derived (`panelMaxHeight`), never `vh` / `innerHeight`: leave room for
   the overlay Bar (64 thinking-orb included), root padding, the Bar–Panel gap, useAutoResize's grow
   grid, and main's `workArea.height - 48` ceiling. Last paragraph, actions, and footer chips must be
   reachable by trackpad/mouse. No nested transcript scroll trap. No "scroll here" hint.

## Review / recap (never clip)
The post-meeting **Summary** Tony opens after a session lives in Review inside `Panel`. Sibling
recap/note bodies that share that shell follow the same rule: fit cleanly, or scroll to the last
line. Safe-area / overlay Bar height is respected. Content never sits under the glass bar or the
window frame. Defaults stay the friendly path.

## Rules (from §6.2 + Cluely fidelity)
- ONE accent (`accent`). Everything else is white-alpha on dark glass.
- Content is king; chrome recedes. Dense, small type. No heavy borders — hairlines only.
- Every interactive el: hover + focus-visible ring (`accent`) + reduced-motion fallback.
- States on every async surface: idle / loading (shimmer) / streaming / empty / error.
- Drag region: the bar background is `-webkit-app-region: drag`; inputs/buttons `no-drag`.
- Pixel target: side-by-side with Cluely, a stranger can't tell which is which (minus brand).

## Identity (Settings → Identity)
The Métis member pass and license foundation live under Settings → Identity.
They are **not** overlay chrome. Tokens, motion, copy, and do/don'ts are
binding in [`IDENTITY-CARD.md`](IDENTITY-CARD.md). One accent: Mantu Bright
Purple `#7F00DA` (the live Settings token, not the overlay indigo above).
Implement to that contract only.

## Anti-slop (do NOT)
- No purple-gradient hero, no generic card-in-card-in-card, no emoji UI, no rounded-3xl everything,
  no drop-shadow on text, no 6-line text wraps. Match Cluely's restraint.

## Brand mark
Métis = five-star constellation-M glyph (own SVG), dots + thin connectors, `text-primary`.
NOT Cluely's logo. Wordmark "Métis" in Geist medium, tracking-tight.

## Answer first (every LLM path)
Typed and screen answers lead with the answer. No "sure", no restating the question, no "let's".
System rail: `ANSWER_FIRST_RAIL` in `src/shared/answer-first.ts`, appended by `buildSystem` for
answer/vision (not live suggest, not recap/summary, not fact-check). Post-filter:
`stripLeadingFiller` / `AnswerFirstFilter` on the enterprise client stream. Tests lock both.

## Enterprise LLM client
Every provider (local llama-server, Apple FM, OpenAI-compatible, Anthropic, Dust, CLI) enters
through `createStream` → `wrapEnterpriseStream`. Contract: hard timeout, cancel, retry-with-jitter
primitives, fallback chain helper, streaming, TTFT/TTA metrics, circuit snapshot, secret redaction
in logs. Fail closed on a hung call. Honest errors, never "Something went wrong".

Local runtime stays llama.cpp sidecar (plus Apple FM when live). Do not swap it. Threads / GPU /
ctx stay machine-aware (`inferenceThreads`, `spawnProfileFor`). Streaming stays on.

## Time saved
See [TIME-SAVED.md](./TIME-SAVED.md). Tokens, type, motion, do/don'ts live there. The Intelligence
dashboard (PR 61) is a separate surface; this module is a small honest feed it can read later.

## Intelligence Update
See [INTELLIGENCE-UPDATE.md](./INTELLIGENCE-UPDATE.md). One **Update Intelligence** button starts a
local-first agent pass (API once if Local is missing, refused, or errors) and refreshes the
dashboard. The button is the trigger. Never auto-send. Not leftover PR 61.

## Operator
See [OPERATOR.md](./OPERATOR.md). Cloudflare Access packed ops console (`operator/`, Worker `metis-operator`). Client keeps prompt cache on. Map geo comes from `request.cf`, never from the app. Not overlay chrome. Not the Fly license-server. Not `cloudflare-proxy`.

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

## MCP write
Outlook drafts and CRM notes are user-confirmed. Never auto-send. A disconnected connector shows
Connect, it does not pretend a send happened.

## ClickUp post-meeting push
See [CLICKUP-PUSH.md](./CLICKUP-PUSH.md). Confirm creates a task in the last/connected list. Never
attach a file. Destination is named on screen. Fail loud with ClickUp's error. OAuth redirect is PR 73.

## Connector marks (Settings → Brain)
ClickUp and Plane use official simple-icons SVG paths (CC0; trademarks remain with the brands). Do not invent marks or scrape PNGs.

- ClickUp: simple-icons `clickup`, official hex `#7B68EE`, source https://clickup.com/brand — `ClickUpMark`.
- Plane: simple-icons `plane` (commit `978656df6ce854ac04e45351059f8e3db7e34ef4`), official hex `#121212`, source https://plane.so/brand-logos/logo-with-wordmark.svg — `PlaneMark`. Near-black hex is painted as `currentColor` on dark glass so the official path still reads.

See `docs/design/BRAIN-CONNECTORS.md`.

## Onboarding flow
See [ONBOARDING-FLOW.md](./ONBOARDING-FLOW.md). Order: hero → problem → reveal → appearance → setup → personalize → [license] → ready. Loading orb on Your setup. Act 4 heading contrast on KineticGrid.

## Onboarding appearance
See [ONBOARDING-APPEARANCE.md](./ONBOARDING-APPEARANCE.md). Tony ask: Hidden (default, mouse to top, click to trigger) vs Island vs Bar. Sits after the demo, before Your setup. Live preview. Persist existing overlay. Hide 8×2 and Island hover stay out.

## Starfield Close (onboarding bed)
See [ONBOARDING-STARFIELD.md](./ONBOARDING-STARFIELD.md). **Superseded after the lady beat** by [ONBOARDING-KINETIC-GRID.md](./ONBOARDING-KINETIC-GRID.md). Starfield / space-with-moving-lights does not mount after Next. Overlay hide/island stay out.

## Onboarding KineticGrid
See [ONBOARDING-KINETIC-GRID.md](./ONBOARDING-KINETIC-GRID.md). Lady+universe first. KineticGrid only after that. No Skip. Tile warp, not stage slide.

## Exclusive onboarding window (opaque)
While `!onboardingDone`, the BrowserWindow is **opaque** hero/universe hold (`transparent: false`, `#05010A`). Never `#3A0B6B` first paint. Mac `setSimpleFullScreen` on a transparent window composites as a dead black void (Totos-Mac 044c0f1). After `onboardingDone` the overlay is transparent again. Replay re-enters opaque exclusive and locks Goldberg first.

## Thinking orbs
See [THINKING-ORB.md](./THINKING-ORB.md). Caption then sphere. Word first.

## Bar sphere
See [BAR-PILL.md](./BAR-PILL.md). The Bar control is a Jakub thinking-orb (`thinking-orbs`, theme `dark`): canvas 64, 2x backing, visible 41×41. Idle `solving` with no caption, listen `listening`, think `working`, fact-check `searching`, connecting `connecting`. Same circle when minimized. Left Settings M stays a circle (no-squash M). Not stuffed into overlay Hide/Island. Not a Fit Studio magenta core.

Bar rest look (power choice): [ORB-SELECTION.md](./ORB-SELECTION.md). Full bar (default, Jarvis circle docked) or Circle (Jarvis particle rest). Hide/Island ignore it. Never Obsidian.

## Auto-answer
Ambient copilot / auto-answer stays until Tony clicks (dismiss/read, never send) or a new question replaces it. Not an ephemeral 4s/7s card.

## CLI session and Spotlight Ref
Settings → CLI Integration Connect is a zero-token session probe (`missing` / `signed-out` / `weekly-limit` / `live`). A Claude weekly cap is signed-in, not disconnected. Codex `login status` = Logged in is connected. Never auto-send a billed turn to connect.

Connect / Install must install in-flow (managed tarball, no system Node) when the CLI is missing, then prove that session. Windows must reuse a licensed Claude Code / Codex native install (`%USERPROFILE%\.local\bin`, `%LOCALAPPDATA%\Programs\...`) and must never treat Claude Desktop's `WindowsApps` alias as the CLI. Login scripts invoke that resolved binary (or the managed entry), not a PATH-only `call claude`. No fake Connected.

### Managed Dust CLI (not web-only)

Spotlight Ref is a CLI call. The web REST picker (`listDustAgents` / view merge) must not be the only path and must not dead-end on reconnect copy.

- **Install.** `MANAGED_CLIS.dust` is `@dust-tt/dust-cli` (verified 0.4.5: `bin.dust` = `dist/index.js`). Same `installManagedCli` pattern as claude/codex: fetch the npm tarball, sha512 integrity, zip-slip-safe unpack into `userData/managed-cli/dust`. No system `npm i -g`. The published tarball is not a single-file bundle: after unpack, install production deps with the **managed Node** binary plus `npm-cli.js` (never the `bin/npm` shebang: Electron PATH has no `node`, and that was exit 127). Fail loud if Node is missing. Never leave a half tmp package as Connected.
- **Runtime.** `@dust-tt/dust-cli` statically imports `keytar` (native). `ELECTRON_RUN_AS_NODE` does not load a Node-ABI addon. Spawn the managed `dust` entry with a **vendored portable Node** (`userData/managed-node` or `resources/managed-node`), never a user-installed Node/Git/VC++ homework step. If the pack omitted the binary (dev checkout), Set up Dust fetches official Node 22.22.3 into userData after a sha256 check.
- **Windows.** Ship portable Node (pinned `22.22.3` win-x64) under `resources/managed-node/win-x64` so the next pack includes it. If keytar cannot load without the VC++ runtime, ship `vc_redist.x64.exe` under `resources/vcredist` and run it from the Set up Dust / installer path (`/quiet /norestart`). One-click Set up Dust. No browser-only Windows path.
- **Set up Dust.** Settings → AI → Set up Dust installs this CLI, then signs in (native OAuth or an existing CLI session). Copy must not say "No CLI".
- **Invoke.** `dust chat --sId GOr913Zr5V -m <prompt>`. Also `-a "Spotlight Ref"`: 0.4.5 non-interactive chat (`-m`) selects by agent **name**, not `--sId` (confirmed in the published `dist/index.js`). Headless auth from the saved Métis Dust session: `--key` + `--workspaceId` (help also says `--wId` / `--api-key`) or `DUST_API_KEY` + `DUST_WORKSPACE_ID`. Seed keytar with that session before chat so 0.4.5 `getDustClient()` (keytar-only) works. Never `--with-tools` / `-t` (auto-approves every tool). Never auto-send.
- **`--projectName`.** The CLI supports it (exact space name). Pass it only when `fetchDustProjects` / `matchDataAndAiProjects` returns a real name. Do not invent project names.
- **Fail loud, correctly.** Missing CLI → install (or one-click Install), not "reconnect Dust to the workspace that has it". Agent truly absent from the CLI session → "The Spotlight Ref agent is not in this workspace." A `view:list` omission is not proof the agent is gone.

Spotlight Ref is locked to Dust agent `GOr913Zr5V`. READY TO MERGE stays no until Devon Mac-shows Spotlight Ref returning Data and AI projects through the installed Dust CLI (not the REST-only picker).
