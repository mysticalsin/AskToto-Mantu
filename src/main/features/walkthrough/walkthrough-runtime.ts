import type { WalkthroughPauseReason, WalkthroughView } from '@shared/walkthrough-view'
import { createWalkthroughEngine, type WalkthroughEngine, type WalkthroughEvent } from './walkthrough-engine'
import type { WalkthroughIntent } from './walkthrough-intent'
import type { WalkthroughObserver } from './walkthrough-model'

/**
 * The thin main-side runtime around the walkthrough engine (G44, CAP-25).
 *
 * It owns what the pure engine must not: the feature switch, the single-walkthrough lease, the planner seam, the
 * metadata-only audit event and the renderer-safe view for G45. It guides and observes; it never acts for the owner.
 *
 * Preview rule (owner decision): the switch is ON in the QA build and OFF in release until the owner checklist is
 * done. `enabled()` is read on every turn, so turning it off stops the next intent from starting anything.
 *
 * Seams that later tickets bind (until then each answers honestly and nothing is guessed):
 *  - `observer`: structured current state (G46 snapshots, G38 accessibility). Absent: the screen is "unavailable".
 *  - `planner`: turns the owner's goal into typed steps (R114 teaching packs are not in 2.12). Absent: "no plan".
 */

export type WalkthroughTurnStatus =
  | 'started'
  | 'no_plan'
  | 'busy'
  | 'meeting'
  | 'no_owner'
  | 'disabled'
  | 'ignored'
  | 'advanced'
  | 'completed'
  | 'budget'
  | 'retry'
  | 'unverified'
  | 'unavailable'
  | 'changed'
  | 'resumed'
  | 'blocked'
  | 'paused'
  | 'stopped'

export interface WalkthroughTurnResult {
  status: WalkthroughTurnStatus
  view: WalkthroughView
}

export interface WalkthroughPlanner {
  /** A plan object (validated by the engine) or null when this goal has no safe plan. */
  plan(goal: string, signal: AbortSignal): Promise<unknown | null>
}

export interface WalkthroughRuntimeDeps {
  enabled(): boolean
  /** The signed-in owner window, as a stable key; null when there is none. */
  ownerKey(): string | null
  meetingActive(): boolean
  observer?: WalkthroughObserver
  planner?: WalkthroughPlanner
  now?(): number
  setTimer?(fn: () => void, ms: number): () => void
  onView?(view: WalkthroughView): void
  audit?(event: 'walkthrough.event', data: Record<string, string | number>): void
  focusAwayPauseMs?: number
  maxAttemptsPerStep?: number
}

export interface WalkthroughRuntime {
  enabled(): boolean
  /** A walkthrough is planning, running or paused. */
  active(): boolean
  view(): WalkthroughView
  handle(intent: WalkthroughIntent): Promise<WalkthroughTurnResult>
  noteFocus(app: string | null): void
  noteLock(locked: boolean): void
  pause(reason: WalkthroughPauseReason): void
  stop(reason: 'owner_stop' | 'sign_out' | 'owner_switch'): void
}

/** The observer used until G46 or G38 binds a real one: the screen cannot be looked at, so nothing is verified. */
export const UNAVAILABLE_WALKTHROUGH_OBSERVER: WalkthroughObserver = {
  watermark: () => ({ generation: 0, sequence: 0 }),
  observe: async () => null
}

export function createWalkthroughRuntime(deps: WalkthroughRuntimeDeps): WalkthroughRuntime {
  let planning: AbortController | null = null
  const audit = (event: WalkthroughEvent): void => {
    const data: Record<string, string | number> = { event: event.event }
    if (event.step !== null) data.step = event.step
    if (event.reason) data.reason = event.reason
    if (event.attempts !== undefined) data.attempts = event.attempts
    try {
      deps.audit?.('walkthrough.event', data)
    } catch {
      /* best effort */
    }
  }
  const engine: WalkthroughEngine = createWalkthroughEngine({
    now: deps.now ?? (() => Date.now()),
    observer: deps.observer ?? UNAVAILABLE_WALKTHROUGH_OBSERVER,
    setTimer:
      deps.setTimer ??
      ((fn, ms) => {
        const timer = setTimeout(fn, ms)
        timer.unref?.()
        return () => clearTimeout(timer)
      }),
    onChange: (view) => {
      if (view.phase !== 'planning') {
        planning?.abort()
        planning = null
      }
      deps.onView?.(view)
    },
    onEvent: audit,
    focusAwayPauseMs: deps.focusAwayPauseMs,
    maxAttemptsPerStep: deps.maxAttemptsPerStep
  })
  const live = (): boolean => {
    const phase = engine.view().phase
    return (
      phase === 'planning' ||
      phase === 'awaiting' ||
      phase === 'verifying' ||
      phase === 'revalidating' ||
      phase === 'paused'
    )
  }
  const result = (status: WalkthroughTurnStatus): WalkthroughTurnResult => ({ status, view: engine.view() })

  async function start(goal: string): Promise<WalkthroughTurnResult> {
    if (deps.meetingActive()) return result('meeting')
    const owner = deps.ownerKey()
    if (owner === null) return result('no_owner')
    const begun = engine.begin(goal, owner)
    if (!begun.ok) return result('busy')
    const own = new AbortController()
    planning = own
    let raw: unknown = null
    try {
      raw = deps.planner ? await deps.planner.plan(goal, own.signal) : null
    } catch {
      raw = null
    }
    if (own.signal.aborted || engine.view().runId !== begun.runId || engine.view().phase !== 'planning') {
      return result('stopped')
    }
    if (planning === own) planning = null
    if (raw === null || raw === undefined) {
      engine.planUnavailable(begun.runId)
      return result('no_plan')
    }
    const supplied = engine.supplyPlan(begun.runId, raw)
    return result(supplied.ok ? 'started' : 'no_plan')
  }

  return {
    enabled: () => deps.enabled(),
    active: live,
    view: () => engine.view(),
    async handle(intent) {
      if (!deps.enabled()) return result('disabled')
      engine.ownerChanged(deps.ownerKey())
      switch (intent.kind) {
        case 'start':
          return start(intent.goal)
        case 'check': {
          const outcome = await engine.check()
          return result(outcome)
        }
        case 'pause':
          return result(engine.pause('owner') ? 'paused' : 'ignored')
        case 'resume': {
          // The meeting flag follows the live reservation, so a meeting that ended no longer blocks resume.
          engine.noteMeeting(deps.meetingActive())
          return result(await engine.resume())
        }
        case 'stop':
          engine.stop('owner_stop')
          return result('stopped')
      }
    },
    noteFocus: (app) => engine.noteFocus(app),
    noteLock: (locked) => engine.noteLock(locked),
    pause: (reason) => {
      engine.pause(reason)
    },
    stop: (reason) => engine.stop(reason)
  }
}
