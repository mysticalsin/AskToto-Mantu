import { createHash, randomUUID } from 'node:crypto'
import { app } from 'electron'
import { join, resolve } from 'node:path'
import { isSummaryOnlyProfile, resolveEnterpriseLiveProfile } from '@shared/enterprise-live-profile'
import { captureMainPersistenceSessionBoundary, subscribeSpeechAuthLeaseInvalidation } from '../auth'
import { getPublishedSettingsObservation } from '../settings-observation'
import {
  captureSettingsAuthority,
  isSettingsAuthorityCurrent,
  observeSettingsAuthorityInvalidation
} from '../settings-authority-history'
import {
  createMeetingSpeechPersistenceService,
  type MeetingSpeechPersistenceService
} from '../infra/process/meeting-speech-host'
import { createStorageGateway, type StorageGateway } from '../infra/storage/gateway'
import {
  createIncrementalMeetingAppender,
  type IncrementalMeetingAppender,
  type IncrementalJournalSnapshot
} from '../features/meetings/incremental-meeting-journal'
import { createIncrementalMeetingJournalFileStorage } from '../features/meetings/incremental-meeting-journal-files'
import {
  readAdminPolicyReceipt,
  readBundledPersistenceReceipt,
  resolvePersistenceResourcePolicy,
  toMeetingSpeechPolicy,
  type ResourcePolicyResult,
  type ResourcePolicyInput,
  type AdminPolicyReceipt,
  type BundledPersistenceReceipt,
  type ResolvedPersistenceProfile
} from './resource-policy'
import {
  createNativeMeetingKeyStore,
  createProtectedMeetingKeys,
  type NativeKeyStore,
  type ProtectedKeyHandle,
  type ProtectedMeetingKeys
} from './protected-meeting-keys'
import { createProfileBoundLegacyFileKeyAccess, type ProfileBoundLegacyFileKeyAccess } from './legacy-file-key'
import {
  RootRegistry,
  type OpaqueOperationScope,
  type OwnedMeetingRoot,
  type RootScopeBinding,
  type WriterLease
} from './root-registry'
import { PersistencePolicyHighWaterStore } from './policy-high-water'

declare const __METIS_SOURCE_COMMIT__: string
let mainInstanceAuthorityLost = false

/** Captured while this module is evaluated, before main applies the legacy macOS compatibility default. */
export const PERSISTENCE_NATIVE_KEY_INTENT = captureNativeKeyIntent(process.env.ASKTOTO_LOCAL_KEYSTORE)

export type PersistenceCapability =
  | { status: 'initializing' }
  | { status: 'candidate'; profileId: string; reason: 'qualification-required' }
  | { status: 'ready'; profileId: string; nativeKeyAccess: 'allowed' | 'explicitly-disabled' }
  | { status: 'policy-unavailable'; code: string }
  | { status: 'identity-unavailable' }
  | { status: 'disposed' }

export interface MainMeetingJournal {
  readonly meetingId: string
  readonly keyReference: ProtectedKeyHandle['reference']
  retire(): void
  settle(): Promise<void>
}

export interface WritableMainMeetingJournal extends MainMeetingJournal {
  append(record: Uint8Array, expectedRevision: number): ReturnType<IncrementalMeetingAppender['append']>
}

export interface ReadOnlyMainMeetingJournal extends MainMeetingJournal {
  readonly snapshot: Readonly<IncrementalJournalSnapshot>
}

export interface MainPersistenceBootstrap {
  prime(): Promise<PersistenceCapability>
  capabilities(): PersistenceCapability
  openNew(meetingId?: string): Promise<WritableMainMeetingJournal>
  openExisting(meetingId: string, keyReference: ProtectedKeyHandle['reference']): Promise<ReadOnlyMainMeetingJournal>
  retire(reason: string): void
  settle(): Promise<void>
  dispose(): Promise<void>
}

