import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/ipc'

describe('settings publication', () => {
  beforeEach(() => vi.resetModules())

  it('exposes only the current publication without reading or acknowledging settings', async () => {
    const bus = await import('./settings-observation')
    expect(bus.getPublishedSettingsObservation()).toBeNull()
    bus.publishSettingsSnapshot(DEFAULT_SETTINGS, true)
    const epoch = bus.getSettingsObservationEpoch()
    expect(bus.getPublishedSettingsObservation()).toEqual({ settings: DEFAULT_SETTINGS, readable: true, epoch })
    for (let index = 0; index < 600; index += 1) bus.getPublishedSettingsObservation()
    expect(bus.getSettingsObservationEpoch()).toBe(epoch)
    bus.observeSettingsSnapshot(() => {
      throw new Error('synthetic failure')
    })
    expect(bus.getPublishedSettingsObservation()).toEqual({
      settings: DEFAULT_SETTINGS,
      readable: false,
      epoch: epoch + 1
    })
  })

  it('publishes cache hits without renewing the epoch and respects subscription ownership', async () => {
    const bus = await import('./settings-observation')
    const first = vi.fn()
    const stopFirst = bus.observeSettingsSnapshot(first)
    bus.publishSettingsSnapshot(DEFAULT_SETTINGS, true)
    const epoch = bus.getSettingsObservationEpoch()
    bus.publishSettingsSnapshot(DEFAULT_SETTINGS, true)
    expect(first).toHaveBeenCalledTimes(2)
    expect(bus.getSettingsObservationEpoch()).toBe(epoch)
    const successor = vi.fn()
    const stopSuccessor = bus.observeSettingsSnapshot(successor)
    stopFirst()
    bus.publishSettingsSnapshot(DEFAULT_SETTINGS, false)
    expect(successor).toHaveBeenCalledTimes(2)
    expect(successor.mock.lastCall?.[0]).toEqual({ settings: DEFAULT_SETTINGS, readable: false, epoch: epoch + 1 })
    stopSuccessor()
    bus.publishSettingsSnapshot(DEFAULT_SETTINGS, true)
    expect(successor).toHaveBeenCalledTimes(2)
  })

  it('closes the epoch on observer failure without breaking legacy settings reads', async () => {
    const bus = await import('./settings-observation')
    bus.publishSettingsSnapshot(DEFAULT_SETTINGS, true)
    const before = bus.getSettingsObservationEpoch()
    expect(() =>
      bus.observeSettingsSnapshot(() => {
        throw new Error('synthetic observer failure')
      })
    ).not.toThrow()
    expect(bus.getSettingsObservationEpoch()).toBeGreaterThan(before)
    const invalidated = bus.getSettingsObservationEpoch()
    expect(() => bus.publishSettingsSnapshot(DEFAULT_SETTINGS, true)).not.toThrow()
    expect(bus.getSettingsObservationEpoch()).toBeGreaterThan(invalidated)
  })
})
