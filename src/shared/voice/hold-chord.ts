/**
 * hold-chord.ts — the pure recognizer behind the global hold-to-talk chord (V01).
 *
 * It reduces the helpers' `(modifierMask, otherInputSeq)` samples and a clock into a handful of events. It owns no
 * timer and no process: the caller feeds samples with `feed(sample, now)` and drives deadlines with `tick(now)`,
 * asking `nextDeadline()` when to wake. That keeps every rule below testable with a fake clock.
 *
 * Rules (the design's section 1.2 and 3, PROPOSED unless noted):
 * - Hold threshold 250 ms. A shorter press produces no event at all, so a chord used inside other shortcuts never
 *   opens a microphone.
 * - Alone rule. The chord must be pressed from clean (no other modifier down, no other input in the same poll) and
 *   the mask must equal the chord exactly for the whole hold. Any other key or mouse button (the `seq` moves), or any
 *   added or different modifier, disqualifies the press. Before the threshold that is silent; after it the open turn
 *   is `aborted`. A disqualified press stays disqualified until every modifier is released.
 * - Multi-key chords (Left Ctrl + Left Alt) may be assembled and released one key at a time: a partial set is
 *   transient, not a violation.
 * - Exact mask match is what excludes AltGr (Windows reports it as Left Ctrl + Right Alt) and the wrong-side key.
 * - Latched (hands-free) mode: a press that starts within 400 ms after a short tap's release latches listening at
 *   that second press-down (`latched`). One more press, any other key, or the cap ends it (`latch-ended`).
 * - Cap 15 s from arming or latching.
 * - A Control+Option chord is suspended while assistive technology runs (VoiceOver's modifier).
 * - Clock skew: time never runs backwards inside the recognizer; a non-finite `now` is ignored.
 */
import { chordConflictsWithScreenReader, type ModifierSample } from './modifier-mask'

export const HOLD_THRESHOLD_MS = 250
export const LATCH_WINDOW_MS = 400
export const HOLD_CAP_MS = 15_000

export type HoldChordResetReason = 'suspended' | 'reset'

export type HoldChordEvent =
  /** The chord has been held alone for the threshold: a listening turn may begin. */
  | { readonly type: 'armed' }
  /** A double press latched hands-free listening: a listening turn may begin. */
  | { readonly type: 'latched' }
  /** The held chord ended normally (key-up) or hit the cap: the turn should finish. */
  | { readonly type: 'released'; readonly reason: 'release' | 'cap' }
  /** An open hold was cancelled: another key or modifier, a suspension or a reset. */
  | { readonly type: 'aborted'; readonly reason: 'other-input' | 'other-modifier' | HoldChordResetReason }
  /** Latched listening ended. */
  | { readonly type: 'latch-ended'; readonly reason: 'press' | 'other-input' | 'cap' | HoldChordResetReason }

export interface HoldChordConfig {
  /** Exact modifier set that forms the chord (`MODIFIER_BITS` or-ed together). */
  readonly chordMask: number
  readonly holdThresholdMs?: number
  readonly latchWindowMs?: number
  readonly capMs?: number
  readonly latchEnabled?: boolean
  readonly assistiveTechnologyActive?: boolean
}

export type HoldChordState = 'idle' | 'pending' | 'armed' | 'latched' | 'blocked'

export interface HoldChordRecognizer {
  /** Apply one helper sample. */
  feed(sample: ModifierSample, now: number): HoldChordEvent[]
  /** Advance the clock with no new sample (arm at the threshold, cap). */
  tick(now: number): HoldChordEvent[]
  /** The time `tick` next has something to do, or null. */
  nextDeadline(): number | null
  /** Drop all state (helper restart, lock, suspend). Ends an open hold or latch with the given reason. */
  reset(now: number, reason: HoldChordResetReason): HoldChordEvent[]
  /** Change the chord or assistive-technology flag. A change ends an open hold. */
  configure(update: Partial<HoldChordConfig>, now: number): HoldChordEvent[]
  state(): HoldChordState
  suspendedReason(): 'assistive-technology' | null
}

