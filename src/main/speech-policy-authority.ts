import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { OPERATOR_LICENSE_MAX, OPERATOR_LICENSE_MAX_DAYS, parseOperatorLicense } from '@shared/operator-license'
import { operatorReportingAllowed } from './operator-reporting-policy'
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

type SignedUnmanagedProof = {
  version: number
  revision: string
  verifiedAt: number
  monotonicAt: number
  epoch: number
}

export type SpeechPolicyAuthorityStatus =
  | { status: 'unverified'; identity: string }
  | { status: 'unmanaged'; identity: string }
  | { status: 'managed'; identity: string; policy: ModelPolicyDocument }

type PolicyHighWater = {
  version: number
  revision: string
  kind: 'managed' | 'unmanaged'
}

export type SpeechPolicyAcceptResult = 'accepted' | 'unmanaged' | 'lower-version' | 'conflict' | 'capacity'

export type SpeechPolicyProofEvent =
  | {
      kind: 'revoked'
      reason: 'explicit-invalidation' | 'http-denied' | 'invalid-response' | 'signed-unmanaged' | 'policy-conflict'
    }
  | { kind: 'changed'; reason: 'policy-changed' }

export type SpeechPolicyProofListener = (event: SpeechPolicyProofEvent) => void

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
    parsed.exp - parsed.iat > OPERATOR_LICENSE_MAX_DAYS * 24 * 60 * 60 ||
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

/** Speech authority applies only to a managed seat. An auto reporting seat holds no licence in these settings
 *  and the admin kill switch turns the whole Operator off, so both read as unconfigured, as they do today. */
