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

---

# Mantu Intelligence dashboard (this slice)

Scope: the second-brain surfaces only. Overlay chrome, onboarding, portal, hero video, and PR 58
island/bar files stay frozen. Settings IA, Brain MCP logo-tap, and ASR are out.

Surfaces in this slice:
1. **Glance** (`BrainView`) — in-window Intelligence panel over `.brain/`.
2. **Record** (`BrainRecordPage`) — person / account / deal drill-down.
3. **History strip** (`RecallView` GraphBar + import meters) — the door into Intelligence.
4. **Meter** (`WorkProgressMeter`) — truthful index/import progress, shared by glance and History.
5. **Full window** (`intelligence/`) — the dedicated Mantu Intelligence dashboard.

## Hats
- **PM** — one logical change: visual + motion. No new IA, no new ingest, no auto-send.
- **Design** — original Métis copy. Taste of bklit charts, kokonut liquid glass, and motion.dev
  springs. Not a clone, not a component dump.
- **UX** — FACTUAL vs PREDICTIVE stays readable. Empty / loading / error are designed states.
  Status is icon + label + color, never color alone. Never invented percentages.
- **UI** — tokens only (`--color-ink`, `--color-accent-2`, glass, `--ease-spring`). Single-hue
  magnitude marks. No purple-gradient slop.
- **QA** — BrainView / BrainRecordPage / RecallView tests stay green. READY TO MERGE stays no
  until Devon Mac-shows the glance, the record page, and the full window.
- **Security** — no new network, no new IPC, no secrets. `motion` is MIT, pinned. bklit is a
  taste reference only (MIT); we do not vendor their source.

## Chart language (bklit taste, Métis marks)
Composable plot: Grid → Bar → XAxis → Tooltip. Thin marks, rounded data ends, recessive axes.
Magnitude is one hue (`--color-accent-2`). Zero columns are a faint track, not a fake value.
Hover/focus opens a real tooltip (week + meeting count). Selective direct labels stay on the
busiest week and this week only. Status colors (`success` / mixed amber / `danger`) are reserved
for state chips that also carry an icon and a label.

## Surfaces (kokonut craft bar)
Intelligence cards are **liquid glass**, not flat `bg-white/[0.02]` tiles:
- specular top-left sheen, hairline border, inset rim, soft lift
- same glass family as the overlay, but a card radius (`--radius-lg`), never a pill bar
- one accent, white-alpha type, dense chrome

Empty, loading, and error frames keep the page identity (title + standfirst) and say what is
missing or broken in product words. An empty Attention queue stays a quiet line: good news, not
a gap.

## Motion (motion.dev)
Enter: spring, compositor-class (`transform` / `opacity` only). Stagger on first paint, capped.
Hover lift on tiles is a short spring. No layout animation on polling content (status refresh
must not re-play the entrance). `prefers-reduced-motion: reduce` snaps to opacity-only or still.

`WorkProgressMeter` stays honest: fill = a real checkpoint. The moving pulse only means "alive".
Fill is a single mark hue plus a white specular, not a second purple.

## Copy
Métis voice. No em dashes in user-facing strings. Never identify as AI. Estimates stay marked
as estimates (time-saved card keeps `≈` and the word "estimate").

## Anti-slop
No rainbow charts, no invented win-rate percents, no card-in-card-in-card, no emoji UI, no
default shadcn purple gradient, no template dump from kokonut or bklit.
