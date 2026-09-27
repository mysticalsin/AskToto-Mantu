/**
 * run-observability.ts — owns the whole life of one boot's observability: claims the run watch, audits
 * `app.started`, runs the liveness heartbeat and the stall monitor, and closes out with
 * `app.shutdown.clean`. index.ts's job is only to call `startRunObservability` once, `observability.timePhase`
 * around each boot step, and `observability.shutdownClean(...)` once, from `will-quit` — every other line
 * here is this module's, not index.ts's, so a change to any of these invariants shows up in one place.
 *
 * Deliberately takes `powerMonitor` as a parameter rather than importing it from `electron` — same
 * "inject everything Electron-specific" shape as stall-monitor.ts's test seams, so this module stays
 * importable and testable outside a real Electron process.
 */
import { beginRunWatch, markAlive, markShutdownClean } from '../../boot-sentinel'
import type { AuditEvent } from '../../logger'
import { startStallMonitor, type StallMonitor, type StallMonitorOptions } from './stall-monitor'

type Timer = ReturnType<typeof setInterval>

/** Only the `powerMonitor` events this module uses. */
export interface PowerMonitorSource {
  on(event: 'resume' | 'suspend' | 'unlock-screen', listener: () => void): unknown
  removeListener(event: 'resume' | 'suspend' | 'unlock-screen', listener: () => void): unknown
}

export interface RunObservabilityOptions {
  userData: string
  version: string
  platform: string
  arch: string
  audit: (event: AuditEvent, detail?: Record<string, unknown>) => void
  /** Electron's `powerMonitor` (or any object shaped like it) — pauses the stall monitor's heartbeat
   *  across sleep on 'suspend', and restarts it on both 'resume' and 'unlock-screen' (the latter is the
   *  fallback for a sleep whose matching 'resume' never arrives); see stall-monitor.ts for why one
   *  restart-if-paused method shared by both events is what makes them order-independent. */
  powerMonitor: PowerMonitorSource
  /** Test seams only — production wires the real fs-backed boot-sentinel functions and real timers. */
  deps?: {
    beginRunWatch?: typeof beginRunWatch
    markAlive?: typeof markAlive
    markShutdownClean?: typeof markShutdownClean
    startStallMonitor?: (opts: StallMonitorOptions) => StallMonitor
    setIntervalFn?: (handler: () => void, ms: number) => Timer
    clearIntervalFn?: (handle: Timer) => void
  }
}

export interface RunObservability {
  /** Run `fn`, measuring its duration so a late stall tick can name whichever phase actually ran longest
   *  since the previous tick. Forwarded straight to the stall monitor, which owns that measurement and
   *  clearing it every tick (stall-monitor.ts). Wrap any boot step or background-timer callback worth
   *  naming on a late tick; returns `fn`'s result. */
  timePhase<T>(label: string, fn: () => T): T
  /** Stop the heartbeat and the stall monitor and audit `app.shutdown.clean`. Call once, last, from
   *  `will-quit`. Idempotent. */
  shutdownClean(uptimeS: number): void
}

const ALIVE_INTERVAL_MS = 10_000

/** Start this boot's observability. Call once, at the same point the app is ready to claim a window. */
export function startRunObservability(opts: RunObservabilityOptions): RunObservability {
  const deps = opts.deps ?? {}
  const doBeginRunWatch = deps.beginRunWatch ?? beginRunWatch
  const doMarkAlive = deps.markAlive ?? markAlive
  const doMarkShutdownClean = deps.markShutdownClean ?? markShutdownClean
  const doStartStallMonitor = deps.startStallMonitor ?? startStallMonitor
  const setIntervalFn = deps.setIntervalFn ?? setInterval
  const clearIntervalFn = deps.clearIntervalFn ?? clearInterval
  const powerMonitor = opts.powerMonitor

  const { bootId, prior } = doBeginRunWatch(opts.userData)
  opts.audit('app.started', {
    version: opts.version,
    platform: opts.platform,
    arch: opts.arch,
    bootId,
    prevBootId: prior.prevBootId,
    prevShutdown: prior.prevShutdown,
    prevLastAliveAt: prior.prevLastAliveAt
  })

  const aliveTimer = setIntervalFn(() => {
    void doMarkAlive(opts.userData, bootId)
  }, ALIVE_INTERVAL_MS)

  const stallMonitor = doStartStallMonitor({
    bootId,
    // The stall monitor decides what phase (if any) a tick names and clears it every tick — this module
    // only forwards whatever detail it produces.
    onStall: (detail) =>
      opts.audit('app.stall', {
        bootId: detail.bootId,
        durationMs: detail.durationMs,
        phase: detail.phase,
        phaseMs: detail.phaseMs
      }),
    onSummary: (detail) => opts.audit('app.stall.summary', { bootId: detail.bootId, p99Ms: detail.p99Ms })
  })

  // 'suspend' clears the heartbeat so no tick can race the wake-up events; 'resume' and 'unlock-screen'
  // (the fallback when 'resume' never arrives) both call restartIfPaused(), a no-op on a running heartbeat,
  // so neither event order nor an unlock after a plain screen lock can re-baseline it and discard accruing
  // lateness.
  const onSuspend = (): void => stallMonitor.pause()
  const onWake = (): void => stallMonitor.restartIfPaused()
  powerMonitor.on('suspend', onSuspend)
  powerMonitor.on('resume', onWake)
  powerMonitor.on('unlock-screen', onWake)

  let stopped = false
  return {
    timePhase<T>(label: string, fn: () => T): T {
      return stallMonitor.timePhase(label, fn)
    },
    shutdownClean(uptimeS: number): void {
      if (stopped) return
      stopped = true
      clearIntervalFn(aliveTimer)
      powerMonitor.removeListener('suspend', onSuspend)
      powerMonitor.removeListener('resume', onWake)
      powerMonitor.removeListener('unlock-screen', onWake)
      stallMonitor.stop()
      opts.audit('app.shutdown.clean', doMarkShutdownClean(opts.userData, bootId, uptimeS))
    }
  }
}
