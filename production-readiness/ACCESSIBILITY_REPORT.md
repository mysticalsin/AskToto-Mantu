# Accessibility Report (WCAG 2.2 AA) — AskToto

**Scope:** keyboard operability, visible focus, accessible names on icon-only buttons and `role="switch"`
toggles, contrast on the frosted-purple glass, `prefers-reduced-motion`, status-message live regions, images.
**Date:** 2026-06-27.

---

## Verdict (Gate 3 — Accessibility sub-area)

**FAIL (conditional) on one AA criterion; otherwise strong.** Most of the surface is genuinely accessible —
native semantics, visible focus rings, `role="switch"` toggles done correctly, comprehensive `aria-live`
regions, and (contrary to the prior audit note) a working global `prefers-reduced-motion` override. The
blocker is **1.4.3 Contrast (Minimum)**: white body text on the default 44%-opacity translucent glass cannot
guarantee 4.5:1 over arbitrary desktop backdrops. Two icon-only buttons also rely on `title` alone for their
name.

---

## Criterion-by-criterion

### 1.4.3 Contrast (Minimum) — **FAIL (worst case) / MEDIUM**
- **Evidence:** the default ask/answer surface is `--glass-fill: rgba(26,0,51,0.44)` with `--color-ink: #fff`
  (`styles.css:31,47`). Because the fill is 44% opaque, the effective text background is a blend with whatever
  is behind the overlay. Over a white/bright desktop the effective bg ≈ `rgb(154,143,165)` (0.44·#1A0033 +
  0.56·#fff); white-on-that computes to **≈2.9:1**, below the 4.5:1 AA floor for normal text (and below 3:1
  for large text). `backdrop-filter: blur(34px) saturate(190%)` helps perceptually but cannot guarantee a
  ratio against user content.
- **Mitigation already present:** the **listening** state (the most text-heavy view) swaps to a dense neutral
  gray `rgba(18,18,22,0.78)`–`rgba(22,22,26,0.86)` specifically for legibility (`styles.css:56-61,242-264`),
  and the **Settings** window uses solid surfaces (`--cl-bg:#14012a`, etc.). Those states are fine.
- **Fix:** raise the default glass opacity (or add a semi-opaque text scrim behind body copy) so the ask/answer
  surface meets 4.5:1 independent of the backdrop; or apply the listening-state density to all text-heavy
  panels. This is the single criterion blocking a clean AA pass.

### 4.1.2 Name/Role/Value — icon-only buttons (MOSTLY PASS, 2 gaps / LOW–MEDIUM)
- **PASS:** the shared `IconButton` sets **both** `title` and `aria-label` (`ui.tsx:19-21`), so every Bar
  control (mic, capture, history, settings, collapse, hide, quit) is named. `Copilot` actions
  (`Copilot.tsx:36`), `RecallView` connections button (`RecallView.tsx:224`), and `Review` copy/folder buttons
  carry explicit `aria-label`s.
- **GAP:** two bespoke icon-only buttons have `title` but **no `aria-label`**: remove-API-key `<Trash2>`
  (`Settings.tsx:483-492`, `title="Remove saved key"`) and remove-context-doc `<Trash>`
  (`Settings.tsx:1260-1267`, `title="Remove"`). `title` is the last-resort name source in the accname
  algorithm and is not reliably announced by all AT, nor shown on keyboard focus. Add `aria-label`.

### 4.1.2 — `role="switch"` toggles (PASS)
- **Evidence:** the Settings `Toggle` is a `<button role="switch" aria-checked={on} aria-label={label}>`
  (`Settings.tsx:206-212`), wired through `ToggleRow` with a `<label htmlFor>` association
  (`Settings.tsx:252-269`). The Bar "Think" toggle is `role="switch" aria-checked aria-label="Thinking mode"`
  (`Bar.tsx:115-120`). The Listen control uses `aria-pressed` on a native button (`Bar.tsx:89-93`) — valid
  (the redundant `role="button"` there is harmless).

