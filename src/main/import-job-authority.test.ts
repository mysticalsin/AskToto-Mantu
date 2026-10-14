import { describe, expect, it } from 'vitest'
import type { Settings } from '@shared/ipc'
import type { SettingsObservation, SettingsPolicyAuthoritySnapshot } from './settings-observation'
import { createImportJobAuthority } from './import-job-authority'

function settings(summaryOnly = false, cloudOnly = false): Settings {
  return {
    enterpriseLive: cloudOnly
      ? { managed: true, inferenceMode: 'cloud-only', summaryOnly }
      : { managed: false, inferenceMode: 'local', summaryOnly },
    meetingsFolder: '/meetings-a',
    encryptTranscripts: false,
    asrEngine: 'whisper',
    asrLanguage: 'auto'
  } as Settings
}

function snapshot(value: Settings, epoch: number, readable = true): SettingsPolicyAuthoritySnapshot {
  return { settings: value, readable, epoch, allowedProviders: null, localSpeechPack: null, lockedKeys: [] }
}

describe('import job authority boundary', () => {
  it('keeps an operation current across verified equivalent fresh Settings publications', async () => {
    let current: SettingsObservation | null = null
    let epoch = 1
    const value = settings()
    current = snapshot(value, epoch)
    const authority = createImportJobAuthority({
      requireAuth: () => true,
      authGeneration: () => 4,
      readAuthority: async () => {
        const fresh = snapshot({ ...value }, ++epoch)
        current = fresh
        return fresh
      },
      currentObservation: () => current
    })

    const operation = await authority.captureOperation()
    operation.assertCurrent()
    await authority.assertAdmissionAllowed()
    operation.assertCurrent()
    await operation.refreshSameScope()
    operation.assertCurrent()
  })

  it('pins the invocation auth generation while its initial authority refresh is queued', async () => {
    let current: SettingsObservation | null = snapshot(settings(), 1)
    let generation = 6
    let releaseRead: (() => void) | undefined
    let announceRead: (() => void) | undefined
    const readStarted = new Promise<void>((resolve) => {
      announceRead = resolve
    })
    const authority = createImportJobAuthority({
      requireAuth: () => true,
      authGeneration: () => generation,
      readAuthority: async () => {
        announceRead?.()
        await new Promise<void>((resolve) => {
          releaseRead = resolve
        })
        const fresh = snapshot(settings(), 1)
        current = fresh
        return fresh
      },
      currentObservation: () => current
    })

    const captured = authority.captureOperation()
    await readStarted
    generation += 1
    releaseRead?.()
    await expect(captured).rejects.toThrow(/policy could not be verified/)
  })

  it('rejects a settings A to B to A transition while the initial authority refresh is queued', async () => {
    let current: SettingsObservation | null = snapshot(settings(), 1)
    let releaseRead: (() => void) | undefined
    let announceRead: (() => void) | undefined
    const readStarted = new Promise<void>((resolve) => {
      announceRead = resolve
    })
    const authority = createImportJobAuthority({
      requireAuth: () => true,
      authGeneration: () => 2,
      readAuthority: async () => {
        announceRead?.()
        await new Promise<void>((resolve) => {
          releaseRead = resolve
        })
        const fresh = snapshot(settings(), 3)
        current = fresh
        return fresh
      },
      currentObservation: () => current
    })

    const captured = authority.captureOperation()
    await readStarted
    current = snapshot(settings(true), 2)
    current = snapshot(settings(), 3)
    releaseRead?.()
    await expect(captured).rejects.toThrow(/policy could not be verified/)
  })

  it('requires fresh readable settings and a matching published epoch', async () => {
    let current: SettingsObservation | null = null
    let allowed = true
    const readAuthority = async () => {
      const authority = snapshot(settings(), 3)
      current = authority
      return authority
    }
    const authority = createImportJobAuthority({
      requireAuth: () => allowed,
      authGeneration: () => 0,
      readAuthority,
      currentObservation: () => current
    })

    await expect(authority.assertAdmissionAllowed()).resolves.toMatchObject(settings())
    allowed = false
    await expect(authority.assertAdmissionAllowed()).rejects.toThrow(/policy could not be verified/)
  })

  it('rechecks trusted policy after held temp I/O before authorizing a rename retry', async () => {
    let current: SettingsObservation | null = null
    let currentSettings = settings()
    let epoch = 1
    const authority = createImportJobAuthority({
      requireAuth: () => true,
      authGeneration: () => 0,
      readAuthority: async () => {
        const fresh = snapshot(currentSettings, epoch)
        current = fresh
        return fresh
      },
      currentObservation: () => current
    })

    await authority.refreshSettings()
    const prepareRename = authority.prepareReplacement()
    const originalAttemptGuard = await prepareRename()
    if (typeof originalAttemptGuard !== 'function') throw new Error('Expected a captured authority guard.')

    // A retry performs another fresh authority read after its previous rename attempt was held.
    currentSettings = settings(true)
    epoch += 1
    await expect(prepareRename()).rejects.toThrow(/policy could not be verified/)
    expect(originalAttemptGuard).toThrow(/policy could not be verified/)
  })

  it('reports a fresh summary-only policy refusal without treating it as stale authority', async () => {
    let current: SettingsObservation | null = null
    const authority = createImportJobAuthority({
      requireAuth: () => true,
      authGeneration: () => 0,
      readAuthority: async () => {
        const fresh = snapshot(settings(true), 1)
        current = fresh
        return fresh
      },
      currentObservation: () => current
    })
    const settingsSnapshot = await authority.refreshSettings()
    const prepareRename = authority.prepareReplacement(settingsSnapshot)
    await expect(prepareRename()).rejects.toThrow(/summary-only policy prevents import/)
  })

  it('refuses a prepared write if its root or encryption scope changes during temporary I/O', async () => {
    let current: SettingsObservation | null = null
    let currentSettings = settings()
    let epoch = 3
    let authorityReads = 0
    const authority = createImportJobAuthority({
      requireAuth: () => true,
      authGeneration: () => 0,
      readAuthority: async () => {
        authorityReads += 1
        const fresh = snapshot(currentSettings, epoch)
        current = fresh
        return fresh
      },
      currentObservation: () => current
    })
    await authority.refreshSettings()
    const prepare = authority.prepareReplacement(currentSettings)
    const originalReads = authorityReads
    currentSettings = { ...currentSettings, meetingsFolder: '/meetings-b', encryptTranscripts: true }
    epoch += 1
    current = snapshot(currentSettings, epoch)

    await expect(prepare()).rejects.toThrow(/policy could not be verified/)
    expect(authorityReads).toBe(originalReads)
  })

  it('refuses an epoch-only ABA during a held write instead of adopting the restored scope', async () => {
    let current: SettingsObservation | null = null
    const original = settings()
    let epoch = 8
    const authority = createImportJobAuthority({
      requireAuth: () => true,
      authGeneration: () => 0,
      readAuthority: async () => {
        const fresh = snapshot(original, epoch)
        current = fresh
        return fresh
      },
      currentObservation: () => current
    })
    await authority.refreshSettings()
    const prepare = authority.prepareReplacement(original)
    const savedEpoch = epoch
    epoch += 2 // policy/settings changed and returned to its prior value during the temp write
    current = snapshot(original, epoch)

    await expect(prepare()).rejects.toThrow(/policy could not be verified/)
    expect(epoch).not.toBe(savedEpoch)
  })

  it('keeps cloud-only capability refusal separate from summary-only retention state', async () => {
    let current: SettingsObservation | null = null
    const authority = createImportJobAuthority({
      requireAuth: () => true,
      authGeneration: () => 0,
      readAuthority: async () => {
        const fresh = snapshot(settings(false, true), 7)
        current = fresh
        return fresh
      },
      currentObservation: () => current
    })

    await expect(authority.refreshRetentionState()).resolves.toBe('allowed')
    await expect(authority.refreshCapabilityState()).resolves.toBe('cloud-only-unsupported')
    await expect(authority.assertAdmissionAllowed()).rejects.toThrow(/cloud-only speech profile/)
  })

  it('keeps an original ASR lease bound to auth generation across sign-out and reauthentication', async () => {
    let current: SettingsObservation | null = null
    let generation = 12
    const authority = createImportJobAuthority({
      requireAuth: () => true,
      authGeneration: () => generation,
      readAuthority: async () => {
        const fresh = snapshot(settings(), 4)
        current = fresh
        return fresh
      },
      currentObservation: () => current
    })
    const lease = await authority.captureAsrAdmission()

    generation += 2

    expect(() => lease.assertCurrent()).toThrow(/policy could not be verified/)
  })
})
