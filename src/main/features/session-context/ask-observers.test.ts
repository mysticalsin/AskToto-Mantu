import { describe, expect, it, vi } from 'vitest'
import { fanOutAskObservers } from './ask-observers'
import type { AskTurnObservation } from './ask-turn'

const event = { kind: 'started', id: 'ask-1' } as unknown as AskTurnObservation

describe('fanOutAskObservers', () => {
  it('delivers the same event to every observer in order', () => {
    const calls: string[] = []
    fanOutAskObservers(
      (e) => calls.push(`a:${(e as unknown as { id: string }).id}`),
      (e) => calls.push(`b:${(e as unknown as { id: string }).id}`)
    )(event)
    expect(calls).toEqual(['a:ask-1', 'b:ask-1'])
  })

  it('one throwing observer never blocks the next', () => {
    const second = vi.fn()
    const third = vi.fn()
    const fan = fanOutAskObservers(
      () => {
        throw new Error('boom')
      },
      second,
      third
    )
    expect(() => fan(event)).not.toThrow()
    expect(second).toHaveBeenCalledWith(event)
    expect(third).toHaveBeenCalledWith(event)
  })

  it('a later throw does not undo earlier delivery', () => {
    const first = vi.fn()
    expect(() =>
      fanOutAskObservers(first, () => {
        throw new Error('boom')
      })(event)
    ).not.toThrow()
    expect(first).toHaveBeenCalledTimes(1)
  })
})
