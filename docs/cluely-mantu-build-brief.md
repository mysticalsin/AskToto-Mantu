# AskToto → Cluely-grade UI, Mantu-branded — Build Brief

**How to use this file:** open a fresh Claude Code session **inside the AskToto repo root**, then paste this whole document as your first message. It is self-contained: it names the real files, the design tokens that already exist, the things you must NOT break, and the work split into verifiable packages. Do the packages in order. Stop and ask before any step marked **CONFIRM**.

Companion visual map (context, optional): the Cluely teardown mind-map artifact (4 surfaces, built from two screen captures).

**Headline finding:** AskToto already ships ~85% of Cluely's surface area — including the entire history/recall layer (`RecallView`, `Review`, `recall.ts`). This is a **cohesion + recolor** job, not a rebuild. Match Cluely's shell and Mantu's palette; don't reinvent working features.

---

## 0. What we're doing (and what we're NOT)

We are making AskToto's overlay + settings **look and behave like Cluely** across its four surfaces (floating ask bar → drop-down chat panel → history/recall layer → two-pane settings window), **recolored to Mantu purple**, **without losing AskToto's differentiators**.

This is **not** a rewrite. AskToto already has the hard parts: a glass overlay bar, a real streaming chat engine, editable per-mode system prompts, multi-provider/CLI LLM routing, and a Mantu-purple token system. The job is mostly: **adopt Cluely's two-pane settings shell, polish the chat-panel anchoring, and add a few context affordances** — while preserving everything below.

---

## 1. Orient before touching anything

Read these first (do not edit yet):

