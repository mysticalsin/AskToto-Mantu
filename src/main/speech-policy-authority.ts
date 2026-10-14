import { createHash } from 'node:crypto'
import { OPERATOR_LICENSE_MAX, parseOperatorLicense } from '@shared/operator-license'
import { resolveOperatorBaseUrl } from '@shared/operator'
import type { ModelPolicyDocument } from '@shared/model-policy'
import { hashOperatorId } from './operator-hmac-sign'

export const VERIFIED_SPEECH_POLICY_MAX_AGE_MS = 60_000
const MAX_SCOPED_POLICY_HIGH_WATER = 32

export interface SpeechPolicyIdentitySettings {
  operatorUrl?: string
  operatorIngestSecret?: string
  operatorLicenseToken?: string
}

export interface SpeechPolicyIdentitySource {
  settings: SpeechPolicyIdentitySettings
  durableDeviceId: string | null
}

export type SpeechPolicyIdentityReader = () => SpeechPolicyIdentitySource

export interface SpeechPolicyIdentity {
  origin: string
  credentialDigest: string
  deviceIdHash: string
  /** Internal scope key. It contains only hashes and is never returned in the policy snapshot. */
  scopeKey: string
  /** The direct seat licence is held only while constructing the authenticated request. */
  licenseToken: string
}

export interface VerifiedSpeechPolicy {
  origin: string
  credentialDigest: string
  deviceIdHash: string
  verifiedAt: number
  revision: string
  policy: ModelPolicyDocument
}

type PolicyHighWater = {
  version: number
  revision: string
  kind: 'managed' | 'unmanaged'
}

export type SpeechPolicyAcceptResult = 'accepted' | 'unmanaged' | 'lower-version' | 'conflict' | 'capacity'

