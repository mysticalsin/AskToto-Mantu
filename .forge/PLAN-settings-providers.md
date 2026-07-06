# PLAN — Settings AI: pick any API provider (CLI-first, then open API picker)

Author: Fable. Executor: Sonnet. Branch: fix/enterprise-panel-findings (worktree D:\asktoto-wt).

## Problem
Settings → AI front-loads Anthropic as "the" provider; the real multi-provider picker is buried in a
COLLAPSED "Experience: more models" section framed "Anthropic above covers most people". Onboarding's
"An API key" tile hardcodes Anthropic. User wants: suggest CLI first, THEN an open API picker exposing
every provider (Claude, GPT, Grok, Gemini, Kimi, DeepSeek, Qwen, Groq, Mistral, NVIDIA, MiniMax,
OpenRouter, Custom). Grok (xAI) is missing from the registry.

## Backend is already generic
`src/main/llm.ts` dispatches any non-cli/dust/anthropic kind to `streamOpenAI` (baseURL-driven). Grok
(OpenAI-compatible) needs only a registry entry — NO dispatch/routing changes. `providerReady` for an
API provider = `hasApiKey(provider)` (src/main/index.ts:230). Do not touch main-process files.

## Change 1 — add Grok · xAI  (src/shared/providers.ts)
- Add `'grok'` to the `ProviderId` union, right after `'openai'`.
- Add to `PROVIDERS` (kind 'openai', so it flows through streamOpenAI):
  ```
  grok: {
    id: 'grok',
    label: 'Grok · xAI',
    blurb: 'xAI’s models with strong reasoning and live web/X context.',
    kind: 'openai',
    baseUrl: 'https://api.x.ai/v1',
    models: ['grok-4', 'grok-3', 'grok-3-mini'],
    defaultModel: 'grok-4',
    fastModel: 'grok-3-mini',
    thinkModel: 'grok-4',
    keyHint: 'xai-…',
    keyPattern: '^xai-',
    vision: true,
    keyUrl: 'https://console.x.ai/'
  },
  ```
- `PROVIDER_IDS` derives from `Object.keys(PROVIDERS)` — no other edit. Auto-detect on paste now works
  for `xai-` keys via keyPattern.

## Change 2 — Settings AI restructure  (src/renderer/src/components/Settings.tsx, the AiSection return ~785-947)
Keep CLI-first, expose the API picker openly. New top-level order:
1. `<CliIntegration .../>` — unchanged (CLI suggested first). Leave as-is.
2. NEW always-visible provider picker replacing BOTH the hardcoded Anthropic row (807-836) AND the
   collapsed `ExpandableSection "Experience: more models"` (840-907). Render:
   ```
   <Section title="Choose your AI provider"
            desc="Connect a CLI above (no key), or pick any provider here and paste its key — stored encrypted on this device.">
     {/* filter box: keep existing block, still gated on PROVIDER_IDS.length > 8 */}
     <div className="grid grid-cols-2 gap-2"> {shown.map(... EXISTING tile markup ...)} </div>
     {locked && <managed chip>}
   </Section>
   {keyEntrySection}   {/* the active provider's key card, ALWAYS shown for non-CLI providers */}
   ```
   - Tile markup: reuse the existing button exactly (lines ~860-895): aria-pressed, "Best pick" badge on
     `recommended`, `settings.hasKeys[id]` check, blurb. Do not restyle.
3. `<div ref={dustSectionRef}><DustSetup .../></div>` — MOVE to here (after the picker; Dust is a
   special integration, keep its dedicated card). Keep the ref so CliIntegration's Dust shortcut still
   scrolls to it.
4. `<Section title="Thinking mode" ...>` — unchanged.

Required edits to make the picker show every provider:
- `shown` (line 575): remove the `id !== 'anthropic'` exclusion so Anthropic appears IN the grid:
  `const shown = PROVIDER_IDS.filter((id) => !CLI_PROVIDERS.has(id) && (!q || PROVIDERS[id].label.toLowerCase().includes(q)))`
- Delete the standalone Anthropic row (807-836) and the `ExpandableSection` wrapper (keep its inner
  `<Section title="Model provider">` grid, retitled as in step 2). Remove the now-dead
  `provider === 'anthropic' && keyEntrySection` (838) and `provider !== 'anthropic' && keyEntrySection`
  (906); render `keyEntrySection` once, right after the picker Section.
- `keyEntrySection` (585): unchanged logic (already null for CLI providers, shown for any API provider).
- If `ExpandableSection` import becomes unused, remove it. If `Search`/`filter` stay used (they do), keep.
- Recommended badge: `recommendedProvider` unchanged (Anthropic stays "Best pick").

## Change 3 — Onboarding "An API key" tile  (src/renderer/src/components/Onboarding.tsx ~402-407)
- Keep `onClick={() => choose('anthropic')}` (Anthropic is the tuned default active provider).
- Change `desc` to name the options honestly:
  `desc="Claude, GPT, Grok, Gemini, Kimi and more — paste a key on the next screen or in Settings → AI. You pay your provider directly."`
- Optionally change `title` to `"An API key"` (unchanged) — leave title.

## Verify (executor must run, paste output)
- `npm run typecheck` exit 0.
- `npm test` exit 0 (534 passing).
- Do NOT run electron-builder (Fable handles packaging + live screenshot verification).

## Constraints
- Surgical: touch only these 3 files. No main-process edits. No restyle beyond the structural move.
- Keep all `cl-focus`, `aria-pressed`, managed-`locked` handling intact. No new deps.