/** Explicit source-fixture adapters; production callers use the fixed main-owned resolver below. */
export interface MainPersistenceBootstrapSourceFixture {
  readonly readBundledReceipt: () => Promise<BundledPersistenceReceipt | null>
  readonly readAdminReceipt: () => Promise<AdminPolicyReceipt>
  readonly sourceCommit: () => string
  readonly resolvePolicy: (input: ResourcePolicyInput) => ResourcePolicyResult
  readonly nativeKeyStore: NativeKeyStore
  readonly createSpeech: (profile: ResolvedPersistenceProfile) => MeetingSpeechPersistenceService
}

export interface MainPersistenceBootstrapOptions {
  readonly afterFirstShow: () => boolean
  readonly nativeKeyIntent: 'allowed' | 'explicitly-disabled'
}

interface ScopeEntry {
  readonly binding: RootScopeBinding
  readonly scope: OpaqueOperationScope
  retired: boolean
}

interface OpenJournal {
  readonly scope: OpaqueOperationScope
  readonly root: OwnedMeetingRoot
  readonly writer?: WriterLease
  readonly key: ProtectedKeyHandle
  readonly storage: NonNullable<ReturnType<typeof createIncrementalMeetingJournalFileStorage>>
  readonly gateway: StorageGateway
  readonly pending: Set<Promise<unknown>>
  readonly settle: () => Promise<void>
  disposed: boolean
  settling?: Promise<void>
}

function runtimeIdentity() {
  const platform = process.platform
  if (platform !== 'win32' && platform !== 'darwin' && platform !== 'linux')
    throw new Error('Unsupported persistence platform')
  const arch = process.arch
  if (arch !== 'x64' && arch !== 'arm64') throw new Error('Unsupported persistence architecture')
  return {
    platform,
    arch,
    node: process.versions.node,
    electron: process.versions.electron,
    v8: process.versions.v8,
    modules: process.versions.modules
  }
}

function sourceCommit(): string {
  try {
    return /^[a-f0-9]{40}$/.test(__METIS_SOURCE_COMMIT__) ? __METIS_SOURCE_COMMIT__ : ''
  } catch {
    return ''
  }
}

function ownsMainInstance(): boolean {
  if (mainInstanceAuthorityLost) return false
  try {
    if (app.hasSingleInstanceLock()) return true
  } catch {
    // A failed authority read is permanent for scopes already issued by this module.
  }
  mainInstanceAuthorityLost = true
  return false
}

