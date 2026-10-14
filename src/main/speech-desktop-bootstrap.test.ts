import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type Settings } from '@shared/ipc'
import type { SpeechDesktopRuntimeOptions } from './speech-desktop-runtime'
import type { SpeechPolicyIdentityReader } from './speech-policy-authority'
import { SpeechCaptureGrantRegistry } from './capture-permissions/speech-capture-grant'
import { startSpeechDesktopBootstrap } from './speech-desktop-bootstrap'
import type { SettingsObservation } from './settings-observation'
import type { ManagedSpeechPolicyRead } from './managed-speech-providers'

const desktop = vi.hoisted(() => ({ options: null as SpeechDesktopRuntimeOptions | null, invalidate: vi.fn() }))
vi.mock('./speech-desktop-runtime', () => ({
  createSpeechDesktopRuntime: (options: SpeechDesktopRuntimeOptions) => {
    desktop.options = options
    return { invalidateCurrent: desktop.invalidate, dispose: vi.fn(), closeInput: vi.fn(), shutdown: vi.fn() }
  }
}))

function fixture() {
  let settings: Settings = {
    ...DEFAULT_SETTINGS,
    operatorUrl: 'https://operator.test',
    operatorIngestSecret: 'synthetic-ingest'
  }
  let epoch = 0
  let listener: ((observation: SettingsObservation) => void) | null = null
  let identityReader: SpeechPolicyIdentityReader | null = null
  const publish = (next: Settings, readable = true) => {
    settings = next
    epoch += 1
    listener?.({ settings, readable, epoch })
  }
  const metadata = vi.fn(async () => ({
    durableDeviceId: 'synthetic-persisted-device',
    managedPolicy: { state: 'absent' } as ManagedSpeechPolicyRead,
    screenDiagnosisState: 'granted'
  }))
  const readSettings = vi.fn(() => {
    if (epoch === 0) publish(settings)
    else listener?.({ settings, readable: true, epoch })
    return settings
  })
  const authentication = vi.fn(async () => {})
  const verifiedPolicy = vi.fn(async () => {})
  let revokeAuthentication: (() => void) | null = null
  const bootstrap = startSpeechDesktopBootstrap({
    ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
    assertMainWindow: () => {},
    readListenContext: () => null,
    isListening: () => false,
    requireAuth: () => true,
    grants: new SpeechCaptureGrantRegistry(),
    platform: 'darwin',
    enabled: () => true,
    observeSettings: (next) => {
      listener = next
      return () => {
        listener = null
      }
    },
    readSettingsAtBoundary: readSettings,
    readSettingsEpoch: () => epoch,
    readBoundaryMetadata: metadata,
    readPolicyPathsRevision: () => 'synthetic-policy-paths-v1',
    installPolicyIdentityReader: (next) => {
      identityReader = next
    },
    invalidatePolicyProof: vi.fn(),
    observePolicyRevocations: vi.fn(),
    refreshVerifiedPolicy: verifiedPolicy,
    prepareAuthentication: authentication,
    observeAuthenticationSettings: vi.fn(),
    observeAuthenticationRevocations: (next) => {
      revokeAuthentication = next
      return () => {
        revokeAuthentication = null
      }
    },
    releaseAuthentication: vi.fn()
  })
  return {
    bootstrap,
    metadata,
    readSettings,
    authentication,
    verifiedPolicy,
    revokeAuthentication: () => revokeAuthentication?.(),
    publish,
    settings: () => settings,
    identity: () => identityReader?.()
  }
}

