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
  /** UV_THREADPOOL_SIZE as this process started with it (ADR-021); absent or empty means libuv's default. */
  uvThreadpoolSize?: string
  audit: (event: AuditEvent, detail?: Record<string, unknown>) => void
  /** Electron's `powerMonitor` (or any object shaped like it) — pauses the stall monitor's heartbeat
   *  across sleep and resyncs it on resume; see stall-monitor.ts for why both events are needed. Also
   *  restarts that heartbeat on 'unlock-screen' as a fallback for a sleep whose matching 'resume' never
   *  arrives — see the `suspended`-gated handler below for why that resync is conditional. */
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

  // Order-independent by construction (see stall-monitor.ts): 'suspend' removes the heartbeat outright, so
  // there is no tick left pending to race 'resume' no matter which the event loop processes first; 'resume'
  // re-arms the schedule and restarts the heartbeat. Needed even though stall-monitor.ts's own clock does
  // not advance during sleep on macOS, because some platforms' monotonic clock does.
  //
  // `suspended` tracks whether a 'suspend' has paused the heartbeat with no 'resume' having re-armed it
  // since; it is cleared by whichever of 'resume' or 'unlock-screen' re-arms the heartbeat first. Only
  // 'unlock-screen' below reads it — 'resume' always resyncs unconditionally, because after any real sleep
  // the gap on the stall clock is sleep, not a main-thread stall: on a platform whose monotonic clock counts
  // through sleep that gap must be discarded, and resync() also restarts the heartbeat that 'suspend'
  // paused. The cost: 'resume' can still arrive after 'unlock-screen' has already restarted a heartbeat
  // 'suspend' had paused (see onUnlockScreen below); that unconditional resync() then re-baselines a
  // heartbeat that is already running, discarding whatever real lateness accrued since it restarted — the
  // same class of bug onUnlockScreen's own `suspended` guard exists to prevent, just from 'resume' arriving
  // second instead of first.
  let suspended = false
  const onSuspend = (): void => {
    suspended = true
    stallMonitor.pause()
  }
  const onResume = (): void => {
    suspended = false
    stallMonitor.resync()
  }
  powerMonitor.on('suspend', onSuspend)
  powerMonitor.on('resume', onResume)
  // Fallback for the case 'resume' itself never arrives (an aborted sleep, or a platform that raises
  // 'suspend' without a matching 'resume'): only resync here when 'suspend' actually paused the heartbeat
  // and no 'resume' has re-armed it since. resync() unconditionally re-baselines expectedAt from now(), and
  // a screen lock usually leaves the machine awake with the heartbeat still running — calling it on a
  // running heartbeat would discard any real lateness already accumulated (e.g. the main thread blocked in
  // a synchronous OneDrive read while the screen was locked), silently erasing the exact evidence this
  // module exists to produce. Gating on `suspended` makes this a no-op whenever the heartbeat never
  // stopped ticking, so it can only ever restart one that 'suspend' actually stopped.
  const onUnlockScreen = (): void => {
    if (!suspended) return
    suspended = false
    stallMonitor.resync()
  }
  powerMonitor.on('unlock-screen', onUnlockScreen)

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
      powerMonitor.removeListener('resume', onResume)
      powerMonitor.removeListener('unlock-screen', onUnlockScreen)
      stallMonitor.stop()
      opts.audit('app.shutdown.clean', doMarkShutdownClean(opts.userData, bootId, uptimeS))
    }
  }
}
