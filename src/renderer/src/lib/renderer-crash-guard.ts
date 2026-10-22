import type { RendererCrashReport } from '@shared/ipc'
import { crashReport } from './crash-context'

const REPORT_INTERVAL_MS = 60_000
const REPORTS_PER_SESSION = 5
const REMOUNT_WINDOW_MS = 60_000
const REMOUNTS_BEFORE_RELOAD = 3

/** Rate limiter for errors caught outside React's render path: one a minute, five a session. */
export function createCrashReportLimiter(now: () => number = Date.now): () => boolean {
  let last = -Infinity
  let sent = 0
  return () => {
    const t = now()
    if (sent >= REPORTS_PER_SESSION || t - last < REPORT_INTERVAL_MS) return false
    last = t
    sent += 1
    return true
  }
}

/**
 * What the crash card's Reload button should do. A remount re-renders the same state, so a deterministic
 * render error would throw again forever; the third remount inside a minute escalates to a real reload.
 */
export function createReloadBudget(now: () => number = Date.now): () => 'remount' | 'reload' {
  let stamps: number[] = []
  return () => {
    const t = now()
    stamps = stamps.filter((s) => t - s < REMOUNT_WINDOW_MS)
    stamps.push(t)
    return stamps.length >= REMOUNTS_BEFORE_RELOAD ? 'reload' : 'remount'
  }
}

type ErrorTarget = Pick<Window, 'addEventListener' | 'removeEventListener'>

function describeReason(reason: unknown): Error {
  if (reason instanceof Error) return reason
  return new Error(typeof reason === 'string' && reason ? reason : 'Unhandled promise rejection')
}

/**
 * Reports window `error` and `unhandledrejection` events (event handlers, timers and promises, which an
 * error boundary cannot see) through `report`. Reports only: it shows no crash card, so a failed IPC
 * continuation never replaces a working overlay. Returns the uninstall function.
 */
export function installGlobalCrashHandlers(
  target: ErrorTarget,
  report: (r: RendererCrashReport) => void,
  allow: () => boolean
): () => void {
  const send = (error: Error): void => {
    try {
      if (allow()) report(crashReport(error, null))
    } catch {
      /* the preload bridge may be what broke; reporting is best-effort */
    }
  }
  const onError = (event: ErrorEvent): void =>
    send(event.error instanceof Error ? event.error : new Error(event.message || 'Uncaught renderer error'))
  const onRejection = (event: PromiseRejectionEvent): void => send(describeReason(event.reason))
  target.addEventListener('error', onError)
  target.addEventListener('unhandledrejection', onRejection)
  return () => {
    target.removeEventListener('error', onError)
    target.removeEventListener('unhandledrejection', onRejection)
  }
}
