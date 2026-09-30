import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CURSOR_WATCH_INTERVAL_MS, TOP_CENTER_REVEAL_DWELL_MS, decideCursorWatch } from './cursor-watch'
import {
  CURSOR_WATCH_IDLE_INTERVAL_MS,
  CURSOR_WATCH_NEAR_PX,
  PRESENTER_IDLE_BLUR_MS,
  createAdaptiveCursorWatch,
  createPresenterIdleSignal,
  cursorWatchIntervalMs
} from './idle-throttle'

const rest = { x: 700, y: 0, width: 400, height: 40 }
const bar = { x: 460, y: 39, width: 880, height: 120 }

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('cursorWatchIntervalMs', () => {
  it('polls at 24 ms near the top-edge zone and at least 250 ms when parked with the pointer away', () => {
    expect(CURSOR_WATCH_INTERVAL_MS).toBe(24)
    expect(CURSOR_WATCH_IDLE_INTERVAL_MS).toBeGreaterThanOrEqual(250)
    const parked = { restRect: rest, revealedRect: null, transitioning: false }
    expect(cursorWatchIntervalMs({ ...parked, cursor: { x: 900, y: 10 } })).toBe(24)
    expect(cursorWatchIntervalMs({ ...parked, cursor: { x: 900, y: 40 + CURSOR_WATCH_NEAR_PX - 1 } })).toBe(24)
    expect(cursorWatchIntervalMs({ ...parked, cursor: { x: 900, y: 40 + CURSOR_WATCH_NEAR_PX } })).toBe(
      CURSOR_WATCH_IDLE_INTERVAL_MS
    )
    expect(cursorWatchIntervalMs({ ...parked, cursor: { x: 100, y: 900 } })).toBe(CURSOR_WATCH_IDLE_INTERVAL_MS)
  })

  it('stays fast during a transition wherever the pointer is', () => {
    expect(
      cursorWatchIntervalMs({ cursor: { x: 100, y: 900 }, restRect: rest, revealedRect: null, transitioning: true })
    ).toBe(24)
  })

  it('stays fast near a revealed bar and drops to idle once the pointer is far from it too', () => {
    const revealed = { restRect: rest, revealedRect: bar, transitioning: false }
    expect(cursorWatchIntervalMs({ ...revealed, cursor: { x: 470, y: 300 } })).toBe(24)
    expect(cursorWatchIntervalMs({ ...revealed, cursor: { x: 100, y: 900 } })).toBe(CURSOR_WATCH_IDLE_INTERVAL_MS)
  })
})

describe('createAdaptiveCursorWatch', () => {
  it('reschedules each tick with the delay asked for after it', () => {
    const ticks: number[] = []
    const delays = [250, 24, 24]
    const watch = createAdaptiveCursorWatch({
      tick: () => ticks.push(Date.now()),
      intervalMs: () => delays.shift() ?? 250
    })
    const t0 = Date.now()
    watch.start()
    vi.advanceTimersByTime(24 + 250 + 24 + 24)
    expect(ticks.map((t) => t - t0)).toEqual([24, 274, 298, 322])
    watch.stop()
    expect(watch.running()).toBe(false)
    vi.advanceTimersByTime(1000)
    expect(ticks).toHaveLength(4)
  })

  it('reports running while a tick is in flight, so a reveal from inside a tick never restarts it', () => {
    const seen: boolean[] = []
    const watch = createAdaptiveCursorWatch({ tick: () => seen.push(watch.running()), intervalMs: () => 250 })
    expect(watch.running()).toBe(false)
    watch.start()
    vi.advanceTimersByTime(24)
    expect(seen).toEqual([true])
    watch.stop()
  })

  it('does not reschedule after a tick that stopped the watch', () => {
    let ticks = 0
    const watch = createAdaptiveCursorWatch({
      tick: () => {
        ticks += 1
        watch.stop()
      },
      intervalMs: () => 24
    })
    watch.start()
    vi.advanceTimersByTime(1000)
    expect(ticks).toBe(1)
    expect(watch.running()).toBe(false)
  })

  it('keeps a single timer when a tick restarts the watch', () => {
    let ticks = 0
    const watch = createAdaptiveCursorWatch({
      tick: () => {
        ticks += 1
        if (ticks === 1) watch.start()
      },
      intervalMs: () => 24
    })
    watch.start()
    vi.advanceTimersByTime(24 * 10)
    expect(ticks).toBe(10)
  })
})

