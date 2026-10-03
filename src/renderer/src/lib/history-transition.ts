/**
 * Records {from, to, committedAtMs} for every committed navigation a History request took part in, so a
 * report of "History did not open" can be told apart from a freeze.
 *
 * Invariants:
 *   - A navigation request involves History when the view it changes from or to is 'history'. Every such
 *     request is reported once, when the render holding it commits; requests batched into one render are
 *     one report, `from` being the view before the first of them.
 *   - `from === to` is the toggle race: an open and a close batched into one transition render commit as a
 *     no-op. A freeze commits nothing, so it reports nothing.
 *   - `requested` runs inside a state updater, which React may call more than once for one render: it only
 *     ever sets the same pending state, so a repeated call changes nothing.
 */
import {
  startTransition,
  useCallback,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction
} from 'react'
import type { HistoryTransition } from '@shared/ipc'
import type { RendererView } from '@shared/renderer-view'
import { authenticatedIpcResult } from './ipc-auth'

/**
 * App's view state. `setView` switches views as a transition (App explains the #426 hazard this avoids) and
 * records History transitions; `setViewRaw` is the plain setter, for a switch that must land this frame.
 */
export function useTransitionView(
  initial: () => RendererView
): [RendererView, Dispatch<SetStateAction<RendererView>>, Dispatch<SetStateAction<RendererView>>] {
  const [view, setViewRaw] = useState<RendererView>(initial)
  // Every setView commits a render (navCommits always changes), even one that nets no view change, so the
  // toggle race commits and is recorded as from === to.
  const [navCommits, countNavCommit] = useReducer((n: number) => n + 1, 0)
  const recorder = useMemo(() => createHistoryTransitionRecorder(), [])
  const setView = useCallback(
    (v: SetStateAction<RendererView>): void => {
      startTransition(() => {
        setViewRaw((prev) => {
          const next = typeof v === 'function' ? v(prev) : v
          recorder.requested(prev, next)
          return next
        })
        countNavCommit()
      })
    },
    [recorder]
  )
  // Runs in the navigation's own commit, before paint; a view change from setViewRaw alone is not one.
  const recordedNavCommits = useRef(0)
  useLayoutEffect(() => {
    if (navCommits === recordedNavCommits.current) return
    recordedNavCommits.current = navCommits
    recorder.committed(view)
  }, [navCommits, view, recorder])
  return [view, setView, setViewRaw]
}

export interface HistoryTransitionRecorder {
  /** A view change was requested (setView's updater): `prev` is the view that render starts from. */
  requested(prev: RendererView, next: RendererView): void
  /** The render holding the requests committed `view`: reports it when a History request was among them. */
  committed(view: RendererView): HistoryTransition | null
}

export interface HistoryTransitionDeps {
  report: (transition: HistoryTransition) => void
  wallClock: () => number
}

export function createHistoryTransitionRecorder(deps: HistoryTransitionDeps = defaultDeps()): HistoryTransitionRecorder {
  let from: RendererView | null = null
  let involvesHistory = false
  return {
    requested(prev, next): void {
      if (from === null) from = prev
      if (prev === 'history' || next === 'history') involvesHistory = true
    },
    committed(view): HistoryTransition | null {
      const start = from
      const report = involvesHistory
      from = null
      involvesHistory = false
      if (start === null || !report) return null
      const transition: HistoryTransition = { from: start, to: view, committedAtMs: deps.wallClock() }
      deps.report(transition)
      return transition
    }
  }
}

function defaultDeps(): HistoryTransitionDeps {
  return {
    report: (transition) => {
      void window.toto.reportHistoryTransition(transition).then(authenticatedIpcResult).catch(() => {})
    },
    wallClock: Date.now
  }
}
