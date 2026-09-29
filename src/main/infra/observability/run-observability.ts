/**
 * run-observability.ts — owns the whole life of one boot's observability: claims the run watch, audits
 * `app.started`, runs the liveness heartbeat, the out-of-process stall sampler (stall-sampler.ts) and the
 * stall monitor, and closes out with `app.shutdown.clean`. index.ts's job is only to call
 * `startRunObservability` once, `observability.timePhase` around each boot step, and
 * `observability.shutdownClean(...)` once, from `will-quit` — every other line here is this module's, not
 * index.ts's, so a change to any of these invariants shows up in one place.
 *
 * Deliberately takes `powerMonitor` as a parameter rather than importing it from `electron` — same
 * "inject everything Electron-specific" shape as stall-monitor.ts's test seams, so this module stays
 * importable and testable outside a real Electron process.
 */
import { performance } from 'node:perf_hooks'
import { beginRunWatch, markAlive, markShutdownClean, type PriorShutdown } from '../../boot-sentinel'
import type { AuditSink } from '../../logger'
import type { BootStage, BootWindowVariant } from './projection'

/** What a window stage built: its chrome and its rendering configuration. */
export interface BootStageDetail {
  transparent?: boolean
  windowVariant?: BootWindowVariant
}
import { startStallMonitor, type StallMonitor, type StallMonitorOptions } from './stall-monitor'
import { startStallSampler, type StallSampler, type StallSamplerOptions } from './stall-sampler'

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
  audit: AuditSink
  /** Electron's `powerMonitor` (or any object shaped like it) — pauses the stall monitor's heartbeat
   *  across sleep on 'suspend', and restarts it on both 'resume' and 'unlock-screen' (the latter is the
   *  fallback for a sleep whose matching 'resume' never arrives); see stall-monitor.ts for why one
   *  restart-if-paused method shared by both events is what makes them order-independent. */
  powerMonitor: PowerMonitorSource
  /** The metis-mac-helper binary that runs this boot's out-of-process stall sampler (stall-sampler.ts).
   *  Absent or null means no sampler (no helper on this platform, or flag `diagnostics.stall_sampler`
   *  off), and then this module behaves exactly as it did before M2-0192. */
  stallWatchCommand?: string | null
  /** Test seams only — production wires the real fs-backed boot-sentinel functions and real timers. */
  deps?: {
    beginRunWatch?: typeof beginRunWatch
    markAlive?: typeof markAlive
    markShutdownClean?: typeof markShutdownClean
    startStallMonitor?: (opts: StallMonitorOptions) => StallMonitor
    startStallSampler?: (opts: StallSamplerOptions) => StallSampler
    setIntervalFn?: (handler: () => void, ms: number) => Timer
    clearIntervalFn?: (handle: Timer) => void
    now?: () => number
  }
}

export interface RunObservability {
  /** How the previous run ended, read once by beginRunWatch. */
  readonly priorShutdown: PriorShutdown
  /** Run `fn`, measuring its duration so a late stall tick can name whichever phase actually ran longest
   *  since the previous tick. Forwarded straight to the stall monitor, which owns that measurement and
   *  clearing it every tick (stall-monitor.ts). Wrap any boot step or background-timer callback worth
   *  naming on a late tick; returns `fn`'s result. */
  timePhase<T>(label: string, fn: () => T): T
  /** timePhase for a native boot stage that runs in a main-thread task of its own (M2-0433). Its duration is
   *  also audited as `app.boot.stage`, whether `fn` returns or throws, so every run names each stage's cost
   *  without a CPU profile. The audit write is outside the measured time. */
  timeBootStage<T>(stage: BootStage, fn: () => T): T
  /** Audits `app.boot.stage` for a stage the caller timed itself (a constructor whose assignment must stay
   *  in place), with what the stage built. */
  recordBootStage(stage: BootStage, ms: number, detail?: BootStageDetail): void
  /** Stop the heartbeat and the stall monitor and audit `app.shutdown.clean`. Call once, last, from
   *  `will-quit`. Idempotent. */
  shutdownClean(uptimeS: number): void
}

/** Runs one native boot stage through `observability.timeBootStage` once observability has started, and untimed
 *  before that (M2-0433). */
export function timeBootStage<T>(observability: RunObservability | null, stage: BootStage, fn: () => T): T {
  return observability ? observability.timeBootStage(stage, fn) : fn()
}

const ALIVE_INTERVAL_MS = 10_000

/** Start this boot's observability. Call once, at the same point the app is ready to claim a window. */
export function startRunObservability(opts: RunObservabilityOptions): RunObservability {
  const deps = opts.deps ?? {}
  const doBeginRunWatch = deps.beginRunWatch ?? beginRunWatch
  const doMarkAlive = deps.markAlive ?? markAlive
  const doMarkShutdownClean = deps.markShutdownClean ?? markShutdownClean
  const doStartStallMonitor = deps.startStallMonitor ?? startStallMonitor
  const doStartStallSampler = deps.startStallSampler ?? startStallSampler
  const setIntervalFn = deps.setIntervalFn ?? setInterval
  const clearIntervalFn = deps.clearIntervalFn ?? clearInterval
  const now = deps.now ?? (() => performance.now())
  const powerMonitor = opts.powerMonitor

  const { bootId, prior } = doBeginRunWatch(opts.userData)
  opts.audit('app.started', {
    version: opts.version,
    platform: opts.platform,
    arch: opts.arch,
    bootId,
    prevBootId: prior.prevBootId,
    prevShutdown: prior.prevShutdown,
    prevLastAliveAt: prior.prevLastAliveAt,
    uvThreadpoolSize: opts.uvThreadpoolSize || 'default'
  })

  const aliveTimer = setIntervalFn(() => {
    void doMarkAlive(opts.userData, bootId)
  }, ALIVE_INTERVAL_MS)

  const stallSampler = opts.stallWatchCommand
    ? doStartStallSampler({
        command: opts.stallWatchCommand,
        userData: opts.userData,
        bootId,
        aliveIntervalMs: ALIVE_INTERVAL_MS,
        audit: opts.audit
      })
    : undefined

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

  const recordBootStage = (stage: BootStage, ms: number, detail?: BootStageDetail): void =>
    opts.audit('app.boot.stage', { bootId, stage, ms, ...detail })

  let stopped = false
  return {
    priorShutdown: prior.prevShutdown,
    timePhase<T>(label: string, fn: () => T): T {
      return stallMonitor.timePhase(label, fn)
    },
    timeBootStage<T>(stage: BootStage, fn: () => T): T {
      let ms = 0
      try {
        return stallMonitor.timePhase(stage, () => {
          const start = now()
          try {
            return fn()
          } finally {
            ms = now() - start
          }
        })
      } finally {
        recordBootStage(stage, ms)
      }
    },
    recordBootStage,
    shutdownClean(uptimeS: number): void {
      if (stopped) return
      stopped = true
      // Before the heartbeat stops, so the helper can never see the marker go stale during the rest of
      // will-quit.
      stallSampler?.stop()
      clearIntervalFn(aliveTimer)
      powerMonitor.removeListener('suspend', onSuspend)
      powerMonitor.removeListener('resume', onWake)
      powerMonitor.removeListener('unlock-screen', onWake)
      stallMonitor.stop()
      opts.audit('app.shutdown.clean', doMarkShutdownClean(opts.userData, bootId, uptimeS))
    }
  }
}
