---
project: Métis
type: design-system-contract
surface: Time saved
basis: WALTEUR design law (this file before UI)
tokens:
  # Mantu tokens already in src/renderer/src/styles.css. Reuse them. Do not invent a palette.
  accent: "#7F00DA"                 # --color-accent (Bright Purple)
  accent-text: "#B388F0"            # --color-accent-text (AA on glass)
  ink: "rgba(255,255,255,1)"        # --color-ink
  ink-2: "rgba(255,255,255,0.86)"   # --color-ink-2
  ink-3: "rgba(255,255,255,0.74)"   # --color-ink-3
  muted: "var(--cl-muted-foreground)"
  glass: "var(--cl-card) / glass-fill"
  hair: "rgba(255,255,255,0.10)"    # --color-hair
  ok: "#83C092"                     # --color-success
  danger: "#F0717A"
typography:
  ui: "Geist, -apple-system, system-ui, sans-serif"
  body: "Inter, -apple-system, system-ui, sans-serif"
  headline: { size: 24, weight: 600, tracking: -0.02em }
  label: { size: 11, weight: 500, tracking: 0.04em, transform: uppercase }
  body-size: 12
  footnote: 10.5
radius: { card: 10, control: 10 }
spacing: 4px-scale
motion:
  ease: "cubic-bezier(0.22, 1, 0.36, 1)"
  enter: "180ms"
  hover: "120ms"
  reduced-motion: respected
---

# Time saved

A calm, factual record of work Métis actually finished. Never a vanity dashboard. Never a percentage
that was not measured. Every minute on screen is an **estimate**, labeled as one.

## What this is

Four sensors write an append-only local event log. The view adds them up and shows its work.

| Kind | When it fires | Estimate (heuristic) |
| --- | --- | --- |
| `note-taking` | A meeting transcript or a saved note is written | `words / 180` wpm, rounded, min 1 when any words exist |
| `second-brain` | Brain ingest captures commitments / opportunities | 2 min per captured opportunity, cap 15 |
| `email-summary` | An email recap with next steps is produced | 4 min |
| `mcp-push` | The user confirms a push to a connected MCP or an Outlook draft | 3 min |

Heuristics live in `src/shared/time-saved-events.ts` and are repeated in code comments. The UI says
"estimate". It never says "you saved 37%".

The older meeting write-up model (`src/shared/time-saved.ts`, adjustable ratio) stays as a secondary
line: "from meeting notes". It is also an estimate. The event log is the primary figure because it
is tied to real events, not an invented share of meeting length.

## Event shape

```
kind            note-taking | second-brain | email-summary | mcp-push
timestamp       epoch ms
estimatedMinutes  number, from the heuristic above
connector?      bidstack | plane | clickup | outlook | none
ids?            meeting / note / tool / draft identifiers (never secrets)
```

Local file: append-only JSONL under the user data folder. Never shipped. A failed write does not
invent a number to keep the UI pretty.

## Surfaces

1. **Settings → Intelligence → Time saved** (this PR). Small module. Headline, four-kind breakdown,
   recent events, footnote with the heuristics.
2. Later: Intelligence can read the same log. Do not merge PR 61 charts into this change.

## Layout

- One glass card (`radius-md`, hairline, no drop shadow on type).
- Headline: `≈ {formatted}` in Geist 24 semibold, then the word `estimate` in ink-3 at 11px.
- Breakdown: four rows, kind label left, `~N min` tabular-nums right. Empty kinds stay visible at 0.
- Recent: up to 8 rows. Kind, relative time, connector if any, `~N min`. No sparklines.
- Empty: "Time saved appears when Métis finishes a note, a recap, or a push you confirm."
- Footnote: the four heuristics, each marked estimate.

## MCP / Outlook write (same law)

- Push is a button the user presses. Never auto-send. Tony: never auto-send.
- Connected + a real write tool: show the payload, then Confirm.
- Not connected: the same button slot reads **Connect Outlook** or **Connect Polo Pre-Sales**.
  It does not claim a send. It does not invent a Polo or Outlook delivery.
- Outlook write creates a **draft** (Graph `POST /me/messages`, never `sendMail`) or a calendar
  event without attendees (no invites). If write consent is missing, say so and offer Connect.
- CRM notes go through the existing BidStack / Polo MCP tool the user already picked.

## Do

- One accent (Mantu purple). Everything else is white-alpha on dark glass.
- Label every number as an estimate.
- Fail closed: a hung LLM call times out; a missing connector says connect.
- Answer first on every ask: the answer, then silence.

## Do not

- Purple-gradient heroes, emoji, rounded-3xl stacks, vanity gauges, invented percentages.
- "Something went wrong". Name the timeout, the cancel, the missing connector, the refused key.
- Em dashes in copy. Do not identify Métis as AI in user-facing copy.
- Auto-send mail, CRM, or calendar invites.
- Touch overlay chrome, island geometry, onboarding, or the Settings identity / member-pass card.
