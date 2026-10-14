import { BaseSettingsSchema, type Settings } from '@shared/ipc'
import { LocalSpeechPackPolicySchema, type LocalSpeechPackPolicy } from '@shared/model-policy'

export type SettingsAuthorityDomain = 'import' | 'persistence'

declare const receiptBrand: unique symbol
export type SettingsAuthorityReceipt = Readonly<{ [receiptBrand]: true }>
export type SettingsAuthorityHistory = Readonly<{
  import: SettingsAuthorityReceipt | null
  persistence: SettingsAuthorityReceipt | null
}>

export type SelectedSettingsKey =
  | 'meetingsFolder'
  | 'encryptTranscripts'
  | 'enterpriseLive'
  | 'asrEngine'
  | 'asrLanguage'
  | 'azureClientId'
  | 'azureTenantId'
  | 'azureAllowedDomain'
export type ManagedAuthorityFields = Readonly<{
  settings: Readonly<Partial<Pick<Settings, SelectedSettingsKey>>>
  allowedProviders: readonly string[] | null
  localSpeechPack: Readonly<LocalSpeechPackPolicy> | null
  lockedKeys: readonly string[]
}>
export type ManagedAuthoritySourceObservation = Readonly<{
  source: 'user' | 'admin'
  sourceIdentity: string
}> &
  (Readonly<{ status: 'readable'; fields: ManagedAuthorityFields }> | Readonly<{ status: 'unreadable' }>)

type EffectiveImportPolicyObservation =
  | Readonly<{
      status: 'readable'
      sourceIdentity: string
      allowedProviders: readonly string[] | null
      localSpeechPack: Readonly<LocalSpeechPackPolicy> | null
    }>
  | Readonly<{ status: 'unreadable'; sourceIdentity: string }>

interface ReceiptRecord {
  readonly domain: SettingsAuthorityDomain
  readonly generation: bigint
}

interface DomainState {
  generation: bigint
  signature: string | null
  receipt: SettingsAuthorityReceipt | null
  available: boolean
  dirty: boolean
  readonly listeners: Set<() => void>
}

const receiptRecords = new WeakMap<object, ReceiptRecord>()
const domains: Record<SettingsAuthorityDomain, DomainState> = {
  import: { generation: 0n, signature: null, receipt: null, available: false, dirty: false, listeners: new Set() },
  persistence: {
    generation: 0n,
    signature: null,
    receipt: null,
    available: false,
    dirty: false,
    listeners: new Set()
  }
}
const sources = new Map<'user' | 'admin', ManagedAuthoritySourceObservation>()
let selectedSettings: Readonly<Partial<Pick<Settings, SelectedSettingsKey>>> | null = null
let settingsReadable = false
const settingsFrameCurrent: Record<SettingsAuthorityDomain, boolean> = { import: false, persistence: false }
let effectiveImportPolicy: EffectiveImportPolicyObservation | null = null
let dispatching = false

const SETTINGS_KEYS: readonly SelectedSettingsKey[] = [
  'meetingsFolder',
  'encryptTranscripts',
  'enterpriseLive',
  'asrEngine',
  'asrLanguage',
  'azureClientId',
  'azureTenantId',
  'azureAllowedDomain'
]
const PERSISTENCE_SETTINGS_KEYS: readonly SelectedSettingsKey[] = [
  'meetingsFolder',
  'encryptTranscripts',
  'enterpriseLive',
  'azureClientId',
  'azureTenantId',
  'azureAllowedDomain'
]
const PERSISTENCE_LOCK_KEYS = new Set<string>(PERSISTENCE_SETTINGS_KEYS)
const IMPORT_LOCK_KEYS = new Set<string>([...SETTINGS_KEYS, 'localSpeechPack', 'allowedProviders'])

