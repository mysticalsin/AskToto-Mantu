/**
 * Métis command parser for the command panel (Cmd/Ctrl+Shift+M): a thin view over the V03 voice grammar.
 *
 * The grammar (src/shared/voice/voice-grammar.ts) is the one place a transcript becomes a typed request, in
 * English, French, Portuguese and Spanish, with real bounded slots. This module keeps the panel's original
 * snapshot shape so the session reducer and its tests keep working. One utterance yields at most one
 * candidate; the Cap1 /v1/decide path may disambiguate only and this path must work with Jev off or down.
 */
import { type DesktopActionRequest, type DesktopAdapterId } from './desktop-actions'
import { parseVoiceUtterance, provisionalIntent } from './voice/voice-grammar'

export type ParseCandidate = {
  request: DesktopActionRequest
  at: number
  confidence: 'deterministic'
}

export type ParseSnapshot = {
  candidates: ParseCandidate[]
  provisional: DesktopAdapterId[]
  ambiguous: boolean
  negation: boolean
}

export function parseMetisCommandTranscript(rawText: string): ParseSnapshot {
  const utterance = parseVoiceUtterance(rawText)
  const snapshot: ParseSnapshot = { candidates: [], provisional: [], ambiguous: false, negation: false }
  if (utterance.kind === 'action') {
    snapshot.candidates.push({ request: utterance.request, at: rawText.length, confidence: 'deterministic' })
  } else if (utterance.kind === 'cancelled') {
    snapshot.negation = true
  } else if (utterance.kind !== 'question') {
    // Incomplete, unsupported or unrecognised: still hint at what it was about (advisory only).
    if (utterance.kind === 'incomplete') snapshot.ambiguous = true
    const hint = provisionalIntent(rawText)
    if (hint) snapshot.provisional.push(hint)
  }
  return snapshot
}
