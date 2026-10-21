/**
 * Closing a panel surface (Settings sheet, History / Review / Agenda / Intelligence panel) plays its open
 * transition in reverse before the view changes, so Escape, Done, the close button and the Bar toggles all
 * leave the way the surface arrived instead of cutting to the bar.
 *
 * Invariants:
 *   - Only a close to a view with no panel (the Bar's Answer / Copilot) waits; a switch between panels lands at
 *     once and the arriving content cross-fades in (see LazyPanel).
 *   - Reduced motion, or no panel surface on screen, closes at once.
 *   - A second request while one is pending lands at once and replaces it (HIG Motion: let people cancel motion).
 *   - While exiting, the surface keeps showing what it showed when the close began (LazyPanel freezes its
 *     children) and takes no pointer input. The flag clears when the surface unmounts, or after a backstop.
 */
import { useCallback, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { RendererView } from '@shared/renderer-view'
import { prefersOverlayReducedMotion } from './overlay-motion'

/** Matches --duration-hover, the exit leg of the panel spring (tokens.css). */
export const SURFACE_EXIT_MS = 150
/** Clears a stuck exit when the close commits nothing (a toggle that nets no view change). */
export const SURFACE_EXIT_BACKSTOP_MS = 600
/** The attribute every exit-participating surface carries. */
export const SURFACE_EXIT_ATTR = 'data-surface-exit'

const PANEL_FREE_VIEWS: ReadonlySet<RendererView> = new Set<RendererView>(['answer', 'copilot'])

let exiting = false
const listeners = new Set<() => void>()

function setExiting(next: boolean): void {
  if (exiting === next) return
  exiting = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function isSurfaceExiting(): boolean {
  return exiting
}

/** True while the on-screen panel surface plays its exit. */
export function useSurfaceExiting(): boolean {
  return useSyncExternalStore(subscribe, isSurfaceExiting, () => false)
}

/** Marks a surface as exit-participating; its unmount ends the exit. Returns the attribute props to spread. */
export function useSurfaceExitTarget(): { [SURFACE_EXIT_ATTR]: '' } {
  useLayoutEffect(() => () => setExiting(false), [])
  return { [SURFACE_EXIT_ATTR]: '' }
}

export interface SurfaceExitDeps {
  reducedMotion: () => boolean
  /** Whether an exit-participating surface is on screen right now. */
  surfaceShown: () => boolean
  schedule: (run: () => void, ms: number) => () => void
}

export interface SurfaceExit {
  /** Runs `commit` after the exit plays, or at once when nothing should animate. */
  run: (commit: () => void) => void
  /** Drops a pending exit and shows the surface again (its view changed some other way). */
  cancel: () => void
}

export function createSurfaceExit(deps: SurfaceExitDeps): SurfaceExit {
  let cancelPending: (() => void) | null = null
  let cancelBackstop: (() => void) | null = null
  const clearTimers = (): void => {
    cancelPending?.()
    cancelPending = null
    cancelBackstop?.()
    cancelBackstop = null
  }
  return {
    run(commit) {
      const interrupting = cancelPending !== null
      clearTimers()
      if (interrupting || deps.reducedMotion() || !deps.surfaceShown()) {
        setExiting(false)
        commit()
        return
      }
      setExiting(true)
      cancelPending = deps.schedule(() => {
        cancelPending = null
        commit()
        // The surface unmounts in the commit that lands the close; this only catches a close that committed
        // nothing, so the frozen surface never stays faded out.
        cancelBackstop = deps.schedule(() => {
          cancelBackstop = null
          setExiting(false)
        }, SURFACE_EXIT_BACKSTOP_MS)
      }, SURFACE_EXIT_MS)
    },
    cancel() {
      clearTimers()
      setExiting(false)
    }
  }
}

const browserDeps: SurfaceExitDeps = {
  reducedMotion: prefersOverlayReducedMotion,
  surfaceShown: () => typeof document !== 'undefined' && document.querySelector(`[${SURFACE_EXIT_ATTR}]`) !== null,
  schedule: (run, ms) => {
    const id = setTimeout(run, ms)
    return () => clearTimeout(id)
  }
}

/**
 * Wraps App's view setter: a close from a panel view to the Bar plays the exit first. Also returns
 * `afterExit`, for a close that is not a view change (the collapse chevron).
 */
export function useSurfaceExitView(
  view: RendererView,
  setView: Dispatch<SetStateAction<RendererView>>,
  deps: SurfaceExitDeps = browserDeps
): [Dispatch<SetStateAction<RendererView>>, (commit: () => void) => void] {
  const viewRef = useRef(view)
  viewRef.current = view
  const exit = useMemo(() => createSurfaceExit(deps), [deps])
  const setViewAfterExit = useCallback(
    (v: SetStateAction<RendererView>): void => {
      const current = viewRef.current
      const next = typeof v === 'function' ? v(current) : v
      if (PANEL_FREE_VIEWS.has(current) || !PANEL_FREE_VIEWS.has(next)) {
        exit.cancel()
        setView(v)
        return
      }
      exit.run(() => setView(next))
    },
    [exit, setView]
  )
  return [setViewAfterExit, exit.run]
}
