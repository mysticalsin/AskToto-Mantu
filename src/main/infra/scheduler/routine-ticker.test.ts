import { afterEach, describe, expect, it, vi } from 'vitest'
import { startRoutineTicker } from './routine-ticker'

function powerMonitor() {
  const listeners = new Map<string, Set<() => void>>()
  return {
    listeners,
    on(event: 'resume' | 'unlock-screen', listener: () => void) {
      const set = listeners.get(event) ?? new Set()
      set.add(listener)
      listeners.set(event, set)
    },
    removeListener(event: 'resume' | 'unlock-screen', listener: () => void) {
      listeners.get(event)?.delete(listener)
    },
    emit(event: string) {
      for (const l of [...(listeners.get(event) ?? [])]) l()
    }
  }
}

afterEach(() => vi.useRealTimers())

describe('routine ticker (G66)', () => {
  it('ticks on an interval', () => {
    vi.useFakeTimers()
    const onTick = vi.fn()
    const stop = startRoutineTicker(onTick, { everyMs: 1000, powerMonitor: powerMonitor() })
    vi.advanceTimersByTime(3500)
    expect(onTick).toHaveBeenCalledTimes(3)
    stop()
  })

  it('resume and unlock-screen trigger a tick', () => {
    const power = powerMonitor()
    const onTick = vi.fn()
    const stop = startRoutineTicker(onTick, { powerMonitor: power })
    power.emit('resume')
    power.emit('unlock-screen')
    expect(onTick).toHaveBeenCalledTimes(2)
    stop()
  })

  it('disposer removes listeners and timer', () => {
    vi.useFakeTimers()
    const power = powerMonitor()
    const onTick = vi.fn()
    const stop = startRoutineTicker(onTick, { everyMs: 1000, powerMonitor: power })
    stop()
    stop()
    power.emit('resume')
    power.emit('unlock-screen')
    vi.advanceTimersByTime(5000)
    expect(onTick).not.toHaveBeenCalled()
    expect(power.listeners.get('resume')!.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a throwing tick does not break the next one', () => {
    const power = powerMonitor()
    const onTick = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('x')
      })
      .mockImplementation(() => undefined)
    startRoutineTicker(onTick, { powerMonitor: power })
    power.emit('resume')
    power.emit('resume')
    expect(onTick).toHaveBeenCalledTimes(2)
  })
})
