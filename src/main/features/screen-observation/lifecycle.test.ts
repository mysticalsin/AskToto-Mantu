import { describe, expect, it, vi } from 'vitest'
import { installScreenObservationLifecycle, type ScreenLifecycleEvent } from './lifecycle'

function fakePower() {
  const listeners = new Map<string, () => void>()
  return {
    on: (event: string, cb: () => void) => {
      listeners.set(event, cb)
    },
    emit: (event: ScreenLifecycleEvent) => listeners.get(event)?.(),
    events: () => [...listeners.keys()].sort()
  }
}

describe('installScreenObservationLifecycle (G16)', () => {
  it('maps lock, unlock, suspend and resume onto the observation', () => {
    const power = fakePower()
    const observation = { noteScreenLocked: vi.fn(), noteSuspended: vi.fn() }
    expect(installScreenObservationLifecycle(power, observation, { warn: vi.fn() })).toBe(true)
    expect(power.events()).toEqual(['lock-screen', 'resume', 'suspend', 'unlock-screen'])
    power.emit('lock-screen')
    power.emit('unlock-screen')
    power.emit('suspend')
    power.emit('resume')
    expect(observation.noteScreenLocked.mock.calls).toEqual([[true], [false]])
    expect(observation.noteSuspended.mock.calls).toEqual([[true], [false]])
  })

  it('reports false and warns, never throws, when the OS refuses a subscription', () => {
    const warn = vi.fn()
    const power = {
      on: () => {
        throw new Error('no such event')
      }
    }
    expect(
      installScreenObservationLifecycle(power, { noteScreenLocked: vi.fn(), noteSuspended: vi.fn() }, { warn })
    ).toBe(false)
    expect(warn).toHaveBeenCalledOnce()
  })
})
