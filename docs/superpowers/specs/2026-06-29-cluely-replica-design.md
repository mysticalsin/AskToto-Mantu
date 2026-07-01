# AskToto — Cluely-replica in-call widget (Mantu branding)

> Design spec. Date 2026-06-29. Branch `feat/ux-fixes-models-cli-integration`.
> Grounded in: live CDP capture of Cluely v2.1.19 (`/#/chat` widget) + its extracted source, and a 15-agent
> code-map/design/adversarial-review pass over AskToto. Feasibility-review corrections folded in.

## Goal

Replace AskToto's stacked in-call UI (Bar + toasts + mode badge + suggestion card + always-on button row +
transcript) with **one Cluely-style hero widget**: a long, sleek, dark **deep-purple** glass bar — a
**"Ask anything about your screen"** input on top, a minimal toolbar below (Mantu mark bottom-left, screen /
stealth / mode / listen, History right), and the answer streaming **replace-in-place**. Behave exactly like
Cluely; brand it Mantu; then out-do it on transparency, fact-check, and privacy.

## What Cluely actually is (captured)

Main widget route `/#/chat`, **690×104**, dark glass `rgba(9,14,15,.68)`, **18px** radius, Geist font, two rows:
- **Row 1 (hero input):** large placeholder "Ask anything about your screen" + rounded ↵ submit (textarea ~570×56). Submitting runs an AI ask that **uses the screen** (a "Uses Screen" indicator).
- **Row 2 (toolbar):** circular brand **logo bottom-left** · center = screen-capture / 👁 stealth / ⠿ mode / divider / ∿ listen · right = **History** + ▾ chevron.
- Answer streams **in place** above the input (single hero, replace-in-place). Transcript hidden by default; notes post-call.
- A separate tiny **control pill** (`/#/control`, 163×50): logo · ✕ Hide · 🎤.
- Heavily **hotkey-driven**: `⌘⏎` ask, `⌘⇧⏎` silent, `⌘↑/↓` scroll, `⌘R` reset, `⌘H` hide. Always-on-top, content-protected.
- Stack: React + Tailwind v4 + base-ui + streamdown + Lucide + **Geist** — identical to AskToto, so it ports cleanly.

## Branding (Tony's decisions, locked)

