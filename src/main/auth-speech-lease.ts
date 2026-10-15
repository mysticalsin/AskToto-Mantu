import type { Settings } from '@shared/ipc'
import type { AuthEnvironmentSnapshot } from './auth-config'
import { createHash } from 'node:crypto'
import {
  assertVerifiedSpeechAuthBoundaryCurrent,
  getVerifiedSpeechAuthBoundaryPersistenceReceipt,
  getVerifiedSpeechAuthBoundaryEnvironmentSnapshot,
  isVerifiedSpeechAuthBoundary,
  sameVerifiedSpeechAuthBoundarySources
} from './auth-speech-boundary'

export interface SpeechAuthSettingsObservation {
  readonly settings: Settings
  readonly readable: boolean
  readonly epoch: number
  readonly authoritySnapshot?: object
}

export interface SpeechAuthLeaseReaders {
  readSettingsAtBoundary: () => Promise<SpeechAuthSettingsObservation | null>
  readSettingsEpoch: () => number
  readPolicyPathsRevision: () => string
  readTrustedAdminManagedBytes?: (path: string) => Promise<Uint8Array | null>
}

export interface SpeechAuthConfig {
  readonly clientId: string
  readonly tenantId: string
  readonly allowedDomain: string
}

export interface SpeechAuthSession {
  readonly email: string
  readonly domain: string
  readonly tid: string
  readonly at: number
}

export interface VerifiedSpeechAuthBoundary {
  readonly observation: SpeechAuthSettingsObservation
  readonly settingsEpoch: number
  readonly pathsRevision: string
  readonly config: SpeechAuthConfig | null
  readonly enforced: boolean
  readonly sticky: boolean
  readonly session: SpeechAuthSession | null
}

export interface SpeechAuthLeaseDependencies {
  prepareSession: () => void
  readSession: () => SpeechAuthSession | null
  readSessionEpoch: () => number
  readProfilePath: () => string
  isPersistenceSettingsReceiptCurrent?: (receipt: object) => boolean
  isAuthEnvironmentSnapshotCurrent?: (snapshot: AuthEnvironmentSnapshot) => boolean
  readBoundary: (readers: SpeechAuthLeaseReaders) => Promise<VerifiedSpeechAuthBoundary | null>
  readMainPersistenceBoundary?: (isOriginalFenceCurrent: () => boolean) => Promise<VerifiedSpeechAuthBoundary | null>
  validateSession: (config: SpeechAuthConfig | null) => void
  sessionIsValid: (session: SpeechAuthSession, config: SpeechAuthConfig | null, now: number) => boolean
}

declare const speechAuthLeaseBrand: unique symbol
export type SpeechAuthLease = { readonly [speechAuthLeaseBrand]: true }

declare const mainPersistenceBoundaryBrand: unique symbol
export interface MainPersistenceSessionBoundary {
  readonly [mainPersistenceBoundaryBrand]: true
  readonly principalAssociation: string | null
  readonly configured: boolean
  isCurrent(): boolean
}

export interface MainPersistenceSessionBoundaryInput {
  readonly config: SpeechAuthConfig | null
  readonly enforced: boolean
  readonly sticky: boolean
}

function persistencePrincipal(session: SpeechAuthSession): string | null {
  const tenant = session.tid.trim().toLowerCase()
  const email = session.email.trim().toLowerCase()
  const domain = session.domain.trim().toLowerCase()
  if (!tenant || !email || !domain || !email.endsWith(`@${domain}`)) return null
  return createHash('sha256').update(`metis-persistence-principal/v1\n${tenant}\n${domain}\n${email}`).digest('hex')
}

function sameSessionSnapshot(current: SpeechAuthSession | null, snapshot: SpeechAuthSession | null): boolean {
  return current === null || snapshot === null
    ? current === snapshot
    : current.email === snapshot.email &&
        current.domain === snapshot.domain &&
        current.tid === snapshot.tid &&
        current.at === snapshot.at
}

interface PublishedMainPersistenceObservation {
  readonly config: SpeechAuthConfig | null
  readonly configured: boolean
  readonly enforced: boolean
  readonly sticky: boolean
  readonly settingsReceipt: object
  readonly session: SpeechAuthSession | null
  readonly sessionSnapshot: SpeechAuthSession | null
  readonly sessionEpoch: number
  readonly profilePath: string
  readonly environmentSnapshot: AuthEnvironmentSnapshot
  readonly authorityEpoch: number
  readonly semanticEpoch: number
  readonly principalAssociation: string | null
  readonly verifiedBoundary: VerifiedSpeechAuthBoundary
}

