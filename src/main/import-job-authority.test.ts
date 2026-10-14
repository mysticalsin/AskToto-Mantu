import { describe, expect, it } from 'vitest'
import type { Settings } from '@shared/ipc'
import type { SettingsObservation, SettingsPolicyAuthoritySnapshot } from './settings-observation'
import { resolveEnterpriseLiveProfile } from '@shared/enterprise-live-profile'
import { createImportJobAuthority } from './import-job-authority'

function settings(summaryOnly = false, cloudOnly = false): Settings {
  return {
    enterpriseLive: cloudOnly
      ? { managed: true, inferenceMode: 'cloud-only', summaryOnly }
      : summaryOnly
        ? { managed: true, inferenceMode: 'legacy', summaryOnly: true }
        : { managed: false, inferenceMode: 'legacy', summaryOnly: false },
    meetingsFolder: '/meetings-a',
    encryptTranscripts: false,
    asrEngine: 'whisper',
    asrLanguage: 'auto'
  } as Settings
}

const authorityReceipt = Object.freeze({})

function snapshot(
  value: Settings,
  epoch: number,
  readable = true,
  receipt: object | null = authorityReceipt
): SettingsPolicyAuthoritySnapshot & { history: { import: object | null; persistence?: object | null } } {
  return {
    settings: value,
    readable,
    epoch,
    allowedProviders: null,
    localSpeechPack: null,
    lockedKeys: [],
    history: { import: receipt }
  }
}

function testAuthorityReceipt() {
  return {
    captureAuthorityReceipt: () => authorityReceipt,
    isAuthorityReceiptCurrent: (receipt: object) => receipt === authorityReceipt
  }
}

