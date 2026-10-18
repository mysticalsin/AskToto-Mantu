import { ModelPolicyDocumentSchema, type ModelPolicyDocument, type ModelPolicyEntry } from '../shared/model-policy'
import { parseBrokerSpeechSettings, type BrokerSpeechSettings } from '../shared/broker-speech-settings'
import type { SpeechCapability } from './cloud-stt/broker-client'

// Broker authority consumes the known top-level fields of the verified v1 snapshot.
const BrokerModelPolicyDocumentSchema = ModelPolicyDocumentSchema.strict()

export const SPEECH_POLICY_MAX_AGE_MS = 60_000

export type VerifiedSpeechPolicySnapshot = {
  origin: string
  credentialDigest: string
  deviceIdHash: string
  verifiedAt: number
  revision: string
  policy: ModelPolicyDocument
}

export type SpeechPolicyIdentity = Pick<VerifiedSpeechPolicySnapshot, 'origin' | 'credentialDigest' | 'deviceIdHash'>

export type ManagedSpeechProviders =
  | { state: 'absent' }
  | { state: 'invalid' }
  | { state: 'valid'; providers: readonly string[] }

export type SpeechBrokerPair = {
  routeId: 'deepgram-via-gateway' | 'workers-ai-nova3'
  modelId: 'nova-3' | '@cf/deepgram/nova-3'
}

export type SpeechBrokerAuthorityPair = SpeechBrokerPair & {
  engine: Exclude<BrokerSpeechSettings['engine'], 'unconfigured'>
}

export type SpeechBrokerPolicyRefusalCode =
  | 'PROFILE_INVALID'
  | 'LEGACY_TRANSPORT'
  | 'ENGINE_UNCONFIGURED'
  | 'POLICY_UNAVAILABLE'
  | 'POLICY_IDENTITY'
  | 'POLICY_STALE'
  | 'POLICY_INVALID'
  | 'PROVIDER_POLICY_INVALID'
  | 'PROVIDER_DENIED'
  | 'STT_NOT_ALLOWED'
  | 'CAPABILITY_UNREADY'
  | 'CAPABILITY_SELECTION'
  | 'LANGUAGE_UNAVAILABLE'

export type SpeechBrokerAuthorityRefusalCode = Exclude<
  SpeechBrokerPolicyRefusalCode,
  'CAPABILITY_UNREADY' | 'CAPABILITY_SELECTION' | 'LANGUAGE_UNAVAILABLE'
>

export type SpeechBrokerPolicyResolution =
  | { ok: false; code: SpeechBrokerPolicyRefusalCode }
  | {
      ok: true
      engine: Exclude<BrokerSpeechSettings['engine'], 'unconfigured'>
      selected: SpeechBrokerPair & { language: string }
      allowed: SpeechBrokerPair[]
    }

type BrokerSelection = {
  engine: Exclude<BrokerSpeechSettings['engine'], 'unconfigured'>
  provider: 'deepgram-nova3' | 'cloudflare-nova3'
  model: 'nova-3' | '@cf/deepgram/nova-3'
  routeId: SpeechBrokerPair['routeId']
}

const BROKER_SELECTIONS: Record<BrokerSelection['engine'], BrokerSelection> = {
  'deepgram-nova3': {
    engine: 'deepgram-nova3',
    provider: 'deepgram-nova3',
    model: 'nova-3',
    routeId: 'deepgram-via-gateway'
  },
  'cloudflare-nova3': {
    engine: 'cloudflare-nova3',
    provider: 'cloudflare-nova3',
    model: '@cf/deepgram/nova-3',
    routeId: 'workers-ai-nova3'
  }
}

export type SpeechBrokerAuthorityResolution =
  | { ok: false; code: SpeechBrokerAuthorityRefusalCode }
  | {
      ok: true
      engine: Exclude<BrokerSpeechSettings['engine'], 'unconfigured'>
      selected: SpeechBrokerAuthorityPair
      allowed: SpeechBrokerAuthorityPair[]
    }

