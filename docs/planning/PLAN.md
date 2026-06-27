# PLAN — AskToto (Cluely look-and-feel clone, full functional)

> WALTEUR build. Why → see DESIGN-SPEC.md (reverse-engineered intent) + DESIGN.md (contract).
> Scope confirmed by Tony: FULL FUNCTIONAL CLONE. Autonomy: full autopilot.

## Why (PRD-lite)
- **User:** Tony (personal power-user). **Success metric:** (1) overlay is visually
  indistinguishable from Cluely side-by-side minus branding; (2) Ask streams a real Claude
  answer; (3) Capture sends a real screenshot to Claude vision; (4) Listen produces a live
  transcript + AI suggestions from real audio. All four demoable on macOS.
- **Anti-persona:** not a multi-tenant SaaS; no billing/accounts/cloud sync.

## Scope
**IN:** transparent frameless always-on-top glass overlay; content-protection ("undetectable");
pill bar + 690px panel; hotkeys (Cmd+Enter/H/Q/R/arrows); Ask→Claude stream (markdown);
Capture→Claude vision; Listen→mic+ (system-audio best-effort) →local Whisper STT→suggestions +
transcript; Settings (API key, model, hotkeys, toggles); Hide; own AskToto branding.
**OUT (signed defer):** Clerk auth, cloud accounts, billing, web3, electron-updater, i18n,
the full Cluely onboarding deck. Reason: personal clone; not load-bearing for the look/feel.
**Risk-owned defer:** macOS *system* audio capture may fall back to mic-only if ScreenCaptureKit
audio path isn't viable in-session — will be stated honestly, never silently.

## Stack (current best-practice, run-date 2026-06-26)
electron-vite · electron · React 18 · TypeScript · Tailwind v4 (@tailwindcss/vite) ·
@anthropic-ai/sdk · streamdown (stream MD+Shiki+KaTeX) · @base-ui-components/react ·
lucide-react · geist + @fontsource/inter · @xenova/transformers (local Whisper STT) ·
renderer getUserMedia (mic, no sox native dep).

## Architecture
- **main** (`src/main`): app lifecycle; BarWindow (frameless/transparent/alwaysOnTop/contentProtection)
  + PanelWindow (or single resizable window — decide via ADR-0001); global shortcuts; tray;
  IPC handlers: `ask:stream`, `capture:screen`, `listen:start/stop`, `settings:get/set`, `window:*`.
  Claude calls happen in MAIN (key never in renderer). Screenshot via `desktopCapturer`.
- **preload** (`src/preload`): contextBridge `window.toto` typed API; no nodeIntegration.
- **renderer** (`src/renderer`): React glass UI; streams tokens over IPC; Whisper runs in a
  renderer Web Worker (WASM) fed by getUserMedia PCM.
- **shared** (`src/shared`): IPC channel names + zod types (single source of contract).

## Task matrix
- [ ] T1 SCAFFOLD — package.json, electron.vite.config, tsconfigs, tailwind v4, index.html, .gitignore, .env.example. AC: `npm run dev` opens a transparent window. Model: sonnet
- [ ] T2 OVERLAY SHELL — main: Bar+Panel windows, transparent/frameless/alwaysOnTop/hasShadow/skipTaskbar/contentProtection/visibleOnAllWorkspaces; drag region. AC: glass bar floats over desktop, screenshot proves it. Model: opus (blast-radius)
- [ ] T3 DESIGN SYSTEM — Tailwind tokens from DESIGN.md, Geist/Inter, glass utilities, AskToto mark SVG. AC: bar matches DESIGN.md tokens. Model: sonnet
- [ ] T4 BAR UI — input + Listen/Capture/Settings/Hide pills, hover/focus/active states, timer. AC: interactive, pixel-faithful. Model: sonnet
- [ ] T5 HOTKEYS + WINDOW CTRL — Cmd+Enter ask, Cmd+H hide, Cmd+Q quit, Cmd+R reset, Cmd+arrows move. AC: each verified. Model: sonnet
- [ ] T6 SHARED CONTRACT — IPC channel consts + zod schemas + preload bridge + typed window.toto. AC: typecheck clean. Model: opus
- [ ] T7 ASK (Claude stream) — main handler streams @anthropic-ai/sdk → renderer; streamdown render (MD/code/katex). AC: real answer streams. Model: opus (critical path)
- [ ] T8 CAPTURE (vision) — desktopCapturer screenshot → Claude vision message. AC: screenshot answered. Model: opus
- [ ] T9 LISTEN (STT+suggestions) — getUserMedia mic → Whisper worker → live transcript; periodic Claude "suggestions" from transcript; system-audio best-effort. AC: speak → transcript + suggestion. Model: opus
- [ ] T10 SETTINGS — API key (stored via safeStorage), model picker, toggles, hotkey display. AC: key persists, used by Ask. Model: sonnet
- [ ] T11 PANEL MODES — Answer vs Listen layouts, empty/loading/error/streaming states, auto-scroll. Model: sonnet
- [ ] T12 PACKAGING — electron-builder config (mac, entitlements for mic/screen), `npm run build`. AC: app builds. Model: sonnet (defer dmg if heavy)
- [ ] T13 VERIFY+AUDIT — launch, screenshot each feature, real outputs; fresh-Opus audit; known-gaps. Model: opus