interface LeaseRecord {
  readonly config: SpeechAuthConfig | null
  readonly enforced: boolean
  readonly sticky: boolean
  readonly sessionSnapshot: SpeechAuthSession | null
  readonly sessionIdentity: SpeechAuthSession | null
  readonly sessionEpoch: number
  readonly authorityEpoch: number
  readonly semanticEpoch: number
  readonly settingsEpoch: number
  readonly policyPathsRevision: string
  readonly profilePath: string
  readonly wallStartedAt: number
  readonly monotonicStartedAt: number
  lastWallNow: number
  lastMonotonicNow: number
  retired: boolean
}

const MAX_AGE_MS = 60_000

function settingsSemantic(settings: Settings): string {
  return JSON.stringify([
    String(settings.azureClientId || '').trim(),
    String(settings.azureTenantId || '').trim(),
    String(settings.azureAllowedDomain || '')
      .trim()
      .replace(/^@/, '')
  ])
}

function sameConfig(left: SpeechAuthConfig | null, right: SpeechAuthConfig | null): boolean {
  return (
    left === right ||
    (!!left &&
      !!right &&
      left.clientId === right.clientId &&
      left.tenantId === right.tenantId &&
      left.allowedDomain === right.allowedDomain)
  )
}

export class SpeechAuthLeaseController {
  private readonly records = new WeakMap<object, LeaseRecord>()
  private readonly listeners = new Set<() => void>()
  private authorityEpoch = 0
  private semanticEpoch = 0
  private authorityKey: string | null = null
  private observedSettingsEpoch: number | null = null
  private observedSettingsSemantic: string | null = null
  private observedPolicyPathsRevision: string | null = null
  private observedReadable = false
  private notifying = false
  private readers: SpeechAuthLeaseReaders | null = null
  private boundaryGeneration = 0
  private latestRecord: LeaseRecord | null = null
  private inFlight: Promise<SpeechAuthLease | null> | null = null
  private publishedMainPersistence: PublishedMainPersistenceObservation | null = null
  private inFlightMainPersistence: Promise<MainPersistenceSessionBoundary | null> | null = null
  private readonly publishedMainBoundaries = new WeakMap<object, MainPersistenceSessionBoundary>()

  constructor(private readonly dependencies: SpeechAuthLeaseDependencies) {}

  /** Bind non-speech async reads to the underlying auth session without minting a provider lease. */
  captureSessionBoundary(isAuthorized: () => boolean): () => boolean {
    const session = this.dependencies.readSession()
    const sessionEpoch = this.dependencies.readSessionEpoch()
    const profilePath = this.dependencies.readProfilePath()
    return () =>
      this.dependencies.readProfilePath() === profilePath &&
      this.dependencies.readSessionEpoch() === sessionEpoch &&
      this.dependencies.readSession() === session &&
      isAuthorized()
  }

  /** Hash the verified in-memory tenant/account association without exposing raw identity to callers. */
  capturePersistencePrincipal(): string | null {
    const session = this.dependencies.readSession()
    return session ? persistencePrincipal(session) : null
  }

  /** Explicit preparation API. Its caller has already performed the actual auth refresh. */
  captureMainPersistenceSessionBoundary(input: MainPersistenceSessionBoundaryInput): MainPersistenceSessionBoundary {
    const session = this.dependencies.readSession()
    const sessionSnapshot = session ? { ...session } : null
    const sessionEpoch = this.dependencies.readSessionEpoch()
    const profilePath = this.dependencies.readProfilePath()
    const authorityEpoch = this.authorityEpoch
    const semanticEpoch = this.semanticEpoch
    const config = input.config ? { ...input.config } : null
    const configured = config !== null
    const principalAssociation = this.capturePersistencePrincipal()
    let lastWallNow = Date.now()
    let lastMonotonicNow = performance.now()
    const boundary = Object.freeze({
      principalAssociation,
      configured,
      isCurrent: () => {
        const wallNow = Date.now()
        const monotonicNow = performance.now()
        const currentSession = this.dependencies.readSession()
        if (
          !(input.enforced || input.sticky ? !!currentSession : !configured || !!currentSession) ||
          this.authorityEpoch !== authorityEpoch ||
          this.semanticEpoch !== semanticEpoch ||
          this.dependencies.readSessionEpoch() !== sessionEpoch ||
          this.dependencies.readProfilePath() !== profilePath ||
          currentSession !== session ||
          !Number.isFinite(wallNow) ||
          !Number.isFinite(monotonicNow) ||
          wallNow < lastWallNow ||
          monotonicNow < lastMonotonicNow
        ) {
          return false
        }
        if (sessionSnapshot) {
          if (
            !currentSession ||
            currentSession.email !== sessionSnapshot.email ||
            currentSession.domain !== sessionSnapshot.domain ||
            currentSession.tid !== sessionSnapshot.tid ||
            currentSession.at !== sessionSnapshot.at ||
            !this.dependencies.sessionIsValid(currentSession, config, wallNow)
          ) {
            return false
          }
        } else if (currentSession !== null || input.enforced || input.sticky || configured) {
          return false
        }
        lastWallNow = wallNow
        lastMonotonicNow = monotonicNow
        return true
      }
    }) as MainPersistenceSessionBoundary
    return boundary
  }

