/**
 * capability-router.ts — the capability, cost and deadline router (Métis 2.12 G29, CAP-19).
 *
 * Pure. Given what a request needs (a capability), how long it has, how much the user will spend, whether the
 * on-device model can serve it and what the fleet model policy allows, it decides the tier, whether the on-device
 * model goes first, and which managed model (if any) the cloud leg may use. It never touches a provider.
 *
 * Invariants:
 *  - It never names a model of its own. The only model it can return is one the signed Operator policy lists for the
 *    capability (after the admin allowlist narrowed it). With no fleet policy it returns `model: null` and the user's
 *    own provider settings decide, exactly as before.
 *  - A request nothing may serve is typed `unavailable` with honest copy. It is never quietly sent somewhere the
 *    organisation or the user did not allow.
 *  - Local-only is honoured: the plan stays on-device and on the base tier, and an on-device model that cannot do the
 *    work makes the request unavailable instead of falling back to a cloud send.
 *  - The existing heuristic (`routeTier` in routing.ts) and the existing local eligibility predicates stay the source
 *    of truth for "what tier would this prompt like" and "may the on-device model serve it". The router lowers or raises
 *    that, it does not re-derive it.
 *
 * The numeric deadline lines below are PROPOSED engineering defaults, not measured results (the Rebuild spec gives one
 * number, the 2.5 s useful-suggestion p95); G90 measures them.
 */
import type { ModelTier } from './providers'
import { resolveModelPolicyCandidates, type ModelPolicyCapability, type ModelPolicyDocument } from './model-policy'

export const ROUTER_CAPABILITIES = [
  'suggest',
  'answer',
  'deep_answer',
  'vision',
  'command_intent',
  'dictation_polish',
  'translate'
] as const
export type RouterCapability = (typeof ROUTER_CAPABILITIES)[number]

export const COST_CLASSES = ['free', 'low', 'standard', 'premium'] as const
export type CostClass = (typeof COST_CLASSES)[number]

const COST_RANK: Record<CostClass, number> = { free: 0, low: 1, standard: 2, premium: 3 }
const TIER_COST: Record<ModelTier, CostClass> = { base: 'low', think: 'standard', deep: 'premium' }
const TIER_RANK: Record<ModelTier, number> = { base: 0, think: 1, deep: 2 }
const TIERS_BY_RANK: readonly ModelTier[] = ['base', 'think', 'deep']

/** PROPOSED. A first-usable-output budget at or under this line answers from the fast tier only. */
export const FAST_ONLY_DEADLINE_MS = 3_000
/** PROPOSED. The deepest tier needs at least this long; below it the plan thinks instead. */
export const DEEP_MIN_DEADLINE_MS = 10_000

/** PROPOSED defaults. `suggest` is the spec's committed-question-to-first-card p95; the rest are engineering guesses G90 replaces. */
export const ROUTER_DEADLINES_MS: Readonly<Record<RouterCapability, number>> = {
  suggest: 2_500,
  answer: 20_000,
  deep_answer: 60_000,
  vision: 25_000,
  command_intent: 4_000,
  dictation_polish: 3_000,
  translate: 4_000
}

const CAPABILITY_LABELS: Record<RouterCapability, string> = {
  suggest: 'live suggestions',
  answer: 'answers',
  deep_answer: 'deeper answers',
  vision: 'screen questions',
  command_intent: 'command understanding',
  dictation_polish: 'dictation cleanup',
  translate: 'live translation'
}

/**
 * The ask modes the router judges. Recap and summary keep their own policy path (`recap`) and are not routed here.
 * An explicit "Go deeper" is a deep answer whatever the first stage was.
 */
export function askCapabilityOf(req: { mode: string; depth?: string }): RouterCapability | null {
  if (req.depth === 'deeper' && (req.mode === 'answer' || req.mode === 'vision')) return 'deep_answer'
  if (req.mode === 'suggest') return 'suggest'
  if (req.mode === 'answer') return 'answer'
  if (req.mode === 'vision') return 'vision'
  return null
}

/**
 * The fleet-policy capability whose model a request may use. Dictation cleanup has no entry in the policy document
 * (ASSUMED: it is not an ask and not a command), so on a managed fleet it has no cloud model, only the on-device one.
 */
export function policyCapabilityFor(capability: RouterCapability): ModelPolicyCapability | null {
  switch (capability) {
    case 'suggest':
    case 'answer':
    case 'deep_answer':
    case 'vision':
      return 'askChat'
    case 'command_intent':
      return 'commandAgent'
    case 'dictation_polish':
      return null
    case 'translate':
      // ASSUMED (G73): transcript processing shares the recap policy; the Operator schema has no translation entry yet.
      return 'recap'
  }
}

