/**
 * InterventionPolicy: the deterministic admission policy around an optional classifier.
 *
 * Ported from the reference kernel (intervention-policy.mjs) with the named constants in
 * intervention-contract.ts. It decides whether the existing live copilot should generate a card. It
 * never writes the answer and never executes a desktop action.
 *
 * IMPORTANT INTEGRATION BOUNDARY: `existingRules` is a heuristic opportunity decision ONLY, not
 * authorization. A score may permit generation when that heuristic returned false. The caller must
 * separately enforce hard eligibility BEFORE evaluate, again inside the injected classify seam before
 * any network request, and before invoking the main generator: auto-assist switch, consent,
 * local-only/network policy, entitlement, quota and capture/session authority. Session identity and
 * freshness checks do not authorize network access.
 *
 * One instance per session context. Any classifier failure disables this optional layer for that
 * session (a deliberately simpler breaker than the Canary app-wide latch/backoff).
 */
import {
  DEFAULT_INTERVENTION_THRESHOLDS,
  INTERVENTION_CLASSIFIER_TIMEOUT_MS,
  INTERVENTION_INPUT_MAX_UTF8_BYTES,
  INTERVENTION_LIVE_FRAGMENT_MAX_UTF8_BYTES,
  INTERVENTION_MAX_FINAL_MESSAGES,
  INTERVENTION_MAX_REQUEST_INTERVAL_MS,
  INTERVENTION_MESSAGE_MAX_UTF8_BYTES,
  INTERVENTION_MIN_REQUEST_INTERVAL_MS,
  INTERVENTION_OBJECTIVE_MAX_UTF8_BYTES,
  INTERVENTION_PARTIAL_DEBOUNCE_MS,
  INTERVENTION_SCHEMA_VERSION,
  INTERVENTION_SCORE_NAMES,
  INTERVENTION_SHORT_FRAGMENT_CODE_POINTS,
  INTERVENTION_CARD_TEXT_MAX_UTF8_BYTES,
  InterventionError,
  assertInterventionByteBudget,
  assertSameScope,
  clipUtf8,
  freezeDeep,
  interventionExistingRulesSchema,
  interventionInputBytes,
  requireCondition,
  utf8ByteLength,
  validateInterventionScores,
  type InterventionBudget,
  type InterventionContext,
  type InterventionDecision,
  type InterventionExistingRules,
  type InterventionInput,
  type InterventionScope,
  type InterventionScoreName,
  type InterventionScores,
  type InterventionSnapshot,
  type InterventionStatus,
  type InterventionThresholds,
  isInterventionId
} from '../intervention-contract'

export interface BuildInterventionInputOptions {
  liveFragment?: string
  currentCard?: { scope: InterventionScope; id: string; text: string } | null
  maxFinalMessages?: number
  maxUtf8Bytes?: number
}

export interface BuiltInterventionInput {
  readonly input: InterventionInput
  readonly budget: InterventionBudget
}

/**
 * Builds the classifier input under one hard UTF-8 byte cap. This is a byte budget on the serialized
 * input, not a model-token estimate. The oldest selected messages are dropped first so the newest
 * evidence survives; only a very small custom budget shortens the objective, fragment or card.
 */
