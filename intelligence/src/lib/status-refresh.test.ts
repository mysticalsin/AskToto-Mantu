import { describe, expect, it, vi } from 'vitest'
import {
  brainStatusIsWorking,
  createSingleFlightStatusReader,
  startSingleFlightStatusPolling,
  shouldReloadForBrainStatus
} from './status-refresh'

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

  it('reloads once after unavailable status recovers even with an unchanged idle revision', () => {
    expect(shouldReloadForBrainStatus({
      status: { revision: 12, intelligenceIndex: { running: false } },
      previousRevision: 12,
      wasWorking: false,
      wasUnavailable: true,
      lastLoadAt: now - 100,
      now
    })).toBe(true)
  })

  it('treats the Intelligence index as working even after backfill has settled', () => {
    expect(
      brainStatusIsWorking({
        backfill: { running: false },
        live: { running: false },
        intelligenceIndex: { running: true }
      })
    ).toBe(true)
  })

  it('coalesces overlapping polls but makes an explicit refresh newer than an active poll', async () => {
    const pending: Array<(status: { revision: number }) => void> = []
    const read = vi.fn(
      () =>
        new Promise<{ revision: number }>((resolve) => {
          pending.push(resolve)
        })
    )
    const reader = createSingleFlightStatusReader(read)

    const firstPoll = reader.poll()
    const overlappingPoll = reader.poll()
    const explicitRefresh = reader.refresh()

    expect(read).toHaveBeenCalledTimes(1)
    expect(overlappingPoll).toBe(firstPoll)

    pending[0]({ revision: 1 })
    await firstPoll
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2))

    pending[1]({ revision: 2 })
    await expect(explicitRefresh).resolves.toEqual({ revision: 2 })
  })

  it('keeps the same poll owner alive through nulls, explicit recovery, and terminal completion', async () => {
    vi.useFakeTimers()
    try {
      const read = vi
        .fn<() => Promise<{ running: boolean } | null>>()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ running: true })
        .mockResolvedValueOnce({ running: false })
      const seen: Array<{ running: boolean } | null> = []
      const polling = startSingleFlightStatusPolling({
        read,
        onStatus: (status) => seen.push(status),
        intervalMs: 2_000
      })

      await vi.advanceTimersByTimeAsync(6_000)
      expect(read).toHaveBeenCalledTimes(3)
      expect(seen).toEqual([null, null, null])

      await expect(polling.refresh()).resolves.toEqual({ running: true })
      await vi.advanceTimersByTimeAsync(2_000)
      expect(read).toHaveBeenCalledTimes(5)
      expect(seen.at(-1)).toEqual({ running: false })

      polling.stop()
      await vi.advanceTimersByTimeAsync(4_000)
      expect(read).toHaveBeenCalledTimes(5)
    } finally {
      vi.useRealTimers()
    }
  })
})
