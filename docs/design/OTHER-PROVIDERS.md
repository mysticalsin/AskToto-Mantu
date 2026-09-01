---
project: Métis
type: settings-ai-other-providers-contract
product: Métis (AskToto-Mantu)
owner: Tony
coordinator: Devon
status: binding — implement to this file only
surface: Settings → AI → Other providers
frozen: Overlay Island / Hide — do not pack, do not restyle
---

# Other providers — logo-first row

This is the **DESIGN.md for this slice**. UI code implements this file. It
does not invent a second picker, a dropdown of vendor names, or a Bootstrap
button row.

Taste: Apple Settings, sparse and quiet. Large hit targets. One accent.
Company mark only. Name lives in the accessible label and in the details
that open after a click — never as the default row.

## Outcome

Settings → AI → **Other providers** shows a single quiet row of company
logos. No name chips. Click a logo. Then the existing fields appear:
API key, endpoint (when that provider needs one), and the enable /
active state.

Claude, Cloud CLI, Codex, Dust, and Métis Local stay as they are.
Overlay chrome is frozen.

## Who sits in this row

Only providers the app already ships whose `tier` is `featured` and that
already render in this section (not Claude, not CLI, not Dust, not Local):

| id | Company mark | Visible name on the default row |
|---|---|---|
| `openai` | OpenAI | none |
| `nvidia` | NVIDIA | none |
| `deepseek` | DeepSeek | none |
| `minimax` | MiniMax | none |
| `kimi` | Kimi | none |
| `cloudflare` | Cloudflare | none |
| `custom` | quiet local endpoint mark | none |

Do not add a provider that is not already in `PROVIDERS`. Do not move
Qwen, Groq, Mistral, Grok, Gemini, OpenRouter, or Dust into this row.
Those stay in **Experience: more models** as the existing named tiles.

Org allowlist still filters the row. A locked provider field still
disables the tiles.

## Default row (closed)

One wrap of **logo tiles**. Nothing else.

```
[ ◯ ]  [ ◯ ]  [ ◯ ]  [ ◯ ]
[ ◯ ]  [ ◯ ]  [ ◯ ]
```

Each tile:

1. Official (or official-looking) mark, 28px, centered.
2. `aria-label` = `PROVIDERS[id].label` (the accessible name).
3. `aria-pressed` when that id is the active answering provider.
4. Native `<button>`. Tab, Space, Enter. Existing `cl-focus` ring.

Forbidden on the default row (and on a tile that is not the open one):

- Visible text `GPT`, `OpenAI`, `NVIDIA`, `NIM`, `DeepSeek`, `MiniMax`,
  `Kimi`, `Cloudflare`, `Custom`, or any other provider label / blurb.
- "Best pick" chips.
- Check-plus-name chips.
- A 2-column card grid of title + blurb.
- A dense `<select>` of vendor names.
- A Bootstrap / pill button row of names.

A saved key is a **4px success dot** on the tile, not a name. Selected
is a hairline accent ring and a soft fill, not a label.

## Click, then details

Click (or keyboard activate) a logo:

1. That provider becomes the answering provider — the existing
   `patch({ provider })` enable. This **is** enable. Do not invent a
   second Enable switch.
2. The **existing** key card appears under the row: password field,
   Save, Test, Remove, Get a key, Advanced (models, temperature,
   endpoint when required).
3. The provider's name may appear **in that card title**
   (`{label} key`). That is after the click, not the default row.

`custom` still seeds `customBaseUrl: 'https://your-endpoint/v1'` when
the stored URL is not already `https://`, same refine the more-models
Custom tile already uses. Without that seed the write reverts.

When the active provider is Claude, a CLI, Dust, or Local, no
other-provider tile is pressed and the key card for this row is hidden.
The row is still the logos.

When the active provider is one of the row (including the shipped
Cloudflare default), that logo is pressed and the existing fields
are already open.

## Visual

Settings column is ~320–360px. Chrome recedes.

