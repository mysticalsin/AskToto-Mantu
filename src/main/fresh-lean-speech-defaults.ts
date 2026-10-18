import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { BaseSettingsSchema, type Settings } from '@shared/ipc'
import { BrokerSpeechSettingsSchema, DEFAULT_BROKER_SPEECH_SETTINGS } from '@shared/broker-speech-settings'
import { LocalSpeechPackPolicySchema, type LocalSpeechPackPolicy } from '@shared/model-policy'
import type { PackageRuntimeContract } from './features/components/speech-pack/package-contract'
import type { SettingsPolicyAuthoritySnapshot } from './settings-observation'
import type { ManagedPolicyAuthorityRead } from './win-security'
import { isProfileRecoveryFileName } from './profile-recovery-files'

type PackageProfile = 'full' | 'lean'

/** Main-only durable facts captured before any default Settings file is created. */
export type FreshLeanSpeechDefaultContext = {
  settings: Settings
  compiledPackageProfile: PackageProfile | null
  verifiedPackageProfile: PackageProfile | null
  /** True only when the user profile was absent before the current initialization began. */
  freshProfile: boolean
  /** True when persisted settings contained brokerSpeech or cloudSttProvider. */
  speechRouteExplicit: boolean
  managedKeys: readonly string[]
  lockedKeys: readonly string[]
  /** Unknown managed/admin policy must never be interpreted as an unmanaged profile. */
  authorityReadable: boolean
}

const FRESH_LEAN_BROKER_DEFAULT = Object.freeze({
  transport: 'broker-v1' as const,
  engine: 'deepgram-nova3' as const
})

type SettingsShape = Record<string, { safeParse: (value: unknown) => { success: boolean; data?: unknown } }>

/** Keep only individually valid persisted settings keys while malformed managed policy is denied separately. */
export function validSettingsKeysOnly(obj: Record<string, unknown>): Record<string, unknown> {
  const shape = BaseSettingsSchema.shape as unknown as SettingsShape
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    if (!shape[key] || value === undefined) continue
    const parsed = shape[key].safeParse(value)
    if (parsed.success) out[key] = parsed.data
  }
  return out
}

/** Setup is complete only after a typed onboarding bit or a durable completion timestamp. */
export function isSettingsSetupComplete(user: Record<string, unknown>, managed: Record<string, unknown>): boolean {
  const userDone =
    'onboardingDone' in user ? BaseSettingsSchema.shape.onboardingDone.safeParse(user.onboardingDone) : null
  const managedDone =
    'onboardingDone' in managed ? BaseSettingsSchema.shape.onboardingDone.safeParse(managed.onboardingDone) : null
  return (
    (userDone?.success ? userDone.data : managedDone?.success ? managedDone.data : false) === true ||
    (typeof user.onboardingDoneAt === 'number' && Number.isFinite(user.onboardingDoneAt) && user.onboardingDoneAt > 0)
  )
}

async function doesNotExist(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
  }
}

/** Capture durable pre-settings profile absence with async metadata only, before initialization writes. */
export async function captureFreshProfileBoundary(userDataRoot: string): Promise<boolean> {
  const siblingPaths = ['settings.json', 'settings.json.recovered', 'settings.json.tmp']
  for (const name of siblingPaths) if (!(await doesNotExist(join(userDataRoot, name)))) return false
  try {
    const entries = await readdir(userDataRoot, { withFileTypes: true })
    return !entries.some((entry) => isProfileRecoveryFileName(entry.name))
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
  }
}

/** Whether a persisted route may be derived for this exact fresh, verified, unmanaged lean profile. */
export function canProjectFreshLeanSpeechDefaults(context: FreshLeanSpeechDefaultContext): boolean {
  const { settings } = context
  if (
    context.compiledPackageProfile !== 'lean' ||
    context.verifiedPackageProfile !== 'lean' ||
    context.freshProfile !== true ||
    context.authorityReadable !== true ||
    settings.onboardingDone !== false ||
    context.speechRouteExplicit !== false ||
    !Array.isArray(context.managedKeys) ||
    !Array.isArray(context.lockedKeys) ||
    context.managedKeys.length > 0 ||
    context.lockedKeys.includes('brokerSpeech') ||
    context.lockedKeys.includes('cloudSttProvider') ||
    settings.cloudSttProvider !== 'unconfigured' ||
    !settings.enterpriseLive ||
    settings.enterpriseLive.managed !== false ||
    settings.enterpriseLive.inferenceMode !== 'legacy' ||
    settings.enterpriseLive.summaryOnly !== false
  )
    return false

  const broker = BrokerSpeechSettingsSchema.safeParse(settings.brokerSpeech)
  if (
    !broker.success ||
    broker.data.transport !== DEFAULT_BROKER_SPEECH_SETTINGS.transport ||
    broker.data.engine !== DEFAULT_BROKER_SPEECH_SETTINGS.engine
  )
    return false

  return true
}

