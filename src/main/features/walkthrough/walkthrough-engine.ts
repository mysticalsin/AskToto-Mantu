import { randomUUID } from 'node:crypto'
import {
  IDLE_WALKTHROUGH_VIEW,
  WALKTHROUGH_STEP_BUDGET,
  type WalkthroughPauseReason,
  type WalkthroughPhase,
  type WalkthroughStopReason,
  type WalkthroughView
} from '@shared/walkthrough-view'
import {
  WALKTHROUGH_COPY,
  WalkthroughPlanSchema,
  evaluatePredicate,
  isFresh,
  type WalkthroughObservation,
  type WalkthroughObserver,
  type WalkthroughPlan
} from './walkthrough-model'

/**
 * Walkthrough state machine (G44, CAP-25). Pure and Electron-free: the clock, the observer, the timer and the lease
 * are injected.
 *
 *   idle -> planning -> awaiting(step n) -> verifying -> advanced | retry -> ... -> completed
 *                           |                  |
 *                           +-> paused <-------+      (owner, lock, away from the app, a meeting)
 *                           +-> abandoned             (Stop, sign-out, owner switch, budget, unverified, no plan)
 *
 * Invariants:
 *  - A step advances ONLY when a fresh observation (taken after the step started, never a replay) satisfies its
 *    typed post-condition. A missing, stale or failing observation never advances.
 *  - The budget is 15 steps. A plan is cut there and the walkthrough stops with plain copy; it never runs on.
 *  - Resume looks first: a fresh observation is taken and the current step revalidated before anything else.
 *  - Stop, sign-out and an owner switch abandon and release the lease. Nothing here acts on the owner's behalf:
 *    the engine only observes and guides.
 *  - Observation content stays inside this module. The view and the events carry no screen text.
 */

export type WalkthroughEventName =
  | 'started'
  | 'planned'
  | 'advanced'
  | 'retry'
  | 'unavailable'
  | 'paused'
  | 'resumed'
  | 'completed'
  | 'abandoned'

/** Metadata only. Never the goal, an instruction or anything read from the screen. */
export interface WalkthroughEvent {
  event: WalkthroughEventName
  step: number | null
  reason?: string
  attempts?: number
}

export type CheckResult = 'advanced' | 'completed' | 'budget' | 'retry' | 'unverified' | 'unavailable' | 'ignored'
export type ResumeResult =
  | 'advanced'
  | 'completed'
  | 'budget'
  | 'changed'
  | 'resumed'
  | 'blocked'
  | 'unavailable'
  | 'ignored'

export interface WalkthroughEngineDeps {
  now(): number
  observer: WalkthroughObserver
  /** Schedule `fn` once after `ms`; returns the cancel function. */
  setTimer(fn: () => void, ms: number): () => void
  /** One live walkthrough at a time. Returns the release function, or null when one is already held. */
  acquireLease?(runId: string): (() => void) | null
  onChange?(view: WalkthroughView): void
  onEvent?(event: WalkthroughEvent): void
  newRunId?(): string
  /** PROPOSED: how long another app may hold focus before the walkthrough pauses. */
  focusAwayPauseMs?: number
  /** PROPOSED: unverified checks on one step before the walkthrough stops instead of guessing. */
  maxAttemptsPerStep?: number
}

export const WALKTHROUGH_FOCUS_AWAY_PAUSE_MS = 45_000
export const WALKTHROUGH_MAX_ATTEMPTS_PER_STEP = 3
const GOAL_MAX_CHARS = 400

export interface WalkthroughEngine {
  view(): WalkthroughView
  ownerKey(): string | null
  begin(goal: string, ownerKey: string): { ok: true; runId: string } | { ok: false; reason: 'busy' | 'empty' }
  supplyPlan(runId: string, plan: unknown): { ok: true } | { ok: false; reason: 'stale' | 'invalid' | 'empty' }
  planUnavailable(runId: string): void
  check(): Promise<CheckResult>
  pause(reason: WalkthroughPauseReason): boolean
  resume(): Promise<ResumeResult>
  noteFocus(app: string | null): void
  noteLock(locked: boolean): void
  noteMeeting(active: boolean): void
  stop(reason: 'owner_stop' | 'sign_out' | 'owner_switch'): void
  ownerChanged(ownerKey: string | null): void
}

const LIVE: ReadonlySet<WalkthroughPhase> = new Set(['planning', 'awaiting', 'verifying', 'revalidating', 'paused'])

