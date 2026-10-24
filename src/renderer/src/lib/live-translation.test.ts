import { describe, expect, it } from 'vitest'
import {
  EMPTY_LIVE_TRANSLATION,
  reduceLiveTranslation,
  translationFor,
  type LiveTranslationState
} from './live-translation'

const M = 1_700_000_000_000
const segment = (utteranceId: string, revision: number, text = 'Hello', lowConfidence = false) =>
  ({ kind: 'segment', meetingStartedAt: M, utteranceId, revision, text, lowConfidence }) as const

describe('live translation renderer state (G73)', () => {
  it('shows only when line.revision equals translation revision', () => {
    const state = reduceLiveTranslation(EMPTY_LIVE_TRANSLATION, segment('u1', 2, 'Two'))
    expect(translationFor(state, { t: 1, utteranceId: 'u1', revision: 2 })?.text).toBe('Two')
    expect(translationFor(state, { t: 1, utteranceId: 'u1', revision: 3 })).toBeNull()
    expect(translationFor(state, { t: 1, utteranceId: 'u1', revision: 1 })).toBeNull()
    expect(translationFor(state, { t: 1, utteranceId: 'other', revision: 2 })).toBeNull()
  })

  it('matches a local line by its main-side identity at revision 1', () => {
    const state = reduceLiveTranslation(EMPTY_LIVE_TRANSLATION, segment('local:55', 1, 'Local'))
    expect(translationFor(state, { t: 55 })?.text).toBe('Local')
    expect(translationFor(state, { t: 56 })).toBeNull()
  })

  it('an older revision never replaces a newer one, and retract removes', () => {
    let state: LiveTranslationState = reduceLiveTranslation(EMPTY_LIVE_TRANSLATION, segment('u1', 2, 'Two'))
    state = reduceLiveTranslation(state, segment('u1', 1, 'One late'))
    expect(translationFor(state, { t: 1, utteranceId: 'u1', revision: 2 })?.text).toBe('Two')
    state = reduceLiveTranslation(state, { kind: 'retract', meetingStartedAt: M, utteranceIds: ['u1'] })
    expect(translationFor(state, { t: 1, utteranceId: 'u1', revision: 2 })).toBeNull()
  })

  it('carries the low confidence flag', () => {
    const state = reduceLiveTranslation(EMPTY_LIVE_TRANSLATION, segment('u1', 1, 'Maybe', true))
    expect(translationFor(state, { t: 1, utteranceId: 'u1', revision: 1 })?.lowConfidence).toBe(true)
  })

  it('reset clears all, and a push for another meeting starts fresh', () => {
    let state = reduceLiveTranslation(EMPTY_LIVE_TRANSLATION, segment('u1', 1))
    state = reduceLiveTranslation(state, {
      kind: 'status',
      meetingStartedAt: M,
      state: 'unavailable',
      message: 'No model'
    })
    expect(state.unavailable).toBe('No model')
    state = reduceLiveTranslation(state, { kind: 'reset', meetingStartedAt: M })
    expect(state.entries.size).toBe(0)
    expect(state.unavailable).toBeNull()
    state = reduceLiveTranslation(state, segment('u2', 1))
    state = reduceLiveTranslation(state, { ...segment('u3', 1), meetingStartedAt: M + 1 })
    expect([...state.entries.keys()]).toEqual(['u3'])
    expect(state.meetingStartedAt).toBe(M + 1)
  })
})
