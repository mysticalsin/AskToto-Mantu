/**
 * Métis 2.0 Cap 2 — command session state machine (pure).
 * Meeting Listen ≠ command until wake word. Stop/Escape is local (never await decide).
 */
import { desktopActionFingerprint, type DesktopActionRequest } from './desktop-actions'
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

export interface MetisCommandSessionState {
  phase: MetisCommandPhase
  active: boolean
  pillVisible: boolean
  pillCopy: MetisCommandUiCopy
  liveTranscript: string
  committed: string[]
  pending: DesktopActionRequest[]
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
    committed: [],
    pending: [],
    chime: 'none',
    lastParse: null
  }
}

export type MetisCommandEvent =
  | { type: 'transcript'; text: string; channel: 'meeting' | 'command' }
  | { type: 'stop' }
  | { type: 'mark_committed'; fingerprints: string[] }
  | { type: 'tick_listening_copy' }

/**
 * Advance session. Meeting-channel transcripts never activate or execute.
 */
export function reduceMetisCommandSession(
  prev: MetisCommandSessionState,
  event: MetisCommandEvent
): MetisCommandSessionState {
  if (event.type === 'stop') {
    if (!prev.active && prev.phase === 'idle') return { ...prev, chime: 'none' }
    return {
      ...idleMetisCommandSession(),
      phase: 'deactivating',
      chime: 'double',
      reason: 'local_stop'
    }
  }

  if (event.type === 'mark_committed') {
    const committed = [...prev.committed]
    for (const fp of event.fingerprints) {
      if (!committed.includes(fp)) committed.push(fp)
    }
    const pending = prev.pending.filter(
      (request) => !event.fingerprints.includes(desktopActionFingerprint(request))
    )
    return {
      ...prev,
      committed,
      pending,
      chime: 'none',
      phase: prev.active ? (pending.length ? 'executing' : 'listening') : prev.phase
    }
  }

  if (event.type === 'tick_listening_copy') {
    if (!prev.active) return prev
    return { ...prev, pillCopy: METIS_PILL_LISTENING, phase: 'listening', chime: 'none' }
  }

  // transcript
  const { text, channel } = event
  if (channel === 'meeting') return prev

  if (!prev.active) {
    if (!transcriptContainsWakeWord(text)) {
      return { ...prev, chime: 'none' }
    }
    // Wake → single chime + pill; same utterance may also finalize keywords.
    const snap = parseMetisCommandTranscript(text, new Set<string>())
    const pending = snap.negation ? [] : snap.commits.map((c) => c.request)
    return {
      phase: pending.length ? 'executing' : 'waking',
      active: true,
      pillVisible: true,
      pillCopy: METIS_PILL_HI,
      liveTranscript: text,
      committed: [],
      pending,
      chime: 'single',
      lastParse: snap,
      reason: 'wake'
    }
  }

  // Active command session
  if (transcriptContainsEndPhrase(text)) {
    return {
      ...idleMetisCommandSession(),
      phase: 'deactivating',
      chime: 'double',
      liveTranscript: text,
      reason: 'thank_you'
    }
  }

  const snap = parseMetisCommandTranscript(text, new Set(prev.committed))
  // ASR emits incremental and final copies of the same sentence. Keep the action already being
  // executed plus any queued follow-ons, add each new request once, and let a later negation clear
  // only work that has not reached the OS yet.
  const queued = new Set(prev.pending.map(desktopActionFingerprint))
  const pending = snap.negation
    ? []
    : [...prev.pending, ...snap.commits.map((c) => c.request).filter((request) => !queued.has(desktopActionFingerprint(request)))]
  const phase: MetisCommandPhase = pending.length ? 'executing' : 'listening'

  return {
    ...prev,
    phase,
    pillVisible: true,
    pillCopy: prev.pillCopy === METIS_PILL_HI ? METIS_PILL_HI : METIS_PILL_LISTENING,
    liveTranscript: text,
    pending,
    chime: 'none',
    lastParse: snap
  }
}

export function pendingFingerprints(state: MetisCommandSessionState): string[] {
  return state.pending.map(desktopActionFingerprint)
}
