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
import { isDownloaded, assertRamOk } from './local-models'

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

/** MQA-018: the machine's RAM against the model's declared floor. `isDownloaded` is a file-SIZE check
 *  only, so on a box below `minTotalRamGB` every local call still throws InsufficientRamError from
 *  verifyIntegrity — deterministically, forever — while eligibility claimed local was ready. listModels()
 *  already reports exactly this as `unavailableReason: 'insufficient-ram'`; without it here the snapshot
 *  and the routing decision assert opposite things about the same machine. Same defensive shape as
 *  safeIsDownloaded: an unknown model id degrades to "not ready", never throws into a routing decision. */
function safeRamOk(modelId: string): boolean {
  try {
    assertRamOk(modelId)
    return true
  } catch {
    return false
  }
}

/**
 * Task-independent local readiness: enabled, the runtime binary is provisioned, the configured model is
 * present in the installer AND loadable on this machine's RAM, and the org allowlist (if any) permits
 * 'local'. This is `localReady` in the settings snapshot (index.ts's publicSettings()) and the shared base
 * every per-task *Ready flag and localEligibleFor build on — one definition, so the snapshot and the live
 * routing decision can never drift apart.
 */
export function localBaseReady(s: Pick<Settings, 'localLlm'>, allowed: string[] | null): boolean {
  if (!s.localLlm.enabled) return false
  if (allowed && !allowed.includes('local')) return false
  if (!localRuntimeBinaryPresent()) return false
  if (!safeIsDownloaded(s.localLlm.modelId)) return false
  if (!safeRamOk(s.localLlm.modelId)) return false
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
 * "Local as safety net" (localLlm.fallback): whether 'local' may serve THIS request as the strictly-LAST
 * resort once every cloud/CLI route is exhausted or none was ever configured. Deliberately ignores the
 * per-mode useFor opt-in — useFor[mode] means "local FIRST for this mode" (it preempts a configured
 * cloud provider via pickPrimaryProvider), while fallback means "local LAST, only when nothing else can
 * answer". Everything else about local's v1 scope still binds: in-scope modes only (never answer/recap),
 * base tier only for text (the same gate localEligibleFor enforces — a deep/thinking escalation must not
 * land on the small bundled model just because cloud is down), and the full localBaseReady() eligibility
 * (enabled + provisioned + org allowlist permits 'local'). index.ts consults this at the same two seams
 * as localEligibleFor — the ineligible chain and pickFailover's candidate filter — plus the primary pick
 * when NO other provider is ready at all, so a zero-API-key install still gets in-scope answers instead
 * of "no provider" while a capable model sits on disk.
 */
export function localFallbackEligibleFor(
  req: { mode: AskMode },
  s: Pick<Settings, 'localLlm'>,
  tier: ModelTier,
  allowed: string[] | null
): boolean {
  if (!s.localLlm.fallback) return false
  if (!isLocalScopedMode(req.mode)) return false
  if (req.mode !== 'vision' && tier !== 'base') return false
  return localBaseReady(s, allowed)
}

/**
 * The ABSOLUTE floor: may 'local' answer THIS request as the strictly-last resort even for a mode that is
 * out of its normal v1 scope (answer/recap) and at any tier? This is the "worst case, no API needed"
 * guarantee — when every cloud/CLI provider is exhausted (rate-limited, out of credit, capped, or simply
 * not configured) and even the free-aggregator hop can't serve, a weak on-device answer beats handing the
 * user an error. Deliberately looser than localFallbackEligibleFor (which stays scoped to suggest/summary/
 * vision at base tier, the modes local is actually good at): this ignores mode-scope and tier because the
 * alternative here is not "a better cloud answer" but "no answer at all".
 *
 * Gated only on the same safety-net toggle (localLlm.fallback) and base readiness. index.ts's pickFailover
 * places this DEAD LAST — after even a cooling cloud provider that might recover — so it can never preempt
 * a real provider; it only catches the case where the walk would otherwise dead-end at null.
 */
export function localAnswerFloorEligibleFor(
  req: { mode: AskMode },
  s: Pick<Settings, 'localLlm'>,
  allowed: string[] | null
): boolean {
  if (!s.localLlm.fallback) return false
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
export function localPrewarmEligible(
  s: Pick<Settings, 'localLlm' | 'resilience'>,
  allowed: string[] | null,
  cloudReady = true
): boolean {
  if (!s.localLlm.enabled) return false
  if (allowed && !allowed.includes('local')) return false
  // "Local first for suggestions" — the original condition: local WILL serve the next suggest.
  if (s.localLlm.useFor.suggest) return true
  // The hedge now starts an on-device backup at t=0 on every interactive ask (index.ts's hedgeDelayMs),
  // so the MQA-006 rationale below — "nothing would route to it while cloud is healthy" — no longer
  // holds: something routes to it on EVERY ask. Left cold, that leg spawns a ~730 MB load mid-request,
  // loses the race it was started to win, and competes for CPU with the cloud stream it cannot beat.
  // Warming on intent makes the race real. The sidecar still idle-stops after 15 minutes
  // (local-runtime.ts IDLE_STOP_MS), so this buys speed without a permanently resident model.
  if (s.resilience?.hedge === true && s.localLlm.fallback === true) return true
  // MQA-006: with useFor defaulting off, a zero-API-key install never satisfied the condition above, so
  // the on-device model was always COLD when the fallback finally routed to it — and a cold ~730 MB load
  // overruns askStart's 15s suggest idle budget, so the user's very first live suggestion on a fresh
  // install timed out. Warm it only when local is genuinely the likely server (fallback armed AND no
  // cloud/CLI provider is ready); with a healthy cloud provider configured this stays false, so a
  // sidecar is never spawned for its standing RAM cost when nothing would route to it.
  // Coerced, not just returned: a settings object from an older profile (or a test fixture) may carry no
  // `fallback` key at all, and a bare `undefined` leaking out of a boolean-typed predicate makes every
  // caller's strict comparison quietly wrong.
  return s.localLlm.fallback === true && !cloudReady
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

/**
 * Whether a request may fail over to a DIFFERENT provider when its primary can't answer.
 *
 * A request pinned to a specific Dust agent (`agentOverride` — e.g. the hard-locked Spotlight Ref sales-
 * reference agent) has NO valid cross-provider failover target: that managed agent lives only in Dust, so
 * answering from the active generic provider (e.g. Kimi/Anthropic) would silently return a reply that never
 * touched the agent. When the pinned agent can't answer, the honest outcome is the reconnect-Dust message,
 * not a substitute answer. `agentOverride` is Dust-only by construction (ipc.ts AskStart, index.ts's
 * `agentOverride && provider === 'dust'` model gate), so this is exactly the "pinned to one managed agent"
 * signal. A plain `providerOverride: 'dust'` cascade WITHOUT agentOverride (recap/summary) is NOT pinned and
 * still fails over — the designed "Dust down → your configured cloud provider takes over" waterfall.
 *
 * index.ts consults this at both failover seams (the retry-budget sizing and the pre-token failover), via
 * pickFailover, so the two can never drift apart (same rationale that extracted this whole module).
 */
export function allowCrossProviderFailover(req: { agentOverride?: string }): boolean {
  return !req.agentOverride
}