| File | What it is |
|---|---|
| `src/renderer/src/styles.css` | Design tokens. `@theme` block = overlay (`--color-accent`, `--glass-*`). `:root` block = settings window theme (`--cl-*`). **Use these. Invent no new colors.** |
| `src/renderer/src/components/Bar.tsx` | The floating ask bar (the glass pill). ~288 lines. |
| `src/renderer/src/components/Copilot.tsx` | The chat / response surface that renders answers. |
| `src/renderer/src/components/Settings.tsx` | The full settings window (~2800 lines). Single-scroll today. |
| `src/renderer/src/components/ModePicker.tsx` | `ModeIndicator` (read-only badge on overlay) + `ModePicker` (used in Settings). |
| `src/renderer/src/components/QuickActions.tsx` | The text-option chips under the bar (Tony's feature — preserve). |
| `src/renderer/src/state.ts` | `useAsk` (streaming lifecycle), `useSettings`, `useAuth`, `usePermissions`, `useAutoResize`. |
| `src/shared/prompts.ts` | `DEFAULT_MODE_PROMPTS` — one editable system prompt per mode. |
| `src/shared/ipc.ts` | `ConversationMode`, `AskMode`, `PublicSettings`, `SettingsPatch` types. |
| `src/main/index.ts` | Window lifecycle + global shortcuts. |
| `src/main/store.ts` | Persisted settings (incl. `modePrompts`). |
| `src/renderer/src/components/RecallView.tsx` | History/search surface: "Search past meetings…", `recallSearch`/`recallList`, graph. = Cluely's meeting-list. |
| `src/renderer/src/components/Review.tsx` | Recap detail: `groupByDate`, summary, Copy, transcript toggle (`showTranscript`). = Cluely's recap + transcript. |
| `src/renderer/src/components/AgendaView.tsx` | Calendar/agenda view. |
| `src/main/recall.ts` | `listMeetings()` / `searchMeetings(query)`. |
| `src/main/transcripts.ts` | Save/encrypt meetings, OneDrive folder, recap export. |
| `src/main/calendar.ts` | `calendarToday(tz)`. |
| `src/renderer/src/components/MantuLogo.tsx` / `MantuMark.tsx` | Brand lockup + "M" mark assets. |

Architectural note from `useAutoResize` (state.ts): the transparent overlay window **hugs its content height**. The root alternates between the bar `<div>` and full-window branches (Settings / onboarding / sign-in) that unmount/remount. Any new Settings shell must live in that full-window branch and not fight the resize observer.

---

## 2. The Mantu rebrand rule (80% of the look)

Cluely's identity is **charcoal + electric cyan (#0099FF–#00D9FF)**. The single highest-leverage change: **every cyan element → Mantu Bright Purple `#7F00DA`** (toggle-on, active nav, links, ✓ marks, primary buttons, badges). These tokens already exist:

| Role | Token | Value |
|---|---|---|
| Overlay accent | `--color-accent` | `#7F00DA` |
| Overlay bright accent (caret, active icon, chevron) | `--color-accent-2` | `#A64DFF` |
| Overlay glass fill | `--glass-fill` | `rgba(34,14,60,.6)` |
| Settings shell bg | `--cl-bg` | `#14012A` |
| Settings content pane | `--cl-background` | `#1A0033` |
| Settings raised card | `--cl-card` | `#291050` |
| Settings primary | `--cl-primary` | `#7F00DA` |
| Settings ring / toggle-on | `--cl-ring` | `#9A4DFF` |
| Muted text | `--cl-muted-foreground` | `#CDBFE3` |
| Danger | `--color-danger` | `#F0717A` |

Rules: white bright text on glass; **no yellow anywhere**; Mantu logo via `<MantuLogo/>` / `<MantuMark/>`, never a text wordmark.

---

## 3. DO NOT break or rebuild these (guardrails)

These are working AskToto features. Preserve their behavior; you may restyle them to match Cluely, but do not delete, replace, or regress them:

1. **Streaming chat engine** — `useAsk` in `state.ts`: first-token sync flush, per-RAF batching, `retry()`, `deeper()` ("Go deeper"), `cancel()`, `clear()`, vision (`image`), `transcript`, `history`, `depth`. Reuse it; don't reinvent.
2. **Mode system** — `ConversationMode` (interview/meeting/sales/negotiation/presentation/support/general) with **editable system prompts** in `DEFAULT_MODE_PROMPTS`, overridden per-user in `settings.modePrompts`, edited in **Settings → Personalize**. This is already Cluely's "Modes" mechanism.
3. **`QuickActions`** chips under the bar (What to say next / Fact-check / Explain / Summarize screen) — Tony's feature. Keep them.
4. **Multi-LLM + CLI routing** — Settings sections for: Model provider + encrypted keys, CLI Integration (`claude-cli`, `codex-cli`), Dust ("your brain"), Audio source (You / Them / Both), Thinking mode (tiered routing). These are AskToto's differentiator. Keep every one.
5. **History / recall / meetings layer** — `RecallView.tsx` (search), `Review.tsx` (date-grouped recap + transcript), `recall.ts` (`listMeetings`/`searchMeetings`), `transcripts.ts`, `calendar.ts`. This is Cluely's entire "History" surface, already built. **Restyle only — do not touch the data layer.**
6. **Mantu token system** in `styles.css` — extend, never fork into new hardcoded hexes.

If a change would remove or hollow out any of the above, **stop and ask**.

---

## 4. CONFIRM with Tony before building (real decisions, not defaults)

Cluely's design conflicts with choices Tony already made. Do not silently override them — surface each and get a yes:

- **CONFIRM-1 — Mode switching location.** Cluely puts a mode dropdown **on the bar**. AskToto deliberately does the opposite — the code comment says *"the mode can only be changed in Settings → Personalize (Tony: no mode switching directly on the platform)."* **Default: keep Settings-only.** Only add a bar dropdown if Tony says so.
- **CONFIRM-2 — Custom modes + files.** Confirmed from the second capture: Cluely ships ~12 presets (General, Interview, Behavioral, Coding, System Design, Case Interview, Recruiter Screen, Team Meet, Lecture, Sales, Recruiting, Default), each with an editable "Meeting context" prompt **and a per-mode drag-&-drop file uploader** (native file picker; "Adding files gives more context"), plus "+ New Mode" / Delete. AskToto has 7 fixed modes with editable prompts and no file attach. **Default: keep the 7 fixed modes** and just make the Personalize editor feel like Cluely's. Add "+ New Mode" + per-mode file upload only if Tony wants it — that's real work (store schema + IPC + file-context assembly into the prompt), not a recolor.
- **CONFIRM-3 — Tabs to skip.** Cluely ships Billing, Security (devices/password), Undetectability, Calendar, Notifications. **Default: skip Billing, Security, Undetectability** (don't apply). **Keep Calendar + Notifications** — they're real for AskToto (you have `calendar.ts`) and are scoped in WP6.

---

## 5. Work packages (do in order; verify after each)

### WP1 — Settings two-pane shell (highest visual payoff)
**Goal:** turn the single-scroll `Settings.tsx` into Cluely's shell: a top icon-tab bar + a left sub-nav + a scrollable right content pane, on a solid `--cl-bg` window (not glass).
**Keep:** every existing section (Personalize, Model provider, CLI Integration, Dust, Audio, Thinking mode). You are **reorganizing them into tabs**, not removing them.
**Suggested tabs:** `Personalize` (modes), `AI` (provider + keys + CLI + Dust + thinking mode), `Audio`, `Calendar` (WP6), `Notifications` (WP6), `Keybinds` (WP4), `About`. Section→row(label + sub-text + control) rhythm, like Cluely.
**Style:** active tab/nav item uses `--cl-primary`; toggles use `--cl-ring` when on; muted copy `--cl-muted-foreground`; cards `--cl-card`. Mantu mark top-left where Cluely shows its logo.
**Acceptance:** all prior settings still reachable and functional; window themed purple; no new hardcoded colors; `useAutoResize` still hugs the window.

### WP2 — Personalize page feels like Cluely "Modes"
**Goal:** make the mode editor read like Cluely's Modes pane: left list of modes (active one marked with a purple ✓), right pane = the selected mode's **editable system-prompt textarea** (this maps to `settings.modePrompts[mode]`, falling back to `DEFAULT_MODE_PROMPTS`), with a clear "active mode" control and a "reset to default" affordance per mode.
**Respect CONFIRM-1 / CONFIRM-2:** no bar dropdown, no create/delete, no file upload unless approved.
**Acceptance:** editing a mode's prompt persists to `settings.modePrompts` and changes the live system prompt; switching active mode updates `ModeIndicator`.

### WP3 — Chat panel anchoring + context affordances
**Goal:** make the ask→answer flow read like Cluely.
- The bar **does not move** on submit; the answer panel grows directly below it from the same top-center origin (reuse `useAsk`/`Copilot.tsx`; this is layout, not new logic).
- **Context-aware placeholder** on the bar, derived from state: idle → "Ask anything about your screen"; live session → "Ask anything about the meeting"; after first answer → "Ask a follow-up…". (Derive from existing session/answer state; add no new persisted state.)
- **"Viewed screen" context chip** with a purple live dot when an `image`/`transcript` was attached to the ask — shows what context the model used. (`useAsk` already carries `image`/`transcript`; just surface it.)
- Keep `QuickActions` chips and the existing "Go deeper" / Copy / retry controls.
**Acceptance:** submit doesn't shift the bar; placeholder changes with state; chip appears only when context was sent; QuickActions + Go-deeper still work.

### WP4 — Keybinds tab + global shortcuts
**Goal:** a Cluely-style Keybinds page listing shortcuts, backed by real global shortcuts in `src/main/index.ts`. **Exact bindings from the capture:** toggle visibility `⌘⇧C`, ask about screen/audio `⌘⇧J`, new chat `⌘⇧N`, open settings `⌘⇧,`, start/stop session `⌘⌃K` / `⌘⌃L`, move window `⌘⇧↑ ↓ ← →`. Editable rows are nice-to-have; a correct read-only list wired to working shortcuts is the floor.
**Acceptance:** each listed shortcut actually fires its action.

### WP5 — History / recall shell (data already exists)
**Goal:** give AskToto's recall layer Cluely's "History" look. **Restyle + reorganize only — do not change the data layer.**
**Files:** `src/renderer/src/components/RecallView.tsx` + `Review.tsx`; data via `src/main/recall.ts` (`listMeetings`/`searchMeetings`) + `transcripts.ts`.
- Entry point: an "Ask or search anything" field that searches past meetings (`recallSearch`) and can start an ask. Purple focus ring.
- Meeting list: keep `Review.groupByDate`; render date headers + rows as `title · duration/status · time`, with an "Analyzing" purple badge while a session processes. Add a "Connect your calendar" CTA row when no calendar is linked.
- Recap detail (`Review.tsx`): title · date · summary + "Copy Summary" (purple) · Discussion bullets · "Show Transcript" disclosure (already supported) · add a **"Resume session"** primary button that re-enters that saved meeting as a live session.
**Acceptance:** search + list + recap + transcript still work; styled to match; "Resume session" re-enters a session.

### WP6 — Calendar connect + meeting notifications
**Goal:** Cluely's Calendar + Notifications behavior.
- **Calendar** (Settings → Calendar + the History CTA): "Connect your calendar" runs Google OAuth and, once linked, drives the UPCOMING list. Build on `src/main/calendar.ts` (`calendarToday`) and `AgendaView.tsx`; **reuse AskToto's existing auth (`src/main/auth.ts`)** rather than adding a new OAuth stack if possible.
- **Notifications** (Settings → Notifications): a "Scheduled meetings" toggle — "Show a notification 1 minute before meetings start based on your Calendar." Fire a native Electron notification from main on a calendar-derived timer; gate on the toggle (persist in `store.ts`).
**Acceptance:** linking a calendar populates upcoming meetings; the toggle controls a real 1-minute-before notification.

---

## 6. Verification gate (per package — no "looks right")

Run and show output before claiming a package done:

```bash
npm run typecheck && npm test
```

(`vitest`; there is no lint gate.) For UI behavior, drive the **built** app with the existing Playwright `_electron` QA harness (sandbox off, real onboarding flow) — do not assert UI works from the diff alone. Per-turn mode/context must flow as **`userText`**, never by rebuilding the cached system prompt (prompt-cache rule).

---

## 7. Honest scoping — what is NOT a recolor

- **Screen-capture context** ("Viewed screen"): the capability exists (`useAsk` takes `image`/`transcript`); WP3 only surfaces it. Building *new* capture is out of scope unless asked.
- **Undetectability / Billing / Security devices:** real features, mostly N/A to AskToto — skip per CONFIRM-3.
- **Custom modes + per-mode files:** real schema/IPC work — only if CONFIRM-2 says yes.

Branch off `main` (or the current feature branch), one logical change per commit, and keep the diff to the packages above. When done, summarize what changed, what was skipped, and the test output.
