# Métis Provider Routing Policy

**Source of truth in code:** `src/main/llm/local-routing.ts`, ask pipeline in `src/main/index.ts`, resilience settings in `src/shared/ipc.ts`.

## Routing modes (Wave 2)

| Mode | Setting | Behavior |
|---|---|---|
| **Local** | `routingMode: 'local'` | Prefer Métis Local / Apple FM for every eligible mode. Escalate to cloud only on hard failure; show a one-shot status chip. |
| **API** | `routingMode: 'api'` | Use `provider` / `providerFallbackOrder`. Local is not first; local floor still applies when `localLlm.fallback` and everything else is exhausted. |
| **Auto** | `routingMode: 'auto'` (default) | Health + headroom + free-tier exhaustion + per-mode `localLlm.useFor` + hedge race. |

Legacy installs without `routingMode` behave as **auto**.

## Precedence (auto / shared)

1. **Vision privacy** — `localVisionPrivacyRequired` forces `local` (never upload a screenshot the user marked local-only).
2. **Pinned override** — `providerOverride` / Dust `agentOverride`. Pinned Dust agent → no cross-provider hop (`allowCrossProviderFailover`).
3. **Local first** — `localEligibleFor`: mode ∈ {suggest, summary, vision}, base tier (vision excepted), `localLlm.useFor[mode]`, binary + model + RAM ready.
4. **CLI primary** — when `providerPriority === 'cli'` and a CLI provider is connected.
5. **Active provider** — `settings.provider` (kept in sync with the head of `providerFallbackOrder`).
6. **Exhaustion / health** — `preferFreeOnExhaustion`, provider cooldowns (`provider-health.ts`), usage headroom preempt.
7. **Hedge** — `resilience.hedge`: race a backup after ~3s (0s when backup is local).
8. **Local fallback** — `localFallbackEligibleFor` (in-scope modes) then `localAnswerFloorEligibleFor` (any mode) when `localLlm.fallback`.

## Mode scope (v1)

Métis Local is **not** a general answer/recap engine unless the answer floor is the only remaining route. Recap prefers cloud/CLI/Dust; local `summary` is the degraded but honest path when no cloud key exists.

## Warm-up

`localPrewarmEligible` warms the sidecar when fallback is armed and no cloud is ready, or when hedge + fallback are on — so the first failover does not pay a cold ~730 MB load.

## UI surfaces

- Settings → **AI → Routing** — `routingMode`
- Settings → **Local AI** — enabled, useFor, fallback
- Settings → **Backups & limits** — prefer free, budget preempt, hedge, fallback order
- Status chip — last failover reason (non-noisy: once per session unless Settings opened)

## Invariants (contract-tested)

- Out-of-scope modes never pick local as *first* attempt via `useFor`.
- Pinned Dust agent never silently hops to OpenAI/Anthropic.
- Transcript save never depends on recap provider success.
