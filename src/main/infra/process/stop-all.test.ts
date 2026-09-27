import { describe, expect, it, vi } from 'vitest'
import { createStopAll } from './stop-all'

describe('createStopAll', () => {
  it('stops every family once, in list order', () => {
    const calls: string[] = []
    const stopAll = createStopAll(
      [
        { name: 'a', stop: () => calls.push('a') },
        { name: 'b', stop: () => calls.push('b') },
        { name: 'c', stop: () => calls.push('c') }
      ],
      () => {}
    )

    stopAll()

    expect(calls).toEqual(['a', 'b', 'c'])
  })

  it('reports a family whose stop throws and still stops every family after it', () => {
    const calls: string[] = []
    const onError = vi.fn()
    const stopAll = createStopAll(
      [
        { name: 'a', stop: () => calls.push('a') },
        {
          name: 'b',
          stop: () => {
            throw new Error('b failed')
          }
        },
        { name: 'c', stop: () => calls.push('c') }
      ],
      onError
    )

    stopAll()

    expect(calls).toEqual(['a', 'c'])
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0]).toBe('b')
    expect(onError.mock.calls[0][1]).toBeInstanceOf(Error)
    expect((onError.mock.calls[0][1] as Error).message).toBe('b failed')
  })

  it('can run again: a second run stops every family again without throwing', () => {
    const calls: string[] = []
    const stopAll = createStopAll(
      [
        { name: 'a', stop: () => calls.push('a') },
        { name: 'b', stop: () => calls.push('b') },
        { name: 'c', stop: () => calls.push('c') }
      ],
      () => {}
    )

    stopAll()
    expect(() => stopAll()).not.toThrow()

    expect(calls).toEqual(['a', 'b', 'c', 'a', 'b', 'c'])
  })
})
