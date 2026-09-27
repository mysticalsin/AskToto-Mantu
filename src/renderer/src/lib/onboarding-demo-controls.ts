/**
 * User-controlled timing for the existing Métis onboarding demo.
 * No capture, IPC, network, persistence or action execution belongs in this module.
 */
export type DemoPlaybackPhase = 'paused' | 'playing' | 'held' | 'disposed'

export interface DemoPlaybackSnapshot {
  elapsedMs: number
  phase: DemoPlaybackPhase
}

export interface DemoFrameScheduler {
  now(): number
  request(callback: (timestamp: number) => void): number
  cancel(id: number): void
}

export interface DemoPlaybackClock {
  snapshot(): DemoPlaybackSnapshot
  play(): void
  pause(): void
  finish(): void
  dispose(): void
}

/**
 * RAF is scheduling, not the source of elapsed wall time. Pause stores the exact
 * current offset and resume starts a new interval: time hidden is never replayed.
 * A generation fence also ignores a callback delivered after cancellation.
 */
export function createDemoPlaybackClock(
  durationMs: number,
  scheduler: DemoFrameScheduler,
  onFrame: (snapshot: DemoPlaybackSnapshot) => void
): DemoPlaybackClock {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    throw new RangeError('Demo duration must be finite and non-negative')
  }
  let phase: DemoPlaybackPhase = 'paused'
  let elapsedMs = 0
  let anchor: number | null = null
  let ticket: number | null = null
  let generation = 0

  const snapshot = (): DemoPlaybackSnapshot => ({ elapsedMs, phase })
  const timestamp = (value: number): number => {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError('Demo clock requires a monotonic, non-negative timestamp')
    }
    return value
  }
  const cancel = (): void => {
    generation++
    if (ticket !== null) {
      scheduler.cancel(ticket)
      ticket = null
    }
  }
  const accrue = (now: number): void => {
    const sample = timestamp(now)
    if (anchor !== null) {
      // A backwards sample cannot rewind the demo or be charged again later.
      elapsedMs = Math.min(durationMs, elapsedMs + Math.max(0, sample - anchor))
      anchor = Math.max(anchor, sample)
    }
    if (elapsedMs >= durationMs) {
      phase = 'held'
      anchor = null
    }
  }
  const emit = (): void => onFrame(snapshot())
  const schedule = (): void => {
    if (phase !== 'playing' || ticket !== null) return
    const scheduledGeneration = generation
    ticket = scheduler.request((now) => {
      if (scheduledGeneration !== generation || phase !== 'playing') return
      ticket = null
      accrue(now)
      emit()
      // onFrame may synchronously pause, finish or dispose this clock.
      if (scheduledGeneration === generation) schedule()
    })
  }
  return {
    snapshot,
    play() {
      if (phase !== 'paused') return
      anchor = timestamp(scheduler.now())
      phase = durationMs === elapsedMs ? 'held' : 'playing'
      emit()
      schedule()
    },
    pause() {
      if (phase !== 'playing') return
      accrue(scheduler.now())
      cancel()
      anchor = null
      if (elapsedMs < durationMs) phase = 'paused'
      emit()
    },
    finish() {
      if (phase === 'disposed' || phase === 'held') return
      cancel()
      elapsedMs = durationMs
      anchor = null
      phase = 'held'
      emit()
    },
    dispose() {
      if (phase === 'disposed') return
      cancel()
      anchor = null
      phase = 'disposed'
      // Cleanup must not publish a React state update after unmount.
    }
  }
}

export interface DemoEnvironment {
  hidden: boolean
  reducedMotion: boolean
}

export function readDemoEnvironment(
  owner: Pick<Document, 'visibilityState'> | null,
  motion: Pick<MediaQueryList, 'matches'> | null
): DemoEnvironment {
  return {
    hidden: owner?.visibilityState === 'hidden',
    reducedMotion: motion?.matches === true
  }
}

/** Subscribe once per mounted demo, with matching cleanup and a fresh initial read. */
export function watchDemoEnvironment(
  owner: Document | null,
  motion: MediaQueryList | null,
  onChange: (environment: DemoEnvironment) => void
): () => void {
  let active = true
  const update = (): void => {
    if (active) onChange(readDemoEnvironment(owner, motion))
  }
  owner?.addEventListener('visibilitychange', update)
  motion?.addEventListener('change', update)
  update()
  return () => {
    if (!active) return
    active = false
    owner?.removeEventListener('visibilitychange', update)
    motion?.removeEventListener('change', update)
  }
}

export type DemoClockCommand = keyof Pick<DemoPlaybackClock, 'finish' | 'pause' | 'play'>