function normalizedSettings(settings: Partial<Pick<Settings, SelectedSettingsKey>>): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null)
  for (const key of SETTINGS_KEYS) {
    const value = settings[key]
    if (key === 'enterpriseLive' && value && typeof value === 'object') {
      const live = value as Settings['enterpriseLive']
      result[key] = [live.managed, live.inferenceMode, live.summaryOnly]
    } else if (key === 'azureAllowedDomain' && typeof value === 'string') {
      result[key] = value.trim().replace(/^@/, '')
    } else if ((key === 'azureClientId' || key === 'azureTenantId') && typeof value === 'string') {
      result[key] = value.trim()
    } else result[key] = value ?? null
  }
  return result
}

function normalizeStrings(values: readonly string[] | null): readonly string[] | null {
  return values === null ? null : Object.freeze([...new Set(values)].sort())
}

function normalizeLocalSpeechPack(value: unknown): Readonly<LocalSpeechPackPolicy> | null {
  if (value === null) return null
  const result = LocalSpeechPackPolicySchema.safeParse(value)
  if (!result.success) return null
  return result.data
}

function sourceSignature(source: ManagedAuthoritySourceObservation, domain: SettingsAuthorityDomain): string {
  if (source.status === 'unreadable') return JSON.stringify([source.sourceIdentity, 'unreadable'])
  const fields = source.fields
  const keys = domain === 'import' ? SETTINGS_KEYS : PERSISTENCE_SETTINGS_KEYS
  const selected = Object.fromEntries(keys.map((key) => [key, normalizedSettings(fields.settings)[key]]))
  const locks = [...new Set(fields.lockedKeys)]
    .sort()
    .filter((key) => (domain === 'import' ? IMPORT_LOCK_KEYS : PERSISTENCE_LOCK_KEYS).has(key))
  return domain === 'import'
    ? JSON.stringify([
        source.sourceIdentity,
        'readable',
        selected,
        normalizeStrings(fields.allowedProviders),
        normalizeLocalSpeechPack(fields.localSpeechPack),
        locks
      ])
    : JSON.stringify([source.sourceIdentity, 'readable', selected, locks])
}

function domainAvailable(domain: SettingsAuthorityDomain): boolean {
  if (!selectedSettings || !settingsReadable || !settingsFrameCurrent[domain]) return false
  const user = sources.get('user')
  const admin = sources.get('admin')
  if (!user || user.status !== 'readable' || !admin || admin.status !== 'readable') return false
  return domain !== 'import' || effectiveImportPolicy?.status !== 'unreadable'
}

function domainSignature(domain: SettingsAuthorityDomain): string {
  const settings = selectedSettings ? normalizedSettings(selectedSettings) : null
  const user = sources.get('user')
  const admin = sources.get('admin')
  if (domain === 'import') {
    const remote = effectivePolicySignature(effectiveImportPolicy)
    return JSON.stringify([
      'import/v1',
      settingsReadable,
      settingsFrameCurrent.import,
      settings,
      user ? sourceSignature(user, 'import') : 'missing-user',
      admin ? sourceSignature(admin, 'import') : 'missing-admin',
      remote
    ])
  }
  const selected = settings ? Object.fromEntries(PERSISTENCE_SETTINGS_KEYS.map((key) => [key, settings[key]])) : null
  return JSON.stringify([
    'persistence/v1',
    settingsReadable,
    settingsFrameCurrent.persistence,
    selected,
    user ? sourceSignature(user, 'persistence') : 'missing-user',
    admin ? sourceSignature(admin, 'persistence') : 'missing-admin'
  ])
}

function effectivePolicySignature(policy: EffectiveImportPolicyObservation | null): string | null {
  if (!policy) return null
  if (policy.status === 'unreadable') return JSON.stringify([policy.sourceIdentity, 'unreadable'])
  return JSON.stringify([
    policy.sourceIdentity,
    'readable',
    normalizeStrings(policy.allowedProviders),
    normalizeLocalSpeechPack(policy.localSpeechPack)
  ])
}

