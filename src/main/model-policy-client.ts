/**
 * Fleet model policy client (M2-0412): fetches `GET /v1/model-policy` from the Operator, verifies its
 * signature locally (node:crypto HMAC against the exact same secret this device already uses to sign
 * its own outbound requests — see `src/shared/model-policy.ts`'s doc comment for why that is the
 * right secret to reuse today), caches the last verified document to disk for offline use, and
 * exposes the pure resolution helpers every model call site consults.
 *
 * Polling runs on its own 30s timer in `operator-ingest.ts`'s `startOperatorRuntime` (half the <=60s
 * bound) — call `refreshModelPolicy` once per poll. A tampered, unsigned, or schema-invalid response is rejected outright (audited, never
 * applied) and the last verified cache — in memory, or reloaded from disk after a relaunch — is kept.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { inspectBundleResponse } from '@shared/bundle-response'
import { resolveOperatorBaseUrl, resolveOperatorCredential } from '@shared/operator'
import {
  canonicalModelPolicyPayload,
  canonicalUnmanagedModelPolicyPayload,
  effectiveLocalSpeechPackPolicy,
  MODEL_POLICY_CAPABILITIES,
  narrowAllowedProvidersForCapability,
  pinManagedModel,
  SignedModelPolicySchema,
  SignedUnmanagedModelPolicySchema,
  type ModelPolicyCapability,
  type ModelPolicyDocument,
  type LocalSpeechPackPolicy
} from '@shared/model-policy'
import { getDurableMachineId } from './license'
import { hashOperatorId, operatorHmacHeaders } from './operator-hmac-sign'
import { auditLog, mainLog } from './logger'
import {
  resolveSpeechPolicyIdentity,
  speechPolicyIsConfigured,
  sameSpeechPolicyIdentity,
  SpeechPolicyAuthority,
  type SpeechPolicyIdentity,
  type SpeechPolicyIdentityReader,
  type SpeechPolicyIdentitySettings,
  type SpeechPolicyProofListener,
  type SpeechPolicyAuthorityStatus,
  type VerifiedSpeechPolicy
} from './speech-policy-authority'

export type { VerifiedSpeechPolicy } from './speech-policy-authority'
export type { SpeechPolicyProofEvent, SpeechPolicyProofListener } from './speech-policy-authority'

const CACHE_FILE = 'model-policy-cache.json'
const MAX_MODEL_POLICY_RESPONSE_BYTES = 64 * 1024

export interface ModelPolicyClientSettings extends SpeechPolicyIdentitySettings {}

interface ModelPolicyCacheFile {
  policy: ModelPolicyDocument
  signature: string
}

let currentPolicy: ModelPolicyDocument | null = null
let fetchImpl: typeof fetch = fetch
let dirOverride: string | null = null
let loadedFromDiskFor: string | null = null
let currentPolicyScope: string | null = null
let speechPolicyIdentityReader: SpeechPolicyIdentityReader | null = null
let speechPolicyClock: () => number = Date.now
const speechPolicyAuthority = new SpeechPolicyAuthority()

export function setModelPolicyFetchForTests(fn: typeof fetch | null): void {
  fetchImpl = fn ?? fetch
}

export function setModelPolicyDirForTests(dir: string | null): void {
  dirOverride = dir
}

export function resetModelPolicyStateForTests(): void {
  currentPolicy = null
  loadedFromDiskFor = null
  currentPolicyScope = null
  speechPolicyIdentityReader = null
  speechPolicyClock = Date.now
  speechPolicyAuthority.reset()
}

export function setSpeechPolicyClockForTests(clock: (() => number) | null): void {
  speechPolicyClock = clock ?? Date.now
}

/** Main-only source for live settings and the durable device identity. Without it, new speech stays closed. */
export function setSpeechPolicyIdentityReader(reader: SpeechPolicyIdentityReader | null): void {
  speechPolicyIdentityReader = reader
  if (reader) {
    const source = readSpeechPolicyIdentitySource()
    speechPolicyAuthority.observeIdentity(
      source ? resolveSpeechPolicyIdentity(source.settings, source.durableDeviceId, speechPolicyClock()) : null
    )
  } else {
    speechPolicyAuthority.observeIdentity(null)
  }
}

