export interface BrainStatusSnapshot {
  revision?: number
  backfill?: { running?: boolean }
  live?: { running?: boolean }
  intelligenceIndex?: { running?: boolean; lastError?: string | null }
  error?: string
}

export const BRAIN_STATUS_STALE_REFRESH_MS = 30 * 60 * 1000

export function brainStatusIsWorking(status: BrainStatusSnapshot): boolean {
  return (
    !!status.backfill?.running ||
    !!status.live?.running ||
    !!status.intelligenceIndex?.running
  )
}

/** Coalesce ordinary polls while allowing a caller to require one read newer than the active poll. */
export function createSingleFlightStatusReader<T>(read: () => Promise<T>): {
  poll: () => Promise<T>
  refresh: () => Promise<T>
} {
  let inFlight: Promise<T> | null = null

  const poll = (): Promise<T> => {
    if (inFlight) return inFlight
    const request = read().finally(() => {
      if (inFlight === request) inFlight = null
    })
    inFlight = request
    return request
  }

  const refresh = async (): Promise<T> => {
    const active = inFlight
    if (active) {
      try {
        await active
      } catch {
        // The fresh read below is authoritative even when the earlier poll failed.
      }
    }
    return poll()
  }

  return { poll, refresh }
}

/** Own the hook's one status interval; null values are observations, never a reason to stop polling. */
export function startSingleFlightStatusPolling<T>({
  read,
  onStatus,
  onError,
  intervalMs
}: {
  read: () => Promise<T>
  onStatus: (status: T) => void
  onError?: (error: unknown) => void
  intervalMs: number
}): {
  refresh: () => Promise<T>
  stop: () => void
} {
  const reader = createSingleFlightStatusReader(async () => {
    try {
      const status = await read()
      onStatus(status)
      return status
    } catch (error) {
      onError?.(error)
      throw error
    }
  })
  const timer = setInterval(() => {
    void reader.poll().catch(() => {
      // onError already observed this failure; the same timer owns the retry.
    })
  }, intervalMs)
  return {
    refresh: reader.refresh,
    stop: () => clearInterval(timer)
  }
}

/** Full dashboard reads are needed for a persisted change, terminal ingest transition, or clock freshness. */
export function shouldReloadForBrainStatus({
  status,
  previousRevision,
  wasWorking,
  wasUnavailable = false,
  lastLoadAt,
  now
}: {
  status: BrainStatusSnapshot
  previousRevision: number | undefined
  wasWorking: boolean
  wasUnavailable?: boolean
  lastLoadAt: number
  now: number
}): boolean {
  const revisionChanged = typeof status.revision === 'number' && status.revision !== previousRevision
  const settled = wasWorking && !brainStatusIsWorking(status)
  return wasUnavailable || revisionChanged || settled || now - lastLoadAt >= BRAIN_STATUS_STALE_REFRESH_MS
}