export function normalizeSpeechPolicyOrigin(raw: string): string | null {
  try {
    const url = new URL(raw)
    const authority = /^https:\/\/([^/?#]*)/i.exec(raw)?.[1] ?? ''
    if (
      url.protocol !== 'https:' ||
      authority.includes('@') ||
      url.username ||
      url.password ||
      (url.pathname !== '' && url.pathname !== '/') ||
      raw.includes('?') ||
      raw.includes('#')
    ) {
      return null
    }
    return url.origin
  } catch {
    return null
  }
}

export function resolveSpeechPolicyIdentity(
  settings: SpeechPolicyIdentitySettings,
  durableDeviceId: string | null,
  now = Date.now()
): SpeechPolicyIdentity | null {
  const licenseToken = settings.operatorLicenseToken?.trim() ?? ''
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !licenseToken ||
    licenseToken.length > OPERATOR_LICENSE_MAX ||
    !durableDeviceId?.trim()
  ) {
    return null
  }
  const parsed = parseOperatorLicense(licenseToken)
  if (
    !parsed ||
    !Number.isSafeInteger(parsed.iat) ||
    !Number.isSafeInteger(parsed.exp) ||
    parsed.iat < 0 ||
    parsed.exp <= parsed.iat ||
    parsed.iat * 1000 > now ||
    parsed.exp * 1000 <= now
  ) {
    return null
  }
  const origin = normalizeSpeechPolicyOrigin(resolveOperatorBaseUrl(settings))
  if (!origin) return null
  const credentialDigest = createHash('sha256').update(licenseToken, 'utf8').digest('hex')
  const deviceIdHash = hashOperatorId(durableDeviceId)
  const scopeKey = createHash('sha256').update(`${origin}\0${credentialDigest}\0${deviceIdHash}`, 'utf8').digest('hex')
  return { origin, credentialDigest, deviceIdHash, scopeKey, licenseToken }
}

export function sameSpeechPolicyIdentity(
  left: SpeechPolicyIdentity | null,
  right: SpeechPolicyIdentity | null
): boolean {
  return left !== null && right !== null && left.scopeKey === right.scopeKey
}

function clonePolicy(policy: ModelPolicyDocument): ModelPolicyDocument {
  return JSON.parse(JSON.stringify(policy)) as ModelPolicyDocument
}

export class SpeechPolicyAuthority {
  private readonly snapshots = new Map<string, VerifiedSpeechPolicy>()
  private readonly highWater = new Map<string, PolicyHighWater>()
  private activeScopeKey: string | null = null
  private identityEpoch = 0

  observeIdentity(identity: SpeechPolicyIdentity | null): number {
    const next = identity?.scopeKey ?? null
    if (next !== this.activeScopeKey) {
      this.activeScopeKey = next
      this.identityEpoch++
    }
    return this.identityEpoch
  }

  capture(identity: SpeechPolicyIdentity | null): { scopeKey: string; epoch: number } | null {
    if (!identity) {
      this.observeIdentity(null)
      return null
    }
    return { scopeKey: identity.scopeKey, epoch: this.observeIdentity(identity) }
  }

  isCurrent(captured: { scopeKey: string; epoch: number } | null, identity: SpeechPolicyIdentity | null): boolean {
    if (!captured) return false
    const epoch = this.observeIdentity(identity)
    return identity !== null && captured.scopeKey === identity.scopeKey && captured.epoch === epoch
  }

  invalidate(identity: SpeechPolicyIdentity | null): void {
    if (identity) this.snapshots.delete(identity.scopeKey)
  }

  acceptManaged(
    identity: SpeechPolicyIdentity,
    policy: ModelPolicyDocument,
    verifiedAt: number,
    revision: string
  ): SpeechPolicyAcceptResult {
    if (!Number.isSafeInteger(policy.version) || !Number.isFinite(verifiedAt)) {
      this.snapshots.delete(identity.scopeKey)
      return 'conflict'
    }
    const result = this.compareAndRecord(identity.scopeKey, policy.version, revision, 'managed')
    if (result !== 'accepted') return result
    this.snapshots.set(identity.scopeKey, {
      origin: identity.origin,
      credentialDigest: identity.credentialDigest,
      deviceIdHash: identity.deviceIdHash,
      verifiedAt,
      revision,
      policy: clonePolicy(policy)
    })
    return 'accepted'
  }

  acceptUnmanaged(identity: SpeechPolicyIdentity, version: number, revision: string): SpeechPolicyAcceptResult {
    // A verified signed-null response explicitly says this identity is unmanaged. Even a stale
    // version must revoke the currently usable snapshot; retain the high-water mark so stale
    // managed documents cannot restore authority afterward.
    this.snapshots.delete(identity.scopeKey)
    if (!Number.isSafeInteger(version) || version < 0) {
      return 'conflict'
    }
    const result = this.compareAndRecord(identity.scopeKey, version, revision, 'unmanaged')
    return result === 'accepted' ? 'unmanaged' : result
  }

  get(identity: SpeechPolicyIdentity | null, now = Date.now()): VerifiedSpeechPolicy | null {
    if (!identity) {
      this.observeIdentity(null)
      return null
    }
    this.observeIdentity(identity)
    const snapshot = this.snapshots.get(identity.scopeKey)
    if (
      !snapshot ||
      snapshot.origin !== identity.origin ||
      snapshot.credentialDigest !== identity.credentialDigest ||
      snapshot.deviceIdHash !== identity.deviceIdHash ||
      !Number.isFinite(now) ||
      !Number.isFinite(snapshot.verifiedAt) ||
      now < snapshot.verifiedAt ||
      now - snapshot.verifiedAt > VERIFIED_SPEECH_POLICY_MAX_AGE_MS
    ) {
      return null
    }
    return { ...snapshot, policy: clonePolicy(snapshot.policy) }
  }

  reset(): void {
    this.snapshots.clear()
    this.highWater.clear()
    this.activeScopeKey = null
    this.identityEpoch = 0
  }

  private compareAndRecord(
    scopeKey: string,
    version: number,
    revision: string,
    kind: PolicyHighWater['kind']
  ): SpeechPolicyAcceptResult {
    const prior = this.highWater.get(scopeKey)
    if (!prior && this.highWater.size >= MAX_SCOPED_POLICY_HIGH_WATER) return 'capacity'
    if (prior && version < prior.version) return 'lower-version'
    if (prior && version === prior.version) {
      if (prior.kind !== kind || prior.revision !== revision) {
        this.snapshots.delete(scopeKey)
        return 'conflict'
      }
      return kind === 'unmanaged' ? 'unmanaged' : 'accepted'
    }
    this.highWater.set(scopeKey, { version, revision, kind })
    return 'accepted'
  }
}
