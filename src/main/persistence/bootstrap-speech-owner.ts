import type { MeetingSpeechPersistenceService } from '../infra/process/meeting-speech-host'
import type { ResolvedPersistenceProfile } from './resource-policy'

export interface MainSpeechOwner {
  readonly profile: ResolvedPersistenceProfile
  readonly policyPublication: object
  readonly policyReadOperation: number
  readonly generation: string
  readonly service: MeetingSpeechPersistenceService | undefined
  isCurrent(): boolean
  attachService(service: MeetingSpeechPersistenceService): void
  publish(): boolean
  retire(): void
}

export interface MainSpeechOwnerOptions {
  readonly profile: ResolvedPersistenceProfile
  readonly policyPublication: object
  readonly policyReadOperation: number
  readonly generation: string
  readonly profilePath: string
  readonly isDisposed: () => boolean
  readonly isAdmissionPending: () => boolean
  readonly currentPolicyReadOperation: () => number
  readonly currentGeneration: () => string
  readonly currentProfilePath: () => string
  readonly isOriginalAuthorityCurrent: () => boolean
  readonly isPublished: (owner: MainSpeechOwner) => boolean
}

export function createMainSpeechOwner(options: MainSpeechOwnerOptions): MainSpeechOwner {
  let state: 'candidate' | 'published' | 'retired' = 'candidate'
  let service: MeetingSpeechPersistenceService | undefined
  let lastWallNow = Date.now()
  let lastMonotonicNow = performance.now()
  const enterpriseWindow = options.profile.enterpriseWindow
  const initialClockValid =
    Number.isFinite(lastWallNow) &&
    Number.isFinite(lastMonotonicNow) &&
    (!enterpriseWindow ||
      (Number.isFinite(enterpriseWindow.notBefore) &&
        Number.isFinite(enterpriseWindow.expiresAt) &&
        lastWallNow >= enterpriseWindow.notBefore &&
        lastWallNow < enterpriseWindow.expiresAt))

  function originalAuthorityCurrent(): boolean {
    try {
      const wallNow = Date.now()
      const monotonicNow = performance.now()
      if (
        !initialClockValid ||
        !Number.isFinite(wallNow) ||
        !Number.isFinite(monotonicNow) ||
        wallNow < lastWallNow ||
        monotonicNow < lastMonotonicNow ||
        (enterpriseWindow && (wallNow < enterpriseWindow.notBefore || wallNow >= enterpriseWindow.expiresAt)) ||
        options.isDisposed() ||
        options.currentPolicyReadOperation() !== options.policyReadOperation ||
        options.currentGeneration() !== options.generation ||
        options.currentProfilePath() !== options.profilePath ||
        !options.isOriginalAuthorityCurrent()
      )
        return false
      lastWallNow = wallNow
      lastMonotonicNow = monotonicNow
      return true
    } catch {
      return false
    }
  }

  const owner: MainSpeechOwner = {
    profile: options.profile,
    policyPublication: options.policyPublication,
    policyReadOperation: options.policyReadOperation,
    generation: options.generation,
    get service() {
      return service
    },
    isCurrent() {
      if (state !== 'published') return false
      if (!originalAuthorityCurrent() || options.isAdmissionPending() || !service || !options.isPublished(owner)) {
        state = 'retired'
        return false
      }
      return true
    },
    attachService(value) {
      if (state !== 'candidate' || service) throw new Error('Speech owner candidate cannot accept another service')
      service = value
    },
    publish() {
      if (state !== 'candidate' || !service || options.isAdmissionPending() || !originalAuthorityCurrent()) {
        state = 'retired'
        return false
      }
      state = 'published'
      return true
    },
    retire() {
      state = 'retired'
    }
  }
  return owner
}

export function requirePublishedMainSpeechOwner(
  owner: MainSpeechOwner | undefined,
  profile: ResolvedPersistenceProfile
): MainSpeechOwner {
  if (!owner || owner.profile !== profile || !owner.isCurrent())
    throw new Error('The admitted speech policy owner is unavailable')
  return owner
}