| Token | Value |
|---|---|
| Tile | **52×52** (min hit 44×44) |
| Gap | **12px** |
| Radius | **12px** (`radius.md`) |
| Idle | hairline `glass-border`, fill `transparent` / `white/[0.02]` |
| Hover | `white/[0.05]`, 120ms |
| Selected | `accent` hairline + `accent-soft` fill |
| Mark | `currentColor` at `--cl-foreground`, 28px |
| Key dot | 4px `--cl-success`, bottom-center, 6px inset |
| Motion | opacity + transform only, 180ms `--ease-spring` |
| Reduced motion | skip the reveal spring |

Not a rainbow of vendor hex on the row. Monochrome marks on dark glass.
One accent (`--cl-primary` / Mantu). No purple-hero, no card-in-card,
no emoji, no drop-shadow on type.

## Marks

Vendor official simple-icons paths (CC0 marks; trademarks remain with
the brands). Local SVG React components. **No remote hotlink. No CDN.
No scraped PNG.**

| id | simple-icons slug | Paint | Source |
|---|---|---|---|
| `openai` | `openai` | `currentColor` | https://openai.com/brand |
| `nvidia` | `nvidia` | `currentColor` | https://www.nvidia.com/en-us/about-nvidia/legal-info/logo-brand-usage/ |
| `deepseek` | `deepseek` | `currentColor` | https://www.deepseek.com/ |
| `minimax` | `minimax` | `currentColor` | https://www.minimax.io/ |
| `kimi` | `kimi` | `currentColor` | https://www.kimi.com/ |
| `cloudflare` | `cloudflare` | `currentColor` | https://www.cloudflare.com/trademark/ |
| `custom` | none — local geometric endpoint | `currentColor` | this file |

`custom` is not a company. Draw a quiet 24×24 monoline mark (rounded
well + a small gap) so the tile matches the row. Do not pretend it is
a vendor logo. Do not use a Lucide icon as a stand-in brand.

Same pattern as Brain connectors: inline SVG, `aria-hidden` on the
graphic, name on the button.

## What does not change

- Claude card, CLI Integration, Dust setup, Local AI, Backups & limits.
- **Experience: more models** named `ProviderTile` grid (title + blurb).
- Overlay Hide / Island / Bar. Onboarding. Starfield. Jarvis pill.
- Thinking orbs. Identity pass. Pack. Version number.
- Keys, tokens, Worker secrets — never in git.
- Provider registry ids, models, key patterns, routing.

Settings search still finds these companies by keyword (`openai`,
`nvidia`, `nim`, `deepseek`, …). The accessible name on each tile is
enough for assistive tech; search stays word-based.

## QUALITY hats (fail closed)

| Hat | Ships only if | Rejects |
|---|---|---|
| Product | Default row is logos only. Click opens the existing key / endpoint fields. | Name chips GPT / OpenAI / NVIDIA NIM / DeepSeek / MiniMax as the resting row. |
| Craft | 52×52 quiet tiles, 12px air, monochrome official paths. Apple density. | Bootstrap name buttons. Dense vendor `<select>`. Lucide-as-brand. Remote images. |
| Access | Every tile is a keyboard button with `aria-label`. Focus ring. | Mouse-only hit areas. Name-only for screen readers. |
| Scope | Other-providers row only. Overlay and primary flows untouched. | Overlay edits. Pack. Version bump. New invented providers. |
| Trust | Click is the only enable. No `useEffect` that switches provider on mount. | Auto-picking a tile because Settings opened. Keys in the repo. |

Would Apple ship this Settings row? Only if every hat passes.

## Tests (required)

Source-contract on `Settings.tsx` (no Settings render harness):

1. The Other providers block maps each current featured other-provider
   to a logo tile (`aria-label` from `PROVIDERS[id].label`).
2. That default-row JSX has no visible `{PROVIDERS[id].label}` / blurb
   and no string literals `GPT`, `OpenAI`, `NVIDIA NIM`, `DeepSeek`,
   `MiniMax` as chip text.
3. Tile `onClick` still `patch`es `provider` (and seeds Custom's URL).
4. `{isFeatured && keyEntrySection}` still follows the row so the
   existing fields appear after the click.
5. Tiles are `<button>` with `aria-label` and `cl-focus` (keyboard).
6. Marks are local components, not `http` / `https` image src.

Plus: each mark file vendors the simple-icons path (or the local Custom
geometry), `currentColor`, no remote URL.
