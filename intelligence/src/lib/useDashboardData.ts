import { useCallback, useEffect, useRef, useState } from 'react'
import type { DashboardData } from '../types/data'
import {
  brainStatusIsWorking,
  startSingleFlightStatusPolling,
  shouldReloadForBrainStatus,
  type BrainStatusSnapshot
} from './status-refresh'
import { INTELLIGENCE_STATUS_UNAVAILABLE_COPY } from './intelligence-update'

interface State {
  data: DashboardData | null
  loading: boolean
  /** Fatal: there is nothing to show. The view is replaced by the error. */
  error: string | null
  /**
   * Non-fatal: `data` is the last good snapshot and a REFRESH failed.
   *
   * Keeping the last snapshot on screen is deliberate — one IPC hiccup must not blank a dashboard
   * someone is reading. But it used to be kept SILENTLY (`error: prev.data ? null : err.message`),
   * so a bridge that died stayed dead while the page went on presenting figures as current. Numbers
   * that stopped updating have to say so, or they are worse than no numbers.
   */
  stale: string | null
}

/**
 * Data source, in preference order:
 *  1. Embedded in Métis (the Mantu Intelligence window): window.intelligence.getData() reads the
 *     live brain over IPC (decrypted in the main process) and the adapter reshapes it.
 *  2. Standalone/dev: the generated data.json from /public (placeholder or a manual vault build).
 */
