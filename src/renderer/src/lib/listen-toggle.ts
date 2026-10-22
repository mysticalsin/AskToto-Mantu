import { useEffect, useMemo, useRef } from 'react'
import { ADMISSION_DENIED_MSG } from './listen-notes'

/**
 * Q14: what a Start/Stop control does, and what the user sees when a Start does nothing.
 *
 * The bar's chrome keys off "a Stop was initiated" the instant Stop is pressed, but the listening flag stays true
 * until the sealed audio drains (bounded by the engine's no-progress timer). A Start click in that window used to
 * re-enter the Stop path, which is idempotent by latch: a swallowed click with no message. It now says why.
 */
export const STOP_STILL_FINISHING_MSG = 'Still finishing your last meeting. Try again in a moment.'

/** A Start that has produced no meeting and no visible reason after this long is reported, not left silent. */
export const START_WATCHDOG_MS = 2_500

export type ToggleListenIntent = 'start' | 'stop' | 'wait-for-stop'

export function resolveToggleListenIntent(state: { listening: boolean; stopInProgress: boolean }): ToggleListenIntent {
  if (!state.listening) return 'start'
  return state.stopInProgress ? 'wait-for-stop' : 'stop'
}

export interface StartWatchdog {
  /** A Start was just requested: check shortly that it produced a meeting or a visible reason. */
  arm(): void
  /** The request was superseded (a Stop): there is nothing left to check. */
  disarm(): void
  dispose(): void
}

export interface StartWatchdogOptions {
  /** Read at check time, so it sees what the screen shows then, not what it showed at the click. */
  read: () => { listening: boolean; hasVisibleReason: boolean }
  notify: (message: string) => void
  delayMs?: number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export function createStartWatchdog(options: StartWatchdogOptions): StartWatchdog {
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  let pending: unknown = null
  const disarm = (): void => {
    if (pending !== null) clearTimer(pending)
    pending = null
  }
  return {
    arm() {
      disarm()
      pending = setTimer(() => {
        pending = null
        const seen = options.read()
        if (!seen.listening && !seen.hasVisibleReason) options.notify(ADMISSION_DENIED_MSG)
      }, options.delayMs ?? START_WATCHDOG_MS)
    },
    disarm,
    dispose: disarm
  }
}

export interface ListenToggleActions {
  /** Starts a meeting, possibly after a confirmation sheet; calls `onStarted` only when the start really runs. */
  startListen: (onStarted: () => void) => void
  endReview: () => void
  notify: (message: string) => void
  watchdog: StartWatchdog
}

/** The one Start/Stop decision behind every control (bar, control bar, sidecar, hotkey). */
export function runListenToggle(
  state: { listening: boolean; stopInProgress: boolean },
  actions: ListenToggleActions
): void {
  const intent = resolveToggleListenIntent(state)
  if (intent === 'wait-for-stop') {
    actions.notify(STOP_STILL_FINISHING_MSG)
    return
  }
  if (intent === 'stop') {
    actions.watchdog.disarm()
    actions.endReview()
    return
  }
  // A click on Start supersedes any earlier check; the new one arms only once the start actually runs, so an
  // open confirmation sheet (a visible reason in itself) is never mistaken for a swallowed click.
  actions.watchdog.disarm()
  actions.startListen(() => actions.watchdog.arm())
}

/** Stable watchdog bound to the latest render's view of "is it listening, and is a reason on screen". */
export function useStartWatchdog(
  listening: boolean,
  hasVisibleReason: boolean,
  notify: (message: string) => void
): StartWatchdog {
  const latest = useRef({ listening, hasVisibleReason, notify })
  latest.current = { listening, hasVisibleReason, notify }
  const watchdog = useMemo(
    () =>
      createStartWatchdog({
        read: () => latest.current,
        notify: (message) => latest.current.notify(message)
      }),
    []
  )
  useEffect(() => () => watchdog.dispose(), [watchdog])
  return watchdog
}
