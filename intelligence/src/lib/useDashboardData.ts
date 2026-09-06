import { useEffect, useState } from 'react'
import type { DashboardData } from '../types/data'
import { brainStatusIsWorking, shouldReloadForBrainStatus } from './status-refresh'

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
export function useDashboardData(): State {
  const [state, setState] = useState<State>({ data: null, loading: true, error: null, stale: null })

  useEffect(() => {
    let cancelled = false
    let requestId = 0
    let lastLoadAt = 0
    const fromBrain = async (): Promise<DashboardData> => {
      const { brainToDashboard } = await import('./brainAdapter')
      return brainToDashboard(await window.intelligence!.getData())
    }
    const fromFile = async (): Promise<DashboardData> => {
      // Inside Electron (file:// bundle) the preload MUST be present — a missing window.intelligence
      // there is a wiring failure, and silently serving a baked-in data.json would present stale
      // vault numbers as current. Fail loudly instead; the file path is for standalone/dev only.
      if (window.location.protocol === 'file:') {
        throw new Error('Live brain bridge unavailable (preload failed). Refusing to show stale bundled data.')
      }
      const res = await fetch(`${import.meta.env.BASE_URL}data.json`)
      if (!res.ok) throw new Error(`Failed to load data.json (${res.status})`)
      const json = await res.json()
      // A data.json generated against an older schema crashes each view with an opaque TypeError
      // deep in a useMemo. Check the top-level contract here instead, so a stale file fails once,
      // loudly, with the fix in the message.
      for (const k of [
        'deals', 'people', 'accounts', 'meetings_feed', 'coaching_insights', 'account_graph',
        'account_summaries', 'sector_summaries', 'status', 'warnings', 'ingest_errors'
      ]) {
        if (!(k in json)) {
          throw new Error(`data.json is stale: missing "${k}". Rebuild it with intelligence/scripts/build-data.mjs.`)
        }
      }
      return json as DashboardData
    }
    const load = (): void => {
      const myId = ++requestId
      lastLoadAt = Date.now()
      ;(window.intelligence ? fromBrain() : fromFile())
        .then((data) => {
          if (!cancelled && myId === requestId) setState({ data, loading: false, error: null, stale: null })
        })
        .catch((err: Error) => {
          if (!cancelled && myId === requestId)
            setState((prev) => ({
              data: prev.data,
              loading: false,
              // With no snapshot to fall back on this is fatal and replaces the view. With one, keep
              // showing it and mark it stale rather than discarding the failure.
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
    // A persistently-null status (e.g. auth expired) must stop the poll, since nothing else here
    // ever clears it, and without this it would poll the dead IPC forever. A transient null (one
    // hiccup) must NOT stop it, so only consecutive nulls count; any real response resets the streak.
    let consecutiveNulls = 0
    const MAX_CONSECUTIVE_NULLS = 3
    // Wall-clock floor so now()-derived fields (Going-Cold freshness, days-quiet) don't freeze at
    // whatever they were on first load: even when the meeting count never changes, force a reload
    // once this much time has passed. Comfortably below FRESH_DAYS (14 days) so a tier change is
    // never missed. The poll itself is never self-cleared anymore (see below) so this keeps firing
    // for the life of the mount, not just until the first quiet tick.
    const iv = window.intelligence
      ? setInterval(async () => {
        try {
            const st = (await window.intelligence!.getStatus()) as {
              revision?: number
              backfill?: { running?: boolean }
              live?: { running?: boolean }
              error?: string
            } | null
            if (st?.error) {
              consecutiveNulls = 0
              if (!cancelled)
                setState((prev) => ({
                  data: prev.data,
                  loading: false,
                  error: prev.data ? null : st.error!,
                  stale: prev.data ? st.error! : null
                }))
              return
            }
            if (!st) {
              consecutiveNulls += 1
              if (consecutiveNulls >= MAX_CONSECUTIVE_NULLS) clearInterval(iv!)
              return
            }
            consecutiveNulls = 0
            const now = Date.now()
            if (shouldReloadForBrainStatus({ status: st, previousRevision: lastRevision, wasWorking, lastLoadAt, now })) load()
            if (typeof st.revision === 'number') lastRevision = st.revision
            wasWorking = brainStatusIsWorking(st)
            // No self-clear here: the poll is a cheap IPC status call gated by `changed`/`stale`
            // before doing the expensive load(), so there's no cost to leaving it alive for the
            // life of the mount. The only termination path is the consecutive-null check above.
          } catch {
            /* transient IPC hiccup, next tick retries */
          }
        }, 2_000)
      : null
    return () => {
      cancelled = true
      if (iv) clearInterval(iv)
    }
  }, [])

  return state
}
