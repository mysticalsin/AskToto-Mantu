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

## MCP write
Outlook drafts and CRM notes are user-confirmed. Never auto-send. A disconnected connector shows
Connect, it does not pretend a send happened.

## Connector marks (Settings → Brain)
ClickUp and Plane use official simple-icons SVG paths (CC0; trademarks remain with the brands). Do not invent marks or scrape PNGs.

- ClickUp: simple-icons `clickup`, official hex `#7B68EE`, source https://clickup.com/brand — `ClickUpMark`.
- Plane: simple-icons `plane` (commit `978656df6ce854ac04e45351059f8e3db7e34ef4`), official hex `#121212`, source https://plane.so/brand-logos/logo-with-wordmark.svg — `PlaneMark`. Near-black hex is painted as `currentColor` on dark glass so the official path still reads.

See `docs/design/BRAIN-CONNECTORS.md`.

## Starfield Close (onboarding bed)
See [ONBOARDING-STARFIELD.md](./ONBOARDING-STARFIELD.md). Galaxy from frame one. Overlay hide/island stay out.

## Thinking orbs
See [THINKING-ORB.md](./THINKING-ORB.md). Caption then sphere. Word first.

## Bar sphere
See [BAR-PILL.md](./BAR-PILL.md). The Bar control is a Jakub thinking-orb (`thinking-orbs`, theme `dark`): canvas 64, 2x backing, visible 41×41. Idle `solving` with no caption, listen `listening`, think `working`, fact-check `searching`, connecting `connecting`. Same circle when minimized. Left Settings M stays a circle (no-squash M). Not stuffed into overlay Hide/Island. Not a Fit Studio magenta core.

## Auto-answer
Ambient copilot / auto-answer stays until Tony clicks (dismiss/read, never send) or a new question replaces it. Not an ephemeral 4s/7s card.

## CLI session and Spotlight Ref
Settings → CLI Integration Connect is a zero-token session probe (`missing` / `signed-out` / `weekly-limit` / `live`). A Claude weekly cap is signed-in, not disconnected. Codex `login status` = Logged in is connected. Never auto-send a billed turn to connect.

### Managed Dust CLI (not web-only)

Spotlight Ref is a CLI call. The web REST picker (`listDustAgents` / view merge) must not be the only path and must not dead-end on reconnect copy.

- **Install.** `MANAGED_CLIS.dust` is `@dust-tt/dust-cli` (verified 0.4.5: `bin.dust` = `dist/index.js`). Same `installManagedCli` pattern as claude/codex: fetch the npm tarball, sha512 integrity, zip-slip-safe unpack into `userData/managed-cli/dust`. No system `npm i -g`. The published tarball is not a single-file bundle: after unpack, install production deps with the **managed Node** `npm` into that package dir (still not global).
- **Runtime.** `@dust-tt/dust-cli` statically imports `keytar` (native). `ELECTRON_RUN_AS_NODE` does not load a Node-ABI addon. Spawn the managed `dust` entry with a **vendored portable Node** (`userData/managed-node` or `resources/managed-node`), never a user-installed Node/Git/VC++ homework step. If the pack omitted the binary (dev checkout), Set up Dust fetches official Node 22.22.3 into userData after a sha256 check.
- **Windows.** Ship portable Node (pinned `22.22.3` win-x64) under `resources/managed-node/win-x64` so the next pack includes it. If keytar cannot load without the VC++ runtime, ship `vc_redist.x64.exe` under `resources/vcredist` and run it from the Set up Dust / installer path (`/quiet /norestart`). One-click Set up Dust. No browser-only Windows path.
- **Set up Dust.** Settings → AI → Set up Dust installs this CLI, then signs in (native OAuth or an existing CLI session). Copy must not say "No CLI".
- **Invoke.** `dust chat --sId GOr913Zr5V -m <prompt>`. Also `-a "Spotlight Ref"`: 0.4.5 non-interactive chat (`-m`) selects by agent **name**, not `--sId` (confirmed in the published `dist/index.js`). Headless auth from the saved Métis Dust session: `--key` + `--workspaceId` (help also says `--wId` / `--api-key`) or `DUST_API_KEY` + `DUST_WORKSPACE_ID`. Seed keytar with that session before chat so 0.4.5 `getDustClient()` (keytar-only) works. Never `--with-tools` / `-t` (auto-approves every tool). Never auto-send.
- **`--projectName`.** The CLI supports it (exact space name). Pass it only when `fetchDustProjects` / `matchDataAndAiProjects` returns a real name. Do not invent project names.
- **Fail loud, correctly.** Missing CLI → install (or one-click Install), not "reconnect Dust to the workspace that has it". Agent truly absent from the CLI session → "The Spotlight Ref agent is not in this workspace." A `view:list` omission is not proof the agent is gone.

Spotlight Ref is locked to Dust agent `GOr913Zr5V`. READY TO MERGE stays no until Devon Mac-shows Spotlight Ref returning Data and AI projects through the installed Dust CLI (not the REST-only picker).
