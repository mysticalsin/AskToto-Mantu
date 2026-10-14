import type { Settings } from '@shared/ipc'

export interface SpeechAuthSettingsObservation {
  readonly settings: Settings
  readonly readable: boolean
  readonly epoch: number
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
  readBoundary: (readers: SpeechAuthLeaseReaders) => Promise<VerifiedSpeechAuthBoundary | null>
  validateSession: (config: SpeechAuthConfig | null) => void
  sessionIsValid: (session: SpeechAuthSession, config: SpeechAuthConfig | null, now: number) => boolean
}

declare const speechAuthLeaseBrand: unique symbol
export type SpeechAuthLease = { readonly [speechAuthLeaseBrand]: true }

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
