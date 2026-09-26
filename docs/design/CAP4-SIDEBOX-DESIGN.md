# Cap4 Side Box DESIGN — Métis right-edge sidecar
**Status:** DESIGN LOCK — implement after this file, not before  
**Date:** 2026-09-20 ~6:10pm ET  
**CoS:** Ultron  
**Revokes:** Ultron stamp on `d75f6be2` (functional OK, design FAIL)  
**Basis:** `docs/design/DESIGN.md` · CodeNotch MIT interaction ideas · Cluely glass · Bar `aw-toolbar` language  
**Law:** DESIGN before UI. Subtract before add. Apple-grade. No stub buttons.

---

## Intent

The right-edge side box is Métis when chrome is docked to the edge — same product as the top Bar, rotated into a **vertical glass sidecar**. It must feel like a native notch that blooms into a Control-Center-quality panel, not four bordered rectangles labeled Ask/Listen/Intelligence/Settings.

Three feelings (north star):
1. **It just works** — hover reveals; click keeps open; every row does the real action.
2. **It never lies** — Listen shows listening; Ask shows busy; missing Intelligence is actionable, not fake-green.
3. **It recedes** — rest is a thin luminous rail; expand is purposeful; Ear/wake chip stays top-center Cap2, never glued onto this panel.

---

## REJECT (Tony just saw this)

- Plain stacked bordered buttons with only text labels
- Developer copy like "Right edge" in the header
- Flat gray boxes with no icons, no live state, no hierarchy
- Cap2 "Ear on · say Métis" chip visually attached to the dock panel
- Crushed 880-wide Bar jammed into the edge
- Rotated text, neon junk, Em-dash marketing copy

---

## Tokens (from DESIGN.md — do not invent)

| Token | Value |
| --- | --- |
| glass-fill | `rgba(20,20,22,0.55)` / use existing `--aw-glass-bot` if already wired |
| glass-fill-strong | `rgba(16,16,18,0.72)` |
| glass-border | `rgba(255,255,255,0.12)` |
| text-primary | `rgba(255,255,255,0.95)` |
| text-secondary | `rgba(255,255,255,0.55)` |
| accent | `#7C8CF8` design contract **or** live `--color-accent` / `#7f00da` already in styles — **match Bar**, do not introduce a third purple |
| radius | sm 8 · md 12 · lg 16 · pill 9999 |
| blur.panel | 24px |
| elevation.glass | `0 8px 32px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.06)` |
| motion.ease | `cubic-bezier(0.22, 1, 0.36, 1)` |
| panel-in | 180ms |
| hover | 120ms |
| type | Geist UI / Inter body · scale xs–base for chrome |

---

## Structure

### A. Rest (compact notch)

- Vertical **rail** on the selected display's right edge (CodeNotch compact resting control).
- Size: ~10–14px wide × ~96–112px tall; `border-radius: 999px 0 0 999px`.
- Glass + hairline + soft accent glow (existing `.overlay-dock-peek` language, refined).
- Inner **rail gem**: 3×46px pill using accent-soft, not loud neon.
- Hover (≤60ms dwell already wired): widen to ~16px + glow intensify — **never** start mic/camera/model.
- Optional: tiny Métis mark watermark at 20% opacity inside rail — only if it reads at rest; else omit.

### B. Expanded sidecar (the "side box")

Width **300px** (±16). Height **hug content**, min ~360, max ~min(560, workArea). Anchored to right edge; left corners `radius.lg`, right flush to screen (`16px 0 0 16px`).

```
┌─────────────────────────────┐
│  [Mark] Métis          ⌄/×  │  header — mark + name; dismiss/unpin
│  ─────────────────────────  │
│  Ask anything…          ⏎   │  compact Ask field (same submit as Bar)
│                             │
│  ● Listen          ····     │  primary row — live state
│  ◻ Capture                  │  secondary (if wired; else omit, do not fake)
│  ◻ Intelligence             │  opens Cap3 stand
│                             │
│  ──────── settings ···· ──  │  footer ghost: Settings gear
└─────────────────────────────┘
```

### C. Rows (not stub buttons)

Each primary action is a **horizontal row**:
- Leading Lucide (or existing Métis) icon 16–18px in `text-secondary`, accent when active
- Label 13–14px medium, left-aligned
- Trailing status chip only when truthful: `Listening` · `Busy` · `Needs approval`
- Hit target ≥40px tall, full width, `radius.md`
- Rest: transparent / `rgba(255,255,255,0.04)`
- Hover: `rgba(255,255,255,0.08)` + soft border
- Active Listen: `accent-soft` fill + pulse on icon (match Bar Listen language)
- Disabled Ask: opacity 0.45 + no fake click

**Settings** is footer ghost (gear + "Settings"), not a fourth equal primary button.

**Ask field** reuses Bar placeholder "Ask anything" / submit path — typing here must not start Listen. Empty submit no-ops.

### D. Motion

- Expand: width + opacity 180ms spring ease; content fades in after geometry settles (no layout thrash).
- Collapse: reverse; OverlayPeek remounts.
- Keep-open on click; brief pointer leave does not dismiss during active Ask input or Listen.
- `prefers-reduced-motion`: instant snap, no pulse.

### E. Cap2 / Cap3 coexistence

- Cap2 command pill stays **top-center** — never render Ear copy inside DockPanel.
- Cap3 Intelligence row calls the same `openIntelligence` path as Bar; placement clamp from `a694db9c` stays.
- Hover reveal does not arm ear / mic.

---

## Implementation owners

| File | Change |
| --- | --- |
| `DockPanel.tsx` | Full redesign per this DESIGN — Ask field + icon rows + footer Settings |
| `styles.css` `.overlay-dock-*` | Tokens, row states, remove stub button look |
| `App.tsx` | Wire Ask submit / Listen / Intelligence / Settings; ensure Ear chip not dock-scoped |
| Rest peek | Polish only; keep geometry tests green |
| Tests | Extend dock panel contract: rows present, no "Right edge" string, Ask field exists |

Reuse Lucide already in tree. Reuse `MetisMark` / `MantuMark` if present. Do **not** invent a new orb inside the dock.

---

## Acceptance (Tony eye)

1. Rest rail: quiet, luminous, CodeNotch-grade — no Ear error, no junk labels
2. Expand: glass sidecar that looks like Métis Bar DNA, not a settings form
3. Ask field works; Listen toggles with live state; Intelligence opens stand; Settings opens settings
4. Screenshot REST + EXPANDED + Listen-active
5. Cap2 wake + Cap3 stand still PASS
6. Ultron stamp only after Tony eye PASS

## ETA
READY-FOR-FEEL: **~6:45–7:15pm ET** (Mac). Pack HOLD.