export function buildInterventionInput(
  snapshot: InterventionSnapshot,
  options: BuildInterventionInputOptions = {}
): BuiltInterventionInput {
  const {
    liveFragment = '',
    currentCard = null,
    maxFinalMessages = INTERVENTION_MAX_FINAL_MESSAGES,
    maxUtf8Bytes = INTERVENTION_INPUT_MAX_UTF8_BYTES
  } = options
  requireCondition(
    Number.isInteger(maxFinalMessages) && maxFinalMessages >= 0 && maxFinalMessages <= INTERVENTION_MAX_FINAL_MESSAGES,
    'INTERVENTION_MESSAGE_LIMIT'
  )
  assertInterventionByteBudget(maxUtf8Bytes)
  requireCondition(typeof liveFragment === 'string' && liveFragment.length <= 65_536, 'INTERVENTION_TEXT')
  requireCondition(Array.isArray(snapshot.transcript?.segments), 'INTERVENTION_TRANSCRIPT')
  assertSameScope(snapshot.scope, snapshot.transcript.scope)
  if (currentCard !== null) {
    assertSameScope(snapshot.scope, currentCard.scope)
    requireCondition(isInterventionId(currentCard.id) && typeof currentCard.text === 'string', 'INTERVENTION_CARD')
    requireCondition(currentCard.text.length <= 65_536, 'INTERVENTION_TEXT')
  }
  const selected = maxFinalMessages === 0 ? [] : snapshot.transcript.segments.slice(-maxFinalMessages)
  const finalMessages = selected.map((segment) => {
    assertSameScope(snapshot.scope, segment.scope)
    requireCondition(
      segment.state === 'final' &&
        isInterventionId(segment.utteranceId) &&
        isInterventionId(segment.streamId) &&
        isInterventionId(segment.speakerId) &&
        Number.isSafeInteger(segment.revision) &&
        segment.revision > 0 &&
        Number.isSafeInteger(segment.streamEpoch) &&
        segment.streamEpoch > 0,
      'INTERVENTION_SEGMENT'
    )
    return {
      streamId: segment.streamId,
      streamEpoch: segment.streamEpoch,
      utteranceId: segment.utteranceId,
      revision: segment.revision,
      speakerId: segment.speakerId,
      text: clipUtf8(segment.text, INTERVENTION_MESSAGE_MAX_UTF8_BYTES)
    }
  })
  const input: InterventionInput = {
    schemaVersion: INTERVENTION_SCHEMA_VERSION,
    scope: { ...snapshot.scope },
    generation: snapshot.generation,
    contextRevision: snapshot.contextRevision,
    objective: clipUtf8(snapshot.objective, INTERVENTION_OBJECTIVE_MAX_UTF8_BYTES),
    finalMessages,
    liveFragment: clipUtf8(liveFragment, INTERVENTION_LIVE_FRAGMENT_MAX_UTF8_BYTES),
    currentCard:
      currentCard === null
        ? null
        : { id: currentCard.id, text: clipUtf8(currentCard.text, INTERVENTION_CARD_TEXT_MAX_UTF8_BYTES) }
  }
  // Discard the oldest selected messages first. Preserve the newest evidence under a finite budget.
  while (interventionInputBytes(input) > maxUtf8Bytes && input.finalMessages.length > 0) input.finalMessages.shift()
  // An unusually small custom budget may also require shortening non-transcript text.
  while (interventionInputBytes(input) > maxUtf8Bytes) {
    const fields: Array<{ owner: { [key: string]: unknown }; name: string }> = [
      { owner: input as unknown as { [key: string]: unknown }, name: 'objective' },
      { owner: input as unknown as { [key: string]: unknown }, name: 'liveFragment' }
    ]
    if (input.currentCard) fields.push({ owner: input.currentCard, name: 'text' })
    fields.sort((a, b) => utf8ByteLength(b.owner[b.name] as string) - utf8ByteLength(a.owner[a.name] as string))
    const largest = fields[0]
    const current = largest.owner[largest.name] as string
    requireCondition(utf8ByteLength(current) > 0, 'INTERVENTION_BUDGET_TOO_SMALL')
    largest.owner[largest.name] = clipUtf8(current, Math.floor(utf8ByteLength(current) / 2))
  }
  return freezeDeep({
    input,
    budget: {
      utf8Bytes: interventionInputBytes(input),
      maxUtf8Bytes,
      finalMessagesUsed: input.finalMessages.length,
      finalMessagesAvailable: snapshot.transcript.segments.length
    }
  })
}

export type InterventionTrigger = { kind: 'final' } | { kind: 'partial'; stableForMs: number }

export type InterventionClassifier = (input: InterventionInput, signal: AbortSignal) => Promise<unknown> | unknown

export interface InterventionPolicyOptions {
  classify: InterventionClassifier
  /** Off by default: a disabled gate returns the existing rules untouched. */
  enabled?: boolean
  timeoutMs?: number
  stablePartialMs?: number
  shortFragmentCodePoints?: number
  thresholds?: InterventionThresholds
  inputBudget?: { maxFinalMessages?: number; maxUtf8Bytes?: number }
  /** Minimum spacing between classifier call starts (ASSUMED 1,100 ms, Canary default). */
  minIntervalMs?: number
  /** Monotonic clock in ms; injectable for tests. */
  now?: () => number
}

export interface InterventionPolicyStatus {
  readonly enabled: boolean
  readonly disabledReason: string | null
  readonly busy: boolean
  readonly disposed: boolean
}

export interface InterventionEvaluateRequest<S extends InterventionSnapshot> {
  snapshot: S
  existingRules: InterventionExistingRules
  liveFragment?: string
  currentCard?: { scope: InterventionScope; id: string; text: string } | null
  trigger?: InterventionTrigger
}

