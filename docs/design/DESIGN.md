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

## Bar pill
See [BAR-PILL.md](./BAR-PILL.md). Jarvis orb is Bar-minimized only. Not stuffed into overlay Hide/Island.

## Onboarding second brain + no-flash

Tony, 1 Sep 2026. Fail closed on a glitchy tour. Do this slice before any EXE / DMG / native pack. Overlay hide / island / bar geometry stays frozen (`src/main/island/geometry.ts` is not in this slice). Do not pack. Do not merge. READY TO MERGE stays no. Leave Dust / Claude CLI write plumbing to Devon.

### Outcome

1. The exclusive tour is visually stable. No fade-up that hides or blinks copy. No flashing background. No layout jump between steps. Primary CTAs (Next / Continue / Get started / Set me up) stay full-opacity from first paint of that act.
2. During onboarding, Métis maps OneDrive for an existing Obsidian vault named **AI Second Brain**. Typical paths: `Library/CloudStorage/OneDrive-*/Documents/AI Second Brain` and `~/Documents/AI Second Brain` (Windows: OneDrive `Documents/AI Second Brain` plus `~/Documents/AI Second Brain`). If that vault is found, it is the single source of truth. Do not create a competing vault. If it is not found, offer to create one at that path.
3. Dust write-in defaults **ON** into that vault at `00_Inbox/from-dust/`. If a Reagan / writer setting already exists, default it ON too. Do not invent a Reagan product. Published wiki remains Dust-readable when published (existing `publishBrainPages` lock: explicit opt-in, schema default false).
4. OneDrive offline is honest: not-found + retry. Never mkdir a fake vault to look successful.

### No-flash (HARD)

The 31 Aug starfield pass already forbids fade-up on primary CTAs. This slice extends that to the whole tour surface.

Forbidden on the exclusive stage after first paint of an act:

- `.fade-up` (or any `animation-fill-mode: both` / `backwards` that starts at `opacity: 0`) on copy, CTAs, skip, byline, setup rows, or Ready lines. Fade-up that hides then reveals is a blink. Fail.
- `.scene-enter` that interpolates opacity from 0. Translate-only is allowed if copy stays readable (`opacity: 1`) the whole time.
- Remounting or pulsing the starfield bed on every scene change so the canvas drops to opacity 0 and pops back. One bed after hero. Nudge is fine. A black flash is not.
- A flashing stage wash (do not toggle stripe layers, portal mask, or background gradient per step).
- Layout jump: guided acts share one reserved-height slot (`.onboard-tour-slot`). Act dots already sit in a reserved `h-9` row. Do not let heading / CTA / card height collapse the slot between problem, setup, personalize, and ready.

Required:

- Primary CTAs: class `onboard-cta`, `opacity: 1`, `pointer-events: auto`, outside `.scene-enter`, no `fade-up`, no `.onboard-glass`. Tests must not require fade-up on those buttons (the old geometry check that wanted fade-up on hero Next is still wrong).
- Problem lines are visible immediately. Staged 1100ms hide/reveal is a blink. Keep the four lines. Do not hide them.
- `prefers-reduced-motion` already zeros onboard fade-up / scene-enter. The default path must be as stable as that reduced-motion end state for copy and CTAs.

Portal open / close (mask + content fade on first mount and on Get started) stays. That is one ceremonial pair, not a per-step flash.

### Second brain vault (HARD)

Name is fixed: `AI Second Brain`. Not "Métis Second Brain". Not a second Obsidian vault next to an existing one.

Probe, in order, and stop at the first readable hit:

1. Each `~/Library/CloudStorage/OneDrive-*/Documents/AI Second Brain` (skip `OneDrive-SharedLibraries-*` first, then any `OneDrive*`).
2. `{OneDrive root}/Documents/AI Second Brain` and `{OneDrive root}/AI Second Brain` (Windows env roots + `~/OneDrive`).
3. `~/Documents/AI Second Brain`.

A readable directory at that name is enough. Do not require `.obsidian` (the user may not have opened Obsidian on this machine). `readdir` must succeed. `ENOENT` is absent. `EIO` / `EBUSY` / `EPERM` / `ENOTCONN` on a present OneDrive path is **offline**, not absent.

Statuses:

| Status | UI | Persist | Create |
|---|---|---|---|
| `found` | "Using your AI Second Brain vault." Show the path. | Set `secondBrainVaultPath` to that path. | Never. That vault is the source of truth. |
| `not-found` | Offer to create at the preferred typical path (OneDrive Documents when OneDrive is actually available, else `~/Documents/AI Second Brain`). | Only after the user accepts. | mkdir that path plus `00_Inbox/from-dust/`. Nothing else. |
| `offline` | Honest: OneDrive is not available. Retry. | Do not write a path. | Do not mkdir. Do not fall through to a local fake vault. |

