# Model-routing guardrail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lock the `claude-cli` provider to Sonnet-only and the `anthropic` provider's base/think tiers to Haiku/Sonnet in AskToto's interactive ask flow, while giving the Graph extraction pipeline (`brain/ingest.ts`, `graphify.ts`) an explicit, unaffected path to Opus.

**Architecture:** One pure function (`applyInteractiveGuardrail`) intercepts the resolved model string at the single choke point of the interactive flow (`attempt()` in main/index.ts) — everything downstream (audit log, `createStream`) is unaffected in shape, only the value changes. The Graph pipeline is a structurally separate code path that never calls this function, so it needs its own two small changes to actually *reach* Opus (today it only ever requests `'base'` tier or no model at all).

**Tech Stack:** TypeScript (shared/main), vitest, Python (vendored `graphify_runner.py`, no changes there — it already supports `--model`).

## Global Constraints

- No new magic strings — reuse `PROVIDERS['claude-cli'].thinkModel`, `PROVIDERS.anthropic.fastModel`, `PROVIDERS.anthropic.thinkModel` as the single source of truth for the locked values.
- Do not touch `routeTier()` (`src/shared/routing.ts`) — the auto-escalation heuristics are unchanged; the guardrail intercepts *after* tier is chosen.
- Do not touch any provider other than `claude-cli` and `anthropic`.
- Anthropic's **deep** tier (Opus) must remain reachable from the interactive flow for hard/coding questions — only base/think are pinned. Do not over-lock.
- This is Tony's personal guardrail, not an org policy — enforce unconditionally in code, do NOT add it to the managed-config `locked` list mechanism.

---

### Task 1: `applyInteractiveGuardrail` — pure function + unit tests

**Files:**
- Modify: `src/shared/providers.ts` (add the export; the `PROVIDERS` const and `ModelTier`/`ProviderId` types already live here)
- Modify: `src/shared/providers.test.ts` (add a new `describe` block; existing `isDustReady` tests stay untouched)

**Interfaces:**
- Produces: `applyInteractiveGuardrail(id: ProviderId, tier: ModelTier, model: string): string` — exported from `src/shared/providers.ts`, imported by Task 2 as `import { applyInteractiveGuardrail } from '@shared/providers'` (matches the existing import style already used in `main/index.ts` for `PROVIDERS`/`resolveModelTier`).

- [ ] **Step 1: Write the failing tests.** Append to `src/shared/providers.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { isDustReady, applyInteractiveGuardrail, PROVIDERS } from './providers'

describe('applyInteractiveGuardrail', () => {
  it('locks claude-cli to Sonnet for every tier, ignoring the resolved model', () => {
    expect(applyInteractiveGuardrail('claude-cli', 'base', 'haiku')).toBe('sonnet')
    expect(applyInteractiveGuardrail('claude-cli', 'think', 'sonnet')).toBe('sonnet')
    expect(applyInteractiveGuardrail('claude-cli', 'deep', 'opus')).toBe('sonnet')
  })

  it('pins anthropic base tier to the Haiku id regardless of the resolved model', () => {
    expect(applyInteractiveGuardrail('anthropic', 'base', 'claude-opus-4-8')).toBe(
      PROVIDERS.anthropic.fastModel
    )
  })

  it('pins anthropic think tier to the Sonnet id regardless of the resolved model', () => {
    expect(applyInteractiveGuardrail('anthropic', 'think', 'claude-opus-4-8')).toBe(
      PROVIDERS.anthropic.thinkModel
    )
  })

  it('does NOT lock anthropic deep tier — Opus stays reachable for hard questions', () => {
    expect(applyInteractiveGuardrail('anthropic', 'deep', 'claude-opus-4-8')).toBe('claude-opus-4-8')
  })

  it('passes every other provider/tier combination through unchanged', () => {
    expect(applyInteractiveGuardrail('openai', 'base', 'gpt-4o-mini')).toBe('gpt-4o-mini')
    expect(applyInteractiveGuardrail('dust', 'think', 'agent_abc')).toBe('agent_abc')
    expect(applyInteractiveGuardrail('codex-cli', 'base', '')).toBe('')
  })
})
```

  (Existing `describe('isDustReady', ...)` block stays exactly as-is above this new block.)