const STALE_CONTEXT = 'stale-context'
const CLASSIFIER_TIMEOUT = 'classifier-timeout'

const defaultNow = (): number => performance.now()

export class InterventionPolicy<S extends InterventionSnapshot = InterventionSnapshot> {
  private readonly context: InterventionContext<S>
  private readonly classify: InterventionClassifier
  private enabled: boolean
  private disabledReason: string | null
  private inflight: { controller: AbortController } | null = null
  private disposed = false
  private readonly unsubscribe: () => unknown
  private readonly timeoutMs: number
  private readonly stablePartialMs: number
  private readonly shortFragmentCodePoints: number
  private readonly thresholds: InterventionThresholds
  private readonly inputBudget: { maxFinalMessages?: number; maxUtf8Bytes?: number }
  private readonly minIntervalMs: number
  private readonly now: () => number
  private lastStartMs: number | null = null

  constructor(context: InterventionContext<S>, options: InterventionPolicyOptions) {
    const {
      classify,
      enabled = false,
      timeoutMs = INTERVENTION_CLASSIFIER_TIMEOUT_MS,
      stablePartialMs = INTERVENTION_PARTIAL_DEBOUNCE_MS,
      shortFragmentCodePoints = INTERVENTION_SHORT_FRAGMENT_CODE_POINTS,
      thresholds = DEFAULT_INTERVENTION_THRESHOLDS,
      inputBudget = {},
      minIntervalMs = INTERVENTION_MIN_REQUEST_INTERVAL_MS,
      now = defaultNow
    } = options ?? ({} as InterventionPolicyOptions)
    requireCondition(typeof classify === 'function' && typeof enabled === 'boolean', 'INTERVENTION_CLASSIFIER')
    requireCondition(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 60_000, 'INTERVENTION_TIMEOUT')
    requireCondition(
      Number.isInteger(stablePartialMs) && stablePartialMs >= 0 && stablePartialMs <= 5_000,
      'PARTIAL_STABILITY'
    )
    requireCondition(
      Number.isInteger(shortFragmentCodePoints) && shortFragmentCodePoints > 0 && shortFragmentCodePoints <= 256,
      'SHORT_FRAGMENT_LIMIT'
    )
    requireCondition(
      Number.isInteger(minIntervalMs) && minIntervalMs >= 0 && minIntervalMs <= INTERVENTION_MAX_REQUEST_INTERVAL_MS,
      'INTERVENTION_INTERVAL'
    )
    const cleanThresholds = { ...thresholds }
    requireCondition(
      Object.keys(cleanThresholds).sort().join(',') ===
        [...INTERVENTION_SCORE_NAMES, 'shortHesitation'].sort().join(','),
      'THRESHOLD_SCHEMA'
    )
    for (const value of Object.values(cleanThresholds)) {
      requireCondition(typeof value === 'number' && value > 0 && value <= 1, 'THRESHOLD_RANGE')
    }
    this.context = context
    this.classify = classify
    this.enabled = enabled
    this.disabledReason = enabled ? null : 'not-enabled'
    this.timeoutMs = timeoutMs
    this.stablePartialMs = stablePartialMs
    this.shortFragmentCodePoints = shortFragmentCodePoints
    this.thresholds = freezeDeep(cleanThresholds)
    this.inputBudget = { ...inputBudget }
    this.minIntervalMs = minIntervalMs
    this.now = now
    this.unsubscribe = context.onChange(() => {
      this.inflight?.controller.abort(STALE_CONTEXT)
    })
  }

  get status(): InterventionPolicyStatus {
    return Object.freeze({
      enabled: this.enabled,
      disabledReason: this.disabledReason,
      busy: this.inflight !== null,
      disposed: this.disposed
    })
  }