/** Applies only the proposed fresh lean broker default; every other Settings field stays unchanged. */
export function projectFreshLeanSpeechDefaults(context: FreshLeanSpeechDefaultContext): Settings {
  if (!canProjectFreshLeanSpeechDefaults(context)) return context.settings

  return { ...context.settings, brokerSpeech: { ...FRESH_LEAN_BROKER_DEFAULT } }
}

/** Pure managed-file interpretation and validity for settings authority; store retains all filesystem reads. */
export class ManagedPolicyAuthority {
  private userReadable = true
  private adminReadable = true
  readonly managedKeys = new Set<string>()

  get readable(): boolean {
    return this.userReadable && this.adminReadable
  }

  reset(): void {
    this.userReadable = true
    this.adminReadable = true
    this.managedKeys.clear()
  }

  setAdminReadable(readable: boolean): void {
    this.adminReadable = readable
  }

  readAdminContent(
    readContent: () => string | null,
    getPathState: () => 'absent' | 'present' | 'unknown'
  ): string | null {
    const content = readContent()
    const pathState = getPathState()
    if (
      pathState === 'unknown' ||
      (pathState === 'present' && content === null) ||
      (pathState === 'absent' && content !== null)
    )
      this.adminReadable = false
    return content
  }

  setUnreadable(source: 'user' | 'admin'): void {
    if (source === 'user') this.userReadable = false
    else this.adminReadable = false
  }

  noteReadFailure(source: 'user' | 'admin', error: unknown): void {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.setUnreadable(source)
  }

  parseManaged(
    raw: string,
    source: 'user' | 'admin',
    validKeysOnly: (obj: Record<string, unknown>) => Record<string, unknown>
  ): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        this.setUnreadable(source)
        return {}
      }
      const obj = parsed as Record<string, unknown>
      for (const key of Object.keys(obj)) if (!key.startsWith('_')) this.managedKeys.add(key)
      if (
        ('enterpriseLive' in obj && !BaseSettingsSchema.shape.enterpriseLive.safeParse(obj.enterpriseLive).success) ||
        ('localSpeechPack' in obj && !LocalSpeechPackPolicySchema.safeParse(obj.localSpeechPack).success) ||
        ('allowedProviders' in obj &&
          (!Array.isArray(obj.allowedProviders) || obj.allowedProviders.some((key) => typeof key !== 'string')))
      )
        this.setUnreadable(source)
      const clean: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(obj)) if (!key.startsWith('_')) clean[key] = value
      return validKeysOnly(clean)
    } catch {
      this.setUnreadable(source)
      return {}
    }
  }

  parseLocked(raw: string, source: 'user' | 'admin'): string[] {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        this.setUnreadable(source)
        return []
      }
      const obj = parsed as Record<string, unknown>
      const hasLocked = Object.hasOwn(obj, 'locked')
      const value = hasLocked ? obj.locked : obj.lockedKeys
      if (
        (hasLocked || Object.hasOwn(obj, 'lockedKeys')) &&
        (!Array.isArray(value) || value.some((key) => typeof key !== 'string'))
      )
        this.setUnreadable(source)
      return [...new Set((Array.isArray(value) ? value : []).filter((key): key is string => typeof key === 'string'))]
    } catch {
      this.setUnreadable(source)
      return []
    }
  }

  parseAllowed(raw: string, source: 'user' | 'admin'): string[] | null {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        this.setUnreadable(source)
        return null
      }
      const obj = parsed as Record<string, unknown>
      const value = obj.allowedProviders
      if (!Array.isArray(value)) {
        if (Object.hasOwn(obj, 'allowedProviders')) this.setUnreadable(source)
        return null
      }
      if (value.some((item) => typeof item !== 'string')) this.setUnreadable(source)
      return [...new Set(value.filter((item): item is string => typeof item === 'string'))]
    } catch {
      this.setUnreadable(source)
      return null
    }
  }

  parseLocalSpeechPack(raw: string, source: 'user' | 'admin'): LocalSpeechPackPolicy | null {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        this.setUnreadable(source)
        return null
      }
      const value = (parsed as Record<string, unknown>).localSpeechPack
      if (value === undefined) return null
      const result = LocalSpeechPackPolicySchema.safeParse(value)
      if (!result.success) this.setUnreadable(source)
      return result.success ? result.data : null
    } catch {
      this.setUnreadable(source)
      return null
    }
  }
}