/** Register the main-only, one-way runtime retirement signal for revoked or semantically changed
 *  verified speech policy proof. The listener must not call this module's invalidation hook. */
export function setSpeechPolicyProofRevocationListener(listener: SpeechPolicyProofListener | null): void {
  speechPolicyAuthority.setProofListener(listener)
}

/** Hard settings/MDM invalidation. This only clears in-memory speech proof snapshots and advances
 *  pending refresh epochs; legacy policy state, disk cache, and per-scope version high-water remain. */
export function invalidateSpeechPolicyProof(): void {
  speechPolicyAuthority.invalidateAll()
}

function policyDir(): string {
  return dirOverride ?? app.getPath('userData')
}

function cachePath(): string {
  return join(policyDir(), CACHE_FILE)
}

function verifyPayloadLocal(secret: string, payload: string, signature: string): boolean {
  if (!secret || !signature) return false
  const expected = createHmac('sha256', secret).update(payload).digest('hex')
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(signature.toLowerCase().trim(), 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

function verifySignatureLocal(secret: string, policy: ModelPolicyDocument, signature: string): boolean {
  return verifyPayloadLocal(secret, canonicalModelPolicyPayload(policy), signature)
}

function writeCache(policy: ModelPolicyDocument, signature: string): void {
  const file: ModelPolicyCacheFile = { policy, signature }
  try {
    mkdirSync(dirname(cachePath()), { recursive: true })
    writeFileSync(cachePath(), JSON.stringify(file), 'utf8')
  } catch (e) {
    mainLog.warn('[model-policy] failed to write disk cache:', e)
  }
}

function clearCache(): void {
  currentPolicy = null
  try {
    if (existsSync(cachePath())) writeFileSync(cachePath(), JSON.stringify({ policy: null }), 'utf8')
  } catch (e) {
    mainLog.warn('[model-policy] failed to clear disk cache:', e)
  }
}

/** Loads the last verified policy from disk (offline use after a relaunch), re-verifying it against
 *  the CURRENT secret so a credential rotation invalidates a stale cache instead of trusting it
 *  forever. Called lazily, once per resolved secret, by `getActiveModelPolicy`/`refreshModelPolicy` —
 *  never on every single call. */
function legacyPolicyScopeKey(settings: ModelPolicyClientSettings, secret: string): string {
  const credentialDigest = createHash('sha256').update(secret, 'utf8').digest('hex')
  return createHash('sha256')
    .update(`${resolveOperatorBaseUrl(settings)}\0${credentialDigest}`, 'utf8')
    .digest('hex')
}

function ensureLoadedFromDisk(secret: string, settings: ModelPolicyClientSettings): void {
  const scopeKey = legacyPolicyScopeKey(settings, secret)
  if (loadedFromDiskFor === scopeKey) return
  loadedFromDiskFor = scopeKey
  if (currentPolicyScope !== scopeKey) {
    currentPolicy = null
    currentPolicyScope = scopeKey
  }
  if (currentPolicy) return
  try {
    if (!existsSync(cachePath())) return
    const raw = JSON.parse(readFileSync(cachePath(), 'utf8')) as { policy: unknown; signature?: string }
    if (!raw.policy || !raw.signature) return
    const parsed = SignedModelPolicySchema.safeParse({ policy: raw.policy, signature: raw.signature })
    if (!parsed.success) return
    if (!verifySignatureLocal(secret, parsed.data.policy, parsed.data.signature)) return
    currentPolicy = parsed.data.policy
    currentPolicyScope = scopeKey
  } catch (e) {
    mainLog.warn('[model-policy] failed to read disk cache:', e)
  }
}

/** The last verified policy — from this session's fetches, or from disk if nothing has been fetched
 *  yet this run. `null` means "not managed": every call site must fall back to today's defaults. */
export function getActiveModelPolicy(settings: ModelPolicyClientSettings): ModelPolicyDocument | null {
  const secret = resolveOperatorCredential(settings)
  if (secret) ensureLoadedFromDisk(secret, settings)
  return currentPolicy
}

function readSpeechPolicyIdentitySource(): ReturnType<SpeechPolicyIdentityReader> | null {
  try {
    return speechPolicyIdentityReader?.() ?? null
  } catch {
    return null
  }
}

function liveSpeechPolicyIdentity(): SpeechPolicyIdentity | null {
  const source = readSpeechPolicyIdentitySource()
  const identity = source
    ? resolveSpeechPolicyIdentity(source.settings, source.durableDeviceId, speechPolicyClock())
    : null
  speechPolicyAuthority.observeIdentity(identity)
  return identity
}

/** Synchronous main-only read. It never fetches and returns null unless the current scope has a fresh signed response. */
export function getVerifiedSpeechPolicySnapshot(): VerifiedSpeechPolicy | null {
  return speechPolicyAuthority.get(liveSpeechPolicyIdentity(), speechPolicyClock())
}

/** Current signed speech-policy authority; configured credentials without a verified receipt stay closed. */
export function getSpeechPolicyAuthorityStatus(
  settings: ModelPolicyClientSettings
): { status: 'unconfigured'; identity: string } | SpeechPolicyAuthorityStatus {
  if (!resolveOperatorCredential(settings)) {
    const epoch = speechPolicyAuthority.observeIdentity(null)
    if (speechPolicyIsConfigured(settings))
      return { status: 'unverified', identity: `speech-proof:${epoch}:configured-without-credential` }
    return { status: 'unconfigured', identity: `speech-proof:${epoch}:unconfigured` }
  }
  return speechPolicyAuthority.authorityStatus(liveSpeechPolicyIdentity(), speechPolicyClock())
}

/**
 * `GET /v1/model-policy`, verify, apply (or reject); resolves true only when the effective policy changed,
 * so callers re-broadcast settings on a real change and never on an idle poll. Safe to call on every heartbeat tick (<=60s):
 * a network failure or an unconfigured Operator leaves the current/cached policy untouched — this
 * only ever changes state on a definite, verified answer.
 */
export async function refreshModelPolicy(
  settings: ModelPolicyClientSettings,
  now: number = Date.now()
): Promise<boolean> {
  void now
  return (await refreshModelPolicyChecked(settings)).changed
}

/** Like `refreshModelPolicy`, but also reports whether the Operator was actually reached: `ok: false`
 *  is a transport, HTTP or malformed-body failure the caller should retry soon. A definite answer —
 *  including a rejected (unsigned/invalid) policy or an unconfigured Operator — is `ok: true`. */
export async function refreshModelPolicyChecked(
  settings: ModelPolicyClientSettings,
  source?: string
): Promise<{ changed: boolean; ok: boolean }> {
  const liveBefore = readSpeechPolicyIdentitySource()?.settings ?? settings
  const before = getActiveModelPolicy(liveBefore)
  const ok = await fetchAndApplyModelPolicy(liveBefore, source)
  const liveAfter = readSpeechPolicyIdentitySource()?.settings ?? settings
  return { changed: getActiveModelPolicy(liveAfter)?.version !== before?.version, ok }
}

interface SpeechPolicyRefreshCapture {
  identity: SpeechPolicyIdentity
  scopeKey: string
  epoch: number
}

function captureSpeechPolicyRefresh(
  settings: ModelPolicyClientSettings,
  machineId: string,
  secret: string
): SpeechPolicyRefreshCapture | null {
  const source = readSpeechPolicyIdentitySource()
  const requestIdentity = resolveSpeechPolicyIdentity(settings, machineId, speechPolicyClock())
  const liveIdentity = source
    ? resolveSpeechPolicyIdentity(source.settings, source.durableDeviceId, speechPolicyClock())
    : null
  const captured = speechPolicyAuthority.capture(liveIdentity)
  if (
    !captured ||
    !sameSpeechPolicyIdentity(requestIdentity, liveIdentity) ||
    requestIdentity?.licenseToken !== secret
  ) {
    return null
  }
  return { identity: liveIdentity!, scopeKey: captured.scopeKey, epoch: captured.epoch }
}

function speechCaptureIsCurrent(capture: SpeechPolicyRefreshCapture | null): boolean {
  if (!capture) return false
  const source = readSpeechPolicyIdentitySource()
  const current = source
    ? resolveSpeechPolicyIdentity(source.settings, source.durableDeviceId, speechPolicyClock())
    : null
  return speechPolicyAuthority.isCurrent(capture, current)
}

function invalidateSpeechCapture(
  capture: SpeechPolicyRefreshCapture | null,
  reason: 'http-denied' | 'invalid-response' = 'invalid-response'
): void {
  if (capture && speechCaptureIsCurrent(capture)) speechPolicyAuthority.invalidate(capture.identity, reason)
}

function currentLegacyPolicyScope(fallback: ModelPolicyClientSettings): string | null {
  const settings = readSpeechPolicyIdentitySource()?.settings ?? fallback
  const secret = resolveOperatorCredential(settings)
  return secret ? legacyPolicyScopeKey(settings, secret) : null
}

type PolicyBodyRead = { ok: true; text: string } | { ok: false; reason: 'too-large' | 'invalid-utf8' | 'read-failed' }

async function readPolicyResponseBody(res: Response): Promise<PolicyBodyRead> {
  const declaredLength = Number(res.headers.get('content-length'))
  if (Number.isSafeInteger(declaredLength) && declaredLength > MAX_MODEL_POLICY_RESPONSE_BYTES) {
    await res.body?.cancel().catch(() => undefined)
    return { ok: false, reason: 'too-large' }
  }
  if (!res.body) return { ok: true, text: '' }

  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      totalBytes += result.value.byteLength
      if (totalBytes > MAX_MODEL_POLICY_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined)
        return { ok: false, reason: 'too-large' }
      }
      chunks.push(result.value)
    }
  } catch {
    return { ok: false, reason: 'read-failed' }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  } catch {
    return { ok: false, reason: 'invalid-utf8' }
  }
}