function identityHash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** Main-process composition. It reads policy at prime, but native key work is lazy and action-gated. */
function createMainPersistenceBootstrapInternal(
  options: MainPersistenceBootstrapOptions,
  sourceFixture?: MainPersistenceBootstrapSourceFixture
): MainPersistenceBootstrap {
  let disposed = false
  let policy: ResourcePolicyResult | undefined
  let policyReadGeneration = 0
  let policyAdmissionPending = false
  let capability: PersistenceCapability = Object.freeze({ status: 'initializing' })
  let generation = randomUUID()
  let observation = getPublishedSettingsObservation()
  let speech: MeetingSpeechPersistenceService | undefined
  const scopes = new WeakMap<object, ScopeEntry>()
  const liveScopes = new Set<ScopeEntry>()
  const journals = new Set<OpenJournal>()
  const pendingOperations = new Set<Promise<unknown>>()
  let refreshPolicy: (() => Promise<PersistenceCapability>) | undefined
  const gateways = new WeakMap<OwnedMeetingRoot, StorageGateway>()
  const currentUserData = (): string => resolve(app.getPath('userData'))

  function trackOperation<T>(operation: Promise<T>): Promise<T> {
    pendingOperations.add(operation)
    void operation.then(
      () => pendingOperations.delete(operation),
      () => pendingOperations.delete(operation)
    )
    return operation
  }

  const roots = new RootRegistry({
    userDataRoot: currentUserData,
    resolveScope: (scope) => scopes.get(scope as object)?.binding,
    bindGatewayRoot: async (root) => {
      root.assertCurrent()
      gateways.set(root, createStorageGateway({ root: () => join(root.meetingPath, 'journal') }))
    }
  })
  const nativeKeys = sourceFixture?.nativeKeyStore ?? createNativeMeetingKeyStore()
  const speechProxy: MeetingSpeechPersistenceService = {
    reportTiming: (...args) => speech?.reportTiming(...args),
    readLimitBytes: () => speech?.readLimitBytes(),
    render: (...args) => requireSpeech().render(...args),
    decode: (...args) => requireSpeech().decode(...args),
    rewrite: (...args) => requireSpeech().rewrite(...args),
    project: (...args) => requireSpeech().project(...args),
    encryptEnvelopeV2: (...args) => requireSpeech().encryptEnvelopeV2(...args),
    decryptEnvelopeV2: (...args) => requireSpeech().decryptEnvelopeV2(...args),
    rewrapEnvelopeV2: (...args) => requireSpeech().rewrapEnvelopeV2(...args),
    canonicalizeIncrementalRecord: (...args) => requireSpeech().canonicalizeIncrementalRecord(...args),
    invalidateCurrent: async () => speech?.invalidateCurrent(),
    dispose: async () => speech?.dispose()
  }
  const keys: ProtectedMeetingKeys = createProtectedMeetingKeys({
    roots,
    nativeKeyStore: nativeKeys,
    speech: speechProxy
  })
  const legacyKeys: ProfileBoundLegacyFileKeyAccess = createProfileBoundLegacyFileKeyAccess({
    roots,
    nativeKeyStore: nativeKeys
  })

  function requireSpeech(): MeetingSpeechPersistenceService {
    if (!speech) throw new Error('Persistence speech worker is unavailable until a qualified profile is admitted')
    return speech
  }

  function retire(reason: string): void {
    if (disposed) return
    generation = `${generation}:${reason}:${randomUUID()}`
    for (const entry of liveScopes) {
      entry.retired = true
      roots.retireScope(entry.scope)
    }
    for (const journal of journals) {
      journal.root.retire()
      keys.retire(journal.key)
    }
    void speech?.invalidateCurrent()
  }

  const unsubscribeAuth = subscribeSpeechAuthLeaseInvalidation(() => {
    retire('auth-authority-changed')
    policy = undefined
    capability = Object.freeze({ status: 'initializing' })
    if (options.afterFirstShow()) void refreshPolicy?.()
  })

  const unsubscribeSettings = observeSettingsAuthorityInvalidation('persistence', () => {
    observation = getPublishedSettingsObservation()
    if (!observation?.readable) {
      retire('settings-changed')
      policy = undefined
      capability = Object.freeze({ status: 'initializing' })
      if (options.afterFirstShow()) void refreshPolicy?.()
    }
  })

  function admittedProfile(): ResolvedPersistenceProfile | null {
    if (!policy || policy.status !== 'ready' || disposed || policyAdmissionPending) return null
    return policy.profile
  }

  function mintScope(
    profile: ResolvedPersistenceProfile,
    journalGeneration: string = randomUUID()
  ): OpaqueOperationScope {
    const authBoundary = captureMainPersistenceSessionBoundary()
    if (!ownsMainInstance() || !authBoundary.isCurrent())
      throw new Error('The main instance or verified account authority is unavailable')
    const settingsAuthority = captureSettingsAuthority('persistence')
    if (!settingsAuthority) throw new Error('Persistence settings authority is unavailable')
    const principal = authBoundary.configured
      ? authBoundary.principalAssociation
      : identityHash(`local-profile/v1\n${currentUserData()}`)
    if (!principal) throw new Error('The verified account association is unavailable')
    const seenSettings = getPublishedSettingsObservation()
    observation = seenSettings
    if (!seenSettings?.readable || seenSettings.epoch < 0) throw new Error('Settings authority is unavailable')
    const capturedUserData = currentUserData()
    const capturedGeneration = generation
    let lastPolicyWallNow = Date.now()
    let lastPolicyMonotonicNow = performance.now()
    const policyWindow = profile.enterpriseWindow
    if (
      !Number.isFinite(lastPolicyWallNow) ||
      !Number.isFinite(lastPolicyMonotonicNow) ||
      (policyWindow && (lastPolicyWallNow < policyWindow.notBefore || lastPolicyWallNow >= policyWindow.expiresAt))
    )
      throw new Error('Enterprise persistence policy is outside its validity window')
    const scope = Object.freeze(Object.create(null)) as OpaqueOperationScope
    const entry: ScopeEntry = {
      scope,
      retired: false,
      binding: Object.freeze({
        profileNamespace: identityHash(`profile/v2\n${capturedUserData}\n${principal}`).slice(0, 48),
        principalAssociation: principal,
        generation: journalGeneration,
        nativeKeyAccess: options.nativeKeyIntent,
        legacyFileKeyAccess: 'denied',
        maxHeldRoots: profile.maxHeldRoots,
        isCurrent: () => {
          const wallNow = Date.now()
          const monotonicNow = performance.now()
          if (
            !Number.isFinite(wallNow) ||
            !Number.isFinite(monotonicNow) ||
            wallNow < lastPolicyWallNow ||
            monotonicNow < lastPolicyMonotonicNow ||
            (policyWindow && (wallNow < policyWindow.notBefore || wallNow >= policyWindow.expiresAt))
          )
            return false
          lastPolicyWallNow = wallNow
          lastPolicyMonotonicNow = monotonicNow
          return (
            !disposed &&
            ownsMainInstance() &&
            !entry.retired &&
            generation === capturedGeneration &&
            currentUserData() === capturedUserData &&
            isSettingsAuthorityCurrent(settingsAuthority) &&
            authBoundary.isCurrent()
          )
        }
      })
    }
    scopes.set(scope, entry)
    liveScopes.add(entry)
    return scope
  }

  function requireActionableProfile(): ResolvedPersistenceProfile {
    if (!options.afterFirstShow()) throw new Error('Persistence actions are available after the main window is shown')
    observation = getPublishedSettingsObservation()
    const profile = admittedProfile()
    if (!profile) throw new Error('Retained persistence is not qualified for this runtime')
    if (!profile.retentionAllowed) throw new Error('The admitted policy does not allow retained persistence')
    if (
      profile.enterpriseWindow &&
      (Date.now() < profile.enterpriseWindow.notBefore || Date.now() >= profile.enterpriseWindow.expiresAt)
    )
      throw new Error('Enterprise persistence policy is outside its validity window')
    if (!observation?.readable || !settingsEncrypts(observation.settings))
      throw new Error('Encrypted meeting storage must be enabled before retained persistence')
    if (isSummaryOnlyProfile(resolveEnterpriseLiveProfile(observation.settings.enterpriseLive ?? observation.settings)))
      throw new Error('The current enterprise retention policy forbids full meeting transcripts')
    return profile
  }

  function settingsEncrypts(settings: NonNullable<typeof observation>['settings']): boolean {
    return settings.encryptTranscripts === true
  }

  function createJournal(
    profile: ResolvedPersistenceProfile,
    scope: OpaqueOperationScope,
    root: OwnedMeetingRoot,
    writer: WriterLease,
    key: ProtectedKeyHandle
  ): Promise<WritableMainMeetingJournal>
  function createJournal(
    profile: ResolvedPersistenceProfile,
    scope: OpaqueOperationScope,
    root: OwnedMeetingRoot,
    writer: undefined,
    key: ProtectedKeyHandle
  ): Promise<ReadOnlyMainMeetingJournal>
  async function createJournal(
    profile: ResolvedPersistenceProfile,
    scope: OpaqueOperationScope,
    root: OwnedMeetingRoot,
    writer: WriterLease | undefined,
    key: ProtectedKeyHandle
  ): Promise<WritableMainMeetingJournal | ReadOnlyMainMeetingJournal> {
    const gateway = gateways.get(root)
    if (!profile || !gateway) throw new Error('Persistence root services are not installed')
    const current = () => {
      try {
        roots.assertScopeCurrent(scope, root)
        root.assertCurrent()
        writer?.assertCurrent()
        return true
      } catch {
        return false
      }
    }
    const assertPhysicalCurrent = async (): Promise<void> => {
      roots.assertScopeCurrent(scope, root)
      await root.assertPhysicalCurrent()
      if (writer) {
        writer.assertCurrent()
        await writer.assertPhysicalCurrent()
      }
      roots.assertScopeCurrent(scope, root)
      root.assertCurrent()
      writer?.assertCurrent()
    }
    let storage: NonNullable<ReturnType<typeof createIncrementalMeetingJournalFileStorage>> | undefined
    let appender: IncrementalMeetingAppender | undefined
    let snapshot: IncrementalJournalSnapshot | undefined
    const journalRoot = join(root.meetingPath, 'journal')
    try {
      storage = await keys.withKey(scope, key, (ownedKey) => {
        try {
          return createIncrementalMeetingJournalFileStorage({
            root: journalRoot,
            meetingId: root.meetingId,
            key: ownedKey,
            maxJournalBytes: profile.derived.journalBytes,
            maxPhysicalRecordBytes: profile.derived.physicalRecordBytes,
            maxChunkBytes: profile.consumers.transferChunkBytes,
            maxPageRecords: profile.consumers.pageRecords,
            maxPageBytes: profile.consumers.pageBytes,
            isCurrent: current,
            assertPhysicalCurrent,
            createRootIfMissing: writer !== undefined,
            gateway
          })
        } finally {
          ownedKey.fill(0)
        }
      })
      if (!storage) throw new Error('Core journal storage could not be bound to the admitted root')
      if (writer) {
        const initialized = await storage.initialize()
        if (initialized.status !== 'ok') throw new Error('New journal initialization did not commit')
      } else {
        const read = await storage.readSnapshot(root.meetingId, current)
        if (read.status !== 'ok') throw new Error('Existing journal could not be reopened read-only')
        snapshot = Object.freeze({ ...read.snapshot })
      }
      if (writer)
        appender = createIncrementalMeetingAppender({
          meetingId: root.meetingId,
          isCurrent: current,
          readLimits: () => ({ ...profile.speech, maxJournalBytes: profile.derived.journalBytes }),
          canonicalizeRecord: (record, binding) => requireSpeech().canonicalizeIncrementalRecord(record, binding),
          storage
        })
    } catch (error) {
      storage?.dispose()
      throw error
    }
    let owned: OpenJournal
    const dispose = (): Promise<void> => {
      if (owned.settling) return owned.settling
      if (owned.disposed) return Promise.resolve()
      owned.disposed = true
      owned.settling = (async () => {
        keys.retire(key)
        root.retire()
        await Promise.allSettled([...owned.pending])
        storage.dispose()
        try {
          await keys.settleAndDispose(key)
        } finally {
          await writer?.release().catch(() => undefined)
          await roots.closeRoot(scope, root).catch(() => undefined)
          const entry = scopes.get(scope as object)
          if (entry) liveScopes.delete(entry)
          journals.delete(owned)
        }
      })()
      return owned.settling
    }
    owned = {
      scope,
      root,
      ...(writer ? { writer } : {}),
      key,
      storage,
      gateway,
      pending: new Set(),
      settle: dispose,
      disposed: false
    }
    journals.add(owned)
    const common = {
      meetingId: root.meetingId,
      keyReference: key.reference,
      retire: () => {
        root.retire()
        keys.retire(key)
      },
      settle: dispose
    }
    if (writer && appender)
      return Object.freeze({
        ...common,
        append: (record: Uint8Array, expectedRevision: number) => {
          if (owned.disposed || !current())
            return Promise.resolve({ status: 'refused', reason: 'STALE_OWNER' } as const)
          const operation = appender!.append(record, expectedRevision)
          owned.pending.add(operation)
          void operation.then(
            () => owned.pending.delete(operation),
            () => owned.pending.delete(operation)
          )
          return operation
        }
      }) satisfies WritableMainMeetingJournal
    if (!snapshot) throw new Error('Read-only journal snapshot is unavailable')
    return Object.freeze({ ...common, snapshot }) satisfies ReadOnlyMainMeetingJournal
  }

  const bootstrap: MainPersistenceBootstrap = {
    prime() {
      return trackOperation(
        (async () => {
          if (disposed) return capability
          const operation = ++policyReadGeneration
          policyAdmissionPending = true
          capability = Object.freeze({ status: 'initializing' })
          observation = getPublishedSettingsObservation()
          const authBoundary = captureMainPersistenceSessionBoundary()
          if (!ownsMainInstance() || !authBoundary.isCurrent())
            throw new Error('The main instance or verified account authority is unavailable')
          const settingsAuthority = captureSettingsAuthority('persistence')
          if (!settingsAuthority) throw new Error('Persistence settings authority is unavailable')
          const originalObservation = observation
          const originalGeneration = generation
          try {
            const capturedProfilePath = currentUserData()
            const highWaterStore = new PersistencePolicyHighWaterStore(capturedProfilePath)
            const highWaterCurrent = () =>
              !disposed &&
              operation === policyReadGeneration &&
              generation === originalGeneration &&
              currentUserData() === capturedProfilePath &&
              ownsMainInstance() &&
              observation?.readable === true &&
              isSettingsAuthorityCurrent(settingsAuthority) &&
              authBoundary.isCurrent()
            const [bundledReceipt, adminReceipt, highWater] = await Promise.all([
              sourceFixture?.readBundledReceipt() ?? readBundledPersistenceReceipt(),
              sourceFixture?.readAdminReceipt() ?? readAdminPolicyReceipt(),
              highWaterStore.read(highWaterCurrent)
            ])
            if (highWater.status !== 'ok' || !highWaterCurrent())
              throw new Error('Persistence policy rollback state is unreadable or stale')
            const source = sourceFixture?.sourceCommit() ?? sourceCommit()
            if (!source) throw new Error('Packaged source commit provenance is missing')
            const inputs = {
              bundledReceipt: bundledReceipt ?? undefined,
              sourceCommit: source,
              runtime: runtimeIdentity(),
              adminReceipt,
              highWater: highWater.value
            }
            const resolvePolicy = sourceFixture?.resolvePolicy ?? resolvePersistenceResourcePolicy
            let resolvedPolicy = resolvePolicy({ ...inputs, mode: 'production' })
            if (
              resolvedPolicy.status === 'refused' &&
              ['PROFILE_UNQUALIFIED', 'QUALIFICATION_MISSING', 'QUALIFICATION_INVALID'].includes(resolvedPolicy.code)
            ) {
              const candidate = resolvePolicy({ ...inputs, mode: 'qualification' })
              if (candidate.status === 'candidate' && candidate.profile.qualification.state === 'PROPOSED') {
                resolvedPolicy = candidate
                policy = resolvedPolicy
                capability = Object.freeze({
                  status: 'candidate',
                  profileId: candidate.profile.id,
                  reason: 'qualification-required'
                })
                if (operation === policyReadGeneration) policyAdmissionPending = false
                return capability
              }
            }
            if (!highWaterCurrent()) throw new Error('Persistence policy owner changed during admission')
            if (resolvedPolicy.status === 'ready') {
              if (
                resolvedPolicy.policyHighWater &&
                !(await highWaterStore.commit(highWater.value, resolvedPolicy.policyHighWater, highWaterCurrent))
              )
                throw new Error('Persistence policy version was not durably committed')
              const speechPolicy = toMeetingSpeechPolicy(resolvedPolicy.profile)
              speech =
                sourceFixture?.createSpeech(resolvedPolicy.profile) ??
                createMeetingSpeechPersistenceService({
                  readLimits: () => speechPolicy.limits,
                  readBounds: () => ({
                    maxInputBytes: speechPolicy.maxInputBytes,
                    maxOutputBytes: speechPolicy.maxOutputBytes,
                    operationDeadlineMs: speechPolicy.operationDeadlineMs,
                    shutdownDeadlineMs: speechPolicy.shutdownDeadlineMs
                  })
                })
              if (!highWaterCurrent()) throw new Error('Persistence authority changed before publication')
              policy = resolvedPolicy
              capability = Object.freeze({
                status: 'ready',
                profileId: resolvedPolicy.profile.id,
                nativeKeyAccess: options.nativeKeyIntent
              })
            } else if (resolvedPolicy.status === 'candidate') {
              policy = resolvedPolicy
              capability = Object.freeze({
                status: 'candidate',
                profileId: resolvedPolicy.profile.id,
                reason: 'qualification-required'
              })
            } else {
              policy = resolvedPolicy
              capability = Object.freeze({ status: 'policy-unavailable', code: resolvedPolicy.code })
            }
            if (operation === policyReadGeneration) policyAdmissionPending = false
          } catch {
            if (operation === policyReadGeneration && !disposed) {
              policyAdmissionPending = false
              policy = undefined
              capability = Object.freeze({ status: 'policy-unavailable', code: 'POLICY_UNAVAILABLE' })
            }
          }
          return capability
        })()
      )
    },
    capabilities: () => capability,
    openNew(meetingId = randomUUID()) {
      return trackOperation(
        (async () => {
          const profile = requireActionableProfile()
          const scope = mintScope(profile)
          let root: OwnedMeetingRoot
          try {
            root = await roots.create(scope, meetingId)
          } catch (error) {
            const entry = scopes.get(scope as object)
            if (entry) {
              entry.retired = true
              liveScopes.delete(entry)
            }
            throw error
          }
          let writer: WriterLease | undefined
          let key: ProtectedKeyHandle | undefined
          try {
            writer = await roots.acquireWriter(scope, root)
            key = await keys.create(scope, root, writer, randomUUID())
            return await createJournal(profile, scope, root, writer, key)
          } catch (error) {
            if (key) await keys.settleAndDispose(key).catch(() => undefined)
            await writer?.release().catch(() => undefined)
            roots.retire(root)
            await roots.closeRoot(scope, root).catch(() => undefined)
            const entry = scopes.get(scope as object)
            if (entry) liveScopes.delete(entry)
            throw error
          }
        })()
      )
    },
    openExisting(meetingId, keyReference) {
      return trackOperation(
        (async () => {
          const profile = requireActionableProfile()
          const scope = mintScope(profile, keyReference.journalGeneration)
          let root: OwnedMeetingRoot
          try {
            root = await roots.openExisting(scope, meetingId)
          } catch (error) {
            const entry = scopes.get(scope as object)
            if (entry) {
              entry.retired = true
              liveScopes.delete(entry)
            }
            throw error
          }
          let key: ProtectedKeyHandle | undefined
          try {
            key = await keys.open(scope, root, keyReference)
            return await createJournal(profile, scope, root, undefined, key)
          } catch (error) {
            if (key) await keys.settleAndDispose(key).catch(() => undefined)
            roots.retire(root)
            await roots.closeRoot(scope, root).catch(() => undefined)
            const entry = scopes.get(scope as object)
            if (entry) liveScopes.delete(entry)
            throw error
          }
        })()
      )
    },
    retire,
    async settle() {
      while (pendingOperations.size > 0) await Promise.allSettled([...pendingOperations])
      await Promise.allSettled([...journals].map((journal) => journal.settle()))
      await speech?.invalidateCurrent().catch(() => undefined)
    },
    async dispose() {
      if (disposed) return
      retire('dispose')
      disposed = true
      unsubscribeSettings()
      unsubscribeAuth()
      await this.settle()
      await speech?.dispose()
      speech = undefined
      capability = Object.freeze({ status: 'disposed' })
    }
  }
  refreshPolicy = bootstrap.prime
  return bootstrap
}

export function createMainPersistenceBootstrap(options: MainPersistenceBootstrapOptions): MainPersistenceBootstrap {
  return createMainPersistenceBootstrapInternal(options)
}

/** Source fixture only: exercises the same open/create/core path with explicit synthetic policy/key adapters. */
export function createMainPersistenceBootstrapWithSourceFixture(
  options: MainPersistenceBootstrapOptions,
  fixture: MainPersistenceBootstrapSourceFixture
): MainPersistenceBootstrap {
  return createMainPersistenceBootstrapInternal(options, fixture)
}

/** Captured in index.ts before the legacy macOS default is assigned. */
export function captureNativeKeyIntent(environmentValue: string | undefined): 'allowed' | 'explicitly-disabled' {
  return environmentValue === undefined || environmentValue === '' ? 'allowed' : 'explicitly-disabled'
}