export function createWalkthroughEngine(deps: WalkthroughEngineDeps): WalkthroughEngine {
  const focusAwayMs = deps.focusAwayPauseMs ?? WALKTHROUGH_FOCUS_AWAY_PAUSE_MS
  const maxAttempts = deps.maxAttemptsPerStep ?? WALKTHROUGH_MAX_ATTEMPTS_PER_STEP

  let phase: WalkthroughPhase = 'idle'
  let runId: string | null = null
  let owner: string | null = null
  let plan: WalkthroughPlan | null = null
  let stepCount = 0
  let idx = 0
  let attempts = 0
  let status = ''
  let pauseReason: WalkthroughPauseReason | null = null
  let stopReason: WalkthroughStopReason | null = null
  let mark = { generation: 0, sequence: 0 }
  let startedAt = 0
  let releaseLease: (() => void) | null = null
  let controller: AbortController | null = null
  let cancelFocusTimer: (() => void) | null = null
  let homeApp: string | null = null
  let lastApp: string | null = null
  let locked = false
  let meetingActive = false
  // Bumped by every transition that must invalidate an observation still in flight.
  let opSeq = 0

  const stepNo = (): number | null => (plan && phase !== 'planning' && phase !== 'idle' ? idx + 1 : null)

  function view(): WalkthroughView {
    if (phase === 'idle') return IDLE_WALKTHROUGH_VIEW
    const showing = phase === 'awaiting' || phase === 'verifying' || phase === 'revalidating' || phase === 'paused'
    return {
      runId,
      phase,
      step: stepNo(),
      stepCount,
      budget: WALKTHROUGH_STEP_BUDGET,
      instruction: showing && plan ? (plan.steps[idx]?.instruction ?? null) : null,
      status: phase === 'planning' ? WALKTHROUGH_COPY.planning : status,
      pauseReason: phase === 'paused' ? pauseReason : null,
      stopReason: phase === 'abandoned' ? stopReason : null,
      canCheck: phase === 'awaiting',
      canPause: phase === 'awaiting' || phase === 'verifying',
      canResume: phase === 'paused',
      canStop: LIVE.has(phase)
    }
  }

  function emit(event: WalkthroughEventName, extra: { reason?: string; attempts?: number } = {}): void {
    try {
      deps.onEvent?.({ event, step: stepNo(), ...extra })
    } catch {
      /* audit is best effort */
    }
  }

  function changed(): void {
    try {
      deps.onChange?.(view())
    } catch {
      /* a subscriber must not break the engine */
    }
  }

  function dropInFlight(): void {
    opSeq += 1
    controller?.abort()
    controller = null
  }

  function clearFocusTimer(): void {
    cancelFocusTimer?.()
    cancelFocusTimer = null
  }

  function finish(next: 'completed' | 'abandoned'): void {
    dropInFlight()
    clearFocusTimer()
    phase = next
    const release = releaseLease
    releaseLease = null
    try {
      release?.()
    } catch {
      /* releasing is idempotent and best effort */
    }
  }

  function stopWith(reason: WalkthroughStopReason): void {
    stopReason = reason
    pauseReason = null
    status = WALKTHROUGH_COPY.stopped[reason]
    finish('abandoned')
    emit('abandoned', { reason })
    changed()
  }

  /** Watch whether another app holds focus too long. Only while a step is waiting or being checked. */
  function armFocus(): void {
    clearFocusTimer()
    if (phase !== 'awaiting' && phase !== 'verifying') return
    if (homeApp === null || lastApp === null || lastApp === homeApp) return
    const fire = (): void => {
      cancelFocusTimer = null
      if ((phase === 'awaiting' || phase === 'verifying') && lastApp !== null && lastApp !== homeApp) {
        pause('focus_away')
      }
    }
    cancelFocusTimer = deps.setTimer(fire, focusAwayMs)
  }

  function startStep(): void {
    attempts = 0
    mark = deps.observer.watermark()
    startedAt = deps.now()
    phase = 'awaiting'
    status = WALKTHROUGH_COPY.step(idx + 1, stepCount)
    pauseReason = null
    armFocus()
  }

  async function observeSafely(): Promise<{ obs: WalkthroughObservation | null; op: number }> {
    dropInFlight()
    const op = opSeq
    const own = new AbortController()
    controller = own
    let obs: WalkthroughObservation | null = null
    try {
      obs = await deps.observer.observe(own.signal)
    } catch {
      obs = null
    }
    if (op === opSeq && controller === own) controller = null
    return { obs, op }
  }

  /** The current step is verified: move on, finish, or stop at the budget. */
  function advanceFrom(): 'advanced' | 'completed' | 'budget' {
    const planLength = plan?.steps.length ?? 0
    if (idx + 1 >= stepCount) {
      if (planLength > stepCount) {
        stopWith('budget')
        return 'budget'
      }
      status = WALKTHROUGH_COPY.completed
      pauseReason = null
      finish('completed')
      emit('completed')
      changed()
      return 'completed'
    }
    idx += 1
    startStep()
    emit('advanced')
    changed()
    return 'advanced'
  }

  async function check(): Promise<CheckResult> {
    if (phase !== 'awaiting' || !plan) return 'ignored'
    clearFocusTimer()
    phase = 'verifying'
    changed()
    const { obs, op } = await observeSafely()
    if (op !== opSeq || phase !== 'verifying' || !plan) return 'ignored'
    if (!obs || !isFresh(obs, mark, startedAt)) {
      phase = 'awaiting'
      status = WALKTHROUGH_COPY.unavailable
      armFocus()
      emit('unavailable')
      changed()
      return 'unavailable'
    }
    const step = plan.steps[idx]
    if (step && evaluatePredicate(step.postcondition, obs)) return advanceFrom()
    attempts += 1
    if (attempts >= maxAttempts) {
      stopWith('unverified')
      return 'unverified'
    }
    // The failed frame can never count for the next check either.
    mark = { generation: obs.generation, sequence: obs.sequence }
    phase = 'awaiting'
    status = WALKTHROUGH_COPY.retry
    armFocus()
    emit('retry', { attempts })
    changed()
    return 'retry'
  }

  function pause(reason: WalkthroughPauseReason): boolean {
    if (phase !== 'awaiting' && phase !== 'verifying' && phase !== 'revalidating') return false
    dropInFlight()
    clearFocusTimer()
    phase = 'paused'
    pauseReason = reason
    status = WALKTHROUGH_COPY.paused[reason]
    emit('paused', { reason })
    changed()
    return true
  }

  async function resume(): Promise<ResumeResult> {
    if (phase !== 'paused' || !plan) return 'ignored'
    if (locked || meetingActive) {
      status = WALKTHROUGH_COPY.resumeBlocked
      changed()
      return 'blocked'
    }
    // Look first. Whatever happened while paused, nothing continues until a fresh observation says where we are.
    const held = pauseReason
    phase = 'revalidating'
    mark = deps.observer.watermark()
    startedAt = deps.now()
    changed()
    const { obs, op } = await observeSafely()
    if (op !== opSeq || phase !== 'revalidating' || !plan) return 'ignored'
    if (!obs || !isFresh(obs, mark, startedAt)) {
      phase = 'paused'
      pauseReason = held
      status = WALKTHROUGH_COPY.resumeUnavailable
      changed()
      return 'unavailable'
    }
    const step = plan.steps[idx]
    if (step && evaluatePredicate(step.postcondition, obs)) return advanceFrom()
    const keptAttempts = attempts
    startStep()
    attempts = keptAttempts
    mark = { generation: obs.generation, sequence: obs.sequence }
    if (step?.precondition && !evaluatePredicate(step.precondition, obs)) {
      status = WALKTHROUGH_COPY.resumeChanged
      emit('resumed', { reason: 'changed' })
      changed()
      return 'changed'
    }
    emit('resumed')
    changed()
    return 'resumed'
  }

  return {
    view,
    ownerKey: () => owner,
    begin(goal, ownerKey) {
      if (LIVE.has(phase)) return { ok: false, reason: 'busy' }
      if (goal.trim().length === 0 || goal.length > GOAL_MAX_CHARS) return { ok: false, reason: 'empty' }
      const id = (deps.newRunId ?? randomUUID)()
      const release = deps.acquireLease ? deps.acquireLease(id) : () => {}
      if (!release) return { ok: false, reason: 'busy' }
      releaseLease = release
      runId = id
      owner = ownerKey
      plan = null
      stepCount = 0
      idx = 0
      attempts = 0
      homeApp = lastApp
      pauseReason = null
      stopReason = null
      status = ''
      phase = 'planning'
      emit('started')
      changed()
      return { ok: true, runId: id }
    },
    supplyPlan(id, raw) {
      if (phase !== 'planning' || id !== runId) return { ok: false, reason: 'stale' }
      const parsed = WalkthroughPlanSchema.safeParse(raw)
      if (!parsed.success) {
        stopWith('plan_refused')
        return { ok: false, reason: 'invalid' }
      }
      if (parsed.data.steps.length === 0) {
        stopWith('no_plan')
        return { ok: false, reason: 'empty' }
      }
      plan = parsed.data
      stepCount = Math.min(plan.steps.length, WALKTHROUGH_STEP_BUDGET)
      idx = 0
      homeApp = plan.app ?? lastApp
      startStep()
      emit('planned')
      changed()
      return { ok: true }
    },
    planUnavailable(id) {
      if (phase === 'planning' && id === runId) stopWith('no_plan')
    },
    check,
    pause,
    resume,
    noteFocus(app) {
      if (app === null) return
      lastApp = app
      if (homeApp === null && LIVE.has(phase)) homeApp = app
      if (phase === 'awaiting' || phase === 'verifying') armFocus()
    },
    noteLock(isLocked) {
      locked = isLocked
      if (isLocked) pause('locked')
    },
    noteMeeting(active) {
      meetingActive = active
      if (active) pause('meeting')
    },
    stop(reason) {
      if (!LIVE.has(phase)) return
      stopWith(reason)
    },
    ownerChanged(ownerKey) {
      if (LIVE.has(phase) && ownerKey !== owner) stopWith('owner_switch')
    }
  }
}