  /** Explicit C1 producer; only a privately associated store/auth frame can reach publication. */
  refreshMainPersistenceSessionObservation(): Promise<MainPersistenceSessionBoundary | null> {
    if (this.inFlightMainPersistence) return this.inFlightMainPersistence
    const pending = this.prepareMainPersistenceObservation()
    this.inFlightMainPersistence = pending
    void pending.then(
      () => {
        if (this.inFlightMainPersistence === pending) this.inFlightMainPersistence = null
      },
      () => {
        if (this.inFlightMainPersistence === pending) this.inFlightMainPersistence = null
      }
    )
    return pending
  }

  private async prepareMainPersistenceObservation(): Promise<MainPersistenceSessionBoundary | null> {
    const reader = this.dependencies.readMainPersistenceBoundary
    if (!reader) {
      this.retireMainPersistence()
      return null
    }
    let boundaryGeneration: number
    try {
      this.dependencies.prepareSession()
      boundaryGeneration = ++this.boundaryGeneration
    } catch {
      this.retireMainPersistence()
      return null
    }
    let session: SpeechAuthSession | null
    let sessionSnapshot: SpeechAuthSession | null
    let sessionEpoch: number
    let profilePath: string
    let authorityEpoch: number
    let semanticEpoch: number
    try {
      session = this.dependencies.readSession()
      sessionSnapshot = session ? Object.freeze({ ...session }) : null
      sessionEpoch = this.dependencies.readSessionEpoch()
      profilePath = this.dependencies.readProfilePath()
      authorityEpoch = this.authorityEpoch
      semanticEpoch = this.semanticEpoch
    } catch {
      this.retireMainPersistence()
      return null
    }
    let originalFenceRetired = false
    const isOriginalSessionValueCurrent = () => {
      const currentSession = this.dependencies.readSession()
      if (currentSession !== session || !sameSessionSnapshot(currentSession, sessionSnapshot))
        originalFenceRetired = true
      return !originalFenceRetired
    }
    const isOriginalFenceCurrent = () => {
      const isCurrent =
        boundaryGeneration === this.boundaryGeneration &&
        this.authorityEpoch === authorityEpoch &&
        this.semanticEpoch === semanticEpoch &&
        this.dependencies.readSessionEpoch() === sessionEpoch &&
        this.dependencies.readProfilePath() === profilePath &&
        isOriginalSessionValueCurrent()
      if (!isCurrent) originalFenceRetired = true
      return !originalFenceRetired
    }
    let boundary: VerifiedSpeechAuthBoundary | null = null
    try {
      boundary = await reader(isOriginalFenceCurrent)
      if (!boundary || !isOriginalFenceCurrent() || !isVerifiedSpeechAuthBoundary(boundary))
        throw new Error('Stale auth frame')
      await assertVerifiedSpeechAuthBoundaryCurrent(boundary)
      if (!isOriginalFenceCurrent()) throw new Error('Original auth fence changed')
      const settingsReceipt = getVerifiedSpeechAuthBoundaryPersistenceReceipt(boundary)
      if (!settingsReceipt || !this.dependencies.isPersistenceSettingsReceiptCurrent?.(settingsReceipt))
        throw new Error('Settings receipt is not current')
      const environmentSnapshot = getVerifiedSpeechAuthBoundaryEnvironmentSnapshot(boundary)
      if (!environmentSnapshot || !this.dependencies.isAuthEnvironmentSnapshotCurrent?.(environmentSnapshot))
        throw new Error('Auth environment changed during preparation')
      if (boundary.session !== session || !sameSessionSnapshot(boundary.session, sessionSnapshot))
        throw new Error('Session changed during authority read')
      this.dependencies.validateSession(boundary.config)
      if (!isOriginalFenceCurrent() || this.dependencies.readSession() !== session)
        throw new Error('Session validation changed the captured session')

      const observation = boundary.observation
      const changedSettings = this.observeSettings(observation, boundary.pathsRevision)
      const expectedAuthorityEpoch = authorityEpoch + (changedSettings ? 1 : 0)
      const expectedSemanticEpoch = semanticEpoch + (changedSettings ? 1 : 0)
      if (
        boundaryGeneration !== this.boundaryGeneration ||
        this.authorityEpoch !== expectedAuthorityEpoch ||
        this.semanticEpoch !== expectedSemanticEpoch ||
        this.dependencies.readSessionEpoch() !== sessionEpoch ||
        this.dependencies.readProfilePath() !== profilePath ||
        !isOriginalSessionValueCurrent() ||
        !this.dependencies.isPersistenceSettingsReceiptCurrent?.(settingsReceipt)
      )
        throw new Error('Authority changed before publication')

      const allowed = boundary.enforced || boundary.sticky ? !!session : !boundary.config || !!session
      if (!allowed) throw new Error('Auth policy requires a session')
      const principalAssociation = sessionSnapshot ? persistencePrincipal(sessionSnapshot) : null
      const previous = this.publishedMainPersistence
      if (
        previous &&
        this.isPublishedMainPersistenceCurrent(previous) &&
        previous.session === session &&
        previous.sessionEpoch === sessionEpoch &&
        previous.profilePath === profilePath &&
        JSON.stringify(previous.environmentSnapshot) === JSON.stringify(environmentSnapshot) &&
        previous.configured === (boundary.config !== null) &&
        previous.enforced === boundary.enforced &&
        previous.sticky === boundary.sticky &&
        sameConfig(previous.config, boundary.config) &&
        previous.settingsReceipt === settingsReceipt &&
        previous.principalAssociation === principalAssociation &&
        sameVerifiedSpeechAuthBoundarySources(previous.verifiedBoundary, boundary)
      )
        return this.capturePublishedMainPersistenceSessionBoundary()

      if (previous) {
        this.retireMainPersistence(previous)
        if (
          boundaryGeneration !== this.boundaryGeneration ||
          this.dependencies.readSessionEpoch() !== sessionEpoch ||
          this.dependencies.readProfilePath() !== profilePath ||
          !isOriginalSessionValueCurrent() ||
          !this.dependencies.isPersistenceSettingsReceiptCurrent?.(settingsReceipt)
        )
          throw new Error('Original authority changed while retiring prior publication')
      }
      const published: PublishedMainPersistenceObservation = Object.freeze({
        config: boundary.config ? Object.freeze({ ...boundary.config }) : null,
        configured: boundary.config !== null,
        enforced: boundary.enforced,
        sticky: boundary.sticky,
        settingsReceipt,
        session,
        sessionSnapshot,
        sessionEpoch,
        profilePath,
        environmentSnapshot,
        authorityEpoch: this.authorityEpoch,
        semanticEpoch: this.semanticEpoch,
        principalAssociation,
        verifiedBoundary: boundary
      })
      this.publishedMainPersistence = published
      return this.createPublishedBoundary(published)
    } catch {
      this.retireMainPersistence()
      return null
    }
  }

