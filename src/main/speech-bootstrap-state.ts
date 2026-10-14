import { createHash } from 'node:crypto'
import type { Settings } from '@shared/ipc'
import { OPERATOR_LICENSE_MAX } from '@shared/operator-license'
import {
  BrokerSpeechSettingsSchema,
  BrokerSpeechSettingsRefusalSchema,
  type BrokerSpeechSettingsLoaded
} from '@shared/broker-speech-settings'
import type { ManagedSpeechProviders } from './speech-broker-policy'
import type { SpeechPolicyIdentitySource } from './speech-policy-authority'
import type { ManagedSpeechPolicyRead } from './managed-speech-providers'
import { normalizeHost } from './net/egress-policy'

const MAX_METADATA_AGE_MS = 60_000
const MAX_REVISION_LENGTH = 256
const MAX_OPERATOR_URL_LENGTH = 2_048
const MAX_DEVICE_ID_LENGTH = 512
const MAX_PROVIDER_COUNT = 4_096
const MAX_PROVIDER_ID_LENGTH = 128
const MAX_EGRESS_HOST_COUNT = 4_096
const MAX_EGRESS_HOST_LENGTH = 512

export type SpeechBootstrapSettings = Pick<Settings, 'operatorUrl' | 'operatorLicenseToken' | 'audioSource'> & {
  brokerSpeech: BrokerSpeechSettingsLoaded
}

export type SpeechSettingsObservation = {
  settings: Settings | null
  readable: boolean
  epoch: number
  /** Opaque hash/revision of auth configuration; never a cached signed-in boolean or raw secret. */
  authConfigurationRevision: string
  /** Opaque version of user/admin policy paths, retained only for publication CAS. */
  policyPathsRevision: string
}

export type SpeechBootstrapBoundaryRead = {
  observation: SpeechSettingsObservation
  durableDeviceId: string | null
  managedPolicy: ManagedSpeechPolicyRead
  screenDiagnosisState: string | null
}

export type SpeechBootstrapCachedState = {
  metadataReady: boolean
  generation: number
  settingsEpoch: number
  settings: SpeechBootstrapSettings | null
  durableDeviceId: string | null
  managedProviders: ManagedSpeechProviders
  egressAllowlist: readonly string[] | null
  screenDiagnosisState: string | null
}

export type SpeechBootstrapStateOptions = {
  /** Forced, bounded authority-boundary read. It must not return before all required inputs are read. */
  readBoundary: () => Promise<SpeechBootstrapBoundaryRead>
  now?: () => number
  /** Synchronous owner tombstone notification; never read or refresh settings from this callback. */
  onInvalidated?: (reason: string) => void
}

type ProjectedObservation = {
  settings: SpeechBootstrapSettings
  readable: boolean
  epoch: number
  authConfigurationRevision: string
  policyPathsRevision: string
  semanticRevision: string
}

type PublishedState = {
  observation: ProjectedObservation
  durableDeviceId: string
  managedProviders: Exclude<ManagedSpeechProviders, { state: 'invalid' }>
  egressAllowlist: readonly string[] | null
  screenDiagnosisState: string | null
  readStartedAt: number
  revocationGeneration: number
}

function revisionString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_REVISION_LENGTH
}

function projectSettings(settings: Settings | null): SpeechBootstrapSettings | null {
  if (!settings || typeof settings !== 'object') return null
  if (
    typeof settings.operatorUrl !== 'string' ||
    settings.operatorUrl.length > MAX_OPERATOR_URL_LENGTH ||
    typeof settings.operatorLicenseToken !== 'string' ||
    settings.operatorLicenseToken.length > OPERATOR_LICENSE_MAX ||
    !['mic', 'system', 'both'].includes(settings.audioSource)
  )
    return null
  const loaded = BrokerSpeechSettingsRefusalSchema.safeParse(settings.brokerSpeech)
  let brokerSpeech: BrokerSpeechSettingsLoaded
  if (loaded.success) {
    brokerSpeech = { ...loaded.data }
  } else {
    const parsedBroker = BrokerSpeechSettingsSchema.safeParse(settings.brokerSpeech)
    if (!parsedBroker.success) return null
    brokerSpeech = { ...parsedBroker.data }
  }
  return Object.freeze({
    operatorUrl: settings.operatorUrl,
    operatorLicenseToken: settings.operatorLicenseToken,
    audioSource: settings.audioSource,
    brokerSpeech: Object.freeze(brokerSpeech)
  })
}

function semanticRevision(
  settings: SpeechBootstrapSettings,
  authConfigurationRevision: string,
  policyPathsRevision: string
): string {
  const projection = JSON.stringify([
    settings.operatorUrl,
    settings.operatorLicenseToken,
    settings.audioSource,
    settings.brokerSpeech,
    authConfigurationRevision,
    policyPathsRevision
  ])
  return createHash('sha256').update(projection, 'utf8').digest('hex')
}

