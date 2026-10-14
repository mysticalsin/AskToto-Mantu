import { createHash } from 'node:crypto'
import type { SpeechPolicyIdentitySource } from './speech-policy-authority'
import { createSpeechBootstrapState, type SpeechSettingsObservation } from './speech-bootstrap-state'
import { createSpeechDesktopRuntime, type SpeechDesktopRuntimeOptions } from './speech-desktop-runtime'
import type { ManagedSpeechPolicyRead } from './managed-speech-providers'
import type { SettingsObservation } from './settings-observation'
import type { QuitTrace } from './lifecycle/quit-trace'

type BoundaryMetadata = {
  durableDeviceId: string | null
  managedPolicy: ManagedSpeechPolicyRead
  screenDiagnosisState: string | null
}

export type SpeechDesktopBootstrapOptions = Omit<SpeechDesktopRuntimeOptions, 'readState' | 'prepareAuthority'> & {
  observeSettings: (listener: (observation: SettingsObservation) => void) => () => void
  readSettingsAtBoundary: () => Promise<unknown> | unknown
  readSettingsEpoch: () => number
  readBoundaryMetadata: () => Promise<BoundaryMetadata>
  readPolicyPathsRevision: () => string
  installPolicyIdentityReader: (reader: (() => SpeechPolicyIdentitySource) | null) => void
  invalidatePolicyProof: () => void
  observePolicyRevocations: (listener: (() => void) | null) => void
  refreshVerifiedPolicy: () => Promise<void>
  prepareAuthentication: () => Promise<void>
  observeAuthenticationSettings: (observation: SettingsObservation, policyPathsRevision: string) => void
  observeAuthenticationRevocations: (listener: () => void) => () => void
  releaseAuthentication: () => void
  quitTrace?: QuitTrace
}

/** Registers the real desktop runtime while keeping repeated authority checks on memory snapshots. */
export function startSpeechDesktopBootstrap(options: SpeechDesktopBootstrapOptions) {
  let latest: SettingsObservation | null = null
  let disposed = false
  let queued = false
  let runtime: ReturnType<typeof createSpeechDesktopRuntime> | null = null
  let readingSettingsBoundary = false
  const retireCapture = (): void => {
    runtime?.invalidateCurrent()
    options.grants.invalidateAll()
  }
  const project = (observation: SettingsObservation): SpeechSettingsObservation => ({
    ...observation,
    // Auth owns effective Azure configuration and its revocation epoch.
    authConfigurationRevision: 'auth-owned-lease-v1',
    policyPathsRevision: createHash('sha256').update(options.readPolicyPathsRevision()).digest('hex')
  })

  const state = createSpeechBootstrapState({
    now: options.now,
    onInvalidated: () => {
      options.invalidatePolicyProof()
      retireCapture()
    },
    readBoundary: async () => {
      readingSettingsBoundary = true
      try {
        await options.prepareAuthentication()
        await options.readSettingsAtBoundary()
        const observation = latest
        if (!observation || observation.epoch !== options.readSettingsEpoch())
          throw new Error('Speech settings boundary is unavailable')
        const metadata = await options.readBoundaryMetadata()
        return { observation: project(observation), ...metadata }
      } finally {
        readingSettingsBoundary = false
      }
    }
  })

  const refresh = async (reason: string): Promise<void> => {
    if (disposed) return
    const before = state.readState().generation
    await state.refresh(reason)
    // A newly discovered Settings change retires the first read. Re-read once without an unbounded queue.
    if (!disposed && latest?.readable && !state.readState().metadataReady && state.readState().generation !== before)
      await state.refresh('boundary-follow-up')
  }
  const scheduleRefresh = (): void => {
    if (queued || disposed) return
    queued = true
    queueMicrotask(() => {
      queued = false
      void refresh('settings-change')
    })
  }
  const unsubscribe = options.observeSettings((observation) => {
    latest = observation
    options.observeAuthenticationSettings(observation, options.readPolicyPathsRevision())
    const before = state.readState().generation
    state.observeSettings(project(observation))
    if (state.readState().generation !== before) {
      if (!readingSettingsBoundary) scheduleRefresh()
    }
  })
  const unsubscribeAuthentication = options.observeAuthenticationRevocations(() => {
    state.invalidate('authentication-revocation')
  })

  options.installPolicyIdentityReader(() => ({
    // Legacy ingest-only policy refresh retains its own credential. New speech resolves only a seat license.
    settings: latest?.readable
      ? {
          operatorUrl: latest.settings.operatorUrl,
          operatorLicenseToken: latest.settings.operatorLicenseToken,
          operatorIngestSecret: latest.settings.operatorIngestSecret
        }
      : {},
    durableDeviceId: latest?.epoch === options.readSettingsEpoch() ? state.readPolicyIdentity().durableDeviceId : null
  }))
  options.observePolicyRevocations(retireCapture)

  runtime = createSpeechDesktopRuntime({
    ...options,
    prepareAuthority: async () => {
      await refresh('ipc-authority-boundary')
      if (!disposed && state.readState().metadataReady && options.requireAuth()) await options.refreshVerifiedPolicy()
    },
    readState: () => {
      const cached = state.readState()
      const current = latest?.readable && latest.epoch === options.readSettingsEpoch()
      return {
        ...cached,
        metadataReady: cached.metadataReady && !!current && cached.settingsEpoch === latest?.epoch,
        settings: current && cached.settingsEpoch === latest?.epoch ? cached.settings : null
      }
    }
  })

  const invalidate = (reason: string): void => {
    state.invalidate(reason)
  }
  const dispose = async (): Promise<void> => {
    if (disposed) return
    options.quitTrace?.mark('SPEECH_DISPOSE_START')
    options.quitTrace?.mark(runtime?.registration.ownerCount() ? 'SPEECH_OWNERS_PRESENT' : 'SPEECH_OWNERS_NONE')
    disposed = true
    unsubscribe()
    unsubscribeAuthentication()
    options.releaseAuthentication()
    options.observePolicyRevocations(null)
    options.installPolicyIdentityReader(null)
    state.dispose()
    await runtime?.dispose()
  }
  const prime = refresh('bootstrap')
  return { runtime, refresh, invalidate, dispose, prime }
}
