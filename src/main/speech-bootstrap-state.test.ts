import { describe, expect, it, vi } from 'vitest'
import type { Settings } from '@shared/ipc'
import { DEFAULT_BROKER_SPEECH_SETTINGS } from '@shared/broker-speech-settings'
import type { ManagedSpeechPolicyRead } from './managed-speech-providers'
import {
  createSpeechBootstrapState,
  type SpeechBootstrapBoundaryRead,
  type SpeechSettingsObservation
} from './speech-bootstrap-state'

const NOW = 1_900_000_000_000
const DEVICE_ID = 'cached-device-id'
const OPERATOR_URL = 'https://operator.example'
const OPERATOR_LICENSE_TOKEN = 'METIS-OP-1.0123456789abcdef.1899999999.1900003600.AAAAAAAAAAAAAAAAAAAA'

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    operatorUrl: OPERATOR_URL,
    operatorLicenseToken: OPERATOR_LICENSE_TOKEN,
    audioSource: 'mic',
    brokerSpeech: DEFAULT_BROKER_SPEECH_SETTINGS,
    operatorIngestSecret: 'legacy-ingest-secret-must-not-enter-speech-projection',
    usageStats: { askCount: 0 },
    ...overrides
  } as Settings
}

function observation(overrides: Partial<SpeechSettingsObservation> = {}): SpeechSettingsObservation {
  return {
    settings: settings(),
    readable: true,
    epoch: 1,
    authConfigurationRevision: 'auth-config-hash-a',
    policyPathsRevision: 'policy-paths-a',
    ...overrides
  }
}

const managedPolicy: ManagedSpeechPolicyRead = {
  state: 'valid',
  providers: { state: 'valid', providers: ['deepgram-nova3', 'cloudflare-nova3'] },
  egressAllowlist: ['operator.example']
}

