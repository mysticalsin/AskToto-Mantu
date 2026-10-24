import type { InterventionExistingRules, InterventionSnapshot } from '@shared/intervention-contract'
import type { InterventionOutcome } from '@shared/intervention-shadow'
import type { QuietAction } from '@shared/quiet-mode-settings'
import type { InterventionGate } from './intervention-gate'

/**
 * The question and shadow paths of the live copilot, decided through the InterventionGate (G70). Pure and
 * React-free: the hooks in use-intervention-wiring.ts only supply refs and callbacks.
 *
 * `existingRulesFor*` are today's gates, moved out of App.tsx unchanged. With the classifier off the policy
 * returns them untouched, so behaviour is identical to before this ticket.
 */

export interface FlowSettings {
  autoSuggest?: boolean
  providerReady?: boolean
  localSuggestReady?: boolean
  localFallbackReady?: boolean
  instantSuggestions?: boolean
  suggestEverySec?: number
}

const DEFAULT_SUGGEST_EVERY_SEC = 8

const rule = (shouldGenerate: boolean, reason: string): InterventionExistingRules => ({ shouldGenerate, reason })

export interface QuestionRulesInput {
  settings: FlowSettings | null
  streaming: boolean
  nowMs: number
  lastSuggestAtMs: number
}

/** The auto-answer gate for a detected question: switch, provider, not streaming, `suggestEverySec` cooldown. */
export function existingRulesForQuestion(input: QuestionRulesInput): InterventionExistingRules {
  const { settings, streaming, nowMs, lastSuggestAtMs } = input
  if (!(settings?.autoSuggest ?? true)) return rule(false, 'auto-suggest-off')
  // no provider → don't auto-fire a request that would just error (a local-only setup counts too,
  // including the default-on fallback which serves the suggest this fires)
  if (!settings?.providerReady && !settings?.localSuggestReady && !settings?.localFallbackReady) {
    return rule(false, 'provider-not-ready')
  }
  if (streaming) return rule(false, 'streaming')
  const everyMs = (settings?.suggestEverySec ?? DEFAULT_SUGGEST_EVERY_SEC) * 1000
  if (nowMs - lastSuggestAtMs < everyMs) return rule(false, 'cooldown')
  return rule(true, 'question-detected')
}

export interface ShadowRulesInput {
  listening: boolean
  settings: FlowSettings | null
  lastSpeaker: 'them' | 'you' | 'unknown' | null
  lineCount: number
  watermark: { lineCount: number; at: number }
  nowMs: number
  anyStreaming: boolean
}

/** The shadow pre-generation gate: pre-generate when the other side just spoke and nothing visible is streaming. */
export function existingRulesForShadow(input: ShadowRulesInput): InterventionExistingRules {
  const { listening, settings, lastSpeaker, lineCount, watermark, nowMs, anyStreaming } = input
  if (!listening) return rule(false, 'not-listening')
  if (settings?.instantSuggestions === false) return rule(false, 'instant-suggestions-off')
  if (!settings?.providerReady && !settings?.localSuggestReady) return rule(false, 'provider-not-ready')
  if (lineCount === 0 || lastSpeaker !== 'them') return rule(false, 'last-speaker-not-them')
  const everyMs = (settings?.suggestEverySec ?? DEFAULT_SUGGEST_EVERY_SEC) * 1000
  if (lineCount === watermark.lineCount) return rule(false, 'no-new-line')
  if (nowMs - watermark.at < everyMs) return rule(false, 'cooldown')
  if (anyStreaming) return rule(false, 'streaming')
  return rule(true, 'new-line')
}

export type QuestionFlowOutcome = Extract<
  InterventionOutcome,
  'generate' | 'adopt' | 'hold' | 'stale-drop' | 'suppressed-quiet'
>

export interface QuestionFlowDeps {
  gate: InterventionGate
  nowMs: () => number
  /** Time of the last admitted auto-answer; claimed before the first await so two questions never both fire. */
  lastSuggestAtRef: { current: number }
  settings: FlowSettings | null
  suggestStreaming: () => boolean
  /** Bring the copilot surface forward (no-op when the user is in another panel). */
  focusCopilot: () => void
  /** A finished shadow card that passes the content-hash adopt rule, with the snapshot it was made from. */
  readySpeculative: () => { snapshot: InterventionSnapshot } | null
  showSpeculative: () => void
  /** Runs the ambient suggest; main applies the G68 quiet gate to it. The snapshot binds the live card. */
  runSuggest: (snapshot: InterventionSnapshot) => void
  /** G68: asks main whether an unsolicited card may be shown now. */
  offerQuiet: (channel: 'proactiveSuggestion') => Promise<QuietAction>
}

