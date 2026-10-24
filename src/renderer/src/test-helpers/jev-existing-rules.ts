import { fnv1a } from '@shared/hash'
import { type DeciderOutput, type JevContext, type JevDecider } from '@shared/test-helpers/jev-eval/harness'
import type { Step } from '@shared/test-helpers/jev-eval/label-schema'
import { isQuestion } from '../lib/listen-question'

/**
 * The shipped auto-answer rules as a JEV decider, so the harness can score today's behaviour.
 *
 * MIRROR, not extraction (G70 follow-up: replace this with the real policy decider):
 * - coalesced `them` turn: renderer/src/lib/listen.ts:712-721 (provisional skip, run capped at 600 chars,
 *   a non-`them` final resets the run, a detected question consumes the run);
 * - auto-answer gate: renderer/src/App.tsx:1304-1324 (autoSuggest, provider ready, suggestEverySec
 *   cooldown). Streaming and speculative adoption are not modelled offline.
 * `isQuestion` is the real function. Only `final` steps are modelled: the shipped rules have no revision,
 * retraction, scope, card-swap, classifier, network or action concept, so this decider declares no capabilities.
 */
export function createExistingRulesDecider(): JevDecider {
  let themRun = ''
  let lastSuggestMs = Number.NEGATIVE_INFINITY

  function onFinal(step: Extract<Step, { kind: 'final' }>, ctx: JevContext): DeciderOutput[] {
    if (step.speaker !== 'them') {
      themRun = ''
      return [{ outcome: 'hold', reason: 'not-a-question', utteranceId: step.utteranceId }]
    }
    themRun = themRun ? `${themRun} ${step.text}` : step.text
    if (themRun.length > 600) themRun = themRun.slice(-600)
    const hold = (
      reason: 'not-a-question' | 'auto-suggest-off' | 'provider-not-ready' | 'cooldown'
    ): DeciderOutput[] => [{ outcome: 'hold', reason, utteranceId: step.utteranceId, revision: step.revision }]
    if (!isQuestion(themRun)) return hold('not-a-question')
    const cardHash = fnv1a(themRun) // hash only: the text is never recorded
    themRun = ''
    if (ctx.quiet.autoAnswerCard !== 'allow') {
      return [
        { outcome: 'suppressed-quiet', reason: 'quiet-gate', utteranceId: step.utteranceId, revision: step.revision }
      ]
    }
    if (!ctx.settings.autoSuggest) return hold('auto-suggest-off')
    if (!ctx.settings.providerReady) return hold('provider-not-ready')
    if (ctx.nowMs - lastSuggestMs < ctx.settings.suggestEverySec * 1000) return hold('cooldown')
    lastSuggestMs = ctx.nowMs
    return [
      {
        outcome: 'generate',
        reason: 'question-detected',
        utteranceId: step.utteranceId,
        revision: step.revision,
        cardHash,
        generationCalls: 1
      }
    ]
  }

  return {
    name: 'existing-rules',
    capabilities: new Set(),
    reset: () => {
      themRun = ''
      lastSuggestMs = Number.NEGATIVE_INFINITY
    },
    onStep: (step, ctx) => (step.kind === 'final' ? onFinal(step, ctx) : [])
  }
}
