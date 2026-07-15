import { describe, expect, it } from 'vitest'
import { shouldReloadForBrainStatus } from './status-refresh'

describe('Mantu Intelligence status refresh gate', () => {
  const now = 1_000_000

  it('reloads when a same-count repair advances the brain revision', () => {
    expect(
      shouldReloadForBrainStatus({
        status: { revision: 12, backfill: { running: false }, live: { running: false } },
        previousRevision: 11,
        wasWorking: false,
        lastLoadAt: now - 100,
        now
      })
    ).toBe(true)
  })

  it('reloads when a live or Index run settles even if the meeting count is unchanged', () => {
    expect(
      shouldReloadForBrainStatus({
        status: { revision: 12, backfill: { running: false }, live: { running: false } },
        previousRevision: 12,
        wasWorking: true,
        lastLoadAt: now - 100,
        now
      })
    ).toBe(true)
  })

  it('does not reload an unchanged idle brain before the freshness interval', () => {
    expect(
      shouldReloadForBrainStatus({
        status: { revision: 12, backfill: { running: false }, live: { running: false } },
        previousRevision: 12,
        wasWorking: false,
        lastLoadAt: now - 100,
        now
      })
    ).toBe(false)
  })
})