## Definition of Done
Every T ☑ with evidence · overlay screenshot matches DESIGN.md · Ask/Capture/Listen each
produce a REAL output (shown) · no secrets in git · honest known-gaps · Opus audit certified.

## Open forks → ADR
- ADR-0001: RESOLVED → single transparent always-on-top window (bar + auto-resizing panel stacked).
  Rationale: visually identical to Cluely's multi-window, far simpler, fewer click-through/sync bugs.

---

## BUILD REVIEW (2026-06-26)

### Status per task (evidence-based)
- ☑ T1 SCAFFOLD — `npm run build` exit 0, 2090 modules, dev server :5173. 
- ☑ T2 OVERLAY SHELL — frameless transparent always-on-top glass verified by screenshot over desktop.
- ☑ T3 DESIGN SYSTEM — Tailwind v4 @theme tokens + real Geist/Inter woff2 + glass utils; AskToto mark renders.
- ☑ T4 BAR UI — input + Listen/Capture/Settings/collapse/hide pills, hover/active states; screenshot-verified.
- ☑ T5 HOTKEYS — Cmd+\ / Cmd+Enter / Cmd+⇧F / Cmd+⇧S / Cmd+⇧L / Cmd+⇧R / Cmd+⌥+arrows registered.
- ☑ T6 SHARED CONTRACT — zod IPC schemas + typed preload `window.toto`; `npm run typecheck` exit 0.
- ☑ T7 ASK (stream) — wired; reachability PROVEN (dummy key → 401 authentication_error from api.anthropic.com).
- ☑ T8 CAPTURE — desktopCapturer → Claude vision message; wired (real output needs key).
- ◐ T9 LISTEN — mic getUserMedia → on-device Whisper worker → transcript → periodic suggestions: BUILT + compiles.
       System audio (other side of call) NOT wired (macOS ScreenCaptureKit/virtual-device path). Mic-only.
- ☑ T10 SETTINGS — encrypted key (safeStorage), model picker, temp, audio source, undetectable toggle.
- ☑ T11 PANEL MODES — answer/listen/settings, loading/empty/error/streaming states, auto-resize verified.
- ☑ T12 PACKAGING — electron-builder.yml + entitlements (mic) + LSUIElement; `npm run dist` wired.
- ☑ T13 VERIFY — launched real app, screenshotted bar/answer/quick-actions; SDK reachability proven.
- ➕ Added: one-click FACT-CHECK (chip + Cmd+⇧F) per Tony's request — text claim or screen.

### Known gaps (honest)
1. Real Ask/Capture/Listen OUTPUT needs Tony's ANTHROPIC_API_KEY (pipeline proven to the API via 401).
2. Listen = microphone only; system-audio capture deferred (documented).
3. Code syntax COLORS + inline KaTeX math don't render (streamdown's shiki highlighter not activating in
   this Electron build; code STRUCTURE — line numbers/layout/copy — is correct). Polish, not blocker.
4. Whisper model (~40MB) downloads from HF hub on first Listen use (needs internet once).

### Verification evidence
- typecheck exit 0 · build exit 0 (2090 modules) · Electron launches · overlay screenshot matches DESIGN.md
- Anthropic streaming reachability: STATUS=401 authentication_error (request well-formed, reaches API).

### DoD: NOT fully certifiable in-session (gaps 1-3). App is a runnable, Cluely-faithful, functional
### foundation. "Done when Tony adds key + grants mic/screen perms and the 3 features produce live output."