export function createHoldChordRecognizer(initial: HoldChordConfig): HoldChordRecognizer {
  let config: HoldChordConfig = initial
  let state: HoldChordState = 'idle'
  let lastNow = Number.NEGATIVE_INFINITY
  let lastSeq: number | null = null
  let lastMask = 0
  let tapReleasedAt: number | null = null
  let pressAt = 0
  let armedAt = 0
  let latchedAt = 0
  let chordDown = false

  const threshold = (): number => config.holdThresholdMs ?? HOLD_THRESHOLD_MS
  const latchWindow = (): number => config.latchWindowMs ?? LATCH_WINDOW_MS
  const cap = (): number => config.capMs ?? HOLD_CAP_MS
  const suspended = (): boolean =>
    chordConflictsWithScreenReader(config.chordMask, config.assistiveTechnologyActive === true)

  const clock = (now: number): number => {
    if (!Number.isFinite(now)) return Number.isFinite(lastNow) ? lastNow : 0
    lastNow = Math.max(lastNow, now)
    return lastNow
  }

  // After a disqualifying or finishing event: free if every modifier is already up, otherwise wait for that.
  const settle = (mask: number): void => {
    state = mask === 0 ? 'idle' : 'blocked'
    tapReleasedAt = null
    chordDown = false
  }

  const advance = (now: number, out: HoldChordEvent[]): void => {
    if (state === 'pending' && now >= pressAt + threshold()) {
      state = 'armed'
      armedAt = pressAt + threshold()
      out.push({ type: 'armed' })
    }
    if (state === 'armed' && now >= armedAt + cap()) {
      out.push({ type: 'released', reason: 'cap' })
      settle(lastMask)
    } else if (state === 'latched' && now >= latchedAt + cap()) {
      out.push({ type: 'latch-ended', reason: 'cap' })
      settle(lastMask)
    }
  }

  const end = (reason: HoldChordResetReason): HoldChordEvent[] => {
    const out: HoldChordEvent[] = []
    if (state === 'armed') out.push({ type: 'aborted', reason })
    else if (state === 'latched') out.push({ type: 'latch-ended', reason })
    // The counter's baseline restarts with the next sample (a restarted helper begins a new count). A chord that is
    // still physically down stays blocked: it must be released before it can open another turn.
    state = lastMask === 0 ? 'idle' : 'blocked'
    tapReleasedAt = null
    chordDown = false
    lastSeq = null
    return out
  }

  const onSample = (mask: number, otherInput: boolean, now: number, out: HoldChordEvent[]): void => {
    const matches = mask === config.chordMask
    // A multi-key chord is assembled and released one key at a time, with a poll in between. A proper, non-empty
    // subset of the chord is that transient state, not another modifier: it is neither a press nor a violation.
    const partial = mask !== 0 && !matches && (mask & ~config.chordMask) === 0
    switch (state) {
      case 'blocked':
        if (mask === 0) {
          state = 'idle'
          tapReleasedAt = null
        }
        return
      case 'idle':
        if (mask === 0) {
          if (otherInput) tapReleasedAt = null
          return
        }
        if (partial) {
          if (otherInput) tapReleasedAt = null
          return
        }
        if (!matches || otherInput) {
          settle(mask)
          return
        }
        if (config.latchEnabled !== false && tapReleasedAt !== null && now - tapReleasedAt <= latchWindow()) {
          state = 'latched'
          latchedAt = now
          chordDown = true
          tapReleasedAt = null
          out.push({ type: 'latched' })
          return
        }
        state = 'pending'
        pressAt = now
        return
      case 'pending':
        if (matches && !otherInput) return
        if (mask === 0 && !otherInput) {
          tapReleasedAt = now
          state = 'idle'
          return
        }
        if (partial && !otherInput) {
          state = 'idle'
          tapReleasedAt = null
          return
        }
        settle(mask)
        return
      case 'armed':
        if (matches && !otherInput) return
        if (otherInput) out.push({ type: 'aborted', reason: 'other-input' })
        else if (mask === 0 || partial) out.push({ type: 'released', reason: 'release' })
        else out.push({ type: 'aborted', reason: 'other-modifier' })
        settle(mask)
        return
      case 'latched':
        if (otherInput) {
          out.push({ type: 'latch-ended', reason: 'other-input' })
          settle(mask)
          return
        }
        if (matches && !chordDown) {
          out.push({ type: 'latch-ended', reason: 'press' })
          settle(mask)
          state = 'blocked'
          return
        }
        chordDown = matches
        return
    }
  }

  return {
    feed(sample, rawNow) {
      const out: HoldChordEvent[] = []
      const now = clock(rawNow)
      const otherInput = lastSeq !== null && sample.seq !== lastSeq
      if (suspended()) {
        lastSeq = sample.seq
        lastMask = sample.mask
        return out
      }
      advance(now, out)
      lastSeq = sample.seq
      lastMask = sample.mask
      onSample(sample.mask, otherInput, now, out)
      return out
    },
    tick(rawNow) {
      const out: HoldChordEvent[] = []
      if (suspended()) return out
      advance(clock(rawNow), out)
      return out
    },
    nextDeadline() {
      if (suspended()) return null
      if (state === 'pending') return pressAt + threshold()
      if (state === 'armed') return armedAt + cap()
      if (state === 'latched') return latchedAt + cap()
      return null
    },
    reset(rawNow, reason) {
      clock(rawNow)
      return end(reason)
    },
    configure(update, rawNow) {
      clock(rawNow)
      const next = { ...config, ...update }
      const chordChanged = next.chordMask !== config.chordMask
      const wasSuspended = suspended()
      config = next
      if (chordChanged) return end('reset')
      if (!wasSuspended && suspended()) return end('suspended')
      return []
    },
    state: () => state,
    suspendedReason: () => (suspended() ? 'assistive-technology' : null)
  }
}