/** The one owner of what a DemoPlaybackClock should be doing: reduced motion always settles
 * it at its hold, a hidden window or the user's own pause holds it where it is, and otherwise
 * it plays. Every call site that must drive a clock imperatively resolves through this rather
 * than repeating the rule. */
export function demoClockCommand(environment: DemoEnvironment, paused: boolean): DemoClockCommand {
  if (environment.reducedMotion) return 'finish'
  if (environment.hidden || paused) return 'pause'
  return 'play'
}

/** Optional decoration is attempted in the click, but cannot own navigation. */
export function runOptionalDemoMedia(effect: (() => unknown) | undefined): void {
  try {
    void Promise.resolve(effect?.()).catch(() => {})
  } catch {
    // No raw exception logging: a media failure is not an onboarding failure.
  }
}

export function demoPlaybackStatus(
  phase: DemoPlaybackPhase,
  environment: DemoEnvironment,
  userPaused: boolean
): string {
  if (environment.reducedMotion) return 'Animation off. All content for this step is shown.'
  if (phase === 'held') return 'Step complete. Replay it or continue when you are ready.'
  if (environment.hidden) return 'Paused while this window is hidden.'
  if (userPaused || phase === 'paused') return 'Paused. Resume when you are ready.'
  return 'Playing. Pause at any time.'
}

/**
 * Cold orchestration state: which step is showing, which "take" of it (a fresh replayKey
 * tells the caller to recreate its clock), and the user's own pause choice. The hot,
 * per-frame state (elapsed ms, clock phase) is owned by the DemoPlaybackClock and mirrored
 * into the caller's React state — it is not part of this state, so a tick can never race
 * a step change through this module.
 */
export interface DemoOrchestratorState {
  beat: number
  replayKey: number
  paused: boolean
}

export function initialDemoOrchestratorState(): DemoOrchestratorState {
  return { beat: 0, replayKey: 0, paused: false }
}

/** Content/timing queries the orchestrator composes but does not own — see lib/onboarding-demo.ts. */
export interface DemoBeatModel {
  hasNextBeat(beat: number): boolean
  holdMs(beat: number): number
  playbackElapsed(beat: number, localMs: number): number
  afterNext(beat: number): { beat: number; localMs: number }
}

/**
 * Pause/resume is a no-op once the step has settled at its hold point, or while reduced
 * motion holds every step settled already. Returns the SAME state instance when it is a
 * no-op, so a caller can tell `state === next` apart from an actual transition.
 */
export function toggleDemoPause(
  state: DemoOrchestratorState,
  phase: DemoPlaybackPhase,
  reducedMotion: boolean
): DemoOrchestratorState {
  if (phase === 'held' || reducedMotion) return state
  return { ...state, paused: !state.paused }
}

/** Replaying keeps the same step; the fresh replayKey is the caller's signal to recreate
 * its clock from zero. */
export function replayDemoBeat(state: DemoOrchestratorState): DemoOrchestratorState {
  return { ...state, paused: false, replayKey: state.replayKey + 1 }
}

/** There is no step before the first one — returns the SAME state instance then. */
export function previousDemoBeat(state: DemoOrchestratorState): DemoOrchestratorState {
  if (state.beat === 0) return state
  return { ...state, beat: state.beat - 1, paused: false }
}

/** The caller renders this localMs until the new beat's own clock reports its first frame —
 * the demo's own model always returns 0 here, since every beat starts at rest. */
export function advanceDemoBeat(
  state: DemoOrchestratorState,
  model: Pick<DemoBeatModel, 'afterNext'>
): { state: DemoOrchestratorState; localMs: number } {
  const next = model.afterNext(state.beat)
  return { state: { ...state, beat: next.beat, paused: false }, localMs: next.localMs }
}

export interface DemoOrchestratorSnapshot {
  beat: number
  replayKey: number
  paused: boolean
  hasNext: boolean
  elapsedMs: number
}

/** localMs is this beat's own elapsed-ms reading: reset to 0 whenever the beat changes and
 * updated periodically while it plays. Reduced motion always reports the step already
 * settled at its hold, regardless of localMs. */
export function demoOrchestratorSnapshot(
  state: DemoOrchestratorState,
  localMs: number,
  reducedMotion: boolean,
  model: DemoBeatModel
): DemoOrchestratorSnapshot {
  return {
    beat: state.beat,
    replayKey: state.replayKey,
    paused: state.paused,
    hasNext: model.hasNextBeat(state.beat),
    elapsedMs: reducedMotion ? model.holdMs(state.beat) : model.playbackElapsed(state.beat, localMs)
  }
}