### 2.1.1 Keyboard / 2.1.2 No trap (PASS, minor gap)
- All interactive elements are native `<button>`/`<input>`; Enter submits the Ask bar (`Bar.tsx:64-69`) and
  the key fields (`Settings.tsx:460,910`). No positive `tabIndex`, no custom focus trap, and Settings is an
  inline panel (not a modal) so no trap is required (`grep -rn "tabIndex\|role=\"dialog\"\|aria-modal" …`
  → none). **Minor gap:** no Escape handler (see UX report) — not an AA failure, but expected for an overlay.

### 2.4.7 Focus Visible (PASS)
- **Evidence:** `.focus-ring:focus-visible { outline: 2px solid #b388f0; outline-offset: 2px }` and
  `.focus-ring-strong` (3px) (`styles.css:318-326`); the Settings window uses
  `.cl-focus:focus-visible { outline: 2px solid #9a4dff; outline-offset: 1px }` (`styles.css:179-182`). These
  light-purple rings clear the 3:1 non-text-contrast floor against the dark surfaces and are applied to
  effectively every control class.

### 2.3.3 / 2.2.2 prefers-reduced-motion — **PASS (prior "spinner gap" is resolved)**
- **Evidence:** a global rule zeroes motion: `@media (prefers-reduced-motion: reduce) { *,*::before,*::after {
  animation-duration:0ms !important; transition-duration:0ms !important } }` (`styles.css:422-429`). This
  blanket override neutralizes `animate-spin` (the `Spinner`/`Loader2`), `shimmer` skeletons, `rec-dot`
  pulse, `fade-up`, `panel-enter`, and `step-enter`. The earlier-flagged "spinner ignores reduced-motion"
  no longer holds against this CSS. (The approach is blunt — it also disables functional transitions — which is
  acceptable here and errs safe.)

### 4.1.3 Status Messages (PASS)
- Streaming/answer surfaces use `aria-live="polite"` (`Answer.tsx:143`, `Copilot.tsx:87`, `Review.tsx:145`);
  the meeting toast is `role="alert" aria-live="assertive"` (`MeetingDetectedToast.tsx:46`); the consent
  reminder is `role="status" aria-live="polite" aria-atomic="true"` (`RecordingConsentReminder.tsx:40`).

### 1.1.1 Non-text Content (PASS)
- `MantuLogo` has descriptive `alt="Mantu — Audacious ideas, Delivered beyond"` (`MantuLogo.tsx:17`);
  `MantuMark` is decorative with `alt=""` (`MantuMark.tsx:11`); inline brand SVGs are `aria-hidden="true"`
  (`Onboarding.tsx:11`, `SignInWall.tsx:9`).

### 2.5.8 Target Size (Minimum) (PASS, watch items / LOW)
- `IconButton` is 30×30, `Toggle` 42×24, the Listen/Think pills are 30px tall — all ≥24×24. A few text-link
  buttons use `px-1.5 py-0.5` at 10–11px (e.g. RecallView "Rebuild"/"Open graph" `:60-78`, Review copy
  `:169-177`); their hit height can dip just under 24px. Inline-exception arguably applies; bump padding to be
  safe.

### 1.4.1 Use of Color (PASS)
- Markdown links are `#b388f0` **and** underlined (`styles.css:395-399`) — not color-alone. Verdicts/status use
  text + icon, not color alone.

---

## N/A (justified)
- Screen-reader landmark/page-title navigation, skip-links, heading outline for document pages — N/A: this is a
  compact transient overlay, not a document; there is one root region per view.
- Reflow/zoom to 400% (1.4.10), orientation (1.3.4) — N/A: fixed-size desktop overlay, not a responsive page.
- Captions/audio descriptions (1.2.x) — N/A: no media playback; audio is captured, not presented.

## Commands run
`grep` sweeps for `aria-*`, `role=`, `tabIndex`, `Escape`, `alt=`, `prefers-reduced-motion`; manual contrast
computation from the CSS tokens in `styles.css`.
