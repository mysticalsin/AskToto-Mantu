import { buildFactCheckClaimPrompt } from '@shared/quick-actions'
import { GUARD_LINE, LAST_THEM_SLOT, TRANSCRIPT_SLOT, promptContext } from './ask-context'
import type { AskContextRequest } from '@shared/session-context-request'

/** Most transcript characters a fact-check with no typed claim may embed. */
export const FACT_CHECK_TRANSCRIPT_CHARS = 3000

export interface FactCheckRequestInput {
  /** The user's typed claim ('' when none). */
  claim: string
  /** The most recent line spoken by the other side, if any. Only the label shows it: main fills the prompt. */
  lastThem?: string
  /** The live transcript text. Only whether there is any matters here: main holds the text a prompt is built from. */
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
  /** Set with `redactPrompt`: main fills the prompt's slot from its ledger (the last THEM line, or a bounded tail). */
  context?: AskContextRequest
  /** Whether the ask carries the follow-up history (a typed claim outside a live call only, as before). */
  useHistory: boolean
  /** The short user turn to record for follow-ups. Never transcript text. */
  historyTurn?: string
}

/**
 * Builds the text fact-check ask. A typed claim goes through unredacted. With no claim the claim is the last
 * thing the other side said, or the bounded tail of the transcript, which main fills in from its own ledger
 * (redacted there, and flagged so the whole prompt is), with a short label and nothing transcript-derived
 * recorded in history. Null when there is nothing to check.
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
  if (!lastThem && !input.transcript.trim()) return null
  return {
    mode: 'answer',
    kind: 'factcheck',
    label: lastThem ? `Fact-check: "${lastThem}"` : 'Fact-check: the conversation so far',
    prompt: buildFactCheckClaimPrompt(lastThem ? LAST_THEM_SLOT : TRANSCRIPT_SLOT) + GUARD_LINE,
    redactPrompt: true,
    context: promptContext('manual', FACT_CHECK_TRANSCRIPT_CHARS),
    useHistory: false
  }
}
