import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCommandMicLeaseTimer } from './command-mic-lease-timer'

const id = 'a'.repeat(48)

function setup(lease: { sessionId: string; purpose: string } | null, tracked: string | null = id) {
  const hardStop = vi.fn()
  const timer = createCommandMicLeaseTimer({
    leaseId: () => tracked,
    authority: () => ({ activeLease: lease as never, hardStop })
  })
  return { timer, hardStop }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('createCommandMicLeaseTimer', () => {
  it('hard-stops the same command lease when the deadline passes', () => {
    const { timer, hardStop } = setup({ sessionId: id, purpose: 'command' })
    timer.arm(id, 15_000)
    vi.advanceTimersByTime(14_999)
    expect(hardStop).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(hardStop).toHaveBeenCalledExactlyOnceWith('cancelled')
  })

  it('does nothing for a different lease or a non-command purpose', () => {
    const other = setup({ sessionId: 'b'.repeat(48), purpose: 'command' })
    other.timer.arm(id, 10)
    vi.advanceTimersByTime(10)
    expect(other.hardStop).not.toHaveBeenCalled()
    const dictation = setup({ sessionId: id, purpose: 'dictation' })
    dictation.timer.arm(id, 10)
    vi.advanceTimersByTime(10)
    expect(dictation.hardStop).not.toHaveBeenCalled()
  })

  it('clear cancels the deadline, but only for the tracked lease when an id is given', () => {
    const { timer, hardStop } = setup({ sessionId: id, purpose: 'command' })
    timer.arm(id, 10)
    timer.clear('b'.repeat(48))
    vi.advanceTimersByTime(10)
    expect(hardStop).toHaveBeenCalledOnce()
    timer.arm(id, 10)
    timer.clear(id)
    vi.advanceTimersByTime(10)
    expect(hardStop).toHaveBeenCalledOnce()
  })

  it('arming again replaces the previous deadline', () => {
    const { timer, hardStop } = setup({ sessionId: id, purpose: 'command' })
    timer.arm(id, 10)
    timer.arm(id, 100)
    vi.advanceTimersByTime(10)
    expect(hardStop).not.toHaveBeenCalled()
    vi.advanceTimersByTime(90)
    expect(hardStop).toHaveBeenCalledOnce()
  })
})
