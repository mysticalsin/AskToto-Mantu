/**
 * chord-watcher.ts — the main-process owner of the global hold-chord helper (V01).
 *
 * It does four things and nothing else:
 *  1. Decides, from injected state, whether the helper may run at all. Disabled (voice actions off), no platform
 *     helper, signed out, screen locked, system suspended or app quitting all mean: no child process and no key
 *     monitoring. The default is inert; `refresh()` is the only thing that can start the helper.
 *  2. Supervises that one child with bounded restarts (1, 2, 4, 8, 8 s; the sixth failure inside ten minutes is the
 *     last, then it reports `failed`). Spawning goes through src/main/infra/process/ only (FF-10).
 *  3. Feeds the helper's `m <mask> <seq>` lines to the pure recognizer (src/shared/voice/hold-chord.ts) and drives
 *     its deadlines with one injected timer.
 *  4. Forwards the recognizer's events to its consumer, except that it never opens a turn while Métis records a
 *     meeting (D-09), during onboarding or while the chord recorder is open. A hold during a meeting reaches the
 *     consumer only as a `refused` event, so the UI can explain it. It starts no capture itself.
 *
 * The watcher is a closure, not a class, so no arrow function lives in a class property initializer (bytecode build).
 */
import { createHoldChordRecognizer, type HoldChordEvent } from '@shared/voice/hold-chord'
import { parseModifierLine } from '@shared/voice/modifier-mask'
import type { LineHelperHandle, LineHelperHandlers, LineHelperSpec } from '../infra/process/line-helper-host'

/** Delay before restart attempt 1, 2, 3 and 4; later attempts reuse the last delay. */
export const RESTART_BACKOFF_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000]
export const MAX_RESTARTS_PER_WINDOW = 5
export const RESTART_WINDOW_MS = 10 * 60_000

/** Why a hold is not allowed to open a turn right now. `meeting` is explained to the person; the rest are silent. */
export type ChordGateBlock = 'meeting' | 'onboarding' | 'chord-recorder'

export type ChordLifecycleEvent =
  | 'lock'
  | 'unlock'
  | 'suspend'
  | 'resume'
  | 'sign-out'
  | 'sign-in'
  | 'meeting-started'
  | 'quit'
export type ChordRevokeCause = 'lock' | 'suspend' | 'sign-out' | 'quit' | 'disabled' | 'meeting-started' | 'helper-lost'

export type ChordWatcherEvent =
  | { readonly type: 'armed' }
  | { readonly type: 'latched' }
  | { readonly type: 'released'; readonly reason: 'release' | 'cap' }
  | { readonly type: 'aborted'; readonly reason: Extract<HoldChordEvent, { type: 'aborted' }>['reason'] }
  | { readonly type: 'latch-ended'; readonly reason: Extract<HoldChordEvent, { type: 'latch-ended' }>['reason'] }
  /** A hold was refused, with the reason to tell the person. No turn was opened. */
  | { readonly type: 'refused'; readonly reason: ChordGateBlock }
  /** An open turn was cut off by the watcher (not by the person's keys). */
  | { readonly type: 'revoked'; readonly cause: ChordRevokeCause }

/**
 * inert: off by setting or no helper on this platform. paused: wanted but held back (signed out, locked, suspended).
 * running: the helper is up. restarting: waiting out a backoff. failed: restart budget spent. stopped: quit.
 */
export type ChordWatcherStatus = 'inert' | 'paused' | 'running' | 'restarting' | 'failed' | 'stopped'