- **Mantu "M" mark bottom-left** (real `MantuMark` / `assets/mantu-mark.jpg`), circular. **Hovering/overlapping it reveals "⚙ Settings"** and opens the Settings view (Cluely's logo→dashboard behaviour).
- **Deep-purple glass instead of near-black**; accent **`#7f00da`** on the submit pill, active toolbar icons, and the History chevron. Keep Geist.
- **Long + sleek** proportions: idle widget ≈ **720–760 wide × ~110–155 tall** (slim two rows), not chunky.

## Architecture

Three new renderer components replacing the `Bar` + `Panel` primary surface (secondary Panel for
Settings/History/Review/Agenda stays, rendered below the shell):

- **`WidgetShell.tsx`** — one `.glass` vertical column (18px): `[HeroAnswer scroll region]` over `[hairline divider, only when an answer exists]` over `[HeroInput]` over `[Toolbar]`. Owns the window-drag (excluding the textarea + the scrollable answer so selection/scroll don't drag the window).
- **`HeroInput.tsx`** — auto-grow textarea, placeholder "Ask anything about your screen", `onFocus → prewarmCapture()`, `Enter → submit` / `Shift+Enter → newline` / `⌘⏎ → text-only escape hatch`, solid accent ↵ submit pill (X while streaming).
- **`Toolbar.tsx`** — Mantu mark (→ Settings on hover) + rec dot · center `[Camera capture + "Uses screen" badge][Eye/EyeOff stealth + "Detectable" badge][⠿ mode][| ][∿ listen]` · right `[History][▾ chevron]`. A "More" overflow re-homes Settings/Agenda/Think/Quit so nothing regresses.

`Answer.tsx` loses its centering/idle wrappers (idle = just the hero input); keeps streaming/error/verdict/footer.
`Copilot.tsx` keeps the suggest hook untouched; only its **presenter** moves into the hero Answer slot.

## "Ask anything about your screen" — wiring (zero new capture/IPC)

The hero submit reuses the **existing** vision path: `askScreen(prompt)` (App.tsx:285-304) →
`window.toto.capture()` (IPC `capture:screen`, `requireAuth`) → `ask.run({mode:'vision', image, prompt})` →
vision provider routing + `VISION_GUARD` (inline, llm.ts) + `INJECTION_GUARD` (system, personas.ts) →
streamed `onDelta`/`onDone`. No new IPC, no new capture code.

- New persisted setting **`screenAsk` (default true)** = Cluely's "Uses Screen" model; new derived
  **`visionReady = providerReady && PROVIDERS[provider].vision`** in `publicSettings()`.
- `submit()` router: `listening` → unchanged copilot suggest; `screenAsk && visionReady && !listening` →
  `askScreen(q || "Help me with what's on my screen.")`; else → text-only `ask.run({mode:'answer'})`.
- **Capture is NOT gated on stealth.** Stealth (`setContentProtection`) hides the *overlay from others'
  screen-share*; capturing *your own* screen for a vision answer is the feature itself — orthogonal. (Rejecting
  the review's "skip capture when stealth" note as a category error.)
- `askScreen()` **returns the `ask.run` id** so Retry / Go-deeper replay the same screenshot.

## Hotkeys (Cluely grammar, on the existing globalShortcut pipeline)

Accelerators use **`CommandOrControl+…`** (not "Cmd+…" — that fails `globalShortcut.register()` silently):
`CommandOrControl+Enter` screen-ask · `CommandOrControl+Shift+Enter` silent (no chime) · `CommandOrControl+H`
hide · `CommandOrControl+R` reset · `CommandOrControl+Shift+L` listen · `CommandOrControl+Shift+F` fact-check ·
`CommandOrControl+Up/Down` scroll the answer.
- **Global set** (ask / silent / hide / listen / capture / factcheck) registered app-lifetime; **overlay set**
  (reset / scroll) registered only while visible (`win.on('show'/'hide')`) so they don't steal `⌘R`/arrows
  from other apps. Re-apply after every `unregisterAll()` (load-bearing). No second window — fold the control pill into the bar.
- `register()` results are checked; persistent failures surface a toast.

## Improvements over Cluely (woven in, no extra toolbar buttons)

1. **Model/cost chip** — footer line showing auto-routed provider · model · tier (+ tokens; `$` only behind a flag via `src/shared/pricing.ts`, default tokens-only so no stale prices). Cluely hides this.
2. **Honest dual-intent + source chip** — `Enter` = text, `⌘⏎` = screen; a "Screen/Text" chip shows which ran.
3. **One-key screen-grounded fact-check** — `⌘⇧F` → color verdict pill in the same hero; empty input fact-checks the most prominent on-screen claim (Cluely can't see the screen).
4. **Inline Go-deeper + Retry** — expand/replay the one answer in place (deeper is per-turn so it never busts the prompt cache; retry replays the exact image).
5. **Single-surface live copilot** — our faster THEM-question endpointing routed through the same Answer slot, transcript hidden.
6. **Offline-private posture** — recolor the rec dot when Parakeet on-device ASR + content-protection are both on ("Private · on-device") — only during Listen.
7. **Structured recap JSON export** — kept on the post-call Review surface (Jira/Asana/Notion).
8. **Resize-jitter fix** (correctness): asymmetric grow-now / shrink-after-settle + idempotent `resizeTo()` + a height cap on the *observed* element → kills per-token window pumping and today's long-answer clipping.

## Phases (each independently shippable)

1. **Foundation** — deep-purple glass tokens + shadows (styles.css), resize-jitter fix (state.ts `useAutoResize` + idempotent `resizeTo`), `BAR_HEIGHT 64→~110`, `ui.tsx` solid submit variant, `MantuMark` `round` prop. No behaviour change.
2. **Screen-ask router** — `screenAsk`/`visionReady` (ipc.ts + publicSettings), `submit()` router, interim "Screen" toggle pill in today's Bar.
3. **WidgetShell + Toolbar** — the three new components; collapse Bar+Panel into the one widget; answer replace-in-place; mode row inline; "More" overflow re-homes dropped controls.
4. **Hotkey grammar** — the `CommandOrControl` set, global vs overlay registration, `askScreen` returns id, answer scroll.
5. **Differentiators** — IMP1–7 inside the hero/Answer/footer/post-call surfaces.

## Risks / review corrections folded in

- `contentProtection` can silently no-op on macOS (no getter) → the "Detectable/Private" badges **mirror the
  setting**, never assume the toggle succeeded; tooltip notes "may not hide on all systems."
- `visionReady` is recomputed in `publicSettings()` and refreshed on settings/provider change; non-vision
  provider → toggle disabled, submit falls back to text.
- Answer-scroll cap and `useAutoResize` must agree: cap the **observed element** so the window stops growing
  and the inner region scrolls (don't fight each other).
- Global `⌘⏎`/`⌘⇧L` are app-lifetime (intrinsic to always-on summon) — accepted Cluely tradeoff; rebind UI optional.
- IMP5 (re-route live suggestion to the Answer slot) is highest blast radius → swap the **presenter only**, leave the suggest hook/TTL/history effects untouched.

## Open decisions for Tony

1. **Answer placement:** faithful Cluely **answer-above-input** (input drifts down as it grows) vs the improvement **answer-below-input** (input stays put)?
2. **Mode 4-dot:** make it an **interactive** mode switcher (reverses the current "no mode-switching on platform" decision) or **read-only** + "Change in Settings"?
3. **Dropped controls** (Settings/Agenda/Think): "More" overflow menu vs mode-row footer vs hotkeys-only?
4. **BAR_WIDTH:** narrow `860→720` for true Cluely proportions (needs Settings/History panels to reflow) or keep `860`?
5. **Cost chip:** ship the `$`-per-call estimate (behind a flag) or tokens-only?
6. **`screenAsk` default true** (every idle Enter screenshots, cheap via prewarm) — confirm screen-aware-by-default.