describe('actual speech bootstrap composition', () => {
  it('closes a discarded forced read when an unrelated edit races a newly denied managed policy', async () => {
    const f = fixture()
    try {
      await f.bootstrap.prime
      expect(desktop.options?.readState().metadataReady).toBe(true)
      let started!: () => void
      const metadataStarted = new Promise<void>((resolve) => { started = resolve })
      let release!: (value: Awaited<ReturnType<typeof f.metadata>>) => void
      const denied = { durableDeviceId: 'synthetic-persisted-device', managedPolicy: { state: 'invalid' as const }, screenDiagnosisState: 'granted' }
      f.metadata.mockResolvedValue(denied)
      f.metadata.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; started() }))
      const preparation = desktop.options!.prepareAuthority!({} as never)
      await metadataStarted
      f.publish({ ...f.settings(), overlayOpacity: 0.6 })
      release(denied)
      await preparation
      expect(desktop.options?.readState().metadataReady).toBe(false)
      expect(desktop.options?.readState().managedProviders).toEqual({ state: 'invalid' })
      expect(f.verifiedPolicy).not.toHaveBeenCalled()
      expect(f.identity()?.durableDeviceId).toBeNull()
    } finally {
      await f.bootstrap.dispose()
    }
  })
  it('prepares fresh authentication and metadata before signed policy at real IPC boundaries', async () => {
    const f = fixture()
    try {
      await f.bootstrap.prime
      const order: string[] = []
      f.authentication.mockImplementationOnce(async () => {
        order.push('authentication')
      })
      f.metadata.mockImplementationOnce(async () => {
        order.push('metadata')
        return {
          durableDeviceId: 'synthetic-persisted-device',
          managedPolicy: { state: 'absent' },
          screenDiagnosisState: 'granted'
        }
      })
      f.verifiedPolicy.mockImplementationOnce(async () => {
        order.push('signed-policy')
      })
      await desktop.options?.prepareAuthority?.({} as never)
      expect(order).toEqual(['authentication', 'metadata', 'signed-policy'])
      const boundaryReads = f.authentication.mock.calls.length
      for (let index = 0; index < 600; index += 1) desktop.options?.readState()
      expect(f.authentication).toHaveBeenCalledTimes(boundaryReads)
      f.revokeAuthentication()
      expect(desktop.options?.readState().metadataReady).toBe(false)
      expect(desktop.invalidate).toHaveBeenCalled()
    } finally {
      await f.bootstrap.dispose()
    }
  })
  it('keeps repeated cached-state reads on memory and preserves legacy ingest policy identity', async () => {
    const f = fixture()
    try {
      await f.bootstrap.prime
      expect(desktop.options?.readState().metadataReady).toBe(true)
      expect(desktop.options?.readState().settings).not.toHaveProperty('operatorIngestSecret')
      expect(desktop.options?.readState().settings).not.toHaveProperty('azureClientId')
      const settingsReads = f.readSettings.mock.calls.length
      const boundaryReads = f.metadata.mock.calls.length
      for (let i = 0; i < 600; i += 1) desktop.options?.readState()
      expect(f.readSettings).toHaveBeenCalledTimes(settingsReads)
      expect(f.metadata).toHaveBeenCalledTimes(boundaryReads)
      expect(f.identity()).toEqual({
        settings: {
          operatorUrl: 'https://operator.test',
          operatorLicenseToken: '',
          operatorIngestSecret: 'synthetic-ingest'
        },
        durableDeviceId: 'synthetic-persisted-device'
      })
      f.publish({ ...f.settings(), overlayOpacity: 0.6 })
      expect(desktop.options?.readState().metadataReady).toBe(true)
    } finally {
      await f.bootstrap.dispose()
    }
    expect(f.identity()).toBeUndefined()
  })

  it('immediately closes unreadable observations and credential ABA during a suspended boundary', async () => {
    const f = fixture()
    try {
      await f.bootstrap.prime
      const gate: { release?: (value: Awaited<ReturnType<typeof f.metadata>>) => void } = {}
      let started!: () => void
      const metadataStarted = new Promise<void>((resolve) => {
        started = resolve
      })
      f.metadata.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            gate.release = resolve
            started()
          })
      )
      const refresh = f.bootstrap.refresh('synthetic-held-boundary')
      await metadataStarted
      const original = f.settings()
      f.publish({ ...original, operatorLicenseToken: 'synthetic-credential-change' })
      f.publish(original)
      expect(desktop.options?.readState().metadataReady).toBe(false)
      f.publish(original, false)
      expect(f.identity()?.durableDeviceId).toBeNull()
      gate.release?.({
        durableDeviceId: 'synthetic-retired-device',
        managedPolicy: { state: 'absent' },
        screenDiagnosisState: 'granted'
      })
      await refresh
      expect(desktop.invalidate).toHaveBeenCalled()
      expect(desktop.options?.readState().durableDeviceId).toBeNull()
      expect(desktop.options?.readState().metadataReady).toBe(false)
      expect(desktop.options?.readState().durableDeviceId).not.toBe('synthetic-retired-device')
    } finally {
      await f.bootstrap.dispose()
    }
  })
})