export interface ChordWatcherDeps {
  /** The platform helper to run, or null when there is none (missing binary, unsupported platform). */
  helperSpec(): LineHelperSpec | null
  spawnHelper(spec: LineHelperSpec, handlers: LineHelperHandlers): LineHelperHandle
  /** Voice actions enabled (setting, QA or Preview rule). Read on every refresh. */
  enabled(): boolean
  signedIn(): boolean
  /** Non-null blocks opening a turn: a meeting is reserved, onboarding is exclusive, the chord recorder is open. */
  gate(): ChordGateBlock | null
  chordMask(): number
  /** Hands-free double-press latch. Off unless this says so (it collides with macOS Dictation on Right Command). */
  latchEnabled?(): boolean
  assistiveTechnologyActive(): boolean
  /** Monotonic milliseconds. */
  now(): number
  timers: { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void }
  onEvent(event: ChordWatcherEvent): void
  onStatus?(status: ChordWatcherStatus): void
  /** Metadata only: kind, counts, event type. Never a key, never text. */
  audit(event: 'voice.chord', data: Record<string, unknown>): void
}

export interface ChordWatcher {
  /** Reconcile with reality: start, stop or re-aim the helper. Call on boot and on every input that can change it. */
  refresh(): void
  lifecycle(event: ChordLifecycleEvent): void
  /** The quit path. Idempotent. */
  stop(): void
  status(): ChordWatcherStatus
  suspendedReason(): 'assistive-technology' | null
}