- [ ] **Step 2: Run the tests to verify they fail.**

Run: `npm test -- providers.test.ts`
Expected: FAIL — `applyInteractiveGuardrail is not a function` (or similar import error), since it doesn't exist yet.

- [ ] **Step 3: Implement the function.** In `src/shared/providers.ts`, find the existing `resolveModelTier` function (it ends with a closing `}` — add this new export directly after it, so the two tier-related functions sit together):

```ts
/** Cost/safety guardrail (per Tony): the CLI provider only ever answers as Sonnet in the interactive
 *  ask flow — never Haiku, never Opus — regardless of routeTier's escalation (hard/coding questions,
 *  factcheck, or thinkingMode 'always' would otherwise reach Opus here). The direct Anthropic API
 *  key's base/think tiers are pinned to Haiku/Sonnet so a stray providerModels edit can't drift them.
 *  Deep tier is deliberately EXEMPT on both — that's the Graph extraction pipeline's reserved path to
 *  Opus (brain/ingest.ts and graphify.ts call resolveModelTier directly and never reach this function). */
export function applyInteractiveGuardrail(id: ProviderId, tier: ModelTier, model: string): string {
  if (id === 'claude-cli') return PROVIDERS['claude-cli'].thinkModel ?? 'sonnet'
  if (id === 'anthropic' && tier === 'base') return PROVIDERS.anthropic.fastModel
  if (id === 'anthropic' && tier === 'think') return PROVIDERS.anthropic.thinkModel ?? model
  return model
}
```

  Verify `ModelTier` and `ProviderId` are already exported/imported in this file (they are — `ProviderId` is defined at the top of `providers.ts`; confirm `ModelTier`'s definition location with `grep -n "type ModelTier" src/shared/providers.ts` and use it as-is, don't redefine it).

- [ ] **Step 4: Run the tests to verify they pass.**

Run: `npm test -- providers.test.ts`
Expected: PASS — all 5 new `it()` blocks plus the existing 5 `isDustReady` tests (10 total in this file).

- [ ] **Step 5: Commit**

```bash
git add src/shared/providers.ts src/shared/providers.test.ts
git commit -m "Add applyInteractiveGuardrail: lock CLI to Sonnet, Anthropic base/think to Haiku/Sonnet"
```

### Task 2: Wire the guardrail into the interactive ask flow

**Files:**
- Modify: `src/main/index.ts` (the `attempt()` function inside the ask IPC handler, ~line 1189-1236 — re-read the current file first, this region was NOT touched by any other work today so line numbers should still be close, but confirm before editing)

**Interfaces:**
- Consumes: `applyInteractiveGuardrail` from Task 1 (`import { PROVIDERS, resolveModelTier, applyInteractiveGuardrail } from '@shared/providers'` — add `applyInteractiveGuardrail` to whatever existing import line already pulls `PROVIDERS`/`resolveModelTier` from `@shared/providers` in this file; do not add a second import line).
- Produces: nothing new — this is the enforcement point, not an interface other tasks consume.

- [ ] **Step 1: Read the current `attempt()` function** in `src/main/index.ts` to confirm the exact surrounding code (it should closely match this, verified today):

```ts
      const key = getApiKey(provider)
      const tier = routeTier(req, s.thinkingMode)
      const model =
        req.agentOverride && provider === 'dust'
          ? req.agentOverride
          : resolveModelTier(provider, s.providerModels, s.providerModelsThinking, tier, s.providerModelsDeep)
```

  If it matches, proceed. If it has drifted (another session may have touched this file), locate the equivalent block — the line computing `model` from `resolveModelTier` inside the ask-request handling function — and apply the same transformation described in Step 2 to whatever the current variable name is.

- [ ] **Step 2: Change `const model` to `let model`, and clamp it immediately after.** Replace:

```ts
      const model =
        req.agentOverride && provider === 'dust'
          ? req.agentOverride
          : resolveModelTier(provider, s.providerModels, s.providerModelsThinking, tier, s.providerModelsDeep)
```

  with:

