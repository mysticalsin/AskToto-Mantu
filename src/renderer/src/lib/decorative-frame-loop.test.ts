import { describe, expect, it } from 'vitest'
import {
  FRAME_SLACK_MS,
  REST_ORB_FPS_AMBIENT,
  REST_ORB_FPS_ENGAGED,
  TIMER_LEAD_MS,
  createFrameLoop,
  frameDue,
  frameWaitMs,
  orbFrameBudget,
  type FrameLoopDeps
} from './decorative-frame-loop'

/** A display at `hz` with a deterministic clock: vsyncs and timers fire in time order. */
function fakeDisplay(hz: number) {
  const vsync = 1000 / hz
  let now = 0
  let nextId = 1
  const frames = new Map<number, (time: number) => void>()
  const timers = new Map<number, { at: number; callback: () => void }>()
  const stats = { frameRequests: 0, timers: 0 }
  const deps: FrameLoopDeps = {
    requestFrame: (callback) => {
      stats.frameRequests += 1
      const id = nextId++
      frames.set(id, callback)
      return id
    },
    cancelFrame: (id) => {
      frames.delete(id)
    },
    setTimer: (callback, ms) => {
      stats.timers += 1
      const id = nextId++
      timers.set(id, { at: now + ms, callback })
      return id
    },
    clearTimer: (id) => {
      timers.delete(id as number)
    },
    now: () => now
  }
  /** Advance to `until` ms, firing timers at their time and pending frames at each vsync boundary. */
  const run = (until: number): void => {
    for (;;) {
      const nextVsync = (Math.floor(now / vsync + 1e-9) + 1) * vsync
      const due = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      if (due && due[1].at <= nextVsync && due[1].at <= until) {
        now = Math.max(now, due[1].at)
        timers.delete(due[0])
        due[1].callback()
        continue
      }
      if (nextVsync > until) break
      now = nextVsync
      const pending = [...frames.entries()]
      frames.clear()
      for (const [, callback] of pending) callback(now)
    }
    now = until
  }
  return { deps, run, stats, pendingFrames: () => frames.size, pendingTimers: () => timers.size }
}

describe('orbFrameBudget', () => {
  it('budgets only the resting orb: 60 fps engaged, 30 fps ambient', () => {
    expect(orbFrameBudget({ resting: true, engaged: true })).toBe(REST_ORB_FPS_ENGAGED)
    expect(orbFrameBudget({ resting: true, engaged: false })).toBe(REST_ORB_FPS_AMBIENT)
    expect(REST_ORB_FPS_ENGAGED).toBe(60)
    expect(REST_ORB_FPS_AMBIENT).toBe(30)
  })

  it('never budgets a state that is animating for a reason (listening, working, searching, connecting)', () => {
    expect(orbFrameBudget({ resting: false, engaged: true })).toBeNull()
    expect(orbFrameBudget({ resting: false, engaged: false })).toBeNull()
  })
})

describe('frameDue / frameWaitMs', () => {
  it('lets a frame that is up to half a 120 Hz vsync early count as on time', () => {
    expect(frameDue(1000 / 30 - FRAME_SLACK_MS, 0, 30)).toBe(true)
    expect(frameDue(1000 / 30 - FRAME_SLACK_MS - 1, 0, 30)).toBe(false)
    expect(frameDue(1, 0, null)).toBe(true)
  })

  it('sleeps until just before the next budgeted frame, and never for a wait a vsync would cover', () => {
    expect(frameWaitMs(0, 0, 30)).toBeCloseTo(1000 / 30 - FRAME_SLACK_MS - TIMER_LEAD_MS)
    expect(frameWaitMs(0, 0, null)).toBe(0)
    expect(frameWaitMs(18, 0, 30)).toBe(0)
  })
})

describe('createFrameLoop', () => {
  it('uncapped (null budget) paints on every vsync, as the orb always did', () => {
    const display = fakeDisplay(120)
    const paints: number[] = []
    const loop = createFrameLoop(
      (t) => paints.push(t),
      () => null,
      display.deps
    )
    loop.start()
    display.run(1000)
    expect(paints.length).toBeGreaterThanOrEqual(119)
    expect(display.stats.timers).toBe(0)
  })

  it('a 30 fps budget on a 120 Hz panel paints ~30 times a second and does not wake for skipped vsyncs', () => {
    const display = fakeDisplay(120)
    const paints: number[] = []
    const loop = createFrameLoop(
      (t) => paints.push(t),
      () => 30,
      display.deps
    )
    loop.start()
    display.run(10_000)
    expect(paints.length).toBeGreaterThanOrEqual(290)
    expect(paints.length).toBeLessThanOrEqual(301)
    // One rAF per painted frame (plus at most the very first), not 120 per second.
    expect(display.stats.frameRequests).toBeLessThanOrEqual(paints.length + 2)
  })

  it('a 60 fps budget on a 60 Hz display is every vsync, with no timers (identical to uncapped there)', () => {
    const display = fakeDisplay(60)
    const paints: number[] = []
    const loop = createFrameLoop(
      (t) => paints.push(t),
      () => 60,
      display.deps
    )
    loop.start()
    display.run(1000)
    expect(paints.length).toBeGreaterThanOrEqual(59)
    expect(display.stats.timers).toBe(0)
  })

  it('a 60 fps budget on a 120 Hz panel paints every other vsync', () => {
    const display = fakeDisplay(120)
    const paints: number[] = []
    const loop = createFrameLoop(
      (t) => paints.push(t),
      () => 60,
      display.deps
    )
    loop.start()
    display.run(1000)
    expect(paints.length).toBeGreaterThanOrEqual(58)
    expect(paints.length).toBeLessThanOrEqual(61)
  })

  it('picks up a budget change at the next frame without a restart', () => {
    const display = fakeDisplay(120)
    let budget: number | null = 30
    const paints: number[] = []
    const loop = createFrameLoop(
      (t) => paints.push(t),
      () => budget,
      display.deps
    )
    loop.start()
    display.run(1000)
    const ambient = paints.length
    budget = null
    display.run(2000)
    expect(ambient).toBeLessThanOrEqual(31)
    expect(paints.length - ambient).toBeGreaterThanOrEqual(110)
  })

  it('stop cancels both the pending frame and the pending timer, so nothing runs while stopped', () => {
    const display = fakeDisplay(120)
    let paints = 0
    const loop = createFrameLoop(
      () => {
        paints += 1
      },
      () => 30,
      display.deps
    )
    loop.start()
    display.run(100)
    loop.stop()
    expect(loop.running).toBe(false)
    expect(display.pendingFrames()).toBe(0)
    expect(display.pendingTimers()).toBe(0)
    const stoppedAt = paints
    display.run(2000)
    expect(paints).toBe(stoppedAt)
    loop.start()
    loop.start()
    display.run(3000)
    expect(paints - stoppedAt).toBeLessThanOrEqual(31)
  })
})