export function createChordWatcher(deps: ChordWatcherDeps): ChordWatcher {
  const recognizer = createHoldChordRecognizer({
    chordMask: deps.chordMask(),
    latchEnabled: deps.latchEnabled?.() ?? false
  })
  let stopped = false
  let locked = false
  let suspended = false
  // Set by a sign-out or session revocation and cleared only by an explicit sign-in: those hooks fire before the
  // session state is cleared, so `signedIn()` alone would still say yes.
  let signedOutLatch = false
  let gaveUp = false
  let run = 0
  let helper: LineHelperHandle | null = null
  let restartTimer: unknown = null
  let recognizerTimer: unknown = null
  let restartTimes: number[] = []
  let protocolErrorAudited = false
  let turnOpen = false
  let current: ChordWatcherStatus = 'inert'

  const setStatus = (next: ChordWatcherStatus): void => {
    if (next === current) return
    current = next
    deps.onStatus?.(next)
  }

  const clearRecognizerTimer = (): void => {
    if (recognizerTimer !== null) deps.timers.clear(recognizerTimer)
    recognizerTimer = null
  }

  const clearRestartTimer = (): void => {
    if (restartTimer !== null) deps.timers.clear(restartTimer)
    restartTimer = null
  }

  const emit = (event: ChordWatcherEvent): void => {
    deps.audit('voice.chord', { kind: 'event', type: event.type })
    deps.onEvent(event)
  }

  const revokeOpenTurn = (cause: ChordRevokeCause): void => {
    clearRecognizerTimer()
    recognizer.reset(deps.now(), 'reset')
    if (!turnOpen) return
    turnOpen = false
    emit({ type: 'revoked', cause })
  }

  const handleRecognizerEvent = (event: HoldChordEvent): void => {
    if (event.type === 'armed' || event.type === 'latched') {
      const block = deps.gate()
      if (block) {
        turnOpen = false
        if (block === 'meeting') emit({ type: 'refused', reason: 'meeting' })
        return
      }
      turnOpen = true
      emit(event)
      return
    }
    if (!turnOpen) return
    turnOpen = false
    emit(event)
  }

  const armRecognizerTimer = (): void => {
    clearRecognizerTimer()
    const deadline = recognizer.nextDeadline()
    if (deadline === null) return
    recognizerTimer = deps.timers.set(onRecognizerTimer, Math.max(0, deadline - deps.now()))
  }

  function onRecognizerTimer(): void {
    recognizerTimer = null
    for (const event of recognizer.tick(deps.now())) handleRecognizerEvent(event)
    armRecognizerTimer()
  }

  const stopHelper = (): void => {
    run += 1
    clearRestartTimer()
    clearRecognizerTimer()
    const child = helper
    helper = null
    if (child) {
      child.kill()
      deps.audit('voice.chord', { kind: 'helper-stopped' })
    }
  }

  const heldBackCause = (): ChordRevokeCause | null => {
    if (stopped) return 'quit'
    if (locked) return 'lock'
    if (suspended) return 'suspend'
    if (signedOutLatch || !deps.signedIn()) return 'sign-out'
    return null
  }

  const spawnOnce = (): void => {
    const spec = deps.helperSpec()
    if (!spec) {
      setStatus('inert')
      return
    }
    const myRun = (run += 1)
    protocolErrorAudited = false
    recognizer.reset(deps.now(), 'reset')
    try {
      helper = deps.spawnHelper(spec, {
        onLine: (line) => onHelperLine(myRun, line),
        onExit: () => onHelperExit(myRun)
      })
    } catch {
      helper = null
      onHelperExit(myRun)
      return
    }
    deps.audit('voice.chord', { kind: 'helper-started' })
    setStatus('running')
  }

  function onHelperLine(forRun: number, line: string): void {
    if (forRun !== run || stopped) return
    const sample = parseModifierLine(line)
    if (!sample) {
      if (!protocolErrorAudited) {
        protocolErrorAudited = true
        deps.audit('voice.chord', { kind: 'protocol-error' })
      }
      return
    }
    for (const event of recognizer.feed(sample, deps.now())) handleRecognizerEvent(event)
    armRecognizerTimer()
  }

  function onHelperExit(forRun: number): void {
    if (forRun !== run || stopped) return
    helper = null
    revokeOpenTurn('helper-lost')
    const now = deps.now()
    restartTimes = restartTimes.filter((at) => now - at < RESTART_WINDOW_MS)
    if (restartTimes.length >= MAX_RESTARTS_PER_WINDOW) {
      gaveUp = true
      deps.audit('voice.chord', { kind: 'gave-up', restarts: restartTimes.length })
      setStatus('failed')
      return
    }
    const delay = RESTART_BACKOFF_MS[Math.min(restartTimes.length, RESTART_BACKOFF_MS.length - 1)]
    restartTimes.push(now)
    deps.audit('voice.chord', { kind: 'restart', attempt: restartTimes.length })
    setStatus('restarting')
    restartTimer = deps.timers.set(onRestartTimer, delay)
  }

  function onRestartTimer(): void {
    restartTimer = null
    refresh()
  }

  function refresh(): void {
    if (stopped) {
      setStatus('stopped')
      return
    }
    const wanted = deps.enabled() && deps.helperSpec() !== null
    if (!wanted) {
      revokeOpenTurn('disabled')
      stopHelper()
      gaveUp = false
      restartTimes = []
      setStatus('inert')
      return
    }
    const heldBack = heldBackCause()
    if (heldBack) {
      revokeOpenTurn(heldBack)
      stopHelper()
      setStatus('paused')
      return
    }
    if (gaveUp) {
      setStatus('failed')
      return
    }
    const configEvents = recognizer.configure(
      {
        chordMask: deps.chordMask(),
        latchEnabled: deps.latchEnabled?.() ?? false,
        assistiveTechnologyActive: deps.assistiveTechnologyActive()
      },
      deps.now()
    )
    for (const event of configEvents) handleRecognizerEvent(event)
    armRecognizerTimer()
    if (helper === null && restartTimer === null) spawnOnce()
  }

  function lifecycle(event: ChordLifecycleEvent): void {
    switch (event) {
      case 'lock':
        locked = true
        break
      case 'unlock':
        locked = false
        break
      case 'suspend':
        suspended = true
        break
      case 'resume':
        suspended = false
        break
      case 'quit':
        if (stopped) return
        revokeOpenTurn('quit')
        stopped = true
        stopHelper()
        setStatus('stopped')
        return
      case 'meeting-started':
        revokeOpenTurn('meeting-started')
        return
      case 'sign-out':
        signedOutLatch = true
        break
      case 'sign-in':
        signedOutLatch = false
        break
    }
    refresh()
  }

  return {
    refresh,
    lifecycle,
    stop: () => lifecycle('quit'),
    status: () => current,
    suspendedReason: () => recognizer.suspendedReason()
  }
}
