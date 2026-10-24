import { fnv1a } from '@shared/hash'
import { type DeciderOutput, type JevDecider } from '@shared/test-helpers/jev-eval/harness'
import type { Scenario } from '@shared/test-helpers/jev-eval/label-schema'
import { InterventionGate } from '../lib/intervention-gate'
import { createExistingRulesDecider } from './jev-existing-rules'

/**
 * The G70 policy decider for the JEV harness: the shipped auto-answer rules (the G75 mirror stays the default
 * admission) plus the production InterventionGate's session context, which decides what is stale.
 *
 * - A question the rules admit gets a snapshot bound to its utterance (the production question path does the same).
 * - A correction, a retraction or a newer revision of a known utterance drops its earlier decision as stale.
 * - A `candidate` step is a generated card arriving. It is painted only if the snapshot of the utterance that
 *   produced it is still current; after any newer final or any scope change it is a stale-drop and never a card.
 *
 * `cardArrival: 'candidate'` is for scenarios whose cards arrive as candidate steps: the admission is then
 * recorded as a `hold` (generation requested, card pending) so the card is counted once, when it arrives.
 * The harness is synchronous and the disabled policy returns the rules untouched (proved in
 * intervention-gate.test.ts), so the decider drives the gate's context directly rather than awaiting `decide`.
 */
export interface PolicyDeciderOptions {
  cardArrival: 'inline' | 'candidate'
}

export function createPolicyDecider(options: PolicyDeciderOptions): JevDecider {
  const inner = createExistingRulesDecider()
  let gate = new InterventionGate({ meetingStartMs: 0 })
  const known = new Set<string>()
  const snapshots = new Map<string, ReturnType<InterventionGate['issue']>>()

  const staleDrop = (utteranceId: string, cardKey?: string): DeciderOutput => ({
    outcome: 'stale-drop',
    reason: 'other',
    utteranceId,
    ...(cardKey ? { cardKey } : {})
  })

  return {
    name: 'policy',
    capabilities: new Set(['stale-drop']),
    reset(ctx) {
      gate = new InterventionGate({ meetingStartMs: 0 })
      known.clear()
      snapshots.clear()
      inner.reset(ctx)
    },
    onStep(step, ctx) {
      switch (step.kind) {
        case 'final': {
          const revised = known.has(step.utteranceId) && step.revision > 1
          gate.observe({ kind: revised ? 'correction' : 'final', lineId: step.utteranceId })
          const dropped = revised ? [staleDrop(step.utteranceId)] : []
          known.add(step.utteranceId)
          const outs = inner.onStep(step, ctx).map((out): DeciderOutput => {
            if (out.outcome !== 'generate') return out
            snapshots.set(step.utteranceId, gate.issue(step.utteranceId))
            return options.cardArrival === 'candidate'
              ? { ...out, outcome: 'hold', reason: 'question-detected', cardHash: undefined }
              : out
          })
          return [...dropped, ...outs]
        }
        case 'correction':
        case 'retraction': {
          gate.observe({ kind: step.kind, lineId: step.utteranceId })
          return known.has(step.utteranceId) ? [staleDrop(step.utteranceId)] : []
        }
        case 'scope':
          gate.observe({ kind: 'scope', change: step.change })
          return []
        case 'candidate': {
          const utteranceId = step.forUtteranceId
          const snapshot = utteranceId ? snapshots.get(utteranceId) : undefined
          if (!utteranceId || !snapshot || !gate.isCurrent(snapshot)) {
            return [staleDrop(utteranceId ?? step.cardKey, step.cardKey)]
          }
          return [
            {
              outcome: 'adopt-speculative',
              reason: 'other',
              utteranceId,
              cardKey: step.cardKey,
              cardHash: fnv1a(step.text)
            }
          ]
        }
        default:
          return inner.onStep(step, ctx)
      }
    }
  }
}

/** The decider for a scenario: candidate-driven when the scenario delivers its cards as candidate steps. */
export function createPolicyDeciderFor(scenario: Scenario): JevDecider {
  const cardArrival = scenario.steps.some((s) => s.kind === 'candidate') ? 'candidate' : 'inline'
  return createPolicyDecider({ cardArrival })
}