function projectObservation(value: SpeechSettingsObservation): ProjectedObservation | null {
  if (
    !value ||
    !Number.isSafeInteger(value.epoch) ||
    value.epoch < 0 ||
    !revisionString(value.authConfigurationRevision) ||
    !revisionString(value.policyPathsRevision)
  )
    return null
  const settings = projectSettings(value.settings)
  if (!settings) return null
  return {
    settings,
    readable: value.readable === true,
    epoch: value.epoch,
    authConfigurationRevision: value.authConfigurationRevision,
    policyPathsRevision: value.policyPathsRevision,
    semanticRevision: semanticRevision(settings, value.authConfigurationRevision, value.policyPathsRevision)
  }
}

function copyManagedProviders(
  value: Exclude<ManagedSpeechProviders, { state: 'invalid' }>
): Exclude<ManagedSpeechProviders, { state: 'invalid' }> | null {
  if (value.state === 'absent') return { state: 'absent' }
  if (
    !Array.isArray(value.providers) ||
    value.providers.length > MAX_PROVIDER_COUNT ||
    value.providers.some(
      (provider) => typeof provider !== 'string' || provider.length === 0 || provider.length > MAX_PROVIDER_ID_LENGTH
    )
  )
    return null
  return { state: 'valid', providers: Object.freeze([...new Set(value.providers)]) }
}

function copyEgressAllowlist(value: readonly string[] | null): readonly string[] | null | undefined {
  if (value === null) return null
  if (!Array.isArray(value) || value.length > MAX_EGRESS_HOST_COUNT) return undefined
  const hosts: string[] = []
  for (const candidate of value) {
    if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > MAX_EGRESS_HOST_LENGTH)
      return undefined
    const host = normalizeHost(candidate)
    if (!host) return undefined
    if (!hosts.includes(host)) hosts.push(host)
  }
  return Object.freeze(hosts)
}

function parseManagedPolicy(value: ManagedSpeechPolicyRead): {
  providers: Exclude<ManagedSpeechProviders, { state: 'invalid' }>
  egressAllowlist: readonly string[] | null
} | null {
  if (!value || (value.state !== 'valid' && value.state !== 'absent')) return null
  if (value.state === 'absent') return { providers: { state: 'absent' }, egressAllowlist: null }
  const providers = value.providers
  if (!providers || (providers.state !== 'absent' && providers.state !== 'valid')) return null
  const copiedProviders = copyManagedProviders(providers)
  if (!copiedProviders) return null
  const egressAllowlist = copyEgressAllowlist(value.egressAllowlist)
  if (egressAllowlist === undefined) return null
  return {
    providers: copiedProviders,
    egressAllowlist
  }
}