```ts
      let model =
        req.agentOverride && provider === 'dust'
          ? req.agentOverride
          : resolveModelTier(provider, s.providerModels, s.providerModelsThinking, tier, s.providerModelsDeep)
      // Guardrail (per Tony): CLI is Sonnet-only, Anthropic base/think are pinned to Haiku/Sonnet — both
      // regardless of what routeTier or a user's providerModels override picked. Opus stays reachable only
      // through the Graph pipeline (brain/ingest.ts, graphify.ts), which never calls this function.
      model = applyInteractiveGuardrail(provider, tier, model)
```

  Everything after this point in the function (`ineligible` check, `auditLog('provider.request', { model, ... })`, the `createStream({ model, ... })` call) already reads the `model` variable by name — no other line in this function needs to change.

- [ ] **Step 3: Add the import.** Find the existing import line in `src/main/index.ts` that includes `resolveModelTier` (search `resolveModelTier` — it's imported from `@shared/providers`). Add `applyInteractiveGuardrail` to that same import list.

- [ ] **Step 4: Gate.** Run `npm run typecheck` — must be clean (this file is large; a stray unused-`const`-become-`let` or missed downstream reference would surface here).

- [ ] **Step 5: Gate.** Run `npm test` — full suite must stay green (360+ tests from prior work today plus the 5 new ones from Task 1).

- [ ] **Step 6: Commit**

```bash
git add src/main/index.ts
git commit -m "Enforce the CLI/Anthropic model guardrail in the interactive ask flow"
```

### Task 3: Graph pipeline reaches Opus — brain/ingest.ts

**Files:**
- Modify: `src/main/brain/ingest.ts:52` (the `pickProvider()` function)

**Interfaces:**
- Consumes: `resolveModelTier` (already imported in this file from `@shared/providers`) — signature `resolveModelTier(id, providerModels, thinkModels, tier, deepModels?)`.
- Produces: nothing new — internal to `pickProvider()`, which is already only called from within this same file.

- [ ] **Step 1: Read the current line** to confirm it still matches (verified today):

```ts
    const model = resolveModelTier(p, s.providerModels, s.providerModelsThinking, 'base')
```

- [ ] **Step 2: Change the tier from `'base'` to `'deep'` and pass the deep-overrides map** (currently omitted, which is why it always fell back to the built-in `fastModel`):

```ts
    const model = resolveModelTier(p, s.providerModels, s.providerModelsThinking, 'deep', s.providerModelsDeep)
```

  This function (`pickProvider`) never calls `applyInteractiveGuardrail` — it's a separate code path from `attempt()` in `main/index.ts` — so this now resolves to `PROVIDERS[p].deepModel` (`'opus'` for `claude-cli`, `'claude-opus-4-8'` for `anthropic`) via `resolveModelTier`'s existing fallback chain, unmodified by Task 2's guardrail.

- [ ] **Step 3: Gate.** Run `npm test -- ingest.test.ts` if that test file exists (`ls src/main/brain/ingest.test.ts` first — if it doesn't exist, skip to the full-suite gate). If it exists and asserts specific tier/model behavior for `pickProvider`, read those assertions and update them to expect `'deep'`-tier resolution instead of `'base'`-tier resolution; do not weaken or delete an assertion to make it pass — fix the expected value to match the new, correct behavior.

- [ ] **Step 4: Gate.** Run `npm run typecheck && npm test` — full suite green.

- [ ] **Step 5: Commit**

```bash
git add src/main/brain/ingest.ts
git commit -m "Brain ingest (Graph): request deep tier so extraction can use Opus"
```

### Task 4: Graph pipeline reaches Opus — graphify.ts

**Files:**
- Modify: `src/main/graphify.ts` (the `buildGraph()` function, ~line 217-224)

**Interfaces:**
- Consumes: `picked.backend` (already a local variable in `buildGraph()`, typed `string`, one of `'claude-cli' | 'claude' | 'openai'` per `pickBackend()`'s return shape).
- Produces: nothing new — internal to `buildGraph()`.

- [ ] **Step 1: Read the current block** to confirm it still matches (verified today):

```ts
      const notes = resolveMeetingsFolder(getSettings())
      const args = ['build', '--input', notes, '--out', outDir(), '--backend', picked.backend]
      if (incremental) args.push('--incremental')
      const { stdout } = await exec(python, [runnerPath(), ...args], {
        env: spawnEnv(picked.apiKey ? { GRAPHIFY_API_KEY: picked.apiKey } : {}),
        timeout: 10 * 60_000,
        maxBuffer: 16 * 1024 * 1024
      })
```

- [ ] **Step 2: Add an explicit `--model` argument for the two Anthropic-backed backends.** The vendored runner (`resources/graphify_runner.py:43`) already defines `b.add_argument("--model", default=None)` and forwards it to the extraction call — today AskToto never sets it, so the external `graphifyy` package's own default applies. Replace the block with:

```ts
      const notes = resolveMeetingsFolder(getSettings())
      // Graph extraction is explicitly exempt from the CLI/Anthropic interactive guardrail (see
      // shared/providers.ts applyInteractiveGuardrail) — it's a bounded, infrequent background job where
      // extraction quality matters more than per-call cost, so it's allowed to reach for Opus. 'openai'
      // gets no override (no Anthropic Opus equivalent) — unchanged, whatever graphifyy's own default is.
      const modelArg =
        picked.backend === 'claude-cli' ? 'opus' : picked.backend === 'claude' ? 'claude-opus-4-8' : undefined
      const args = [
        'build', '--input', notes, '--out', outDir(), '--backend', picked.backend,
        ...(modelArg ? ['--model', modelArg] : [])
      ]
      if (incremental) args.push('--incremental')
      const { stdout } = await exec(python, [runnerPath(), ...args], {
        env: spawnEnv(picked.apiKey ? { GRAPHIFY_API_KEY: picked.apiKey } : {}),
        timeout: 10 * 60_000,
        maxBuffer: 16 * 1024 * 1024
      })
```

- [ ] **Step 3: Gate.** Run `npm test -- graphify.test.ts` (the file exists per this repo's test list — `src/main/graphify.test.ts`). If any existing test asserts the exact `args` array passed to `exec()` for a `'claude-cli'` or `'claude'` backend, update the expected array to include the new `--model` pair; if a test asserts the `'openai'` backend's args, confirm it still passes unchanged (no `--model` added for that backend).

- [ ] **Step 4: Gate.** Run `npm run typecheck && npm test` — full suite green.

- [ ] **Step 5: Commit**

```bash
git add src/main/graphify.ts
git commit -m "graphify (Graph): pass --model opus for Anthropic-backed extraction"
```

### Task 5: Settings UI reflects the Anthropic lock

**Note on scope:** `claude-cli`'s Settings presence is the "CLI Integration" card section (~line 1048,
`title="CLI Integration"`) — a connect/status card with no Base/Thinking model text inputs at all
(verified this session by reading lines 1048-1102). There is nothing to disable there; the guardrail
for CLI is enforced entirely by Task 2 and is invisible in Settings by design. Only `anthropic`'s
existing generic API-key card (a *different* section, lines 636-676) has editable model inputs that
need the lock treatment below.

**Files:**
- Modify: `src/renderer/src/components/Settings.tsx:636-671` (the Base model / Thinking model inputs, inside whatever component renders one provider's API-key card — re-read the surrounding ~100 lines first to get the exact component/prop names, since this session did not modify this file and it may have shifted slightly from other concurrent work)

**Interfaces:**
- Consumes: nothing new — reads `provider` (the card's own provider id, a local variable/prop already in scope at this point in the file) and `settings.managedKeys` (existing pattern already used on the same lines for the `providerModels`/`providerModelsThinking` managed-lock chip).

- [ ] **Step 1: Read the current Base model input block** (~line 636-653) and **Thinking model input block** (~line 654-671) in full, plus 20 lines above for the enclosing component's parameter list (need the exact `provider` variable name in scope — it's used elsewhere on these lines, e.g. `providerModels[provider]`).

- [ ] **Step 2: Add an Anthropic-specific disabled+locked state to the Base model input.** The existing pattern (same lines) already disables the input when `settings.managedKeys.includes('providerModels')` and dims it with `opacity-60`, plus renders a `<ManagedChip>` next to it. Extend the *same* disabled condition to also cover the guardrail lock — do not introduce a second, differently-styled lock UI. Change:

```tsx
                  disabled={settings.managedKeys.includes('providerModels')}
```

  to:

```tsx
                  disabled={provider === 'anthropic' || settings.managedKeys.includes('providerModels')}
```

  and change the className's conditional opacity in the same block from:

```tsx
                  className={['w-full', ctl, settings.managedKeys.includes('providerModels') ? 'opacity-60' : ''].join(' ')}
```

  to:

```tsx
                  className={[
                    'w-full', ctl,
                    provider === 'anthropic' || settings.managedKeys.includes('providerModels') ? 'opacity-60' : ''
                  ].join(' ')}
```

- [ ] **Step 3: Do the same for the Thinking model input** (the block directly below, ~line 658-670). Change:

```tsx
                disabled={settings.managedKeys.includes('providerModelsThinking')}
```

  to:

```tsx
                disabled={provider === 'anthropic' || settings.managedKeys.includes('providerModelsThinking')}
```

  and its className conditional (same pattern as Step 2) from:

```tsx
                className={['w-full', ctl, settings.managedKeys.includes('providerModelsThinking') ? 'opacity-60' : ''].join(' ')}
```

  to:

```tsx
                className={[
                  'w-full', ctl,
                  provider === 'anthropic' || settings.managedKeys.includes('providerModelsThinking') ? 'opacity-60' : ''
                ].join(' ')}
```

- [ ] **Step 4: Add a one-line explanatory note directly under the Thinking model input**, inside the same `adv &&` block, right after the Thinking model's closing `</div>` and before the `<datalist>` element:

```tsx
            {provider === 'anthropic' && (
              <p className="text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">
                Locked: base always answers as Haiku, thinking as Sonnet — a cost guardrail. Hard/coding
                questions still escalate to Opus automatically; that tier isn't shown here.
              </p>
            )}
```

- [ ] **Step 5: Gate.** Run `npm run typecheck` — must be clean (JSX conditional syntax, no unclosed tags).

- [ ] **Step 6: Live-check** (no automated test exists for this UI region today — do not invent one; verify by hand). Launch the dev app (`npm run dev`), open Settings → AI → the Claude · Anthropic key card → Advanced. Confirm: Base model input shows `claude-haiku-4-5-20251001`, greyed out, not editable. Thinking model input shows `claude-sonnet-4-6`, greyed out, not editable. The new note renders under Thinking model. Take a screenshot for the record.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/components/Settings.tsx
git commit -m "Settings: show the Anthropic base/think guardrail lock as read-only, matching the Dust pattern"
```

### Task 6: Full-suite verification + live audit-log check

**Files:** none (verification only)

- [ ] **Step 1:** `npm run typecheck && npm test` — both green, full test count reported (should be prior total + 5 new tests from Task 1).
- [ ] **Step 2:** `npm run build` — clean production build.
- [ ] **Step 3:** Live: with the Claude Code CLI connected in Settings → CLI Integration, ask a coding question through the bar (e.g. "refactor this function for clarity" or paste a code block). Find the audit log (check `src/main/logger.ts` / wherever `auditLog` writes — likely a local file under userData) and confirm the `provider.request` entry for this turn shows `model: 'sonnet'`, not `'opus'` or `'haiku'`.
- [ ] **Step 4:** Live: with the Anthropic API key connected and selected as the active provider, ask a one-word question (e.g. "hi") — confirm the audit log shows the Haiku id. Ask an analytical question ("compare X and Y") — confirm it shows the Sonnet id. Ask a coding question — confirm it STILL shows the Opus id (proves deep tier is not over-locked).
- [ ] **Step 5:** Report all four live-check results with the actual audit-log lines, not "looks right." If any step fails, stop and fix before declaring done — do not report success on partial verification.