function boundary(overrides: Partial<SpeechBootstrapBoundaryRead> = {}): SpeechBootstrapBoundaryRead {
  return {
    observation: observation(),
    durableDeviceId: DEVICE_ID,
    managedPolicy,
    screenDiagnosisState: 'unknown',
    ...overrides
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('speech bootstrap metadata cache', () => {
  it('publishes only current boundary data and exposes a narrow policy identity source', async () => {
    const readBoundary = vi.fn(async () => boundary())
    const state = createSpeechBootstrapState({ readBoundary, now: () => NOW })
    state.observeSettings(observation())

    await state.refresh('startup')

    expect(state.readState()).toMatchObject({
      metadataReady: true,
      settings: {
        operatorUrl: OPERATOR_URL,
        operatorLicenseToken: OPERATOR_LICENSE_TOKEN,
        audioSource: 'mic'
      },
      managedProviders: { state: 'valid', providers: ['deepgram-nova3', 'cloudflare-nova3'] },
      egressAllowlist: ['operator.example'],
      screenDiagnosisState: 'unknown'
    })
    expect(JSON.stringify(state.readState())).not.toContain('legacy-ingest-secret-must-not-enter-speech-projection')
    expect(state.readPolicyIdentity()).toEqual({
      settings: { operatorUrl: OPERATOR_URL, operatorLicenseToken: OPERATOR_LICENSE_TOKEN },
      durableDeviceId: DEVICE_ID
    })
    state.dispose()
  })

  it('does not let an older delayed read republish credentials after a semantic settings change', async () => {
    const oldRead = deferred<SpeechBootstrapBoundaryRead>()
    const readBoundary = vi
      .fn<() => Promise<SpeechBootstrapBoundaryRead>>()
      .mockReturnValueOnce(oldRead.promise)
      .mockResolvedValueOnce(
        boundary({
          observation: observation({
            settings: settings({ audioSource: 'system' }),
            epoch: 2
          })
        })
      )
    const state = createSpeechBootstrapState({ readBoundary, now: () => NOW })
    state.observeSettings(observation())

    const staleRefresh = state.refresh('old-boundary')
    state.observeSettings(observation({ settings: settings({ audioSource: 'system' }), epoch: 2 }))
    oldRead.resolve(boundary())
    await staleRefresh
    expect(state.readState().metadataReady).toBe(false)

    await state.refresh('new-boundary')
    expect(state.readState()).toMatchObject({ metadataReady: true, settings: { audioSource: 'system' } })
    expect(readBoundary).toHaveBeenCalledTimes(2)
    state.dispose()
  })

  it('coalesces concurrent refresh requests into one read and at most one follow-up', async () => {
    const first = deferred<SpeechBootstrapBoundaryRead>()
    const readBoundary = vi
      .fn<() => Promise<SpeechBootstrapBoundaryRead>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(boundary())
    const state = createSpeechBootstrapState({ readBoundary, now: () => NOW })
    state.observeSettings(observation())

    const one = state.refresh('policy-a')
    const two = state.refresh('policy-b')
    expect(readBoundary).toHaveBeenCalledTimes(1)
    first.resolve(boundary())
    await Promise.all([one, two])
    expect(readBoundary).toHaveBeenCalledTimes(2)
    expect(state.readState().metadataReady).toBe(true)
    state.dispose()
  })

  it('does not refresh age on read and closes at the exact metadata TTL boundary', async () => {
    let clock = NOW
    const state = createSpeechBootstrapState({ readBoundary: async () => boundary(), now: () => clock })
    state.observeSettings(observation())
    await state.refresh('startup')
    expect(state.readState().metadataReady).toBe(true)

    clock = NOW + 59_999
    expect(state.readState().metadataReady).toBe(true)
    clock = NOW + 60_000
    expect(state.readState()).toMatchObject({
      metadataReady: false,
      settings: null,
      managedProviders: { state: 'invalid' },
      egressAllowlist: []
    })
    expect(state.readPolicyIdentity()).toEqual({ settings: {}, durableDeviceId: null })
    state.dispose()
  })

  it('invalidates immediately on an unreadable profile, semantic authority change, or policy path change', async () => {
    const state = createSpeechBootstrapState({ readBoundary: async () => boundary(), now: () => NOW })
    state.observeSettings(observation())
    await state.refresh('startup')
    expect(state.readState().metadataReady).toBe(true)

    state.observeSettings(
      observation({
        settings: settings({ usageStats: { meetingsSummarized: 1, conversationMinutes: 0, firstMeetingAt: 0 } }),
        epoch: 2
      })
    )
    expect(state.readState().metadataReady).toBe(true)

    state.observeSettings(
      observation({ settings: settings({ operatorLicenseToken: `${OPERATOR_LICENSE_TOKEN}x` }), epoch: 3 })
    )
    expect(state.readState().metadataReady).toBe(false)
    await state.refresh('credential-change')
    expect(state.readState().metadataReady).toBe(true)

    state.observeSettings(observation({ authConfigurationRevision: 'auth-config-hash-b', epoch: 4 }))
    expect(state.readState().metadataReady).toBe(false)
    state.observeSettings(observation({ policyPathsRevision: 'policy-paths-b', epoch: 5 }))
    expect(state.readState().metadataReady).toBe(false)
    state.observeSettings(observation({ readable: false, epoch: 6 }))
    expect(state.readState().metadataReady).toBe(false)
    state.dispose()
  })

  it('fails closed on malformed MDM, absent durable identity, clock rollback, or read failure', async () => {
    let result = boundary({ managedPolicy: { state: 'invalid' } })
    const readBoundary = vi.fn(async () => result)
    let clock = NOW
    const state = createSpeechBootstrapState({ readBoundary, now: () => clock })
    state.observeSettings(observation())
    await state.refresh('bad-mdm')
    expect(state.readState()).toMatchObject({ metadataReady: false, managedProviders: { state: 'invalid' } })

    result = boundary({ durableDeviceId: null })
    await state.refresh('missing-device')
    expect(state.readPolicyIdentity()).toEqual({ settings: {}, durableDeviceId: null })

    result = boundary()
    await state.refresh('good')
    clock = NOW - 1
    expect(state.readState().metadataReady).toBe(false)
    clock = NOW
    readBoundary.mockRejectedValueOnce(new Error('boundary read failed'))
    await state.refresh('failed-boundary')
    expect(state.readState().metadataReady).toBe(false)
    state.dispose()
  })

  it('fails closed on an invalid cached egress value or a throwing clock', async () => {
    const malformedBoundary = boundary({
      managedPolicy: {
        state: 'valid',
        providers: { state: 'absent' },
        egressAllowlist: ['not a host']
      }
    })
    const state = createSpeechBootstrapState({ readBoundary: async () => malformedBoundary, now: () => NOW })
    state.observeSettings(observation())
    await state.refresh('malformed-egress')
    expect(state.readState()).toMatchObject({ metadataReady: false, egressAllowlist: [] })
    state.dispose()

    const throwingClock = createSpeechBootstrapState({
      readBoundary: async () => boundary(),
      now: () => {
        throw new Error('clock unavailable')
      }
    })
    throwingClock.observeSettings(observation())
    await throwingClock.refresh('clock-unavailable')
    expect(throwingClock.readState()).toMatchObject({ metadataReady: false, egressAllowlist: [] })
    throwingClock.dispose()
  })
})
