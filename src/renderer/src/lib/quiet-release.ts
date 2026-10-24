import { useEffect, useRef } from 'react'
import type { QuietDeferredBatch } from '@shared/quiet-mode-settings'
import type { AskRequest, AnswerState } from '../state'
import type { PublicSettings } from '@shared/ipc'
import { fieldContext, noDecisionAsk } from './ask-context'

/**
 * The one ambient ask to run when quiet mode ends and held output is released (G68), or null when nothing is owed.
 * It re-checks the gates the live paths use (listening, proactive-copilot switch, provider ready, no answer already
 * streaming), so a release never starts work the live path would have refused.
 */
export function quietReleaseAsk(
  batch: QuietDeferredBatch,
  state: { listening: boolean; settings: PublicSettings | null; suggestAnswer: AnswerState | null }
): AskRequest | null {
  const { listening, settings, suggestAnswer } = state
  if (!listening || !(settings?.autoSuggest ?? true) || suggestAnswer?.streaming) return null
  if (batch.channels.includes('autoAnswerCard') && settings?.providerReady) return noDecisionAsk()
  const canSuggest = settings?.providerReady || settings?.localSuggestReady || settings?.localFallbackReady
  if (batch.channels.includes('proactiveSuggestion') && canSuggest) {
    return { mode: 'suggest', outputIntent: 'ambient', context: fieldContext('conversation') }
  }
  return null
}

/** Runs the ambient ask owed after a quiet period ends, using the latest listening, settings and answer state. */
export function useQuietRelease(
  listening: boolean,
  settings: PublicSettings | null,
  suggest: { answer: AnswerState | null; run: (req: AskRequest) => string }
): void {
  const latest = useRef({ listening, settings, suggest })
  latest.current = { listening, settings, suggest }
  useEffect(
    () =>
      window.toto.onQuietOutputReleased((batch) => {
        const { listening: live, settings: current, suggest: card } = latest.current
        const req = quietReleaseAsk(batch, { listening: live, settings: current, suggestAnswer: card.answer })
        if (req) card.run(req)
      }),
    []
  )
}
