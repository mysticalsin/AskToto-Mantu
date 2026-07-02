# Model-routing guardrail: CLI locked to Sonnet, Anthropic key locked to Haiku/Sonnet, Graph reserves Opus

Date: 2026-07-02
Status: approved (scoped via direct exchange with Tony + code verification; see Verified/Assumed notes)

## Context

AskToto's interactive ask flow auto-escalates model tier per request (`routeTier()` in
`src/shared/routing.ts`): coding/hard questions and `thinkingMode: 'always'` reach the **deep**
tier, which resolves to Opus for both the `claude-cli` and `anthropic` providers today. Tony wants
a cost/safety guardrail, independent of that auto-routing: the CLI provider must never answer as
anything but Sonnet in the interactive flow, and the direct Anthropic API key's base/think tiers
must be pinned to Haiku/Sonnet. Opus stays reachable only through the Graph extraction pipeline
(Mantu Intelligence's `brain/ingest.ts` and the `graphify` knowledge-graph tool), which never goes
through the interactive flow.

**Verified in code** (this session, direct reads — not inferred):
- `PROVIDERS['claude-cli']` ([providers.ts:242-255](../../../src/shared/providers.ts)): `fastModel:'haiku'`, `thinkModel:'sonnet'`, `deepModel:'opus'`. Today a hard/coding question over the CLI reaches `'opus'` via `routeTier`→`'deep'`.
- `PROVIDERS['anthropic']` ([providers.ts:45-53](../../../src/shared/providers.ts)): `fastModel:'claude-haiku-4-5-20251001'`, `thinkModel:'claude-sonnet-4-6'`, `deepModel:'claude-opus-4-8'`. These are already the *fallback* defaults (matches Tony's screenshot exactly) — the gap is that `providerModels`/`providerModelsThinking` are freely user-editable overrides ([ipc.ts:284,294](../../../src/shared/ipc.ts)) that can silently replace them.
- The single choke point for the whole interactive ask/vision/suggest/summary/recap/factcheck flow is `attempt()` in [main/index.ts:1189-1236](../../../src/main/index.ts) — one `resolveModelTier()` call at line 1209 feeds `createStream()`. `failover()`'s own `resolveModelTier()` call (line 1184) is only a truthy eligibility check, unaffected by which literal string wins.
- `brain/ingest.ts`'s `pickProvider()` ([ingest.ts:43-56](../../../src/main/brain/ingest.ts)) calls `resolveModelTier(p, s.providerModels, s.providerModelsThinking, 'base')` directly — its own code path, never touches `attempt()`/`failover()`. Hardcoded to `'base'` tier today.
- `graphify.ts`'s `buildGraph()` ([graphify.ts:217-224](../../../src/main/graphify.ts)) shells out to a vendored `resources/graphify_runner.py` and today passes **no model at all** — the runner's `argparse` already defines `--model` (default `None`) at [graphify_runner.py:43](../../../resources/graphify_runner.py), forwarded to the external `graphifyy` pip package's build call, but AskToto never sets it.

**Assumed** (flagging per verification discipline — not directly testable without the external
`graphifyy` package's source, which isn't vendored): passing `--model opus` for the `claude-cli`
backend and `--model claude-opus-4-8` for the `claude` (API-key) backend will be forwarded correctly
by `graphifyy`, matching the same short-alias-for-CLI / full-id-for-API convention AskToto's own
`resolveModelTier` already uses. Low risk: the flag exists for exactly this purpose and defaults to
`None` today (untouched path), so this is a net-new, isolated change.

## Design

### 1. Pure, testable guardrail function

New export in `src/shared/providers.ts`:

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

No new magic strings — reuses the existing `PROVIDERS` def fields as the single source of truth.

### 2. Wire it into the interactive choke point

In `attempt()` ([main/index.ts:1206-1209](../../../src/main/index.ts)), change `const model =` to
`let model =`, then immediately after:

```ts
model = applyInteractiveGuardrail(provider, tier, model)
```

Everything downstream (`ineligible` check, `auditLog('provider.request', { model, ... })`,
`createStream({ model, ... })`) already reads the `model` variable — no other call site changes.
`auditLog` already records `model` per request, so a live check after shipping is just: ask a
coding question over the CLI, confirm the audit log shows `model: 'sonnet'` not `'opus'`.

### 3. Graph gets its Opus escape hatch

**`brain/ingest.ts`** ([ingest.ts:52](../../../src/main/brain/ingest.ts)): change the tier from
`'base'` to `'deep'` and pass the deep-overrides map (currently omitted):

```ts
const model = resolveModelTier(p, s.providerModels, s.providerModelsThinking, 'deep', s.providerModelsDeep)
```

This is `pickProvider()`'s only change. It never calls `applyInteractiveGuardrail` (different code
path entirely), so it resolves to real `'opus'` / `'claude-opus-4-8'` per provider's `deepModel`.

**`graphify.ts`** ([graphify.ts:217-224](../../../src/main/graphify.ts)): pass `--model` explicitly
based on the picked backend:

```ts
const modelArg =
  picked.backend === 'claude-cli' ? 'opus' : picked.backend === 'claude' ? 'claude-opus-4-8' : undefined
const args = [
  'build', '--input', notes, '--out', outDir(), '--backend', picked.backend,
  ...(modelArg ? ['--model', modelArg] : [])
]
```

`openai` backend gets no `--model` override (no Anthropic Opus equivalent) — unchanged, still
whatever `graphifyy`'s own default is for that backend.

### 4. Settings UI reflects the lock

Per the existing hard-lock pattern (Dust base-agent, [Settings.tsx:1393-1398](../../../src/renderer/src/components/Settings.tsx) — "read-only display below, no picker, no setter"):

- For `claude-cli`: since base/think are now unconditionally clamped, the provider's Base/Thinking
  model inputs (if the CLI Integration card shows them at all — implementer must read the current
  JSX to confirm) become dead controls. Either hide them for this provider or disable + annotate
  ("Locked to Sonnet — see Settings guardrail") so the UI never implies an edit will take effect.
- For `anthropic`: the existing Base/Thinking inputs ([Settings.tsx:636-676](../../../src/renderer/src/components/Settings.tsx)) become disabled with the resolved locked value shown (`claude-haiku-4-5-20251001` / `claude-sonnet-4-6`), same visual treatment as the Dust read-only fields. Deep tier has no UI today and stays that way — unaffected, still freely escalates for genuinely hard questions.

### Out of scope

- No change to `routeTier()`'s heuristics — hard/coding questions still compute tier `'deep'` for
  `claude-cli`/`anthropic`; the guardrail intercepts *after* that, only for these two providers.
- No change to any other provider (openai, deepseek, dust, etc.) or to `codex-cli`.
- No managed-config / enterprise `locked` list entry — this is Tony's own personal guardrail, not an
  org policy, so it's enforced unconditionally in code rather than via the admin-policy mechanism.
- Anthropic's deep tier (Opus) stays reachable from the interactive flow for genuinely hard/coding
  questions — Tony asked to pin base/think only, not to remove Opus escalation on the API-key path.

## Verification

1. `npm run typecheck` + `npm test` green, including new unit tests for `applyInteractiveGuardrail`
   in `src/shared/providers.test.ts`: `claude-cli` returns `'sonnet'` for all three tiers regardless
   of `model` input; `anthropic` returns the Haiku id for `'base'`, the Sonnet id for `'think'`, and
   passes `model` through unchanged for `'deep'`; every other provider/tier passes `model` through
   unchanged.
2. Live: connect the CLI provider, ask a coding question (`isHardQuestion` heuristic) → audit log
   (`provider.request`) shows `model: 'sonnet'`, not `'opus'`. Same with `thinkingMode: 'always'`.
3. Live: with the Anthropic API key connected, ask a one-word question → audit log shows the Haiku
   id; ask an analytical multi-sentence question → shows the Sonnet id; ask a coding question →
   still escalates to the Opus id (deep tier untouched, confirms no over-lock).
4. Settings UI: CLI and Anthropic model fields read as locked/disabled, matching the Dust pattern.