/** One-time runtime contract and monotonic semantic identities owned by the settings authority. */
export class FreshLeanSpeechAuthority {
  private configured = false
  private compiledProfile: PackageProfile | null = null
  private verifiedProfile: PackageProfile | null = null
  private profileWasAbsent = false
  private projected = false
  private selectionRevision = 0
  private policyRevision = 0
  private localModelRevision = 0
  private selection: string | null = null
  private policy: string | null = null
  private localModel: string | null = null
  private authorityQueue: Promise<void> = Promise.resolve()

  readSettingsAuthorityBoundary(options: {
    readFiles: () => Promise<{ user: ManagedPolicyAuthorityRead; admin: ManagedPolicyAuthorityRead }>
    setReads: (user: ManagedPolicyAuthorityRead | null, admin: ManagedPolicyAuthorityRead | null) => void
    resetCaches: () => void
    readSettings: () => Settings
    readPolicy: () => {
      allowedProviders: string[] | null
      localSpeechPack: LocalSpeechPackPolicy | null
      lockedKeys: string[]
    }
    readable: () => boolean
    epoch: () => number
  }): Promise<SettingsPolicyAuthoritySnapshot> {
    const result = this.authorityQueue.then(async () => {
      const reads = await options.readFiles()
      options.setReads(reads.user, reads.admin)
      options.resetCaches()
      try {
        const settings = options.readSettings()
        const policy = options.readPolicy()
        return { settings, readable: options.readable(), epoch: options.epoch(), ...policy }
      } finally {
        options.setReads(null, null)
      }
    })
    this.authorityQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  async configure(
    compiledProfile: PackageProfile,
    contract: PackageRuntimeContract,
    userDataRoot: string
  ): Promise<void> {
    if (this.configured) return
    this.configured = true
    this.compiledProfile = compiledProfile
    this.verifiedProfile = contract.status === 'verified' ? contract.profile : null
    this.profileWasAbsent =
      contract.status === 'verified' && contract.profile === 'lean' && (await captureFreshProfileBoundary(userDataRoot))
    this.projected = false
  }

  get compiledPackageProfile(): PackageProfile | null {
    return this.compiledProfile
  }

  get verifiedPackageProfile(): PackageProfile | null {
    return this.verifiedProfile
  }

  get freshProfileWasAbsent(): boolean {
    return this.profileWasAbsent
  }

  get wasProjected(): boolean {
    return this.projected
  }

  setProjected(projected: boolean): void {
    this.projected = projected
  }

  project(
    settings: Settings,
    stored: Record<string, unknown> | null,
    raw: Record<string, unknown>,
    lockedKeys: readonly string[],
    authorityReadable: boolean,
    managedAuthority: ManagedPolicyAuthority
  ): Settings {
    const context: FreshLeanSpeechDefaultContext = {
      settings,
      compiledPackageProfile: this.compiledProfile,
      verifiedPackageProfile: this.verifiedProfile,
      freshProfile: this.profileWasAbsent && stored !== null && Object.keys(raw).length === 0,
      speechRouteExplicit: Object.hasOwn(raw, 'brokerSpeech') || Object.hasOwn(raw, 'cloudSttProvider'),
      managedKeys: [...managedAuthority.managedKeys],
      lockedKeys,
      authorityReadable
    }
    this.projected = canProjectFreshLeanSpeechDefaults(context)
    return projectFreshLeanSpeechDefaults(context)
  }

  preserveProjectedRoute(
    next: Record<string, unknown>,
    previous: Record<string, unknown>,
    allowed: Record<string, unknown>,
    managedKeys: readonly string[],
    locked: readonly string[],
    authorityReadable: boolean,
    currentSettings: () => Settings
  ): void {
    if (!this.profileWasAbsent || Object.keys(previous).length !== 0) return
    if (Object.hasOwn(allowed, 'brokerSpeech') || Object.hasOwn(allowed, 'cloudSttProvider')) return
    const initial = currentSettings()
    if (
      !this.projected ||
      !authorityReadable ||
      managedKeys.length > 0 ||
      Object.hasOwn(previous, 'brokerSpeech') ||
      Object.hasOwn(previous, 'cloudSttProvider') ||
      locked.includes('brokerSpeech') ||
      locked.includes('cloudSttProvider') ||
      initial.cloudSttProvider !== 'unconfigured' ||
      initial.enterpriseLive.managed !== false ||
      initial.enterpriseLive.inferenceMode !== 'legacy' ||
      initial.enterpriseLive.summaryOnly !== false
    )
      return
    next.brokerSpeech = initial.brokerSpeech
  }

  observe(selection: string, policy: string, localModel: string): void {
    if (this.selection !== null && this.selection !== selection) this.selectionRevision += 1
    if (this.policy !== null && this.policy !== policy) this.policyRevision += 1
    if (this.localModel !== null && this.localModel !== localModel) this.localModelRevision += 1
    this.selection = selection
    this.policy = policy
    this.localModel = localModel
  }

  observePolicy(
    settings: Settings,
    localSpeechPack: unknown,
    allowedProviders: readonly string[] | null,
    lockedKeys: readonly string[],
    readable: boolean
  ): void {
    this.observe(
      settings.asrEngine,
      JSON.stringify({
        localSpeechPack,
        allowedProviders,
        enterpriseLive: settings.enterpriseLive,
        operatorConfigured: Boolean(
          settings.operatorUrl?.trim() || settings.operatorIngestSecret?.trim() || settings.operatorLicenseToken?.trim()
        ),
        localSpeechPackLocked: lockedKeys.includes('localSpeechPack'),
        readable
      }),
      settings.localLlm.modelId
    )
  }

  observeStorePolicy(
    settings: Settings,
    managed: Record<string, unknown>,
    lockedKeys: readonly string[],
    localPolicy: () => unknown,
    allowedProviders: () => readonly string[] | null,
    readable: boolean
  ): void {
    this.observePolicy(settings, managed.localSpeechPack ?? localPolicy(), allowedProviders(), lockedKeys, readable)
  }

  selectionIdentity(): string {
    return `selection:${this.selectionRevision}`
  }

  policyIdentity(): string {
    return `policy:${this.policyRevision}`
  }

  localModelIdentity(): string {
    return `local-model:${this.localModelRevision}`
  }

  identityAfterRead(readSettings: () => Settings, identity: 'selection' | 'policy' | 'localModel'): string {
    readSettings()
    if (identity === 'selection') return this.selectionIdentity()
    return identity === 'policy' ? this.policyIdentity() : this.localModelIdentity()
  }

  identityReaders(readSettings: () => Settings): {
    selection: () => string
    policy: () => string
    localModel: () => string
  } {
    return {
      selection: () => this.identityAfterRead(readSettings, 'selection'),
      policy: () => this.identityAfterRead(readSettings, 'policy'),
      localModel: () => this.identityAfterRead(readSettings, 'localModel')
    }
  }

  readBoundary<T>(resetCaches: () => void, readSettings: () => T, setFresh: (fresh: boolean) => void): T {
    resetCaches()
    setFresh(true)
    try {
      return readSettings()
    } finally {
      setFresh(false)
    }
  }

  bindBoundary<T>(resetCaches: () => void, readSettings: () => T, setFresh: (fresh: boolean) => void): () => T {
    return () => this.readBoundary(resetCaches, readSettings, setFresh)
  }

  reset(): void {
    this.configured = false
    this.compiledProfile = null
    this.verifiedProfile = null
    this.profileWasAbsent = false
    this.projected = false
    this.selectionRevision = 0
    this.policyRevision = 0
    this.selection = null
    this.policy = null
    this.localModel = null
    this.authorityQueue = Promise.resolve()
  }
}