export function createSpeechBootstrapState(options: SpeechBootstrapStateOptions) {
  const now = options.now ?? Date.now
  let observed: ProjectedObservation | null = null
  let published: PublishedState | null = null
  let generation = 0
  let revocationGeneration = 0
  let disposed = false
  let inFlight: Promise<void> | null = null
  let followupRequested = false
  let revocationAcknowledged = true

  const safeNow = (): number | null => {
    try {
      const current = now()
      return Number.isSafeInteger(current) && current >= 0 ? current : null
    } catch {
      return null
    }
  }

  const invalidate = (reason: string): void => {
    if (disposed) return
    generation += 1
    revocationGeneration += 1
    published = null
    revocationAcknowledged = false
    try {
      options.onInvalidated?.(reason)
      revocationAcknowledged = true
    } catch {
      // A failed owner tombstone cannot be followed by fresh usable metadata.
    }
  }

  const observeSettings = (value: SpeechSettingsObservation): void => {
    if (disposed) return
    const next = projectObservation(value)
    if (!next || !next.readable) {
      observed = next
      invalidate('settings-unreadable')
      return
    }
    const semanticChanged = observed !== null && observed.semanticRevision !== next.semanticRevision
    if (semanticChanged) invalidate('settings-authority-changed')
    observed = next
    if (published && !semanticChanged && published.observation.semanticRevision === next.semanticRevision) {
      // A validated unrelated Settings edit advances the store epoch without revoking speech.
      published = { ...published, observation: next }
    }
  }

  const isFresh = (candidate: PublishedState, observedNow: ProjectedObservation | null): boolean => {
    if (
      disposed ||
      !observedNow ||
      !observedNow.readable ||
      candidate.revocationGeneration !== revocationGeneration ||
      candidate.observation.epoch !== observedNow.epoch ||
      candidate.observation.semanticRevision !== observedNow.semanticRevision
    )
      return false
    const current = safeNow()
    if (current === null || current < candidate.readStartedAt) return false
    return current - candidate.readStartedAt < MAX_METADATA_AGE_MS
  }

  const readState = (): SpeechBootstrapCachedState => {
    const current = published
    const ready = current !== null && isFresh(current, observed)
    const managedProviders = current ? copyManagedProviders(current.managedProviders) : null
    if (!ready || !current || !managedProviders) {
      return {
        metadataReady: false,
        generation,
        settingsEpoch: observed?.epoch ?? -1,
        settings: null,
        durableDeviceId: null,
        managedProviders: { state: 'invalid' },
        egressAllowlist: [],
        screenDiagnosisState: 'unknown'
      }
    }
    return {
      metadataReady: true,
      generation,
      settingsEpoch: current.observation.epoch,
      settings: current.observation.settings,
      durableDeviceId: current.durableDeviceId,
      managedProviders,
      egressAllowlist: current.egressAllowlist === null ? null : [...current.egressAllowlist],
      screenDiagnosisState: current.screenDiagnosisState
    }
  }

  const readPolicyIdentity = (): SpeechPolicyIdentitySource => {
    const current = readState()
    if (!current.metadataReady || !current.settings || !current.durableDeviceId)
      return { settings: {}, durableDeviceId: null }
    return {
      settings: {
        operatorUrl: current.settings.operatorUrl,
        operatorLicenseToken: current.settings.operatorLicenseToken
      },
      durableDeviceId: current.durableDeviceId
    }
  }

  const refreshOnce = async (): Promise<void> => {
    if (disposed) return
    const generationAtStart = generation
    const revocationAtStart = revocationGeneration
    const observationEpochAtStart = observed?.epoch ?? null
    const startedAt = safeNow()
    if (startedAt === null) {
      invalidate('clock-invalid')
      return
    }
    let boundary: SpeechBootstrapBoundaryRead
    try {
      boundary = await options.readBoundary()
    } catch {
      if (generation === generationAtStart && revocationGeneration === revocationAtStart)
        invalidate('boundary-read-failed')
      return
    }
    if (disposed || generation !== generationAtStart || revocationGeneration !== revocationAtStart) return
    const nextObservation = projectObservation(boundary.observation)
    if (!nextObservation || !nextObservation.readable) {
      invalidate('boundary-settings-invalid')
      return
    }
    if (
      (observationEpochAtStart !== null && boundary.observation.epoch < observationEpochAtStart) ||
      (observed && nextObservation.epoch < observed.epoch)
    ) {
      // A forced read that cannot publish must not leave an older policy proof usable at this boundary.
      invalidate('boundary-settings-stale')
      return
    }

    if (observed && observed.semanticRevision !== nextObservation.semanticRevision) {
      // A forced boundary read can discover a change before the store observer callback arrives.
      invalidate('boundary-authority-changed')
    }
    observed = nextObservation
    const managed = parseManagedPolicy(boundary.managedPolicy)
    if (
      !managed ||
      typeof boundary.durableDeviceId !== 'string' ||
      boundary.durableDeviceId.trim().length === 0 ||
      boundary.durableDeviceId.length > MAX_DEVICE_ID_LENGTH
    ) {
      invalidate('boundary-policy-invalid')
      return
    }
    const afterRead = safeNow()
    if (afterRead === null || afterRead < startedAt) {
      invalidate('clock-invalid')
      return
    }
    if (published) {
      const canonicalMetadata = (
        durableDeviceId: string,
        providers: Exclude<ManagedSpeechProviders, { state: 'invalid' }>,
        egressAllowlist: readonly string[] | null
      ): string =>
        JSON.stringify([
          durableDeviceId,
          providers.state === 'absent' ? null : [...providers.providers].sort(),
          egressAllowlist === null ? null : [...egressAllowlist].sort()
        ])
      const changed =
        canonicalMetadata(published.durableDeviceId, published.managedProviders, published.egressAllowlist) !==
        canonicalMetadata(boundary.durableDeviceId, managed.providers, managed.egressAllowlist)
      const screenRevoked = published.screenDiagnosisState === 'granted' && boundary.screenDiagnosisState !== 'granted'
      if (changed || screenRevoked) invalidate('boundary-authority-changed')
    }
    if (!revocationAcknowledged) return
    published = {
      observation: nextObservation,
      durableDeviceId: boundary.durableDeviceId,
      managedProviders: managed.providers,
      egressAllowlist: managed.egressAllowlist,
      screenDiagnosisState: typeof boundary.screenDiagnosisState === 'string' ? boundary.screenDiagnosisState : null,
      readStartedAt: startedAt,
      revocationGeneration
    }
  }

  const refresh = (_reason: string): Promise<void> => {
    if (disposed) return Promise.resolve()
    if (inFlight) {
      followupRequested = true
      return inFlight
    }
    inFlight = (async () => {
      for (let pass = 0; pass < 2; pass += 1) {
        followupRequested = false
        await refreshOnce()
        if (!followupRequested || disposed) break
      }
    })().finally(() => {
      inFlight = null
      followupRequested = false
    })
    return inFlight
  }

  const dispose = (): void => {
    if (disposed) return
    invalidate('disposed')
    disposed = true
    observed = null
    published = null
  }

  return { observeSettings, refresh, invalidate, readState, readPolicyIdentity, dispose }
}
