import { useEffect, useState } from 'react'
import type { DashboardData } from '../types/data'

interface State {
  data: DashboardData | null
  loading: boolean
  error: string | null
}

/**
 * Data source, in preference order:
 *  1. Embedded in AskToto (the Mantu Intelligence window): window.intelligence.getData() reads the
 *     live brain over IPC (decrypted in the main process) and the adapter reshapes it.
 *  2. Standalone/dev: the generated data.json from /public (placeholder or a manual vault build).
 */
export function useDashboardData(): State {
  const [state, setState] = useState<State>({ data: null, loading: true, error: null })

  useEffect(() => {
    let cancelled = false
    const fromBrain = async (): Promise<DashboardData> => {
      const { brainToDashboard } = await import('./brainAdapter')
      return brainToDashboard(await window.intelligence!.getData())
    }
    const fromFile = async (): Promise<DashboardData> => {
      // Inside Electron (file:// bundle) the preload MUST be present — a missing window.intelligence
      // there is a wiring failure, and silently serving a baked-in data.json would present stale
      // vault numbers as current. Fail loudly instead; the file path is for standalone/dev only.
      if (window.location.protocol === 'file:') {
        throw new Error('Live brain bridge unavailable (preload failed) — refusing to show stale bundled data.')
      }
      const res = await fetch(`${import.meta.env.BASE_URL}data.json`)
      if (!res.ok) throw new Error(`Failed to load data.json (${res.status})`)
      return res.json()
    }
    const load = (): void => {
      ;(window.intelligence ? fromBrain() : fromFile())
        .then((data) => {
          if (!cancelled) setState({ data, loading: false, error: null })
        })
        .catch((err: Error) => {
          if (!cancelled) setState((prev) => ({ data: prev.data, loading: false, error: prev.data ? null : err.message }))
        })
    }
    load()
    // Live mode only: while a backfill is ingesting meetings in the host app, refresh so the dashboard
    // fills in as the brain grows instead of freezing at whatever existed when the window opened.
    // Cheap status poll gates the full re-read; the interval dies as soon as the backfill stops.
    let lastCount = -1
    // A persistently-null status (e.g. auth expired) must stop the poll — without this it never hits
    // the clear-check below (which only runs when `st` is truthy) and polls the dead IPC forever. A
    // transient null (one hiccup) must NOT stop it, so only consecutive nulls count; any real response
    // resets the streak.
    let consecutiveNulls = 0
    const MAX_CONSECUTIVE_NULLS = 3
    const iv = window.intelligence
      ? setInterval(async () => {
          try {
            const st = (await window.intelligence!.getStatus()) as { meetings?: number; backfill?: { running?: boolean } } | null
            if (!st) {
              consecutiveNulls += 1
              if (consecutiveNulls >= MAX_CONSECUTIVE_NULLS) clearInterval(iv!)
              return
            }
            consecutiveNulls = 0
            const changed = typeof st.meetings === 'number' && st.meetings !== lastCount
            if (changed) load()
            if (typeof st.meetings === 'number') lastCount = st.meetings
            if (!st.backfill?.running && !changed && lastCount !== -1) {
              clearInterval(iv!)
            }
          } catch {
            /* transient IPC hiccup — next tick retries */
          }
        }, 10_000)
      : null
    return () => {
      cancelled = true
      if (iv) clearInterval(iv)
    }
  }, [])

  return state
}