  /** Read-only currentness over the last coherent authStatus publication; never starts preparation. */
  capturePublishedMainPersistenceSessionBoundary(): MainPersistenceSessionBoundary | null {
    const published = this.publishedMainPersistence
    if (!published || !this.isPublishedMainPersistenceCurrent(published)) return null
    return this.createPublishedBoundary(published)
  }

  private createPublishedBoundary(published: PublishedMainPersistenceObservation): MainPersistenceSessionBoundary {
    const existing = this.publishedMainBoundaries.get(published as object)
    if (existing) return existing
    let lastWallNow = Date.now()
    let lastMonotonicNow = performance.now()
    const boundary = Object.freeze({
      principalAssociation: published.principalAssociation,
      configured: published.configured,
      isCurrent: () => {
        const wallNow = Date.now()
        const monotonicNow = performance.now()
        if (
          !this.isPublishedMainPersistenceCurrent(published) ||
          !Number.isFinite(wallNow) ||
          !Number.isFinite(monotonicNow) ||
          wallNow < lastWallNow ||
          monotonicNow < lastMonotonicNow
        ) {
          this.retireMainPersistence(published)
          return false
        }
        lastWallNow = wallNow
        lastMonotonicNow = monotonicNow
        return true
      }
    }) as MainPersistenceSessionBoundary
    this.publishedMainBoundaries.set(published as object, boundary)
    return boundary
  }