export function useDashboardData(): State & {
  status: BrainStatusSnapshot | null
  refreshStatus: () => Promise<BrainStatusSnapshot | null>
} {
  const [state, setState] = useState<State>({ data: null, loading: true, error: null, stale: null })
  const [status, setStatus] = useState<BrainStatusSnapshot | null>(null)
  const refreshStatusRef = useRef<() => Promise<BrainStatusSnapshot | null>>(async () => null)
  const refreshStatus = useCallback(() => refreshStatusRef.current(), [])

  useEffect(() => {
    let cancelled = false
    let requestId = 0
    let lastLoadAt = 0
    const withTimeout = async <T,>(p: Promise<T>, ms: number, label: string): Promise<T> => {
      let t: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([
          p,
          new Promise<T>((_, reject) => {
            t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
          })
        ])
      } finally {
        if (t) clearTimeout(t)
      }
    }
    const fromBrain = async (): Promise<DashboardData> => {
      const { brainToDashboard } = await import('./brainAdapter')
      // Cap3 blank dig: a hung getData left Today on forever-loading dark void (Tony FAIL).
      const raw = await withTimeout(window.intelligence!.getData(), 8000, 'intelligence.getData')
      return brainToDashboard(raw)
    }
    const validateDashboard = (json: unknown): DashboardData => {
      if (!json || typeof json !== 'object') throw new Error('dashboard payload is not an object')
      for (const k of [
        'deals', 'people', 'accounts', 'meetings_feed', 'coaching_insights', 'account_graph',
        'account_summaries', 'sector_summaries', 'status', 'warnings', 'ingest_errors'
      ]) {
        if (!(k in (json as Record<string, unknown>))) {
          throw new Error(`dashboard payload missing "${k}"`)
        }
      }
      return json as DashboardData
    }
    const fromFile = async (): Promise<DashboardData> => {
      // Inside Electron (file://) prefer live brain. Cap3 QA tip apps may ship data.example.json so
      // Where-do-we-stand still paints when the bridge hangs/fails (never silent zero counts).
      if (window.location.protocol === 'file:') {
        const tryNames = ['data.example.json', 'data.json']
        for (const name of tryNames) {
          try {
            const res = await fetch(`./${name}`)
            if (!res.ok) continue
            return validateDashboard(await res.json())
          } catch {
            /* try next */
          }
        }
        throw new Error('Live brain bridge unavailable and no bundled example dashboard to show.')
      }
      const res = await fetch(`${import.meta.env.BASE_URL}data.json`)
      if (!res.ok) throw new Error(`Failed to load data.json (${res.status})`)
      return validateDashboard(await res.json())
    }
    const load = (): void => {
      const myId = ++requestId
      lastLoadAt = Date.now()
      const primary = window.intelligence
        ? fromBrain().catch(async (err: Error) => {
            // Cap3: never leave the window blank — fall back to bundled example on file:// after brain fail.
            if (window.location.protocol === 'file:') {
              try {
                const data = await fromFile()
                if (!cancelled && myId === requestId) {
                  setState({
                    data,
                    loading: false,
                    error: null,
                    stale: `Brain unavailable (${err.message}). Showing bundled example for Cap3 stand prove.`
                  })
                }
                return null
              } catch {
                /* rethrow original */
              }
            }
            throw err
          })
        : fromFile()
      primary
        .then((data) => {
          if (data == null) return
          if (!cancelled && myId === requestId) setState({ data, loading: false, error: null, stale: null })
        })
        .catch((err: Error) => {
          if (!cancelled && myId === requestId)
            setState((prev) => ({
              data: prev.data,
              loading: false,
              error: prev.data ? null : err.message,
              stale: prev.data ? err.message : null
            }))
        })
    }
    load()
    // Live mode only: while a backfill is ingesting meetings in the host app, refresh so the dashboard
    // fills in as the brain grows instead of freezing at whatever existed when the window opened.
    // Cheap status poll gates the full re-read for the life of the mount (see STALE_REFRESH_MS below).
    let lastRevision: number | undefined
    let wasWorking = false
    let wasUnavailable = false
    // Wall-clock floor so now()-derived fields (Going-Cold freshness, days-quiet) don't freeze at
    // whatever they were on first load: even when the meeting count never changes, force a reload
    // once this much time has passed. Comfortably below FRESH_DAYS (14 days) so a tier change is
    // never missed. The poll itself is never self-cleared anymore (see below) so this keeps firing
    // for the life of the mount, not just until the first quiet tick.
    let statusPolling: ReturnType<typeof startSingleFlightStatusPolling<BrainStatusSnapshot | null>> | null = null
    if (window.intelligence) {
      const consumeStatus = (st: BrainStatusSnapshot | null): BrainStatusSnapshot | null => {
        if (cancelled) return st
        if (st?.error) {
          wasUnavailable = true
          setStatus(st)
          setState((prev) => ({
            data: prev.data,
            loading: false,
            error: prev.data ? null : st.error!,
            stale: prev.data ? st.error! : null
          }))
          return st
        }
        if (!st) {
          wasUnavailable = true
          setStatus({ error: INTELLIGENCE_STATUS_UNAVAILABLE_COPY })
          return null
        }
        setStatus(st)
        const now = Date.now()
        if (
          shouldReloadForBrainStatus({
            status: st,
            previousRevision: lastRevision,
            wasWorking,
            wasUnavailable,
            lastLoadAt,
            now
          })
        ) {
          load()
        }
        if (typeof st.revision === 'number') lastRevision = st.revision
        wasWorking = brainStatusIsWorking(st)
        wasUnavailable = false
        return st
      }
      statusPolling = startSingleFlightStatusPolling({
        read: () => window.intelligence!.getStatus() as Promise<BrainStatusSnapshot | null>,
        onStatus: consumeStatus,
        onError: () => {
          // An unavailable bridge is unknown, not "still running" forever. The same interval keeps
          // retrying, and explicit callers also surface fixed safe uncertain copy.
          if (!cancelled) {
            wasUnavailable = true
            setStatus({ error: INTELLIGENCE_STATUS_UNAVAILABLE_COPY })
          }
        },
        intervalMs: 2_000
      })
      refreshStatusRef.current = statusPolling.refresh
    }
    return () => {
      cancelled = true
      refreshStatusRef.current = async () => null
      statusPolling?.stop()
    }
  }, [])

  return { ...state, status, refreshStatus }
}