/**
 * Drives the adaptive watch with the same dwell rule main applies (reveal once the pointer has stayed in the
 * zone for the dwell) and returns the reveal latency net of that intentional dwell, worst case over timer phase.
 */
function worstRevealLatencyNetOfDwell(speedPxPerMs: number): number {
  const startY = 1000
  let worst = 0
  for (let phase = 0; phase < CURSOR_WATCH_IDLE_INTERVAL_MS; phase += 5) {
    const t0 = Date.now()
    const cursorAt = (): { x: number; y: number } => {
      const elapsed = Math.max(0, Date.now() - t0 - phase)
      return { x: 900, y: Math.max(0, startY - speedPxPerMs * elapsed) }
    }
    let enteredAt: number | null = null
    let revealedAt = null as number | null
    const watch = createAdaptiveCursorWatch({
      tick: () => {
        const decision = decideCursorWatch({ cursor: cursorAt(), restRect: rest, revealedRect: rest, revealed: false })
        if (decision !== 'reveal') {
          enteredAt = null
          return
        }
        enteredAt ??= Date.now()
        if (Date.now() - enteredAt < TOP_CENTER_REVEAL_DWELL_MS) return
        revealedAt = Date.now()
        watch.stop()
      },
      intervalMs: () =>
        cursorWatchIntervalMs({ cursor: cursorAt(), restRect: rest, revealedRect: null, transitioning: enteredAt !== null })
    })
    // Parked with the pointer far away; `phase` sweeps when it starts moving against the idle tick.
    watch.start()
    vi.advanceTimersByTime(5000)
    watch.stop()
    expect(revealedAt).not.toBeNull()
    const zoneEnteredAt = t0 + phase + (startY - (rest.y + rest.height)) / speedPxPerMs
    worst = Math.max(worst, (revealedAt ?? Infinity) - zoneEnteredAt - TOP_CENTER_REVEAL_DWELL_MS)
  }
  return worst
}

describe('reveal latency with the adaptive cadence', () => {
  it('adds at most two fast ticks to the dwell for a pointer within the band design speed', () => {
    expect(worstRevealLatencyNetOfDwell(1.2)).toBeLessThanOrEqual(2 * CURSOR_WATCH_INTERVAL_MS)
  })

  it('keeps a brisk 2 px/ms approach at or under 150 ms beyond the dwell', () => {
    expect(worstRevealLatencyNetOfDwell(2)).toBeLessThanOrEqual(150)
  })
})

describe('createPresenterIdleSignal', () => {
  it('publishes idle when parked and active again on reveal, only on change', () => {
    const published: boolean[] = []
    const signal = createPresenterIdleSignal({ publish: (s) => published.push(s.idle) })
    signal.setParked(true)
    signal.setParked(true)
    signal.setParked(false)
    expect(published).toEqual([true, false])
  })

  it('turns idle only after the overlay has stayed blurred for the blur delay, and clears at once on focus', () => {
    const published: boolean[] = []
    const signal = createPresenterIdleSignal({ publish: (s) => published.push(s.idle) })
    signal.setFocused(false)
    vi.advanceTimersByTime(PRESENTER_IDLE_BLUR_MS - 1)
    expect(published).toEqual([])
    signal.setFocused(true)
    signal.setFocused(false)
    vi.advanceTimersByTime(PRESENTER_IDLE_BLUR_MS - 1)
    expect(published).toEqual([])
    vi.advanceTimersByTime(1)
    expect(published).toEqual([true])
    expect(signal.current()).toEqual({ idle: true })
    signal.setFocused(true)
    expect(published).toEqual([true, false])
  })

  it('stays idle while parked even when focused, and republishes the current state on request', () => {
    const published: boolean[] = []
    const signal = createPresenterIdleSignal({ publish: (s) => published.push(s.idle), blurDelayMs: 1000 })
    signal.setParked(true)
    signal.setFocused(false)
    vi.advanceTimersByTime(1000)
    signal.setFocused(true)
    expect(published).toEqual([true])
    signal.republish()
    expect(published).toEqual([true, true])
    signal.setFocused(false)
    signal.dispose()
    signal.setParked(false)
    vi.advanceTimersByTime(1000)
    expect(published).toEqual([true, true, false])
  })
})