export function speechPolicyIsConfigured(settings: SpeechPolicyIdentitySettings): boolean {
  if (!operatorReportingAllowed()) return false
  return Boolean(
    settings.operatorUrl?.trim() || settings.operatorIngestSecret?.trim() || settings.operatorLicenseToken?.trim()
  )
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
  private readonly unmanagedProofs = new Map<string, SignedUnmanagedProof>()
  private readonly highWater = new Map<string, PolicyHighWater>()
  private activeScopeKey: string | null = null
  private identityEpoch = 0
  private proofListener: SpeechPolicyProofListener | null = null

  setProofListener(listener: SpeechPolicyProofListener | null): void {
    this.proofListener = listener
  }

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

  invalidate(
    identity: SpeechPolicyIdentity | null,
    reason: Exclude<SpeechPolicyProofEvent, { kind: 'changed' }>['reason'] = 'invalid-response'
  ): boolean {
    if (!identity) return false
    const isActive = identity.scopeKey === this.activeScopeKey
    if (isActive) this.identityEpoch++
    const revokedSnapshot = this.snapshots.delete(identity.scopeKey)
    const revokedUnmanaged = this.unmanagedProofs.delete(identity.scopeKey)
    const revoked = revokedSnapshot || revokedUnmanaged
    if (isActive && revoked) this.emit({ kind: 'revoked', reason })
    return revoked
  }

  /** Hard settings/MDM revocation. Keep per-scope high-water tombstones while invalidating every
   *  in-memory proof and every refresh already captured under the old authority epoch. */
  invalidateAll(): boolean {
    this.identityEpoch++
    const revoked = this.snapshots.size > 0 || this.unmanagedProofs.size > 0
    this.snapshots.clear()
    this.unmanagedProofs.clear()
    if (revoked) this.emit({ kind: 'revoked', reason: 'explicit-invalidation' })
    return revoked
  }

  acceptManaged(
    identity: SpeechPolicyIdentity,
    policy: ModelPolicyDocument,
    verifiedAt: number,
    revision: string
  ): SpeechPolicyAcceptResult {
    if (!Number.isSafeInteger(policy.version) || !Number.isFinite(verifiedAt)) {
      this.invalidate(identity, 'invalid-response')
      return 'conflict'
    }
    const previous = this.snapshots.get(identity.scopeKey)
    const previousUnmanaged = this.unmanagedProofs.get(identity.scopeKey)?.epoch === this.identityEpoch
    const result = this.compareAndRecord(identity.scopeKey, policy.version, revision, 'managed')
    if (result !== 'accepted') {
      if (result === 'conflict' && this.activeScopeKey === identity.scopeKey) {
        this.identityEpoch++
        if (previous || previousUnmanaged) this.emit({ kind: 'revoked', reason: 'policy-conflict' })
      }
      return result
    }
    this.snapshots.set(identity.scopeKey, {
      origin: identity.origin,
      credentialDigest: identity.credentialDigest,
      deviceIdHash: identity.deviceIdHash,
      verifiedAt,
      revision,
      policy: clonePolicy(policy)
    })
    this.unmanagedProofs.delete(identity.scopeKey)
    if (
      (previousUnmanaged || (previous && previous.revision !== revision)) &&
      this.activeScopeKey === identity.scopeKey
    ) {
      this.identityEpoch++
      this.emit({ kind: 'changed', reason: 'policy-changed' })
    }
    return 'accepted'
  }

  acceptUnmanaged(
    identity: SpeechPolicyIdentity,
    version: number,
    revision: string,
    verifiedAt = Date.now(),
    monotonicAt = performance.now()
  ): SpeechPolicyAcceptResult {
    // A verified signed-null response explicitly says this identity is unmanaged. Even a stale
    // version must revoke the currently usable snapshot; retain the high-water mark so stale
    // managed documents cannot restore authority afterward.
    const isActive = this.activeScopeKey === identity.scopeKey
    const revoked = this.snapshots.delete(identity.scopeKey)
    const previousProof = this.unmanagedProofs.get(identity.scopeKey)
    this.unmanagedProofs.delete(identity.scopeKey)
    const sameProof = previousProof?.version === version && previousProof.revision === revision
    if (isActive && (revoked || (previousProof && !sameProof))) this.identityEpoch++
    if (
      !Number.isSafeInteger(version) ||
      version < 0 ||
      !Number.isFinite(verifiedAt) ||
      !Number.isFinite(monotonicAt)
    ) {
      if (isActive && sameProof) this.identityEpoch++
      if (isActive && (revoked || previousProof)) this.emit({ kind: 'revoked', reason: 'invalid-response' })
      return 'conflict'
    }
    const result = this.compareAndRecord(identity.scopeKey, version, revision, 'unmanaged')
    const accepted = result === 'accepted' || result === 'unmanaged'
    if (isActive && accepted) {
      this.unmanagedProofs.set(identity.scopeKey, {
        version,
        revision,
        verifiedAt,
        monotonicAt,
        epoch: this.identityEpoch
      })
    }
    if (isActive && (revoked || (previousProof && !accepted))) {
      this.emit({ kind: 'revoked', reason: result === 'conflict' ? 'policy-conflict' : 'signed-unmanaged' })
    }
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

  authorityStatus(
    identity: SpeechPolicyIdentity | null,
    now = Date.now(),
    monotonicNow = performance.now()
  ): SpeechPolicyAuthorityStatus {
    const epoch = this.observeIdentity(identity)
    if (!identity) return { status: 'unverified', identity: `speech-proof:${epoch}:missing-identity` }
    const snapshot = this.get(identity, now)
    if (snapshot) {
      return {
        status: 'managed',
        identity: `speech-proof:${epoch}:${identity.scopeKey}:${snapshot.revision}`,
        policy: snapshot.policy
      }
    }
    const receipt = this.highWater.get(identity.scopeKey)
    const unmanaged = this.unmanagedProofs.get(identity.scopeKey)
    if (unmanaged && unmanaged.epoch === epoch && !this.isUnmanagedFresh(unmanaged, now, monotonicNow)) {
      this.unmanagedProofs.delete(identity.scopeKey)
      if (this.activeScopeKey === identity.scopeKey) this.identityEpoch++
    }
    const currentEpoch = this.identityEpoch
    const currentUnmanaged = this.unmanagedProofs.get(identity.scopeKey)
    if (
      receipt?.kind === 'unmanaged' &&
      currentUnmanaged?.version === receipt.version &&
      currentUnmanaged.revision === receipt.revision &&
      currentUnmanaged.epoch === currentEpoch &&
      this.isUnmanagedFresh(currentUnmanaged, now, monotonicNow)
    ) {
      return {
        status: 'unmanaged',
        identity: `speech-proof:${currentEpoch}:${identity.scopeKey}:unmanaged:${currentUnmanaged.version}:${currentUnmanaged.revision}`
      }
    }
    return {
      status: 'unverified',
      identity: `speech-proof:${currentEpoch}:${identity.scopeKey}:${receipt?.kind ?? 'none'}:${receipt?.version ?? 0}:${receipt?.revision ?? 'none'}`
    }
  }

  reset(): void {
    this.snapshots.clear()
    this.unmanagedProofs.clear()
    this.highWater.clear()
    this.activeScopeKey = null
    this.identityEpoch = 0
    this.proofListener = null
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

  private isUnmanagedFresh(proof: SignedUnmanagedProof, now: number, monotonicNow: number): boolean {
    return (
      Number.isFinite(now) &&
      now >= proof.verifiedAt &&
      now - proof.verifiedAt <= VERIFIED_SPEECH_POLICY_MAX_AGE_MS &&
      Number.isFinite(monotonicNow) &&
      monotonicNow >= proof.monotonicAt &&
      monotonicNow - proof.monotonicAt <= VERIFIED_SPEECH_POLICY_MAX_AGE_MS
    )
  }

  private emit(event: SpeechPolicyProofEvent): void {
    try {
      this.proofListener?.(event)
    } catch {
      // Runtime retirement is a one-way notification and cannot make policy acceptance fail.
    }
  }
}