export async function runQuestionFlow(deps: QuestionFlowDeps, triggerLineId: string): Promise<QuestionFlowOutcome> {
  const { gate } = deps
  const now = deps.nowMs()
  const previousClaim = deps.lastSuggestAtRef.current
  const rules = existingRulesForQuestion({
    settings: deps.settings,
    streaming: deps.suggestStreaming(),
    nowMs: now,
    lastSuggestAtMs: previousClaim
  })
  if (rules.shouldGenerate) deps.lastSuggestAtRef.current = now // claim before the await
  const { decision, snapshot } = await gate.decide('question', rules, triggerLineId)
  if (!decision.shouldGenerate || deps.suggestStreaming()) {
    if (rules.shouldGenerate) deps.lastSuggestAtRef.current = previousClaim
    gate.record({ path: 'question', decision, outcome: 'hold' })
    return 'hold'
  }
  deps.focusCopilot()
  // Prefer a finished shadow suggestion (zero LLM wait). It is unsolicited output, so it needs the same quiet
  // answer the main-side path gets, and it must still describe the live conversation.
  const spec = deps.readySpeculative()
  if (spec && gate.isCurrent(spec.snapshot)) {
    let action: QuietAction | 'unavailable'
    try {
      action = await deps.offerQuiet('proactiveSuggestion')
    } catch {
      action = 'unavailable'
    }
    if (action === 'allow') {
      if (!gate.isCurrent(spec.snapshot)) {
        gate.recordStaleDrop('question', spec.snapshot)
        return 'stale-drop'
      }
      deps.showSpeculative()
      gate.record({ path: 'question', decision, outcome: 'adopt' })
      return 'adopt'
    }
    if (action !== 'unavailable') {
      // 'defer' is already recorded by main, so the quiet release re-runs the ask later.
      gate.record({ path: 'question', decision, outcome: 'suppressed-quiet' })
      return 'suppressed-quiet'
    }
    // The bridge failed: fall through to the ambient run, whose gate is applied by main.
  }
  deps.runSuggest(snapshot)
  gate.record({ path: 'question', decision, outcome: 'generate' })
  return 'generate'
}

export interface ShadowWatermarkCommit {
  lineCount: number
  at: number
  runId: string
  snapshot: InterventionSnapshot
}

export interface ShadowFlowDeps {
  gate: InterventionGate
  /** True while a decision is in flight, so overlapping effect runs never start two pre-generations. */
  busyRef: { current: boolean }
  rulesInput: () => ShadowRulesInput
  /** Starts the speculative (shadow) suggest and returns its run id. */
  runSpeculative: () => string
  commitWatermark: (commit: ShadowWatermarkCommit) => void
}

export type ShadowFlowOutcome = Extract<InterventionOutcome, 'generate' | 'hold' | 'stale-drop'>

export async function runShadowFlow(deps: ShadowFlowDeps): Promise<ShadowFlowOutcome> {
  if (deps.busyRef.current) return 'hold'
  const input = deps.rulesInput()
  const rules = existingRulesForShadow(input)
  // Only an eligible attempt is a decision; the effect re-runs on every line and would flood the log otherwise.
  if (!rules.shouldGenerate) return 'hold'
  deps.busyRef.current = true
  try {
    const { gate } = deps
    const { decision, snapshot } = await gate.decide('shadow', rules)
    if (!decision.shouldGenerate || deps.rulesInput().anyStreaming) {
      gate.record({ path: 'shadow', decision, outcome: 'hold' })
      return 'hold'
    }
    if (!gate.isCurrent(snapshot)) {
      gate.recordStaleDrop('shadow', snapshot)
      return 'stale-drop'
    }
    const runId = deps.runSpeculative()
    deps.commitWatermark({ lineCount: input.lineCount, at: input.nowMs, runId, snapshot })
    gate.record({ path: 'shadow', decision, outcome: 'generate' })
    return 'generate'
  } finally {
    deps.busyRef.current = false
  }
}

export interface StaleLiveDeps {
  gate: InterventionGate
  /** The snapshot the visible live suggestion was started from. */
  snapshotRef: { current: InterventionSnapshot | null }
  streaming: boolean
  cancel: () => void
}

/**
 * A live streaming suggestion is cancelled only on hard invalidation (the scope changed, or its trigger line
 * was corrected or retracted). A newer unrelated line never kills a card that is still useful.
 */
export function cancelStaleLive(deps: StaleLiveDeps): boolean {
  const { gate, snapshotRef, streaming, cancel } = deps
  const snapshot = snapshotRef.current
  if (!snapshot) return false
  if (!streaming) {
    snapshotRef.current = null
    return false
  }
  if (!gate.isHardInvalidated(snapshot)) return false
  snapshotRef.current = null
  cancel()
  gate.recordStaleDrop('question', snapshot, 'live-card-invalidated')
  return true
}