async function fetchAndApplyModelPolicy(settings: ModelPolicyClientSettings, source?: string): Promise<boolean> {
  const url = resolveOperatorBaseUrl(settings)
  const secret = resolveOperatorCredential(settings)
  if (!url || !secret) return true
  ensureLoadedFromDisk(secret, settings)
  const requestPolicyScope = legacyPolicyScopeKey(settings, secret)
  const machineId = getDurableMachineId()
  if (!machineId) return true
  const speechCapture = captureSpeechPolicyRefresh(settings, machineId, secret)
  let res: Response
  try {
    const deviceId = hashOperatorId(machineId)
    const headers = operatorHmacHeaders(secret, deviceId, '')
    // Diagnostic only (not signed): lets QA tell a timer poll from an immediate signal.
    if (source) headers['x-metis-policy-refresh-source'] = source
    res = await fetchImpl(`${url}/v1/model-policy`, {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000)
    })
  } catch (e) {
    mainLog.warn('[model-policy] fetch threw:', e)
    return false
  }
  if (res.status === 401 || res.status === 403) {
    invalidateSpeechCapture(speechCapture, 'http-denied')
    if (res.body) void res.body.cancel().catch(() => undefined)
    mainLog.warn(`[model-policy] fetch failed: ${res.status}`)
    return false
  }
  const bodyRead = await readPolicyResponseBody(res)
  if (!bodyRead.ok) {
    if (bodyRead.reason !== 'read-failed') invalidateSpeechCapture(speechCapture)
    return false
  }
  const text = bodyRead.text
  const inspected = inspectBundleResponse({
    status: res.status,
    contentType: res.headers.get('content-type'),
    location: res.headers.get('location'),
    bodyPrefix: text.slice(0, 1024),
    expected: 'json'
  })
  if (!inspected.ok || !res.ok) {
    mainLog.warn(`[model-policy] fetch failed: ${res.status}`)
    if (res.ok) invalidateSpeechCapture(speechCapture, 'invalid-response')
    else if (res.status === 401 || res.status === 403) invalidateSpeechCapture(speechCapture, 'http-denied')
    return false
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    invalidateSpeechCapture(speechCapture)
    return false
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    invalidateSpeechCapture(speechCapture)
    return false
  }
  const body = json as { ok?: boolean; policy?: unknown; signature?: unknown; issuedAt?: unknown }
  if (body.ok !== true) {
    invalidateSpeechCapture(speechCapture)
    return true
  }
  if (body.policy === null) {
    // "Not managed" only clears a held policy when the Operator signed it, and only when it is newer
    // than that policy — an unsigned, forged or replayed reply must never switch enforcement off.
    const unmanaged = SignedUnmanagedModelPolicySchema.safeParse({ issuedAt: body.issuedAt, signature: body.signature })
    if (
      !unmanaged.success ||
      !verifyPayloadLocal(
        secret,
        canonicalUnmanagedModelPolicyPayload(unmanaged.data.issuedAt),
        unmanaged.data.signature
      )
    ) {
      if (currentPolicy) auditLog('operator.model_policy.rejected', { reason: 'unmanaged-signature' })
      invalidateSpeechCapture(speechCapture)
      return true
    }
    if (currentLegacyPolicyScope(settings) !== requestPolicyScope) return false
    if (currentPolicy && unmanaged.data.issuedAt > currentPolicy.version) clearCache()
    currentPolicyScope = requestPolicyScope
    if (speechCapture && speechCaptureIsCurrent(speechCapture)) {
      const revision = createHash('sha256')
        .update(canonicalUnmanagedModelPolicyPayload(unmanaged.data.issuedAt), 'utf8')
        .digest('hex')
      speechPolicyAuthority.acceptUnmanaged(
        speechCapture.identity,
        unmanaged.data.issuedAt,
        revision,
        speechPolicyClock()
      )
    }
    return true
  }
  const parsed = SignedModelPolicySchema.safeParse({ policy: body.policy, signature: body.signature })
  if (!parsed.success) {
    auditLog('operator.model_policy.rejected', { reason: 'schema' })
    invalidateSpeechCapture(speechCapture)
    return true
  }
  if (!verifySignatureLocal(secret, parsed.data.policy, parsed.data.signature)) {
    auditLog('operator.model_policy.rejected', { reason: 'signature' })
    invalidateSpeechCapture(speechCapture)
    return true
  }
  if (currentLegacyPolicyScope(settings) !== requestPolicyScope) return false
  currentPolicy = parsed.data.policy
  currentPolicyScope = requestPolicyScope
  writeCache(parsed.data.policy, parsed.data.signature)
  if (speechCapture && speechCaptureIsCurrent(speechCapture)) {
    const revision = createHash('sha256').update(canonicalModelPolicyPayload(parsed.data.policy), 'utf8').digest('hex')
    const accepted = speechPolicyAuthority.acceptManaged(
      speechCapture.identity,
      parsed.data.policy,
      speechPolicyClock(),
      revision
    )
    if (accepted !== 'accepted') {
      auditLog('operator.model_policy.rejected', { reason: `speech-${accepted}` })
    }
  }
  return true
}

