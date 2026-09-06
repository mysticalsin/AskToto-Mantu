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

## Operator
See [OPERATOR.md](./OPERATOR.md). Cloudflare Access packed ops console (`operator/`, Worker `metis-operator`). Operator is the central API-key gateway: Tony vaults keys (last4 only), approves each seat **or** the seat activates an Operator-generated license in Settings → Identity → License, then HMAC `/v1/use` + heartbeat `fundedProviders` fund that seat. Unapproved seats without an active Operator license fail loud. `#licenses` has **Generate license** (Tony picks duration / expiry). Chrome is pre-Shoey (Keys, Licenses, Map / macOS / Windows, Skills). Client keeps prompt cache on. Map geo comes from `request.cf`, never from the app. Not overlay chrome. Not the Fly license-server. Not `cloudflare-proxy`. Do not Worker-deploy until Ultron says Mac re-PASS on PR 144. Ultron lock: no pack, no merge, no Metis-Releases Latest. EXE/DMG/Native → Latest only after Bob QA + Ultron approve.

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
