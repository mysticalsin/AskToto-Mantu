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
      const res = await fetch(`${import.meta.env.BASE_URL}data.json`)
      if (!res.ok) throw new Error(`Failed to load data.json (${res.status})`)
      return res.json()
    }
    ;(window.intelligence ? fromBrain() : fromFile())
      .then((data) => {
        if (!cancelled) setState({ data, loading: false, error: null })
      })
      .catch((err: Error) => {
        if (!cancelled) setState({ data: null, loading: false, error: err.message })
      })
    return () => {
      cancelled = true
    }
  }, [])

  return state
}