function ensureReceipt(state: DomainState, domain: SettingsAuthorityDomain): SettingsAuthorityReceipt {
  if (!state.receipt) {
    const receipt = Object.freeze(Object.create(null)) as SettingsAuthorityReceipt
    receiptRecords.set(receipt as object, { domain, generation: state.generation })
    state.receipt = receipt
  }
  return state.receipt
}

function updateDomain(domain: SettingsAuthorityDomain): void {
  const state = domains[domain]
  const next = domainSignature(domain)
  if (next !== state.signature) {
    state.generation += 1n
    state.signature = next
    state.receipt = null
    state.dirty = true
  }
  state.available = domainAvailable(domain)
}

export function flushSettingsAuthorityInvalidations(): void {
  if (dispatching) return
  dispatching = true
  try {
    while (domains.import.dirty || domains.persistence.dirty) {
      for (const domain of ['import', 'persistence'] as const) {
        const state = domains[domain]
        if (!state.dirty) continue
        state.dirty = false
        for (const listener of [...state.listeners]) {
          try {
            listener()
          } catch {
            state.listeners.delete(listener)
          }
        }
      }
    }
  } finally {
    dispatching = false
  }
}

export function captureSettingsAuthority(domain: SettingsAuthorityDomain): SettingsAuthorityReceipt | null {
  const state = domains[domain]
  return state.available ? ensureReceipt(state, domain) : null
}

export function isSettingsAuthorityCurrent(receipt: SettingsAuthorityReceipt): boolean {
  const record = receiptRecords.get(receipt as object)
  return !!record && domains[record.domain].available && domains[record.domain].generation === record.generation
}

export function getSettingsAuthorityHistory(): SettingsAuthorityHistory {
  return Object.freeze({
    import: captureSettingsAuthority('import'),
    persistence: captureSettingsAuthority('persistence')
  })
}