export interface ResolveSpeechBrokerAuthorityOptions {
  profile: unknown
  snapshot: VerifiedSpeechPolicySnapshot | null
  currentIdentity: SpeechPolicyIdentity
  managedProviders: ManagedSpeechProviders
  now?: number
}

export interface ResolveSpeechBrokerPolicyOptions extends ResolveSpeechBrokerAuthorityOptions {
  capability: SpeechCapability
  language: string
}

function isCurrentHttpsOrigin(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return false
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' && parsed.origin === value && parsed.username === '' && parsed.password === ''
  } catch {
    return false
  }
}

function identityMatches(snapshot: VerifiedSpeechPolicySnapshot, current: SpeechPolicyIdentity): boolean {
  if (!current || typeof current !== 'object') return false
  return (
    isCurrentHttpsOrigin(snapshot.origin) &&
    isCurrentHttpsOrigin(current.origin) &&
    snapshot.origin === current.origin &&
    /^[a-f0-9]{64}$/.test(snapshot.credentialDigest) &&
    /^[a-f0-9]{64}$/.test(current.credentialDigest) &&
    snapshot.credentialDigest === current.credentialDigest &&
    /^[a-f0-9]{32}$/.test(snapshot.deviceIdHash) &&
    /^[a-f0-9]{32}$/.test(current.deviceIdHash) &&
    snapshot.deviceIdHash === current.deviceIdHash
  )
}

function containsPair(entry: ModelPolicyEntry, selection: BrokerSelection): boolean {
  return (
    (entry.provider === selection.provider && entry.model === selection.model) ||
    entry.fallbacks.some((item) => item.provider === selection.provider && item.model === selection.model)
  )
}

function isPairAllowed(pairs: readonly SpeechBrokerPair[], pair: SpeechBrokerPair): boolean {
  return pairs.some((candidate) => candidate.routeId === pair.routeId && candidate.modelId === pair.modelId)
}

export function resolveSpeechBrokerAuthority(
  options: ResolveSpeechBrokerAuthorityOptions
): SpeechBrokerAuthorityResolution {
  const parsedProfile = parseBrokerSpeechSettings(options.profile)
  if (!parsedProfile.ok) return { ok: false, code: 'PROFILE_INVALID' }
  if (parsedProfile.value.transport !== 'broker-v1') return { ok: false, code: 'LEGACY_TRANSPORT' }
  if (parsedProfile.value.engine === 'unconfigured') return { ok: false, code: 'ENGINE_UNCONFIGURED' }

  const snapshot = options.snapshot
  if (!snapshot) return { ok: false, code: 'POLICY_UNAVAILABLE' }
  if (!identityMatches(snapshot, options.currentIdentity)) return { ok: false, code: 'POLICY_IDENTITY' }
  const now = options.now ?? Date.now()
  if (!Number.isSafeInteger(now) || now < snapshot.verifiedAt || now - snapshot.verifiedAt > SPEECH_POLICY_MAX_AGE_MS)
    return { ok: false, code: 'POLICY_STALE' }
  if (
    !Number.isSafeInteger(snapshot.verifiedAt) ||
    snapshot.verifiedAt <= 0 ||
    typeof snapshot.revision !== 'string' ||
    snapshot.revision.length === 0 ||
    snapshot.revision.length > 512
  )
    return { ok: false, code: 'POLICY_INVALID' }
  const parsedPolicy = BrokerModelPolicyDocumentSchema.safeParse(snapshot.policy)
  if (!parsedPolicy.success) return { ok: false, code: 'POLICY_INVALID' }

  if (
    !options.managedProviders ||
    (options.managedProviders.state !== 'absent' &&
      options.managedProviders.state !== 'invalid' &&
      options.managedProviders.state !== 'valid')
  )
    return { ok: false, code: 'PROVIDER_POLICY_INVALID' }
  if (options.managedProviders.state === 'invalid') return { ok: false, code: 'PROVIDER_POLICY_INVALID' }
  if (
    options.managedProviders.state === 'valid' &&
    (!Array.isArray(options.managedProviders.providers) ||
      options.managedProviders.providers.some((provider) => typeof provider !== 'string'))
  )
    return { ok: false, code: 'PROVIDER_POLICY_INVALID' }

  const selectedEngine = parsedProfile.value.engine
  const selection = BROKER_SELECTIONS[selectedEngine]
  if (!containsPair(parsedPolicy.data.capabilities.stt, selection)) return { ok: false, code: 'STT_NOT_ALLOWED' }
  if (options.managedProviders.state === 'valid' && !options.managedProviders.providers.includes(selection.provider))
    return { ok: false, code: 'PROVIDER_DENIED' }

  const policyPairs: SpeechBrokerAuthorityPair[] = []
  const entry = parsedPolicy.data.capabilities.stt
  for (const candidate of [entry, ...entry.fallbacks]) {
    const engine = Object.values(BROKER_SELECTIONS).find(
      (item) => item.provider === candidate.provider && item.model === candidate.model
    )
    if (!engine) continue
    if (options.managedProviders.state === 'valid' && !options.managedProviders.providers.includes(engine.provider))
      continue
    const pair = { engine: engine.engine, routeId: engine.routeId, modelId: engine.model }
    if (
      !policyPairs.some(
        (item) => item.engine === pair.engine && item.routeId === pair.routeId && item.modelId === pair.modelId
      )
    )
      policyPairs.push(pair)
  }
  const selected = { engine: selection.engine, routeId: selection.routeId, modelId: selection.model }
  if (
    !policyPairs.some(
      (item) =>
        item.engine === selected.engine && item.routeId === selected.routeId && item.modelId === selected.modelId
    )
  )
    return { ok: false, code: 'STT_NOT_ALLOWED' }

  return { ok: true, engine: selectedEngine, selected, allowed: policyPairs }
}