Retry re-runs the same probe. Skip the tour still uses a found vault (detect on mount / finish). Skip does not create. Continue past setup while offline leaves `secondBrainVaultPath` empty.

Do not point `meetingsFolder` at the vault. Encrypted transcripts stay in the meetings folder. The vault is the second-brain home for Dust inbox notes. Do not invent a parallel vault for those notes.

### Defaults

| Key | Default | Notes |
|---|---|---|
| `secondBrainVaultPath` | `''` | Set only when found or user-created. |
| `dustWriteToVault` | `true` | Inbox relative path is `00_Inbox/from-dust`. Devon owns the Dust / Claude CLI writer. This slice only locks the flag and path. |
| Reagan / writer | — | There is no Reagan product or writer setting in this repo. Do not add one. |
| `publishBrainPages` | `false` | Existing lock (QA #9). Wiki pages are Dust-readable **when** published. Do not derive ON from encryption or from this vault map. |

Settings → Brain may show the vault path, Retry, Create, and the Dust write-in toggle. Same honesty rules.

### Files

| Path | Role |
|---|---|
| `docs/design/DESIGN.md` | this section (written first) |
| `src/main/second-brain-vault.ts` | probe / preferred path / inbox join (no Electron UI) |
| `src/shared/ipc.ts` | settings + detect/create IPC |
| `OnboardingExperience.tsx` | stable tour + vault row |
| `styles.css` | no-flash onboard rules + reserved slot |
| Settings Brain | path + retry + write-in toggle |

Off limits: `src/main/island/geometry.ts`, hide park, cursor-watch, `BAR_MIN_HEIGHT`, Dust/Claude CLI write implementation, pack, merge.

### Tests (must pass)

1. Primary onboard CTAs have no `fade-up` class. Tests must not require fade-up on those CTAs.
2. Onboard copy / setup rows / problem lines do not use fade-up that starts at opacity 0.
3. Vault detect: found / not-found / offline (OneDrive unreadable ≠ create). Preferred create path. Inbox path is `00_Inbox/from-dust`.
4. `dustWriteToVault` defaults true on schema + `DEFAULT_SETTINGS`.
5. `publishBrainPages` stays false by default (existing lock).

### Quality

Apple-grade. If a hat would reject a blinking tour or a fake vault, fail the round. No em dashes in user-facing copy. Never auto-send. Do not claim READY TO MERGE.

## Onboarding close-audio + CTA visible from start

Tony, 1 Sep 2026 5:03pm ET. Two live bugs. Overlay hide/island frozen. No pack. No EXE/DMG/native. Do not merge. READY TO MERGE stays no.

### Close audio (HARD)

The Goldberg Aria (and any Howl / HTMLAudioElement / portal bed that plays the tour) **stops the instant onboarding closes**. Fail-closed. Every close path ends playback: dismiss, finish (Ready Get started), skip Get started, Escape, overlay hide of the exclusive tour, React unmount, `visibilitychange` hidden, `pagehide` / `beforeunload`.

`stop()` / `haltOnboardingAudio` must `pause()`, reset `currentTime` to 0, zero volume, clear `src`, `load()`, and set `autoplay` / `loop` false. No leftover loop after the stage is gone. Scene changes do not stop the bed. Mute still zeros. Overlay Island / CLI Connect / pack stay off limits.

### Post-lady Continue always visible (HARD)

After the first lady (Act 1 hero video) the next act is the space / starfield problem step. Continue and every required click target on that step are **on-screen and readable from first paint**. No `opacity: 0`, no hover-to-reveal, no pointer-events-only fade, no `animation-fill-mode: both` that starts hidden, no framer-motion `initial: { opacity: 0 }`.

Real cause to fix (not just the hover hypothesis): the Starfield Close canvas is `position: fixed; z-index: 0` with an opaque clear. In-flow tour chrome sits in a lower paint layer, so Continue is behind the bed until `:hover { transform }` promotes a compositor layer. Required: `.onboard-tour-slot` and `.onboard-cta` are `position: relative`, `z-index` above the bed, `opacity: 1`, `pointer-events: auto`. Hover may scale. Hover must not be the reveal.

Do not make other steps worse. Persona tiles and later Continues stay full-opacity from their first paint too (no pop-in that starts at opacity 0).
