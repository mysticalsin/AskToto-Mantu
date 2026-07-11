/**
 * local-routing.ts — pure, unit-testable routing/eligibility logic for the 'local' provider (Métis
 * Local). Extracted out of index.ts's askStart closure (attempt()/pickFailover are nested functions over
 * a per-request closure, not exported) so PLAN.md §4.3's mode-scope contract has a real, direct test
 * surface instead of only being reachable through the full IPC handler. index.ts imports and calls these
 * helpers verbatim at every seam the plan calls out: the ineligible chain (replaces the generic key/model
 * checks for provider === 'local'), pickFailover's candidate filter (so local can never be a failover
 * target for an out-of-scope mode), the entry point's first-attempt precedence, and the settings snapshot
 * (localReady + per-task *Ready flags).
 */
import { existsSync } from 'node:fs'
import type { AskMode, Settings } from '@shared/ipc'
import type { ModelTier, ProviderId } from '@shared/providers'
import { resolveBinaryPath, detectPlatform } from './local-runtime'
import { isDownloaded } from './local-models'

/** Ask modes Métis Local is scoped to in v1 (PLAN.md §4.1/§4.3) — never answer/recap, never think/deep. */
const LOCAL_SCOPED_MODES: ReadonlySet<AskMode> = new Set(['suggest', 'summary', 'vision'])

function isLocalScopedMode(mode: AskMode): mode is 'suggest' | 'summary' | 'vision' {
  return LOCAL_SCOPED_MODES.has(mode)
}

/** True when the llama-server sidecar binary for THIS platform exists on disk (mac's single build, or
 *  either of win's Vulkan/CPU pair). Doesn't prove it can actually spawn or load a model — a genuine spawn
 *  failure still fails over via local-runtime.ts's own crash/restart-budget handling; this only gates
 *  whether Métis Local is offered as a route at all (i.e. the fetch-llama-server.mjs provisioning step
 *  actually ran on this install). */
export function localRuntimeBinaryPresent(): boolean {
  return resolveBinaryPath(detectPlatform()).some((c) => existsSync(c.path))
}

/** isDownloaded() throws on an unknown model id (local-models.ts's getModel()) — a stale or removed
 *  manifest id surviving in a user's persisted settings.localLlm.modelId must degrade to "not ready",
 *  never crash the settings snapshot or the ask pipeline. */
function safeIsDownloaded(modelId: string): boolean {
  try {
    return isDownloaded(modelId)
  } catch {
    return false
  }
}

/**
 * Task-independent local readiness: enabled, the runtime binary is provisioned, the configured model is
 * fully downloaded, and the org allowlist (if any) permits 'local'. This is `localReady` in the settings
 * snapshot (index.ts's publicSettings()) and the shared base every per-task *Ready flag and
 * localEligibleFor build on — one definition, so the snapshot and the live routing decision can never
 * drift apart.
 */
export function localBaseReady(s: Pick<Settings, 'localLlm'>, allowed: string[] | null): boolean {
  if (!s.localLlm.enabled) return false
  if (allowed && !allowed.includes('local')) return false
  if (!localRuntimeBinaryPresent()) return false
  if (!safeIsDownloaded(s.localLlm.modelId)) return false
  return true
}

/**
 * Whether the 'local' provider is eligible for THIS specific request right now. REPLACES the generic
 * key/model eligibility checks the cloud providers go through — index.ts's attempt() ineligible chain and
 * pickFailover's candidate filter both call this instead of the generic logic for provider === 'local' —
 * so an out-of-scope mode (answer/recap, or any request escalated off the base tier) can never become
 * Métis Local's first attempt OR a failover target (PLAN.md §4.3: "enforced at BOTH gates").
 */
export function localEligibleFor(
  req: { mode: AskMode },
  s: Pick<Settings, 'localLlm'>,
  tier: ModelTier,
  allowed: string[] | null
): boolean {
  if (tier !== 'base') return false
  if (!isLocalScopedMode(req.mode)) return false
  if (!s.localLlm.useFor[req.mode]) return false
  return localBaseReady(s, allowed)
}

/**
 * Whether the local:prewarm IPC handler (PLAN.md §4.4's pre-warm path, Rock 5) should even attempt to
 * warm the sidecar for THIS settings snapshot. Deliberately narrower than localBaseReady/localEligibleFor:
 * prewarm is a best-effort, fire-and-forget cache-warming ping debounced on every live transcript tick,
 * not a real answer path — a runtime/model that isn't actually provisioned yet just makes
 * ensureLocalRuntimeStarted() (local.ts) reject, which the handler already swallows. The two settings
 * checks are the only gate worth paying on every tick; no allowlist/binary/download check needed here.
 */
export function localPrewarmEligible(s: Pick<Settings, 'localLlm'>): boolean {
  return s.localLlm.enabled && s.localLlm.useFor.suggest
}

/**
 * Precedence for the FIRST provider an ask attempts (index.ts's entry point, PLAN.md §4.3 "Routing
 * precedence, explicit"): an explicit providerOverride always wins (Dust cascades, Spotlight Ref); else
 * 'local' when it's eligible for this specific request; else the CLI-priority primary; else the user's
 * globally active provider. cliPrimary deliberately LOSES to a locally-eligible request — Métis Local is
 * meant to short-circuit even a connected CLI subscription for in-scope suggest/summary/vision asks.
 */
export function pickPrimaryProvider(
  providerOverride: ProviderId | undefined,
  localEligible: boolean,
  cliPrimary: ProviderId | undefined,
  activeProvider: ProviderId
): ProviderId {
  if (providerOverride) return providerOverride
  if (localEligible) return 'local'
  if (cliPrimary) return cliPrimary
  return activeProvider
}
