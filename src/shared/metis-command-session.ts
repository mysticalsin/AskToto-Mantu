/**
 * Métis command session state machine (pure).
 * Trusted command capture can create one typed proposal; it cannot execute it.
 */
import {
  commandContextHash,
  createCommandProposal,
  type CommandProposal
} from './metis-command-proposal'
import { parseMetisCommandTranscript, type ParseSnapshot } from './metis-command-parse'
import {
  METIS_PILL_HI,
  METIS_PILL_LISTENING,
  type MetisCommandPhase,
  transcriptContainsEndPhrase,
  transcriptContainsWakeWord
} from './metis-wake'

export type MetisChimeKind = 'none' | 'single' | 'double'
export type MetisCommandUiCopy = typeof METIS_PILL_HI | typeof METIS_PILL_LISTENING | string
export type MetisProposalPhase = MetisCommandPhase | 'awaiting-confirmation'

export interface MetisCommandSessionState {
  phase: MetisProposalPhase
  active: boolean
  pillVisible: boolean
  pillCopy: MetisCommandUiCopy
  liveTranscript: string
  proposal?: CommandProposal
  chime: MetisChimeKind
  lastParse: ParseSnapshot | null
  reason?: string
}

export function idleMetisCommandSession(): MetisCommandSessionState {
  return {
    phase: 'idle',
    active: false,
    pillVisible: false,
    pillCopy: METIS_PILL_HI,
    liveTranscript: '',
    chime: 'none',
    lastParse: null
  }
}

export type MetisCommandEvent =
  | {
      type: 'transcript'
      text: string
      /** Only the main-owned command capture may provide this literal source. */
      channel: 'meeting' | 'command'
      sessionId?: string
      utteranceRevision?: number
      contextHash?: string
      now?: number
    }
  | { type: 'stop' }
  | { type: 'cancel' }
  | { type: 'proposal_expired'; proposalId: string; now?: number }
  | { type: 'tick_listening_copy' }

function proposalFor(event: Extract<MetisCommandEvent, { type: 'transcript' }>, snapshot: ParseSnapshot) {
  const candidate = snapshot.candidates[0]
  if (!candidate || snapshot.negation) return undefined
  return createCommandProposal({
    sessionId: event.sessionId ?? 'trusted-command',
    utteranceRevision: event.utteranceRevision ?? 0,
    contextHash: event.contextHash ?? commandContextHash(event.text),
    request: candidate.request,
    now: event.now
  })
}

function listeningState(
  prev: MetisCommandSessionState,
  event: Extract<MetisCommandEvent, { type: 'transcript' }>,
  snapshot: ParseSnapshot,
  reason?: string
): MetisCommandSessionState {
  const proposal = proposalFor(event, snapshot)
  return {
    ...prev,
    phase: proposal ? 'awaiting-confirmation' : 'listening',
    active: true,
    pillVisible: true,
    pillCopy: prev.pillCopy === METIS_PILL_HI ? METIS_PILL_HI : METIS_PILL_LISTENING,
    liveTranscript: event.text,
    proposal,
    chime: 'none',
    lastParse: snapshot,
    reason
  }
}

/** Advance session. Meeting transcripts never activate or create proposals. */
export function reduceMetisCommandSession(
  prev: MetisCommandSessionState,
  event: MetisCommandEvent
): MetisCommandSessionState {
  if (event.type === 'stop' || event.type === 'cancel') {
    if (!prev.active && prev.phase === 'idle') return { ...prev, chime: 'none' }
    return {
      ...idleMetisCommandSession(),
      phase: 'deactivating',
      chime: 'double',
      reason: event.type === 'stop' ? 'local_stop' : 'cancelled'
    }
  }

  if (event.type === 'proposal_expired') {
    if (!prev.proposal || prev.proposal.id !== event.proposalId) return prev
    return { ...prev, phase: 'listening', proposal: undefined, reason: 'proposal_expired', chime: 'none' }
  }

  if (event.type === 'tick_listening_copy') {
    if (!prev.active) return prev
    return { ...prev, pillCopy: METIS_PILL_LISTENING, chime: 'none' }
  }

  if (event.channel === 'meeting') return prev

  if (transcriptContainsEndPhrase(event.text)) {
    return {
      ...idleMetisCommandSession(),
      phase: 'deactivating',
      chime: 'double',
      liveTranscript: event.text,
      reason: 'thank_you'
    }
  }

  const snapshot = parseMetisCommandTranscript(event.text)
  if (!prev.active) {
    // The command source is main-owned. It can be activated by wake word or explicit command mic.
    if (!transcriptContainsWakeWord(event.text) && !snapshot.candidates.length && !snapshot.provisional.length) {
      return { ...prev, chime: 'none' }
    }
    const proposal = proposalFor(event, snapshot)
    return {
      phase: proposal ? 'awaiting-confirmation' : 'waking',
      active: true,
      pillVisible: true,
      pillCopy: METIS_PILL_HI,
      liveTranscript: event.text,
      proposal,
      chime: 'single',
      lastParse: snapshot,
      reason: 'wake'
    }
  }

  // Every trusted partial supersedes the prior proposal. Parsing supplies candidates, never authority.
  return listeningState(prev, event, snapshot, snapshot.negation ? 'cancelled' : undefined)
}
