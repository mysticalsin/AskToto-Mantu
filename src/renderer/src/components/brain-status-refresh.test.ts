import { describe, expect, it } from 'vitest'
import { brainStatusPollInterval, shouldRefreshAfterBrainStatus, shouldRefreshAfterBrainStatusTransition } from './brain-status-refresh'

describe('in-app Intelligence status refresh', () => {
  it('keeps a compact idle poll alive so a later automatic ingest is noticed', () => {
    expect(brainStatusPollInterval(false)).toBe(2_000)
    expect(brainStatusPollInterval(true)).toBe(1_000)
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