/** Same `string[] | null` shape every eligibility/failover check already threads through — narrows an
 *  existing org allowlist to what `capability`'s fleet policy permits (or widens `null` to the
 *  policy's own set), while always preserving `alwaysAllow` (CLI providers, `'local'`). */
export function narrowAllowedForCapability(
  settings: ModelPolicyClientSettings,
  allowed: readonly string[] | null,
  capability: ModelPolicyCapability,
  alwaysAllow: readonly string[] = []
): string[] | null {
  return narrowAllowedProvidersForCapability(allowed, getActiveModelPolicy(settings), capability, alwaysAllow)
}

/** Pins `provider`'s model to what the fleet policy declares for `capability`, or returns
 *  `currentModel` unchanged when there is no policy or the policy does not name this provider for
 *  this capability. */
export function resolveManagedModel(
  settings: ModelPolicyClientSettings,
  capability: ModelPolicyCapability,
  provider: string,
  currentModel: string
): string {
  return pinManagedModel(getActiveModelPolicy(settings), capability, provider, currentModel)
}

export function modelPolicyCapabilitiesForSettings(
  settings: ModelPolicyClientSettings
): Record<string, { provider: string; model: string }> {
  const policy = getActiveModelPolicy(settings)
  if (!policy) return {}
  return Object.fromEntries(
    MODEL_POLICY_CAPABILITIES.map((cap) => [
      cap,
      { provider: policy.capabilities[cap].provider, model: policy.capabilities[cap].model }
    ])
  )
}

export function resolveLocalSpeechPackPolicy(
  settings: ModelPolicyClientSettings,
  adminPolicy: LocalSpeechPackPolicy | null
): LocalSpeechPackPolicy {
  return effectiveLocalSpeechPackPolicy(getActiveModelPolicy(settings), adminPolicy)
}
