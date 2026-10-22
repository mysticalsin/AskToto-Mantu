import { buildFactCheckClaimPrompt } from '@shared/quick-actions'
import { GUARD_LINE } from './ask-context'

/** Most transcript characters a fact-check with no typed claim may embed. */
export const FACT_CHECK_TRANSCRIPT_CHARS = 3000

export interface FactCheckRequestInput {
  /** The user's typed claim ('' when none). */
  claim: string
  /** The most recent line spoken by the other side, if any. */
  lastThem?: string
  /** The whole live transcript text (only its tail is ever used). */
  transcript: string
  listening: boolean
}

export interface FactCheckRequest {
  mode: 'answer'
  kind: 'factcheck'
  label: string
  prompt: string
  /** Set only when the prompt is transcript-derived; a typed claim is never altered. */
  redactPrompt?: true
  /** Whether the ask carries the follow-up history (a typed claim outside a live call only, as before). */
  useHistory: boolean
  /** The short user turn to record for follow-ups. Never transcript text. */
  historyTurn?: string
}

/**
 * Builds the text fact-check ask. A typed claim goes through unredacted. With no claim the claim is the last
 * thing the other side said, or the bounded tail of the transcript, flagged so main redacts the prompt, with
 * a short label and nothing transcript-derived recorded in history. Null when there is nothing to check.
 */
export function buildFactCheckRequest(input: FactCheckRequestInput): FactCheckRequest | null {
  const claim = input.claim.trim()
  if (claim) {
    return {
      mode: 'answer',
      kind: 'factcheck',
      label: claim,
      prompt: buildFactCheckClaimPrompt(claim) + (input.listening ? GUARD_LINE : ''),
      useHistory: !input.listening,
      ...(input.listening ? {} : { historyTurn: claim })
    }
  }
  const lastThem = input.lastThem?.trim()
  const c = (lastThem || input.transcript.trim()).slice(-FACT_CHECK_TRANSCRIPT_CHARS)
  if (!c) return null
  return {
    mode: 'answer',
    kind: 'factcheck',
    label: lastThem ? `Fact-check: "${lastThem}"` : 'Fact-check: the conversation so far',
    prompt: buildFactCheckClaimPrompt(c) + GUARD_LINE,
    redactPrompt: true,
    useHistory: false
  }
}
