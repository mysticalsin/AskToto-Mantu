# PLAN v5 — Multi-provider + Cluely-faithful Settings

## Goals (from Tony)
1. **More API providers** + **auto-detect** which provider a pasted key belongs to.
   Set: NVIDIA, DeepSeek, Qwen, MiniMax, Kimi, OpenRouter, Groq, Together, Fireworks, Mistral (+ keep Claude, GPT, Custom). All OpenAI-compatible → data, not new code paths.
2. **Interface** — keep glass but **denser** (less see-through); easier to move (drag grip).
3. **Mode selection only in Settings** after login — remove inline ModePicker from the overlay.
4. **Add NVIDIA key** `nvapi-…` (dev `.env`, gitignored; warn Tony to rotate — pasted in chat).
5. **Replicate Cluely's settings UI/UX** incl. where to add the key. Open the .dmg, match it.

## Cluely settings = ground truth (from app.asar 2.1.19)
- Stack: Base UI + emotion + TanStack Router + Clerk + zod + streamdown (Base UI + zod already in AskToto).
- Root surface: **solid** `bg-[rgb(9,12,13)]`, `dark`, `text-foreground`. NOT transparent.
- Layout: `grid grid-cols-[260px_1fr]` — left **sidebar** (`border-r bg-muted/40`) + content (`mx-auto max-w-4xl flex-col gap-5 pb-8`).
- Draggable header: `app-region-drag border-b border-white/[0.07] bg-white/[0.035]`, title "Settings".
- Footer: `h-14 border-t border-border bg-background px-4 justify-end`.
- Section eyebrow: `text-[10px] text-muted-foreground uppercase tracking-[0.08em]`.
- Card row: `rounded-2xl border border-border bg-muted/30 p-5 shadow-sm`.
- shadcn dark tokens (oklch): background 14.1%, card 21%, muted 27.4%, muted-foreground 70.5%,
  border white/.1, input white/.15, **primary (accent) = oklch(68% .15 237) ≈ blue**, radius .625rem.
- Cluely nav (inferred from copy): Personalize/Modes · Audio · Shortcuts · Calendar · Account/Plan · General/About.

## Build order
1. `src/shared/providers.ts` — add all providers (baseUrl, models, defaultModel, fastModel, keyHint, vision, keyPattern) + `detectProvider(key)`.
2. `src/shared/ipc.ts` — widen `ProviderIdSchema` enum to all ids.
3. `src/main/store.ts` — extend `ENV_VAR` map (exhaustive over ProviderId).
4. `src/main/index.ts` + preload + ipc — add `windowMode('bar'|'settings')`: settings widens window to ~920×640 centered, suppresses content auto-resize; bar restores 700 + content-height.
5. `src/renderer/src/styles.css` — add Cluely shadcn tokens (`--background/--card/--muted/--border/--input/--primary…`), `.cluely-*` surfaces; bump glass fill density (denser).
6. `src/renderer/src/components/Settings.tsx` — **rewrite** as Cluely two-pane window: sidebar tabs [Your AI · Personalize · Audio · Privacy · Meetings · Shortcuts · About], content pane, header, footer. "Your AI" = provider grid + unified key field w/ auto-detect.
7. `src/renderer/src/App.tsx` — Settings becomes full-window view (calls windowMode); remove inline ModePicker from copilot header (modes only in Settings). Add small read-only mode indicator.
8. `src/renderer/src/components/Bar.tsx` — add a drag grip affordance.
9. `.env` (gitignored) — `NVIDIA_API_KEY=nvapi-…`; update `.env.example` (no secret).

## Verify
- `npm run typecheck` · `npm test` · `npm run build`.
- Screenshot settings via `ASKTOTO_SHOT` + `ASKTOTO_DISABLE_CP=1` `?demo=settings`.
- Adversarial review: key-detection correctness, no key leakage to renderer, exhaustive ENV_VAR.

## Security
- NVIDIA key was pasted in chat → tell Tony to rotate after wiring.
- Keys never cross to renderer (PublicSettings has only `hasKeys` booleans). Preserve that.