export function resolveSpeechBrokerPolicy(options: ResolveSpeechBrokerPolicyOptions): SpeechBrokerPolicyResolution {
  const authority = resolveSpeechBrokerAuthority(options)
  if (!authority.ok) return authority

  const now = options.now ?? Date.now()
  const capability = options.capability
  if (
    !capability?.ready ||
    !capability.selected ||
    !Array.isArray(capability.allowed) ||
    !capability.allowed.every(
      (pair) =>
        pair !== null &&
        typeof pair === 'object' &&
        typeof pair.routeId === 'string' &&
        typeof pair.modelId === 'string'
    ) ||
    !Array.isArray(capability.languages) ||
    !capability.languages.every((language) => typeof language === 'string')
  )
    return { ok: false, code: 'CAPABILITY_UNREADY' }
  if (
    capability.routeId !== authority.selected.routeId ||
    capability.modelId !== authority.selected.modelId ||
    capability.selected.routeId !== authority.selected.routeId ||
    capability.selected.modelId !== authority.selected.modelId ||
    !capability.allowed.some(
      (pair) => pair.routeId === authority.selected.routeId && pair.modelId === authority.selected.modelId
    ) ||
    !Number.isSafeInteger(capability.validUntil) ||
    capability.validUntil <= now
  )
    return { ok: false, code: 'CAPABILITY_SELECTION' }
  if (
    typeof options.language !== 'string' ||
    !/^(?:multi|[a-z]{2}(?:-[A-Z]{2})?)$/.test(options.language) ||
    !capability.languages.includes(options.language)
  )
    return { ok: false, code: 'LANGUAGE_UNAVAILABLE' }

  const selectedPair = { routeId: authority.selected.routeId, modelId: authority.selected.modelId }
  const allowed = authority.allowed
    .filter((pair) => isPairAllowed(capability.allowed, pair))
    .map(({ routeId, modelId }) => ({ routeId, modelId }))
  if (!isPairAllowed(allowed, selectedPair)) return { ok: false, code: 'CAPABILITY_SELECTION' }

  return {
    ok: true,
    engine: authority.engine,
    selected: { ...selectedPair, language: options.language },
    allowed
  }
}
