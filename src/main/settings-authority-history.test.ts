import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/ipc'

describe('settings authority history', () => {
  beforeEach(() => vi.resetModules())

  async function initialize() {
    const history = await import('./settings-authority-history')
    const bus = await import('./settings-observation')
    history.commitManagedAuthorityDocument('user', '/profile/managed-config.json', null, 'readable')
    history.commitManagedAuthorityDocument('admin', '/machine/managed-config.json', null, 'readable')
    bus.publishSettingsSnapshot(structuredClone(DEFAULT_SETTINGS), true)
    return { history, bus }
  }

  it('keeps equivalent refreshes live while same-reference A→B→A publication permanently closes old receipts', async () => {
    const { history, bus } = await initialize()
    const first = history.captureSettingsAuthority('persistence')
    expect(first).not.toBeNull()
    bus.publishSettingsSnapshot(structuredClone(DEFAULT_SETTINGS), true)
    expect(history.isSettingsAuthorityCurrent(first!)).toBe(true)
    const unrelated = structuredClone(DEFAULT_SETTINGS)
    unrelated.usageStats.meetingsSummarized += 1
    bus.publishSettingsSnapshot(unrelated, true)
    expect(history.isSettingsAuthorityCurrent(first!)).toBe(true)

    const mutable = structuredClone(DEFAULT_SETTINGS)
    const original = mutable.encryptTranscripts
    mutable.encryptTranscripts = !original
    bus.publishSettingsSnapshot(mutable, true)
    expect(history.isSettingsAuthorityCurrent(first!)).toBe(false)
    mutable.encryptTranscripts = original
    bus.publishSettingsSnapshot(mutable, true)
    expect(history.captureSettingsAuthority('persistence')).not.toBeNull()
    expect(history.isSettingsAuthorityCurrent(first!)).toBe(false)
  })

  it('isolates provider policy transitions to import while persistence keeps its receipt', async () => {
    const { history } = await initialize()
    const persistence = history.captureSettingsAuthority('persistence')!
    const imported = history.captureSettingsAuthority('import')!
    let invalidations = 0
    const dispose = history.observeSettingsAuthorityInvalidation('import', () => invalidations++)
    history.commitManagedAuthorityDocument(
      'user',
      '/profile/managed-config.json',
      '{"allowedProviders":["z","a","a"]}',
      'readable'
    )
    expect(history.isSettingsAuthorityCurrent(imported)).toBe(false)
    expect(history.isSettingsAuthorityCurrent(persistence)).toBe(true)
    expect(history.captureSettingsAuthority('import')).toBeNull()
    history.flushSettingsAuthorityInvalidations()
    expect(invalidations).toBe(1)
    dispose()
    history.commitManagedAuthorityDocument(
      'user',
      '/profile/managed-config.json',
      '{"allowedProviders":["a","z"]}',
      'readable'
    )
    expect(invalidations).toBe(1)
  })

  it('requires a coherent settings publication after a managed source transition', async () => {
    const { history, bus } = await initialize()
    const original = history.captureSettingsAuthority('import')!
    history.commitManagedAuthorityDocument(
      'user',
      '/profile/managed-config.json',
      '{"lockedKeys":["encryptTranscripts"]}',
      'readable'
    )
    expect(history.isSettingsAuthorityCurrent(original)).toBe(false)
    expect(history.captureSettingsAuthority('import')).toBeNull()
    bus.publishSettingsSnapshot(structuredClone(DEFAULT_SETTINGS), true)
    const refreshed = history.captureSettingsAuthority('import')
    expect(refreshed).not.toBeNull()
    expect(history.isSettingsAuthorityCurrent(original)).toBe(false)
  })

  it('closes old receipts on unreadability and never revives them after restoration', async () => {
    const { history } = await initialize()
    const original = history.captureSettingsAuthority('persistence')!
    history.commitManagedAuthorityDocument('user', '/profile/managed-config.json', null, 'unreadable')
    expect(history.isSettingsAuthorityCurrent(original)).toBe(false)
    history.commitManagedAuthorityDocument('user', '/profile/managed-config.json', null, 'readable')
    expect(history.captureSettingsAuthority('persistence')).toBeNull()
  })

  it('commits nested reentrant publications before callbacks and preserves the latest settings', async () => {
    const { history, bus } = await initialize()
    const prior = history.captureSettingsAuthority('persistence')!
    const original = structuredClone(DEFAULT_SETTINGS)
    const changed = { ...original, encryptTranscripts: !original.encryptTranscripts }
    let callbackCount = 0
    let nestedPublicationCount = 0
    let armed = false
    const dispose = bus.observeSettingsSnapshot(() => {
      callbackCount += 1
      if (!armed) return

      // Disarm before invoking the real publisher: nested notifications must not recurse.
      armed = false
      bus.publishSettingsSnapshot(changed, true)
      nestedPublicationCount += 1
      bus.publishSettingsSnapshot(original, true)
      nestedPublicationCount += 1
      expect(history.isSettingsAuthorityCurrent(prior)).toBe(false)
    })
    try {
      armed = true
      bus.publishSettingsSnapshot(changed, true)
      expect(nestedPublicationCount).toBe(2)
      // Immediate subscription plus the outer and two nested real publications.
      expect(callbackCount).toBe(4)
      expect(bus.getPublishedSettingsObservation()?.settings).toBe(original)
      expect(history.isSettingsAuthorityCurrent(prior)).toBe(false)
      const refreshed = history.captureSettingsAuthority('persistence')
      expect(refreshed).not.toBeNull()
      expect(refreshed).not.toBe(prior)
      expect(history.isSettingsAuthorityCurrent(refreshed!)).toBe(true)
    } finally {
      dispose()
    }
  })

  it('keeps a nested publication followed by a legacy callback throw unreadable and revoked', async () => {
    const { history, bus } = await initialize()
    const prior = history.captureSettingsAuthority('persistence')!
    const first = structuredClone(DEFAULT_SETTINGS)
    const second = { ...first, encryptTranscripts: !first.encryptTranscripts }
    let nested = false
    bus.observeSettingsSnapshot(() => {
      if (!nested) return
      nested = false
      bus.publishSettingsSnapshot(first, true)
      bus.publishSettingsSnapshot(second, true)
      throw new Error('synthetic reentrant observer failure')
    })
    nested = true
    expect(() => bus.publishSettingsSnapshot(first, true)).not.toThrow()
    expect(bus.getPublishedSettingsObservation()).toMatchObject({ settings: second, readable: false })
    expect(history.isSettingsAuthorityCurrent(prior)).toBe(false)
    expect(history.captureSettingsAuthority('persistence')).toBeNull()
  })
})