describe('import job authority boundary', () => {
  it('keeps an operation current across verified equivalent fresh Settings publications', async () => {
    let current: SettingsObservation | null = null
    let epoch = 1
    let reads = 0
    const value = settings()
    current = snapshot(value, epoch)
    const authority = createImportJobAuthority({
      requireAuth: () => true,
      authGeneration: () => 4,
      readAuthority: async () => {
        reads += 1
        const fresh = {
          ...snapshot({ ...value }, ++epoch),
          allowedProviders: reads % 2 ? ['cloud', 'whisper'] : ['whisper', 'cloud'],
          lockedKeys: ['meetingsFolder', reads % 2 ? 'unrelatedA' : 'unrelatedB']
        }
        current = fresh
        return fresh
      },
      currentObservation: () => current,
      ...testAuthorityReceipt()
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
      currentObservation: () => current,
      ...testAuthorityReceipt()
    })

    const captured = authority.captureOperation()
    await readStarted
    generation += 1
    releaseRead?.()
    await expect(captured).rejects.toThrow(/policy could not be verified/)
  })

  it('rejects a settings A to B to A transition while the initial authority refresh is queued', async () => {
    let receipt: object = Object.freeze({ generation: 1 })
    let current: SettingsObservation | null = snapshot(settings(), 1, true, receipt)
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
        const fresh = snapshot(settings(), 3, true, receipt)
        current = fresh
        return fresh
      },
      currentObservation: () => current,
      captureAuthorityReceipt: () => receipt,
      isAuthorityReceiptCurrent: (candidate) => candidate === receipt
    })

    const captured = authority.captureOperation()
    await readStarted
    receipt = Object.freeze({ generation: 2 })
    current = snapshot(settings(true), 2, true, receipt)
    receipt = Object.freeze({ generation: 3 })
    current = snapshot(settings(), 3, true, receipt)
    releaseRead?.()
    await expect(captured).rejects.toThrow(/policy could not be verified/)
  })

  it('never revives an operation across a completed semantic A to B to A before a generic refresh', async () => {
    let receipt: object = Object.freeze({ generation: 1 })
    let current: SettingsObservation | null = snapshot(settings(), 1, true, receipt)
    let epoch = 1
    const authority = createImportJobAuthority({
      requireAuth: () => true,
      authGeneration: () => 2,
      readAuthority: async () => {
        const fresh = snapshot(settings(), ++epoch, true, receipt)
        current = fresh
        return fresh
      },
      currentObservation: () => current,
      captureAuthorityReceipt: () => receipt,
      isAuthorityReceiptCurrent: (candidate) => candidate === receipt
    })
    const operation = await authority.captureOperation()
    const firstReceipt = receipt
    receipt = Object.freeze({ generation: 2 })
    current = snapshot(settings(true), ++epoch, true, receipt)
    receipt = Object.freeze({ generation: 3 })
    current = snapshot(settings(), ++epoch, true, receipt)

    await authority.assertAdmissionAllowed()
    expect(receipt).not.toBe(firstReceipt)
    expect(() => operation.assertCurrent()).toThrow(/policy could not be verified/)
    await authority.assertAdmissionAllowed()
    expect(() => operation.assertCurrent()).toThrow(/policy could not be verified/)
  })

  it('keeps a refused operation retired after its settings are restored and authority is refreshed', async () => {
    let receipt: object = Object.freeze({ generation: 1 })
    let current: SettingsObservation | null = snapshot(settings(), 1, true, receipt)
    let epoch = 1
    const authority = createImportJobAuthority({
      requireAuth: () => true,
      authGeneration: () => 2,
      readAuthority: async () => {
        const fresh = snapshot(settings(), ++epoch, true, receipt)
        current = fresh
        return fresh
      },
      currentObservation: () => current,
      captureAuthorityReceipt: () => receipt,
      isAuthorityReceiptCurrent: (candidate) => candidate === receipt
    })
    const operation = await authority.captureOperation()
    receipt = Object.freeze({ generation: 2 })
    current = snapshot(settings(true), ++epoch, true, receipt)
    expect(() => operation.assertCurrent()).toThrow(/policy could not be verified/)

    receipt = Object.freeze({ generation: 3 })
    current = snapshot(settings(), ++epoch, true, receipt)
    await authority.assertAdmissionAllowed()
    expect(() => operation.assertCurrent()).toThrow(/policy could not be verified/)
  })

  it('allows multiple queued equivalent settings refreshes without rejecting the captured scope', async () => {
    let current: SettingsObservation | null = snapshot(settings(), 1)
    let epoch = 1
    const authority = createImportJobAuthority({
      requireAuth: () => true,
      authGeneration: () => 2,
      readAuthority: async () => {
        const fresh = snapshot(settings(), ++epoch)
        current = fresh
        return fresh
      },
      currentObservation: () => current,
      ...testAuthorityReceipt()
    })
    const operation = await authority.captureOperation()
    await Promise.all([authority.refreshSettings(), authority.refreshSettings(), authority.refreshSettings()])
    operation.assertCurrent()
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
      currentObservation: () => current,
      ...testAuthorityReceipt()
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
      currentObservation: () => current,
      ...testAuthorityReceipt()
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
    expect(resolveEnterpriseLiveProfile(settings(true))).toEqual({
      managed: true,
      inferenceMode: 'legacy',
      summaryOnly: true
    })
    expect(resolveEnterpriseLiveProfile(settings())).toEqual({
      managed: false,
      inferenceMode: 'legacy',
      summaryOnly: false
    })
    let current: SettingsObservation | null = null
    const authority = createImportJobAuthority({
      requireAuth: () => true,
      authGeneration: () => 0,
      readAuthority: async () => {
        const fresh = snapshot(settings(true), 1)
        current = fresh
        return fresh
      },
      currentObservation: () => current,
      ...testAuthorityReceipt()
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
      currentObservation: () => current,
      ...testAuthorityReceipt()
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

  it('keeps the original scope across equivalent settings publications during a held write', async () => {
    const original = settings()
    let epoch = 8
    const receipt = authorityReceipt
    let current: SettingsObservation | null = snapshot(original, epoch, true, receipt)
    const authority = createImportJobAuthority({
      requireAuth: () => true,
      authGeneration: () => 0,
      readAuthority: async () => {
        const fresh = snapshot(original, epoch, true, receipt)
        current = fresh
        return fresh
      },
      currentObservation: () => current,
      captureAuthorityReceipt: () => receipt,
      isAuthorityReceiptCurrent: (candidate) => candidate === receipt
    })
    await authority.refreshSettings()
    const prepare = authority.prepareReplacement(original)
    epoch += 2
    current = snapshot(original, epoch)

    const guard = await prepare()
    expect(typeof guard).toBe('function')
    if (typeof guard === 'function') guard()
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
      currentObservation: () => current,
      ...testAuthorityReceipt()
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
      currentObservation: () => current,
      ...testAuthorityReceipt()
    })
    const lease = await authority.captureAsrAdmission()

    generation += 2

    expect(() => lease.assertCurrent()).toThrow(/policy could not be verified/)
  })
})
