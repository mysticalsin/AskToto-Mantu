import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type Settings } from '@shared/ipc'

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

  it('keeps equivalent and unrelated publications current without depending on the speech epoch', async () => {
    const bus = await import('./settings-observation')
    const settings = {
      ...DEFAULT_SETTINGS,
      azureClientId: ' client ',
      azureTenantId: ' tenant ',
      azureAllowedDomain: ' @example.invalid '
    }
    bus.publishSettingsSnapshot(settings, true)
    const current = bus.captureDraftSettingsBoundary()
    const epoch = bus.getSettingsObservationEpoch()
    bus.publishSettingsSnapshot({ ...settings }, true)
    bus.publishSettingsSnapshot({ ...settings, azureClientId: 'client', azureTenantId: 'tenant', azureAllowedDomain: 'example.invalid', autoSaveTranscripts: !settings.autoSaveTranscripts }, true)
    expect(bus.getSettingsObservationEpoch()).toBeGreaterThan(epoch)
    expect(current()).toBe(true)
  })

  it.each([
    ['configured root', { meetingsFolder: 'synthetic-other-root' }],
    ['encryption', { encryptTranscripts: !DEFAULT_SETTINGS.encryptTranscripts }],
    ['retention', { enterpriseLive: { managed: true, inferenceMode: 'cloud-only', summaryOnly: true } }],
    ['client', { azureClientId: 'synthetic-other-client' }],
    ['tenant', { azureTenantId: 'synthetic-other-tenant' }],
    ['domain', { azureAllowedDomain: 'other.invalid' }]
  ] satisfies Array<[string, Partial<Settings>]>)('retires observed %s ABA even after the same object returns', async (_label, change) => {
    const bus = await import('./settings-observation')
    const settings = { ...DEFAULT_SETTINGS }
    bus.publishSettingsSnapshot(settings, true)
    const current = bus.captureDraftSettingsBoundary()
    const prior = { ...settings }
    Object.assign(settings, change)
    bus.publishSettingsSnapshot(settings, true)
    Object.assign(settings, prior)
    bus.publishSettingsSnapshot(settings, true)
    expect(current()).toBe(false)
    expect(bus.captureDraftSettingsBoundary()()).toBe(true)
  })

  it('refuses missing or unreadable authority and retains observed readability loss after recovery', async () => {
    const bus = await import('./settings-observation')
    const missing = bus.captureDraftSettingsBoundary()
    bus.publishSettingsSnapshot(DEFAULT_SETTINGS, false)
    const unreadable = bus.captureDraftSettingsBoundary()
    bus.publishSettingsSnapshot(DEFAULT_SETTINGS, true)
    const current = bus.captureDraftSettingsBoundary()
    bus.publishSettingsSnapshot(DEFAULT_SETTINGS, false)
    bus.publishSettingsSnapshot(DEFAULT_SETTINGS, true)
    expect(missing()).toBe(false)
    expect(unreadable()).toBe(false)
    expect(current()).toBe(false)
    const recovered = bus.captureDraftSettingsBoundary()
    const stop = bus.observeSettingsSnapshot(() => { throw new Error('synthetic private observer failure') })
    stop()
    bus.publishSettingsSnapshot(DEFAULT_SETTINGS, true)
    expect(recovered()).toBe(false)
    expect(bus.captureDraftSettingsBoundary()()).toBe(true)
  })
})