export interface RouterInput {
  capability: RouterCapability
  /** The tier the existing heuristic (`routeTier`) asked for. */
  requestedTier: ModelTier
  /** Time left for the first usable output. Null or undefined uses the capability default. */
  deadlineMs?: number | null
  /** The most the user will spend on one request, or null for no ceiling (`thinkingMode: 'never'` is `low`). */
  costCeiling: CostClass | null
  /** The organisation allows on-device processing only. */
  localOnly: boolean
  /** May the on-device model take the first attempt at this tier? (the existing local eligibility predicate) */
  localFirstAt(tier: ModelTier): boolean
  /** May the on-device model answer as the last resort at this tier? (the existing fallback and floor predicates) */
  localLastResortAt(tier: ModelTier): boolean
  /** The verified fleet policy, or null when the organisation has none. */
  policy: ModelPolicyDocument | null
  /** The admin-managed provider allowlist (`null` means unrestricted). */
  orgAllowed: readonly string[] | null
  /** A connected CLI provider could answer. */
  cliReady: boolean
}

export type RouterLimit = 'cost' | 'deadline' | 'local_only'

export interface ManagedModel {
  provider: string
  model: string
}

export interface RoutePlan {
  kind: 'route'
  capability: RouterCapability
  /** The tier the request runs at, after the deadline, cost ceiling and local-only limits. */
  tier: ModelTier
  /** What lowered the tier (empty when the heuristic's tier stood). */
  limits: RouterLimit[]
  deadlineMs: number
  /** The on-device model takes the first attempt. */
  localFirst: boolean
  localOnly: boolean
  costClass: CostClass
  /** A fleet policy governs this request. */
  managed: boolean
  /** The policy's model for this capability, or null (no policy, local first, or local-only). Never invented. */
  model: ManagedModel | null
}

export type UnavailableReason = 'deadline_expired' | 'local_only_unfit' | 'no_policy_model'

export interface RouteUnavailable {
  kind: 'unavailable'
  capability: RouterCapability
  reason: UnavailableReason
  message: string
}

export type RouteDecision = RoutePlan | RouteUnavailable

const unavailable = (capability: RouterCapability, reason: UnavailableReason): RouteUnavailable => {
  const what = CAPABILITY_LABELS[capability]
  const message =
    reason === 'deadline_expired'
      ? `There was no time left for ${what}, so Métis did not start it. Try again.`
      : reason === 'local_only_unfit'
        ? `Your organization allows on-device processing only, and Métis Local cannot do ${what} on this device right now. Nothing was sent to a cloud provider.`
        : `Your organization has not approved a model for ${what}. Ask your admin to choose one in the Operator portal.`
  return { kind: 'unavailable', capability, reason, message }
}

function lowerTo(tier: ModelTier, rank: number): ModelTier {
  return TIER_RANK[tier] > rank ? TIERS_BY_RANK[rank] : tier
}

/** The router. Order: deadline gate, tier limits, local ability, managed candidates. */
export function routeCapability(input: RouterInput): RouteDecision {
  const { capability } = input
  const deadlineMs = input.deadlineMs ?? ROUTER_DEADLINES_MS[capability]
  if (deadlineMs <= 0) return unavailable(capability, 'deadline_expired')

  let tier = input.requestedTier
  // An explicit "Go deeper" asks for more than the base tier; the user's own cost ceiling still wins below.
  if (capability === 'deep_answer' && tier === 'base') tier = 'think'

  const limits: RouterLimit[] = []
  const limit = (reason: RouterLimit, next: ModelTier): void => {
    if (TIER_RANK[next] >= TIER_RANK[tier]) return
    tier = next
    if (!limits.includes(reason)) limits.push(reason)
  }
  if (input.localOnly) limit('local_only', 'base')
  if (input.costCeiling !== null && input.costCeiling !== 'free') {
    const ceiling = COST_RANK[input.costCeiling]
    if (COST_RANK[TIER_COST[tier]] > ceiling) limit('cost', lowerTo(tier, Math.max(0, ceiling - 1)))
  }
  if (deadlineMs <= FAST_ONLY_DEADLINE_MS) limit('deadline', 'base')
  else if (deadlineMs < DEEP_MIN_DEADLINE_MS) limit('deadline', lowerTo(tier, 1))

  const localFirst = input.localFirstAt(tier)
  const localCanServe = localFirst || input.localLastResortAt(tier)

  if (input.localOnly && !localCanServe) return unavailable(capability, 'local_only_unfit')

  const policyCapability = policyCapabilityFor(capability)
  const managed = input.policy !== null
  const candidates =
    input.policy && policyCapability
      ? resolveModelPolicyCandidates(input.policy, policyCapability, input.orgAllowed)
      : []
  if (!input.localOnly && managed && candidates.length === 0 && !input.cliReady && !localCanServe) {
    return unavailable(capability, 'no_policy_model')
  }

  const model: ManagedModel | null =
    input.localOnly || localFirst || !candidates[0]
      ? null
      : { provider: candidates[0].provider, model: candidates[0].model }

  return {
    kind: 'route',
    capability,
    tier,
    limits,
    deadlineMs,
    localFirst,
    localOnly: input.localOnly,
    costClass: localFirst || input.localOnly ? 'free' : TIER_COST[tier],
    managed,
    model
  }
}
