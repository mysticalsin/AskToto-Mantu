import { describe, expect, it, vi } from 'vitest'
import {
  installDisplayRemovalRevocation,
  installScreenObservationLifecycle,
  type ScreenLifecycleEvent
} from './lifecycle'

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

describe('installDisplayRemovalRevocation (G16)', () => {
  it('revokes when a display is removed, and for nothing else', () => {
    const listeners = new Map<string, () => void>()
    const screen = { on: (event: string, cb: () => void) => void listeners.set(event, cb) }
    const revoke = vi.fn()
    expect(installDisplayRemovalRevocation(screen, { revoke }, { warn: vi.fn() })).toBe(true)
    expect([...listeners.keys()]).toEqual(['display-removed'])
    listeners.get('display-removed')?.()
    expect(revoke).toHaveBeenCalledWith('display-removed')
  })

  it('warns and returns false when the subscription is refused', () => {
    const warn = vi.fn()
    const screen = {
      on: () => {
        throw new Error('no such event')
      }
    }
    expect(installDisplayRemovalRevocation(screen, { revoke: vi.fn() }, { warn })).toBe(false)
    expect(warn).toHaveBeenCalledOnce()
  })
})
