import { describe, expect, it } from 'vitest'
import { idleMetisCommandSession, reduceMetisCommandSession } from './metis-command-session'
import { METIS_PILL_HI, METIS_PILL_LISTENING } from './metis-wake'

describe('command proposal session', () => {
  it('meeting audio cannot activate, propose, or execute', () => {
    const state = reduceMetisCommandSession(idleMetisCommandSession(), {
      type: 'transcript',
      text: 'Métis open notes',
      channel: 'meeting'
    })
    expect(state).toEqual(idleMetisCommandSession())
  })

  it('creates a proposal rather than pending executable work', () => {
    const state = reduceMetisCommandSession(idleMetisCommandSession(), {
      type: 'transcript',
      text: 'open notes',
      channel: 'command',
      sessionId: 'session-1',
      utteranceRevision: 1,
      now: 100
    })
    expect(state.proposal?.request.id).toBe('desktop.open_notes')
    expect(state.phase).toBe('awaiting-confirmation')
    expect(state.proposal?.expiresAt).toBeGreaterThan(100)
    expect(state).not.toHaveProperty('pending')
  })

  it('selects only the first static candidate from a chained utterance', () => {
    const state = reduceMetisCommandSession(idleMetisCommandSession(), {
      type: 'transcript',
      text: 'open notes then open Arc',
      channel: 'command'
    })
    expect(state.proposal?.request.id).toBe('desktop.open_notes')
  })

  it('revokes a proposal on cancel, stop, expiry, or a newer partial', () => {
    let state = reduceMetisCommandSession(idleMetisCommandSession(), {
      type: 'transcript',
      text: 'open notes',
      channel: 'command',
      sessionId: 'session-1',
      utteranceRevision: 1
    })
    const proposalId = state.proposal!.id
    state = reduceMetisCommandSession(state, { type: 'proposal_expired', proposalId })
    expect(state.proposal).toBeUndefined()
    expect(state.reason).toBe('proposal_expired')

    state = reduceMetisCommandSession(state, { type: 'transcript', text: 'open Arc', channel: 'command' })
    state = reduceMetisCommandSession(state, { type: 'cancel' })
    expect(state.proposal).toBeUndefined()
    expect(state.reason).toBe('cancelled')

    state = reduceMetisCommandSession(idleMetisCommandSession(), {
      type: 'transcript', text: 'open notes', channel: 'command'
    })
    state = reduceMetisCommandSession(state, { type: 'transcript', text: 'open Arc', channel: 'command' })
    expect(state.proposal?.request.id).toBe('desktop.open_arc')
    state = reduceMetisCommandSession(state, { type: 'stop' })
    expect(state.proposal).toBeUndefined()
  })

  it('keeps wake and listening pill behavior without action authority', () => {
    let state = reduceMetisCommandSession(idleMetisCommandSession(), {
      type: 'transcript', text: 'Métis', channel: 'command'
    })
    expect(state).toMatchObject({ active: true, pillCopy: METIS_PILL_HI, chime: 'single' })
    state = reduceMetisCommandSession(state, { type: 'tick_listening_copy' })
    expect(state.pillCopy).toBe(METIS_PILL_LISTENING)
  })
})
