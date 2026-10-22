/**
 * Q14 (C31 stress run): a Start click must either start, or say why it did not. Never silently nothing.
 *
 * Deterministic cause found in the click path: while a Stop drains (listen.listening stays true until the
 * sealed audio is decoded, up to the engine's no-progress bound) the bar already shows "Start listening"
 * because its chrome keys off the Stop having been initiated. toggleListen read the raw listening flag, so
 * that Start click re-entered endReview(), which returns early on its idempotence latch: no meeting, no
 * message. The decision is a pure function here so the swallowed click is reproducible without a renderer.
 *
 * The second guard is a bounded watchdog: whatever else swallows a Start (a click the page never saw, an
 * admission reply that never lands), no visible reason within the delay means the user is told to retry.
 */
import { describe, expect, it, vi } from 'vitest'
import { ADMISSION_DENIED_MSG } from './listen-notes'
import {
  START_WATCHDOG_MS,
  STOP_STILL_FINISHING_MSG,
  createStartWatchdog,
  resolveToggleListenIntent,
  runListenToggle,
  type StartWatchdog
} from './listen-toggle'

describe('resolveToggleListenIntent', () => {
  it('stops a live meeting', () => {
    expect(resolveToggleListenIntent({ listening: true, stopInProgress: false })).toBe('stop')
  })

  it('starts when nothing is listening', () => {
    expect(resolveToggleListenIntent({ listening: false, stopInProgress: false })).toBe('start')
  })

  it('starts when a finished Stop left its latch set (the latch only clears on the next Start)', () => {
    expect(resolveToggleListenIntent({ listening: false, stopInProgress: true })).toBe('start')
  })

  it('tells the user to wait, instead of re-entering Stop, when the click lands during the Stop drain', () => {
    expect(resolveToggleListenIntent({ listening: true, stopInProgress: true })).toBe('wait-for-stop')
  })
})

function watchdogHarness(read: { listening: boolean; hasVisibleReason: boolean }) {
  const timers = new Map<number, { fn: () => void; ms: number }>()
  let next = 1
  const notify = vi.fn()
  const watchdog = createStartWatchdog({
    read: () => read,
    notify,
    setTimer: (fn, ms) => {
      const id = next++
      timers.set(id, { fn, ms })
      return id
    },
    clearTimer: (id) => {
      timers.delete(id as number)
    }
  })
  const fireAll = (): void => {
    for (const [id, timer] of [...timers]) {
      timers.delete(id)
      timer.fn()
    }
  }
  return { watchdog, notify, timers, fireAll }
}

describe('createStartWatchdog', () => {
  it('is bounded: the delay is a few seconds, well inside the 15 s the stress run waited', () => {
    expect(START_WATCHDOG_MS).toBeGreaterThanOrEqual(1_000)
    expect(START_WATCHDOG_MS).toBeLessThanOrEqual(5_000)
  })

  it('shows the honest "try again" notice when a Start left nothing listening and nothing visible', () => {
    const { watchdog, notify, timers, fireAll } = watchdogHarness({ listening: false, hasVisibleReason: false })
    watchdog.arm()
    expect([...timers.values()].map((timer) => timer.ms)).toEqual([START_WATCHDOG_MS])
    fireAll()
    expect(notify).toHaveBeenCalledExactlyOnceWith(ADMISSION_DENIED_MSG)
  })

  it('stays quiet when the meeting started', () => {
    const { watchdog, notify, fireAll } = watchdogHarness({ listening: true, hasVisibleReason: false })
    watchdog.arm()
    fireAll()
    expect(notify).not.toHaveBeenCalled()
  })

  it('stays quiet when the app already shows its own reason (notice, error or consent dialog)', () => {
    const { watchdog, notify, fireAll } = watchdogHarness({ listening: false, hasVisibleReason: true })
    watchdog.arm()
    fireAll()
    expect(notify).not.toHaveBeenCalled()
  })

  it('re-arming replaces the pending check, so two quick Start clicks give one notice', () => {
    const { watchdog, notify, timers, fireAll } = watchdogHarness({ listening: false, hasVisibleReason: false })
    watchdog.arm()
    watchdog.arm()
    expect(timers.size).toBe(1)
    fireAll()
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('disarm and dispose cancel the pending check', () => {
    const { watchdog, notify, timers, fireAll } = watchdogHarness({ listening: false, hasVisibleReason: false })
    watchdog.arm()
    watchdog.disarm()
    expect(timers.size).toBe(0)
    watchdog.arm()
    watchdog.dispose()
    fireAll()
    expect(notify).not.toHaveBeenCalled()
  })
})

describe('runListenToggle', () => {
  const setup = (state: { listening: boolean; stopInProgress: boolean }) => {
    const watchdog: StartWatchdog = { arm: vi.fn(), disarm: vi.fn(), dispose: vi.fn() }
    const actions = {
      startListen: vi.fn((onStarted: () => void) => onStarted()),
      endReview: vi.fn(),
      notify: vi.fn(),
      watchdog
    }
    runListenToggle(state, actions)
    return actions
  }

  it('Start during the Stop drain says so and neither starts nor re-enters Stop', () => {
    const actions = setup({ listening: true, stopInProgress: true })
    expect(actions.notify).toHaveBeenCalledExactlyOnceWith(STOP_STILL_FINISHING_MSG)
    expect(actions.startListen).not.toHaveBeenCalled()
    expect(actions.endReview).not.toHaveBeenCalled()
    expect(actions.watchdog.arm).not.toHaveBeenCalled()
  })

  it('Stop ends the meeting and cancels any pending Start check', () => {
    const actions = setup({ listening: true, stopInProgress: false })
    expect(actions.endReview).toHaveBeenCalledTimes(1)
    expect(actions.watchdog.disarm).toHaveBeenCalledTimes(1)
    expect(actions.startListen).not.toHaveBeenCalled()
  })

  it('Start starts and arms the watchdog once the start ran', () => {
    const actions = setup({ listening: false, stopInProgress: false })
    expect(actions.startListen).toHaveBeenCalledTimes(1)
    expect(actions.watchdog.arm).toHaveBeenCalledTimes(1)
    expect(actions.endReview).not.toHaveBeenCalled()
    expect(actions.notify).not.toHaveBeenCalled()
  })

  it('a Start held behind the review-guard sheet arms nothing, and cancels an earlier pending check', () => {
    const watchdog: StartWatchdog = { arm: vi.fn(), disarm: vi.fn(), dispose: vi.fn() }
    const held = vi.fn() // the sheet is open: onStarted is not called until Save or Discard proceeds
    runListenToggle(
      { listening: false, stopInProgress: false },
      { startListen: held, endReview: vi.fn(), notify: vi.fn(), watchdog }
    )
    expect(held).toHaveBeenCalledTimes(1)
    expect(watchdog.disarm).toHaveBeenCalledTimes(1)
    expect(watchdog.arm).not.toHaveBeenCalled()
    held.mock.calls[0][0]() // Save/Discard re-minted the grant and the start ran
    expect(watchdog.arm).toHaveBeenCalledTimes(1)
  })

  it('the copy is plain words without an em dash', () => {
    expect(STOP_STILL_FINISHING_MSG).not.toMatch(/—/)
    expect(STOP_STILL_FINISHING_MSG.length).toBeLessThanOrEqual(80)
  })
})
