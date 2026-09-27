/**
 * Maintenance gate for unattended model work.
 *
 * INV-GATE: unattended model work = an automatic backfill job that calls a model (not the reconcile
 * strategy), an automatic Intelligence recap, and the boot-time local warm. Once started, such work
 * starts only after the boot quiet period, after the prior exit has been read and any unclean exit has
 * seen deliberate input, while no other maintenance holder runs, and while no interactive local-model
 * stream is active. Live jobs, user-triggered jobs and interactive asks never consult the gate. Before
 * startMaintenanceGate, the gate admits everything and counts nothing.
 */
import type { PriorShutdown } from '../../boot-sentinel'
import { auditLog } from '../../logger'
import {
  BOOT_QUIET_PERIOD_MS,
  deferralFor,
  isDeliberateInput,
  type DeferredReason,
  type MaintenanceDeferral
} from './policy'

export type SchedulerJobKind = 'backfill' | 'ingest' | 'intelligence-index' | 'model-work'

const INTERACTIVE_RECHECK_MS = 5_000

type Scheduler = (run: () => void, ms: number) => void
type Waiter = {
  run: () => Promise<unknown>
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

const processUptimeMs = () => process.uptime() * 1000
const DEFAULT_SCHEDULE: Scheduler = (run, ms) => { setTimeout(run, ms).unref() }

let started = false
let uptimeMs: () => number = processUptimeMs
let schedule: Scheduler = DEFAULT_SCHEDULE
let interactiveActive: () => boolean = () => false
let priorExit: PriorShutdown | undefined
let interacted = false
let holding = false
let windowOpenAudited = false
let interactiveRecheckArmed = false
const windowWaiters: Array<() => void> = []
const waiters: Waiter[] = []
const listeners = new Set<() => void>()
const reportedDeferrals = new Set<string>()

function windowDeferral(): MaintenanceDeferral | null {
  return deferralFor({
    uptimeMs: uptimeMs(),
    priorExit,
    interacted,
    holding: false,
    interactiveActive: false
  })
}

export function startMaintenanceGate(opts: {
  interactiveActive: () => boolean
  uptimeMs?: () => number
  schedule?: Scheduler
}): void {
  started = true
  uptimeMs = opts.uptimeMs ?? processUptimeMs
  schedule = opts.schedule ?? DEFAULT_SCHEDULE
  interactiveActive = opts.interactiveActive
  schedule(wake, Math.max(0, BOOT_QUIET_PERIOD_MS - uptimeMs()))
  wake()
}

export function settlePriorExit(prior: PriorShutdown): void {
  priorExit = prior
  wake()
}

export function noteUserInput(inputType: string): void {
  if (!isDeliberateInput(inputType) || interacted) return
  interacted = true
  wake()
}

export function maintenanceDeferral(): MaintenanceDeferral | null {
  if (!started) return null
  return deferralFor({
    uptimeMs: uptimeMs(),
    priorExit,
    interacted,
    holding,
    interactiveActive: interactiveActive()
  })
}

export function beginMaintenance(): () => void {
  if (!started) return () => undefined
  const reason = maintenanceDeferral()
  if (reason) throw new Error(`maintenance is deferred (${reason})`)
  holding = true
  let released = false
  return () => {
    if (released) return
    released = true
    holding = false
    wake()
  }
}

export function runAsMaintenance<T>(work: () => T | Promise<T>): Promise<T> {
  if (!started) return Promise.resolve().then(work)
  return new Promise<T>((resolve, reject) => {
    waiters.push({
      run: () => Promise.resolve().then(work),
      resolve: (value) => resolve(value as T),
      reject
    })
    wake()
  })
}

export function whenMaintenanceWindowOpens(): Promise<void> {
  if (!started || windowDeferral() === null) return Promise.resolve()
  return new Promise((resolve) => {
    windowWaiters.push(resolve)
  })
}

export function onMaintenanceMayBegin(listener: () => void): void {
  listeners.add(listener)
}

export function reportDeferred(kind: SchedulerJobKind, reason: DeferredReason): void {
  const key = `${kind}:${reason}`
  if (reportedDeferrals.has(key)) return
  reportedDeferrals.add(key)
  auditLog('scheduler.job', { kind, outcome: 'deferred', deferredReason: reason })
}

export function resetMaintenanceGateForTests(): void {
  started = false
  uptimeMs = processUptimeMs
  schedule = DEFAULT_SCHEDULE
  interactiveActive = () => false
  priorExit = undefined
  interacted = false
  holding = false
  windowOpenAudited = false
  interactiveRecheckArmed = false
  windowWaiters.splice(0, windowWaiters.length)
  waiters.splice(0, waiters.length)
  reportedDeferrals.clear()
}

function wake(): void {
  if (!started) return
  if (!windowOpenAudited && windowDeferral() === null) {
    windowOpenAudited = true
    auditLog('scheduler.job', {
      kind: 'model-work',
      outcome: 'window-open',
      uptimeMs: Math.round(uptimeMs()),
      afterInteraction: interacted
    })
    const resolvers = windowWaiters.splice(0, windowWaiters.length)
    for (const resolve of resolvers) resolve()
  }
  while (waiters.length > 0 && maintenanceDeferral() === null) {
    const waiter = waiters.shift()!
    const release = beginMaintenance()
    void waiter.run()
      .then(waiter.resolve, waiter.reject)
      .finally(release)
  }
  if (waiters.length > 0 && maintenanceDeferral() === 'interactive_active' && !interactiveRecheckArmed) {
    interactiveRecheckArmed = true
    schedule(() => {
      interactiveRecheckArmed = false
      wake()
    }, INTERACTIVE_RECHECK_MS)
  }
  if (maintenanceDeferral() === null) queueMicrotask(() => {
    if (maintenanceDeferral() !== null) return
    for (const listener of listeners) listener()
  })
}
