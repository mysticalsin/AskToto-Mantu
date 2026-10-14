import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type Settings } from '@shared/ipc'
import type { SpeechDesktopRuntimeOptions } from './speech-desktop-runtime'
import type { SpeechPolicyIdentityReader } from './speech-policy-authority'
import { SpeechCaptureGrantRegistry } from './capture-permissions/speech-capture-grant'
import { startSpeechDesktopBootstrap } from './speech-desktop-bootstrap'
import type { SettingsObservation } from './settings-observation'

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
    managedPolicy: { state: 'absent' as const },
    screenDiagnosisState: 'granted'
  }))
  const readSettings = vi.fn(() => {
    if (epoch === 0) publish(settings)
    else listener?.({ settings, readable: true, epoch })
    return settings
  })
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
    }
  })
  return { bootstrap, metadata, readSettings, publish, settings: () => settings, identity: () => identityReader?.() }
}

describe('actual speech bootstrap composition', () => {
  it('keeps repeated runtime checks on memory and preserves legacy ingest policy identity', async () => {
    const f = fixture()
    try {
      await f.bootstrap.prime
      expect(desktop.options?.readState().metadataReady).toBe(true)
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
      f.bootstrap.dispose()
    }
    expect(f.identity()).toBeUndefined()
  })

  it('immediately closes unreadable observations and credential ABA during a suspended boundary', async () => {
    const f = fixture()
    try {
      await f.bootstrap.prime
      let release: ((value: Awaited<ReturnType<typeof f.metadata>>) => void) | null = null
      f.metadata.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve
          })
      )
      const refresh = f.bootstrap.refresh('synthetic-held-boundary')
      const original = f.settings()
      f.publish({ ...original, operatorLicenseToken: 'synthetic-credential-change' })
      f.publish(original)
      expect(desktop.options?.readState().metadataReady).toBe(false)
      f.publish(original, false)
      expect(f.identity()?.durableDeviceId).toBeNull()
      release?.({
        durableDeviceId: 'synthetic-persisted-device',
        managedPolicy: { state: 'absent' },
        screenDiagnosisState: 'granted'
      })
      await refresh
      // The forced boundary may recover readable settings, but the retired first read cannot publish its stale authority.
      expect(desktop.invalidate).toHaveBeenCalled()
    } finally {
      f.bootstrap.dispose()
    }
  })
})
