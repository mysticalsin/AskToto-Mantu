---
project: Métis
goal: A faithful look-and-feel clone of Cluely (AI desktop overlay assistant), rebranded Métis.
reference: /Users/tony/Downloads/Cluely (New) 2.1.19.dmg  (Cluely v2.1.19, bundle id com.cluely.app.april22)
extracted_to: $TMPDIR/cluely_asar  (app.asar, read-only analysis)
status: ground-truth captured — pending scope confirmation, then PLAN -> BUILD loop
confidence_legend: [V]=verified from binary  [A]=assumed/inferred  [?]=unknown
---

# Métis — Cluely Look-and-Feel Spec (reverse-engineered ground truth)

## 1. What Cluely is (the thing we clone)
A frameless, transparent, always-on-top **AI overlay** that floats over every app and is
**invisible to screen-recording/screen-share**. Three core actions:
- **Ask** — type "Ask anything" / screenshot the screen → streamed AI answer (markdown). [V]
- **Listen** — live system + mic audio transcription → real-time AI **Suggestions** for
  Meetings / Interviews / Sales calls, with a Transcript view. [V]
- **Capture** — screenshot the current screen and feed it to the AI. [V]
Plus: Settings, Hide, Scroll, "undetectability". Brand mark = incognito glasses. [V]

## 2. Window / overlay behaviour  [V — from dist-electron/main.js]
- `frame: false`, `transparent: true`, `alwaysOnTop: true` (screen-saver level),
  `hasShadow: true`, `skipTaskbar: true`, `hiddenInMissionControl: true`,
  `setContentProtection(true)` (the "undetectable" feature — excluded from capture),
  `setVisibleOnAllWorkspaces`, `movable`, click-through via `setIgnoreMouseEvents`.
- `titleBarStyle: "hidden" / "hiddenInset"`.
- Window geometry (px): main bar height **38**; main panel **width 690** (min/maxWidth 690,
  height 670, min/maxHeight 670); secondary widgets 163 / 320 / 360 wide; onboarding 1100x720.
- Global hotkeys: **Cmd+Enter** ask, **Cmd+H** hide, **Cmd+Q** quit, **Cmd+R** reset/new,
  **Cmd+arrows** move window / scroll panel, **Cmd+Shift+…** toggle, **Tab** cycle. [V]

## 3. Tech stack of the original  [V — package.json + bundle]
Electron + Vite + React + **TanStack Router** + **Base UI** (@base-ui-components/react) +
**Clerk** (auth) + **Tailwind** (inlined, no standalone css) + **Lucide** icons +
**Geist** (UI) & **Inter** fonts + **Shiki** (code) + **KaTeX** (math) + **Mermaid** (diagrams)
+ **streamdown** (streaming markdown) + **zod**. Audio capture: **node-record-lpcm16**.
electron-updater (Squirrel.Mac), electron-log.

## 4. Visual language  [V tokens + A composition]
- **Dark translucent glass**: backdrop-blur (sm / md / 2xl / [8px]), black tint ~`#00000030`,
  thin white border (`border-white/…`), heavy use of **`rounded-full`** pills for the bar.
- Fully transparent page background (`#00000000`); the only visible surfaces are the glass bar
  and the answer panel floating beneath it.
- Typography: **Geist** for UI chrome, **Inter** for body; answers render as rich markdown
  (Shiki code blocks w/ gruvbox/catppuccin/material themes, KaTeX math, Mermaid diagrams).
- Layout: a centered horizontal **pill bar** docked near top-of-screen → expandable **answer /
  transcript panel** (690px) drops below it. Buttons: Ask input, Listen, Capture, Settings, Hide.

## 5. Métis target (our build)
Recreate §2/§4 pixel-faithfully; rebrand to **Métis** (own name + own constellation mark, NOT
Cluely's logo/trademark/assets). AI = Claude (Anthropic) — "Ask Toto". Scope of v1 decided next.

## 6. Build approach
Electron + Vite + React + Tailwind + Base UI + Lucide + Geist/Inter + streamdown/Shiki/KaTeX.
Frameless transparent always-on-top BrowserWindow with content-protection. WALTEUR loop:
PLAN -> (Codex adversarial review) -> parallel build waves -> QA panel -> fresh-Opus audit -> refine.

## 7. Legal note
Clone the *look & behaviour*; do NOT ship Cluely's source, logo, name, or copyrighted assets.
Own branding + own implementation only.
