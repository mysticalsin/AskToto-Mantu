import { describe, expect, it } from 'vitest'
import { brainStatusError, brainStatusIsWorking, brainStatusPollInterval, shouldRefreshAfterBrainStatus, shouldRefreshAfterBrainStatusTransition } from './brain-status-refresh'

describe('in-app Intelligence status refresh', () => {
  it('keeps the control busy through recap/publication completion after the extraction queue drains', () => {
    expect(brainStatusIsWorking({ intelligenceIndex: { running: true } })).toBe(true)
    expect(brainStatusIsWorking({ intelligenceIndex: { running: false, lastError: 'Retry' } })).toBe(false)
    expect(brainStatusIsWorking({ backfill: { total: 0, done: 0, running: false, preparing: true } })).toBe(true)
    expect(brainStatusIsWorking({ live: { pending: 1, running: true } })).toBe(true)
    expect(brainStatusIsWorking(null)).toBe(false)
  })
  it('keeps a compact idle poll alive so a later automatic ingest is noticed', () => {
    expect(brainStatusPollInterval(false)).toBe(2_000)
    expect(brainStatusPollInterval(true)).toBe(1_000)
  })

  it('shows terminal indexing errors without carrying a previous failure into a running retry', () => {
    expect(brainStatusError({ intelligenceIndex: { running: false, lastError: 'Retry indexing' } })).toBe('Retry indexing')
    expect(brainStatusError({ intelligenceIndex: { running: true, lastError: 'Previous failure' } })).toBeNull()
    expect(brainStatusError({ error: 'Sign in', intelligenceIndex: { running: true } })).toBe('Sign in')
    expect(brainStatusError(null)).toBeNull()
  })

  it('does one full refresh when a live or Index run settles', () => {
    expect(shouldRefreshAfterBrainStatusTransition(true, false)).toBe(true)
    expect(shouldRefreshAfterBrainStatusTransition(false, false)).toBe(false)
  })

  it('refreshes a same-count Intelligence change when its persisted revision advances', () => {
    expect(
      shouldRefreshAfterBrainStatus({ previousRevision: 8, revision: 9, wasWorking: false, isWorking: false })
    ).toBe(true)
  })
})
