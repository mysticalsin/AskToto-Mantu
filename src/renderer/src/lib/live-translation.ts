import { useEffect, useReducer } from 'react'
import type { TranscriptLine } from '@shared/ipc'

/** What the live view keeps per line: the translation and the revision of the line it was made from. */
export interface TranslationEntry {
  readonly revision: number
  readonly text: string
  readonly lowConfidence: boolean
}

export interface LiveTranslationState {
  readonly meetingStartedAt: number | null
  readonly entries: ReadonlyMap<string, TranslationEntry>
  /** Honest copy when the channel cannot run (policy, local-only, no provider); null otherwise. */
  readonly unavailable: string | null
}

/** The event shapes the preload delivers (see src/preload/live-translation.ts). */
export type LiveTranslationAction =
  | {
      kind: 'segment'
      meetingStartedAt: number
      utteranceId: string
      revision: number
      text: string
      lowConfidence: boolean
    }
  | { kind: 'retract'; meetingStartedAt: number; utteranceIds: readonly string[] }
  | { kind: 'reset'; meetingStartedAt: number }
  | { kind: 'status'; meetingStartedAt: number; state: 'on' | 'unavailable'; message?: string }

export const EMPTY_LIVE_TRANSLATION: LiveTranslationState = {
  meetingStartedAt: null,
  entries: new Map(),
  unavailable: null
}

const MAX_ENTRIES = 4_096

/** Pure. A push for another meeting replaces the state; a push never touches the transcript lines themselves. */
export function reduceLiveTranslation(
  state: LiveTranslationState,
  action: LiveTranslationAction
): LiveTranslationState {
  const sameMeeting = state.meetingStartedAt === action.meetingStartedAt
  const base: LiveTranslationState = sameMeeting
    ? state
    : { meetingStartedAt: action.meetingStartedAt, entries: new Map(), unavailable: null }
  switch (action.kind) {
    case 'reset':
      return { meetingStartedAt: action.meetingStartedAt, entries: new Map(), unavailable: null }
    case 'status':
      return { ...base, unavailable: action.state === 'unavailable' ? (action.message ?? null) : null }
    case 'retract': {
      if (!sameMeeting) return base
      const entries = new Map(base.entries)
      for (const id of action.utteranceIds) entries.delete(id)
      return { ...base, entries }
    }
    case 'segment': {
      const known = base.entries.get(action.utteranceId)
      if (known && known.revision >= action.revision) return base
      const entries = new Map(base.entries)
      entries.delete(action.utteranceId)
      entries.set(action.utteranceId, {
        revision: action.revision,
        text: action.text,
        lowConfidence: action.lowConfidence
      })
      while (entries.size > MAX_ENTRIES) {
        const oldest = entries.keys().next()
        if (oldest.done) break
        entries.delete(oldest.value)
      }
      return { ...base, entries }
    }
  }
}

/**
 * The translation to show under a line, or null. A translation is shown only when the line is the same utterance at the
 * same revision it was made from, so a corrected line never wears the translation of its old text. A local line has no
 * ledger identity in the renderer; main names it `local:<t>` at revision 1.
 */
export function translationFor(
  state: LiveTranslationState,
  line: Pick<TranscriptLine, 't' | 'utteranceId' | 'revision'>
): TranslationEntry | null {
  const id = line.utteranceId ?? `local:${line.t}`
  const entry = state.entries.get(id)
  return entry && entry.revision === (line.revision ?? 1) ? entry : null
}

/** Subscribes to the live translation channel. Renders nothing until the user picks a language in Settings. */
export function useLiveTranslation(): LiveTranslationState {
  const [state, dispatch] = useReducer(reduceLiveTranslation, EMPTY_LIVE_TRANSLATION)
  useEffect(() => {
    // A host without the bridge (a test shell, the onboarding preview) simply has no translation.
    if (typeof window.toto?.onTranslation !== 'function') return undefined
    return window.toto.onTranslation((event) => dispatch(event))
  }, [])
  return state
}