export function observeSettingsAuthorityInvalidation(
  domain: SettingsAuthorityDomain,
  listener: () => void
): () => void {
  const listeners = domains[domain].listeners
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function commitSettingsAuthorityPublication(settings: Settings, readable: boolean): void {
  const copy: Partial<Pick<Settings, SelectedSettingsKey>> = Object.create(null)
  for (const key of SETTINGS_KEYS) {
    const value = settings[key]
    if (key === 'enterpriseLive' && value && typeof value === 'object')
      copy.enterpriseLive = Object.freeze({
        managed: value.managed,
        inferenceMode: value.inferenceMode,
        summaryOnly: value.summaryOnly
      })
    else (copy as Record<string, unknown>)[key] = value
  }
  selectedSettings = Object.freeze(copy)
  settingsReadable = readable
  settingsFrameCurrent.import = true
  settingsFrameCurrent.persistence = true
  updateDomain('import')
  updateDomain('persistence')
}

function applyManagedAuthoritySource(observation: ManagedAuthoritySourceObservation): boolean {
  const previous = sources.get(observation.source)
  const changedImport = !previous || sourceSignature(previous, 'import') !== sourceSignature(observation, 'import')
  const changedPersistence =
    !previous || sourceSignature(previous, 'persistence') !== sourceSignature(observation, 'persistence')
  if (observation.status === 'unreadable') sources.set(observation.source, Object.freeze({ ...observation }))
  else {
    const fields = observation.fields
    const settings: Partial<Pick<Settings, SelectedSettingsKey>> = Object.create(null)
    for (const key of SETTINGS_KEYS) {
      const value = fields.settings[key]
      if (value !== undefined) (settings as Record<string, unknown>)[key] = value
    }
    const normalized: ManagedAuthorityFields = Object.freeze({
      settings: Object.freeze(settings),
      allowedProviders: normalizeStrings(fields.allowedProviders),
      localSpeechPack: normalizeLocalSpeechPack(fields.localSpeechPack),
      lockedKeys: Object.freeze([...new Set(fields.lockedKeys)].sort())
    })
    sources.set(observation.source, Object.freeze({ ...observation, fields: normalized }))
  }
  if (changedImport) settingsFrameCurrent.import = false
  if (changedPersistence) settingsFrameCurrent.persistence = false
  updateDomain('import')
  updateDomain('persistence')
  return changedImport || changedPersistence
}

export function commitManagedAuthoritySource(observation: ManagedAuthoritySourceObservation): void {
  applyManagedAuthoritySource(observation)
}

/** Project one already-read trusted managed document; performs no additional IO. */
export function commitManagedAuthorityDocument(
  source: 'user' | 'admin',
  sourceIdentity: string,
  raw: string | null,
  status: 'readable' | 'unreadable'
): boolean {
  if (status === 'unreadable') {
    return applyManagedAuthoritySource({ source, sourceIdentity, status: 'unreadable' })
  }
  if (raw === null) {
    return applyManagedAuthoritySource({
      source,
      sourceIdentity,
      status: 'readable',
      fields: { settings: {}, allowedProviders: null, localSpeechPack: null, lockedKeys: [] }
    })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return applyManagedAuthoritySource({ source, sourceIdentity, status: 'unreadable' })
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return applyManagedAuthoritySource({ source, sourceIdentity, status: 'unreadable' })
  }
  const value = parsed as Record<string, unknown>
  const settings: Partial<Pick<Settings, SelectedSettingsKey>> = Object.create(null)
  for (const key of SETTINGS_KEYS) {
    let selected = value[key]
    if (key.startsWith('azure') && selected === undefined && value.azure && typeof value.azure === 'object') {
      const azureKey = key === 'azureClientId' ? 'clientId' : key === 'azureTenantId' ? 'tenantId' : 'allowedDomain'
      selected = (value.azure as Record<string, unknown>)[azureKey]
    }
    if (selected === undefined) continue
    const schema = key === 'enterpriseLive' ? BaseSettingsSchema.shape.enterpriseLive : BaseSettingsSchema.shape[key]
    if (!schema.safeParse(selected).success) {
      return applyManagedAuthoritySource({ source, sourceIdentity, status: 'unreadable' })
    }
    ;(settings as Record<string, unknown>)[key] = selected
  }
  const providers = value.allowedProviders
  if (providers !== undefined && (!Array.isArray(providers) || !providers.every((item) => typeof item === 'string'))) {
    return applyManagedAuthoritySource({ source, sourceIdentity, status: 'unreadable' })
  }
  const localSpeechPack = value.localSpeechPack
  if (localSpeechPack !== undefined && !LocalSpeechPackPolicySchema.safeParse(localSpeechPack).success) {
    return applyManagedAuthoritySource({ source, sourceIdentity, status: 'unreadable' })
  }
  const locked = Object.hasOwn(value, 'locked') ? value.locked : (value.lockedKeys ?? [])
  if (!Array.isArray(locked) || !locked.every((item) => typeof item === 'string')) {
    return applyManagedAuthoritySource({ source, sourceIdentity, status: 'unreadable' })
  }
  return applyManagedAuthoritySource({
    source,
    sourceIdentity,
    status: 'readable',
    fields: {
      settings,
      allowedProviders: (providers as string[] | undefined) ?? null,
      localSpeechPack: (localSpeechPack as LocalSpeechPackPolicy | undefined) ?? null,
      lockedKeys: locked as string[]
    }
  })
}

export function commitEffectiveImportPolicy(observation: EffectiveImportPolicyObservation): void {
  const previous = effectiveImportPolicy
  const previousSignature = effectivePolicySignature(previous)
  if (observation.status === 'unreadable') effectiveImportPolicy = Object.freeze({ ...observation })
  else
    effectiveImportPolicy = Object.freeze({
      ...observation,
      allowedProviders: normalizeStrings(observation.allowedProviders),
      localSpeechPack: normalizeLocalSpeechPack(observation.localSpeechPack)
    })
  if (previousSignature !== effectivePolicySignature(effectiveImportPolicy)) settingsFrameCurrent.import = false
  updateDomain('import')
}