  async evaluate(request: InterventionEvaluateRequest<S>): Promise<InterventionDecision> {
    requireCondition(!this.disposed, 'INTERVENTION_DISPOSED')
    const { snapshot, liveFragment = '', currentCard = null, trigger = { kind: 'final' } } = request
    this.context.assertCurrent(snapshot)
    const parsedRules = interventionExistingRulesSchema.safeParse(request.existingRules)
    if (!parsedRules.success) throw new InterventionError('EXISTING_RULE_SCHEMA')
    const rules = parsedRules.data
    // A disabled optional gate must not add new debounce/threshold rules to the established path.
    if (!this.enabled) return this.fallback(snapshot, rules)
    requireCondition(trigger.kind === 'final' || trigger.kind === 'partial', 'INTERVENTION_TRIGGER')
    if (trigger.kind === 'partial') {
      requireCondition(Number.isFinite(trigger.stableForMs) && trigger.stableForMs >= 0, 'PARTIAL_STABILITY')
      if (trigger.stableForMs < this.stablePartialMs) return this.result(snapshot, 'held', false, 'PARTIAL_NOT_STABLE')
    }
    // These are opportunity heuristics only. Hard eligibility must already be enforced by the caller.
    // Single flight: no queue and no coalescing. A second admission reports busy immediately.
    if (this.inflight !== null) return this.result(snapshot, 'busy', false, 'CLASSIFIER_BUSY')
    const startedAt = this.now()
    if (this.lastStartMs !== null && startedAt - this.lastStartMs < this.minIntervalMs) {
      return this.result(snapshot, 'held', false, 'MIN_REQUEST_INTERVAL')
    }
    const bounded = buildInterventionInput(snapshot, { ...this.inputBudget, liveFragment, currentCard })
    const controller = new AbortController()
    const owner = { controller }
    this.inflight = owner
    this.lastStartMs = startedAt
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    try {
      const interrupted = new Promise<never>((_, reject) => {
        onAbort = () => reject(controller.signal.reason)
        controller.signal.addEventListener('abort', onAbort, { once: true })
      })
      timer = setTimeout(() => controller.abort(CLASSIFIER_TIMEOUT), this.timeoutMs)
      const classified = Promise.resolve().then(() => {
        this.context.assertCurrent(snapshot)
        if (controller.signal.aborted) throw controller.signal.reason
        return this.classify(bounded.input, controller.signal)
      })
      const raw = await Promise.race([classified, interrupted])
      if (controller.signal.aborted || !this.context.isCurrent(snapshot)) {
        return this.result(snapshot, 'stale', false, 'STALE_CLASSIFICATION')
      }
      const scores = validateInterventionScores(raw)
      const points = [...bounded.input.liveFragment.trim()].length
      const hesitation =
        points > 0 && points <= this.shortFragmentCodePoints
          ? this.thresholds.shortHesitation
          : this.thresholds.hesitation
      const effective: Record<InterventionScoreName, number> = {
        question: this.thresholds.question,
        objection: this.thresholds.objection,
        hesitation,
        decision: this.thresholds.decision
      }
      const matched = INTERVENTION_SCORE_NAMES.filter((name) => scores[name] >= effective[name])
      return this.result(
        snapshot,
        'classified',
        matched.length > 0,
        matched.length > 0 ? 'SCORE_THRESHOLD' : 'BELOW_THRESHOLD',
        { scores, thresholds: effective, matched: [...matched], budget: bounded.budget }
      )
    } catch {
      if (!this.context.isCurrent(snapshot) || controller.signal.reason === STALE_CONTEXT || this.disposed) {
        return this.result(snapshot, 'stale', false, 'STALE_CLASSIFICATION')
      }
      this.enabled = false
      this.disabledReason = controller.signal.reason === CLASSIFIER_TIMEOUT ? CLASSIFIER_TIMEOUT : 'classifier-failed'
      return this.fallback(snapshot, rules)
    } finally {
      clearTimeout(timer)
      if (onAbort) controller.signal.removeEventListener('abort', onAbort)
      if (this.inflight === owner) this.inflight = null
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe()
    this.inflight?.controller.abort(STALE_CONTEXT)
  }

  private fallback(snapshot: S, rules: InterventionExistingRules): InterventionDecision {
    this.context.assertCurrent(snapshot)
    return this.result(snapshot, 'existing-rules', rules.shouldGenerate, rules.reason)
  }

  private result(
    snapshot: S,
    status: InterventionStatus,
    shouldGenerate: boolean,
    reason: string,
    detail: {
      scores?: InterventionScores
      thresholds?: Record<InterventionScoreName, number>
      matched?: InterventionScoreName[]
      budget?: InterventionBudget
    } = {}
  ): InterventionDecision {
    return freezeDeep({
      stage: 'intervention-classification' as const,
      status,
      shouldGenerate,
      reason,
      scope: { ...snapshot.scope },
      generation: snapshot.generation,
      contextRevision: snapshot.contextRevision,
      ...(detail.scores ? { scores: { ...detail.scores } } : {}),
      ...(detail.thresholds ? { thresholds: { ...detail.thresholds } } : {}),
      ...(detail.matched ? { matched: [...detail.matched] } : {}),
      ...(detail.budget ? { budget: { ...detail.budget } } : {})
    })
  }
}
