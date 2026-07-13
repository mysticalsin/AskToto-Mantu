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

/** Ask modes Métis Local is scoped to in v1 — never answer/recap; only opted-in vision may exceed base tier. */
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
 * present in the installer, and the org allowlist (if any) permits 'local'. This is `localReady` in the settings
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
 * so an out-of-scope mode (answer/recap, or a text request escalated off the base tier) can never become
 * Métis Local's first attempt OR a failover target. Vision is the deliberate exception to the tier gate:
 * once the user enables local screenshots, prompt complexity must not silently turn a local image into a
 * cloud upload (PLAN.md §4.3: "enforced at BOTH gates").
 */
export function localEligibleFor(
  req: { mode: AskMode },
  s: Pick<Settings, 'localLlm'>,
  tier: ModelTier,
  allowed: string[] | null
): boolean {
  if (!isLocalScopedMode(req.mode)) return false
  if (req.mode !== 'vision' && tier !== 'base') return false
  if (!s.localLlm.useFor[req.mode]) return false
  return localBaseReady(s, allowed)
}

/**
 * The screenshot toggle is a privacy policy, not only a routing preference. It is intentionally based on
 * user intent rather than current runtime readiness: if installer assets are damaged or org policy blocks
 * local, the request must fail locally with no upload instead of quietly selecting a cloud provider.
 */
export function localVisionPrivacyRequired(
  req: { mode: AskMode },
  s: Pick<Settings, 'localLlm'>
): boolean {
  return req.mode === 'vision' && s.localLlm.enabled && s.localLlm.useFor.vision
}

/**
 * Whether the local:prewarm IPC handler (PLAN.md §4.4's pre-warm path, Rock 5) should even attempt to
 * warm the sidecar for THIS settings snapshot. Deliberately narrower than localBaseReady/localEligibleFor:
 * prewarm is a best-effort, fire-and-forget cache-warming ping debounced on every live transcript tick,
 * not a real answer path — a runtime/model that isn't actually provisioned just makes
 * ensureLocalRuntimeStarted() (local.ts) reject, which the handler already swallows. Binary/file-presence
 * checks stay excluded for that reason. The org allowlist IS checked (F6 hardening): without it, an org
 * that excludes 'local' would still have its sidecar spun up and warmed by every prewarm tick even though
 * no real request could ever route to it — a pointless spawn + standing RAM/CPU cost with no product
 * benefit, not merely a redundant check.
 */
export function localPrewarmEligible(s: Pick<Settings, 'localLlm'>, allowed: string[] | null): boolean {
  return s.localLlm.enabled && s.localLlm.useFor.suggest && (!allowed || allowed.includes('local'))
}

/**
 * Precedence for the FIRST provider an ask attempts (index.ts's entry point, PLAN.md §4.3 "Routing
 * precedence, explicit"): an opted-in screenshot privacy policy wins first; otherwise an explicit
 * providerOverride wins (Dust cascades, Spotlight Ref); else 'local' when it's eligible for this specific
 * request; else the CLI-priority primary; else the user's globally active provider. cliPrimary deliberately
 * LOSES to a locally-eligible request — Métis Local is meant to short-circuit even a connected CLI
 * subscription for in-scope suggest/summary/vision asks.
 */
export function pickPrimaryProvider(
  providerOverride: ProviderId | undefined,
  localEligible: boolean,
  cliPrimary: ProviderId | undefined,
  activeProvider: ProviderId,
  localVisionRequired = false
): ProviderId {
  if (localVisionRequired) return 'local'
  if (providerOverride) return providerOverride
  if (localEligible) return 'local'
  if (cliPrimary) return cliPrimary
  return activeProvider
}