  private isPublishedMainPersistenceCurrent(published: PublishedMainPersistenceObservation): boolean {
    if (
      this.publishedMainPersistence !== published ||
      this.authorityEpoch !== published.authorityEpoch ||
      this.semanticEpoch !== published.semanticEpoch ||
      this.dependencies.readSessionEpoch() !== published.sessionEpoch ||
      this.dependencies.readProfilePath() !== published.profilePath ||
      this.dependencies.readSession() !== published.session ||
      !this.dependencies.isAuthEnvironmentSnapshotCurrent?.(published.environmentSnapshot) ||
      !this.dependencies.isPersistenceSettingsReceiptCurrent?.(published.settingsReceipt)
    ) {
      this.retireMainPersistence(published)
      return false
    }
    const session = published.session
    if (session) {
      const snapshot = published.sessionSnapshot
      if (
        !snapshot ||
        session.email !== snapshot.email ||
        session.domain !== snapshot.domain ||
        session.tid !== snapshot.tid ||
        session.at !== snapshot.at ||
        !this.dependencies.sessionIsValid(session, published.config, Date.now())
      ) {
        this.retireMainPersistence(published)
        return false
      }
    } else if (published.enforced || published.sticky || published.configured) {
      this.retireMainPersistence(published)
      return false
    }
    return true
  }

  private retireMainPersistence(expected?: PublishedMainPersistenceObservation): void {
    if (expected && this.publishedMainPersistence !== expected) return
    if (!this.publishedMainPersistence) return
    this.publishedMainPersistence = null
    this.semanticEpoch += 1
  }

  /** Legacy synchronous auth reads may revoke stale C1 state, but cannot create or refresh it. */
  retireMainPersistenceIfStatusDisagrees(config: SpeechAuthConfig | null, enforced: boolean, sticky: boolean): void {
    const published = this.publishedMainPersistence
    if (!published) return
    if (
      !sameConfig(published.config, config) ||
      published.enforced !== enforced ||
      published.sticky !== sticky ||
      !this.isPublishedMainPersistenceCurrent(published)
    )
      this.retireMainPersistence(published)
  }

  private retire(): void {
    this.authorityEpoch += 1
    if (this.latestRecord) this.latestRecord.retired = true
    this.latestRecord = null
    if (this.notifying) return
    this.notifying = true
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        // An owner cannot retain authority because a teardown callback failed.
      }
    }
    this.notifying = false
  }

  invalidate(): void {
    this.authorityKey = null
    this.publishedMainPersistence = null
    this.retire()
  }

  configureReaders(readers: SpeechAuthLeaseReaders): void {
    this.readers = readers
    this.boundaryGeneration += 1
    this.invalidate()
  }

  resetReaders(): void {
    this.readers = null
    this.boundaryGeneration += 1
    this.invalidate()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  observeSettings(observation: SpeechAuthSettingsObservation, pathsRevision: string): boolean {
    const semantic = observation.readable ? settingsSemantic(observation.settings) : null
    const backwards = this.observedSettingsEpoch !== null && observation.epoch < this.observedSettingsEpoch
    const changed =
      this.observedReadable !== observation.readable ||
      this.observedSettingsSemantic !== semantic ||
      this.observedPolicyPathsRevision !== pathsRevision ||
      backwards
    this.observedReadable = observation.readable
    this.observedSettingsSemantic = semantic
    this.observedPolicyPathsRevision = pathsRevision
    this.observedSettingsEpoch = observation.epoch
    if (changed) {
      this.semanticEpoch += 1
      this.invalidate()
    }
    return changed
  }

  private recordFresh(record: LeaseRecord): boolean {
    if (record.retired) return false
    const wallNow = Date.now()
    const monotonicNow = performance.now()
    if (
      !Number.isFinite(wallNow) ||
      !Number.isFinite(monotonicNow) ||
      !Number.isFinite(record.wallStartedAt) ||
      !Number.isFinite(record.monotonicStartedAt) ||
      wallNow < record.wallStartedAt ||
      monotonicNow < record.monotonicStartedAt ||
      wallNow < record.lastWallNow ||
      monotonicNow < record.lastMonotonicNow ||
      wallNow - record.wallStartedAt > MAX_AGE_MS ||
      monotonicNow - record.monotonicStartedAt > MAX_AGE_MS
    ) {
      record.retired = true
      return false
    }
    const currentSession = this.dependencies.readSession()
    if (record.sessionEpoch !== this.dependencies.readSessionEpoch() || record.sessionIdentity !== currentSession) {
      record.retired = true
      return false
    }
    if (record.sessionSnapshot) {
      if (
        !currentSession ||
        currentSession.email !== record.sessionSnapshot.email ||
        currentSession.domain !== record.sessionSnapshot.domain ||
        currentSession.tid !== record.sessionSnapshot.tid ||
        currentSession.at !== record.sessionSnapshot.at ||
        !this.dependencies.sessionIsValid(currentSession, record.config, wallNow)
      ) {
        record.retired = true
        return false
      }
    } else if (currentSession !== null) {
      record.retired = true
      return false
    }
    record.lastWallNow = wallNow
    record.lastMonotonicNow = monotonicNow
    return record.enforced || record.sticky ? !!record.sessionSnapshot : !record.config || !!record.sessionSnapshot
  }

  private retireIfPriorProofStale(): boolean {
    const record = this.latestRecord
    if (!record) return false
    let sourcesCurrent = false
    try {
      sourcesCurrent =
        this.readers !== null &&
        this.observedSettingsEpoch !== null &&
        this.readers.readSettingsEpoch() === this.observedSettingsEpoch &&
        this.observedPolicyPathsRevision === record.policyPathsRevision &&
        this.readers.readPolicyPathsRevision() === this.observedPolicyPathsRevision
    } catch {
      sourcesCurrent = false
    }
    if (!this.recordFresh(record) || !sourcesCurrent) {
      this.semanticEpoch += 1
      this.invalidate()
      return true
    }
    return false
  }

  refresh(): Promise<SpeechAuthLease | null> {
    // A concurrent caller shares this captured boundary. If any source changes while it is held, that
    // boundary resolves closed; the caller must explicitly request a new one afterward.
    if (this.inFlight) return this.inFlight
    let resolve!: (value: SpeechAuthLease | null) => void
    const pending = new Promise<SpeechAuthLease | null>((resolvePending) => {
      resolve = resolvePending
    })
    this.inFlight = pending
    void this.refreshBoundary().then(
      (value) => {
        resolve(value)
        if (this.inFlight === pending) this.inFlight = null
      },
      () => {
        this.invalidate()
        resolve(null)
        if (this.inFlight === pending) this.inFlight = null
      }
    )
    return pending
  }

  private async refreshBoundary(): Promise<SpeechAuthLease | null> {
    const readers = this.readers
    if (!readers) return null
    const operation = ++this.boundaryGeneration
    const wallStartedAt = Date.now()
    const monotonicStartedAt = performance.now()
    this.dependencies.prepareSession()
    const profilePath = this.dependencies.readProfilePath()
    this.retireIfPriorProofStale()
    const authorityAtStart = this.authorityEpoch
    const sessionAtStart = this.dependencies.readSessionEpoch()
    const semanticAtStart = this.semanticEpoch
    let boundary: VerifiedSpeechAuthBoundary | null
    try {
      boundary = await this.dependencies.readBoundary(readers)
    } catch {
      boundary = null
    }
    if (!boundary) {
      if (operation === this.boundaryGeneration) this.invalidate()
      return null
    }
    if (operation !== this.boundaryGeneration) return null
    try {
      if (
        this.readers !== readers ||
        this.authorityEpoch !== authorityAtStart ||
        this.dependencies.readSessionEpoch() !== sessionAtStart ||
        this.semanticEpoch !== semanticAtStart ||
        this.dependencies.readProfilePath() !== profilePath ||
        boundary.settingsEpoch !== boundary.observation.epoch ||
        readers.readSettingsEpoch() !== boundary.settingsEpoch ||
        readers.readPolicyPathsRevision() !== boundary.pathsRevision
      ) {
        this.invalidate()
        return null
      }
    } catch {
      this.invalidate()
      return null
    }
    let expectedAuthorityEpoch = this.authorityEpoch
    let expectedSemanticEpoch = this.semanticEpoch
    if (this.observeSettings(boundary.observation, boundary.pathsRevision)) {
      expectedAuthorityEpoch += 1
      expectedSemanticEpoch += 1
    }
    if (this.retireIfPriorProofStale()) {
      expectedAuthorityEpoch += 1
      expectedSemanticEpoch += 1
    }
    this.dependencies.validateSession(boundary.config)
    const liveSession = this.dependencies.readSession()
    const allowed = boundary.enforced || boundary.sticky ? !!liveSession : !boundary.config || !!liveSession
    const key = JSON.stringify({
      config: boundary.config,
      enforced: boundary.enforced,
      sticky: boundary.sticky,
      signedIn: !!liveSession,
      sessionEpoch: this.dependencies.readSessionEpoch(),
      profilePath,
      pathsRevision: boundary.pathsRevision
    })
    if (this.authorityKey !== null && this.authorityKey !== key) {
      this.semanticEpoch += 1
      this.invalidate()
      expectedAuthorityEpoch += 1
      expectedSemanticEpoch += 1
    }
    this.authorityKey = key
    // Observation and expiry callbacks can synchronously re-enter auth or replace the readers. A
    // boundary captured before that callback is never published under the callback's newer authority.
    try {
      if (
        operation !== this.boundaryGeneration ||
        this.readers !== readers ||
        this.authorityEpoch !== expectedAuthorityEpoch ||
        this.semanticEpoch !== expectedSemanticEpoch ||
        this.dependencies.readSessionEpoch() !== sessionAtStart ||
        this.dependencies.readProfilePath() !== profilePath ||
        readers.readSettingsEpoch() !== boundary.settingsEpoch ||
        readers.readPolicyPathsRevision() !== boundary.pathsRevision
      ) {
        this.invalidate()
        return null
      }
    } catch {
      this.invalidate()
      return null
    }
    if (!allowed || !Number.isFinite(wallStartedAt) || !Number.isFinite(monotonicStartedAt)) return null
    const sessionSnapshot = liveSession ? { ...liveSession } : null
    if (sessionSnapshot && (!Number.isFinite(sessionSnapshot.at) || wallStartedAt < sessionSnapshot.at)) return null
    const wallFinishedAt = Date.now()
    const monotonicFinishedAt = performance.now()
    if (
      !Number.isFinite(wallFinishedAt) ||
      wallFinishedAt < wallStartedAt ||
      wallFinishedAt - wallStartedAt > MAX_AGE_MS ||
      !Number.isFinite(monotonicFinishedAt) ||
      monotonicFinishedAt < monotonicStartedAt ||
      monotonicFinishedAt - monotonicStartedAt > MAX_AGE_MS
    ) {
      return null
    }
    const lease = Object.freeze(Object.create(null)) as SpeechAuthLease
    const record: LeaseRecord = {
      config: boundary.config ? { ...boundary.config } : null,
      enforced: boundary.enforced,
      sticky: boundary.sticky,
      sessionSnapshot,
      sessionIdentity: liveSession,
      sessionEpoch: this.dependencies.readSessionEpoch(),
      authorityEpoch: this.authorityEpoch,
      semanticEpoch: this.semanticEpoch,
      settingsEpoch: boundary.settingsEpoch,
      policyPathsRevision: boundary.pathsRevision,
      profilePath,
      wallStartedAt,
      monotonicStartedAt,
      lastWallNow: wallStartedAt,
      lastMonotonicNow: monotonicStartedAt,
      retired: false
    }
    this.records.set(lease, record)
    this.latestRecord = record
    return lease
  }

  isCurrent(lease: SpeechAuthLease | null): boolean {
    const readers = this.readers
    if (!readers || !lease || typeof lease !== 'object') return false
    const record = this.records.get(lease)
    if (
      !record ||
      record.authorityEpoch !== this.authorityEpoch ||
      record.semanticEpoch !== this.semanticEpoch ||
      !this.recordFresh(record)
    ) {
      return false
    }
    try {
      if (
        this.observedSettingsEpoch === null ||
        readers.readSettingsEpoch() !== this.observedSettingsEpoch ||
        this.observedPolicyPathsRevision !== record.policyPathsRevision
      ) {
        record.retired = true
        return false
      }
      return true
    } catch {
      record.retired = true
      return false
    }
  }
}
