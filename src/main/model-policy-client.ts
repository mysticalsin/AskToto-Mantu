/**
 * Fleet model policy client (M2-0412): fetches `GET /v1/model-policy` from the Operator, verifies its
 * signature locally (node:crypto HMAC against the exact same secret this device already uses to sign
 * its own outbound requests — see `src/shared/model-policy.ts`'s doc comment for why that is the
 * right secret to reuse today), caches the last verified document to disk for offline use, and
 * exposes the pure resolution helpers every model call site consults.
 *
 * Polling piggybacks on the existing 60s Operator heartbeat tick (`operator-ingest.ts`'s
 * `startOperatorRuntime`) rather than adding a second timer — call `refreshModelPolicy` once per
 * tick. A tampered, unsigned, or schema-invalid response is rejected outright (audited, never
 * applied) and the last verified cache — in memory, or reloaded from disk after a relaunch — is kept.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { inspectBundleResponse } from '@shared/bundle-response'
import { resolveOperatorBaseUrl, resolveOperatorCredential } from '@shared/operator'
import {
  canonicalModelPolicyPayload,
  narrowAllowedProvidersForCapability,
  pinManagedModel,
  SignedModelPolicySchema,
  type ModelPolicyCapability,
  type ModelPolicyDocument
} from '@shared/model-policy'
import { getDurableMachineId } from './license'
import { hashOperatorId, operatorHmacHeaders } from './operator-hmac-sign'
import { auditLog, mainLog } from './logger'

const CACHE_FILE = 'model-policy-cache.json'

export interface ModelPolicyClientSettings {
  operatorUrl?: string
  operatorIngestSecret?: string
  operatorLicenseToken?: string
}

interface ModelPolicyCacheFile {
  policy: ModelPolicyDocument
  signature: string
}

let currentPolicy: ModelPolicyDocument | null = null
let fetchImpl: typeof fetch = fetch
let dirOverride: string | null = null
let loadedFromDiskFor: string | null = null

export function setModelPolicyFetchForTests(fn: typeof fetch | null): void {
  fetchImpl = fn ?? fetch
}

export function setModelPolicyDirForTests(dir: string | null): void {
  dirOverride = dir
}

export function resetModelPolicyStateForTests(): void {
  currentPolicy = null
  loadedFromDiskFor = null
}

function policyDir(): string {
  return dirOverride ?? app.getPath('userData')
}

function cachePath(): string {
  return join(policyDir(), CACHE_FILE)
}

function verifySignatureLocal(secret: string, policy: ModelPolicyDocument, signature: string): boolean {
  if (!secret || !signature) return false
  const expected = createHmac('sha256', secret).update(canonicalModelPolicyPayload(policy)).digest('hex')
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(signature.toLowerCase().trim(), 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
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
function ensureLoadedFromDisk(secret: string): void {
  if (loadedFromDiskFor === secret) return
  loadedFromDiskFor = secret
  if (currentPolicy) return
  try {
    if (!existsSync(cachePath())) return
    const raw = JSON.parse(readFileSync(cachePath(), 'utf8')) as { policy: unknown; signature?: string }
    if (!raw.policy || !raw.signature) return
    const parsed = SignedModelPolicySchema.safeParse({ policy: raw.policy, signature: raw.signature })
    if (!parsed.success) return
    if (!verifySignatureLocal(secret, parsed.data.policy, parsed.data.signature)) return
    currentPolicy = parsed.data.policy
  } catch (e) {
    mainLog.warn('[model-policy] failed to read disk cache:', e)
  }
}

/** The last verified policy — from this session's fetches, or from disk if nothing has been fetched
 *  yet this run. `null` means "not managed": every call site must fall back to today's defaults. */
export function getActiveModelPolicy(settings: ModelPolicyClientSettings): ModelPolicyDocument | null {
  const secret = resolveOperatorCredential(settings)
  if (secret) ensureLoadedFromDisk(secret)
  return currentPolicy
}

/**
 * `GET /v1/model-policy`, verify, apply (or reject). Safe to call on every heartbeat tick (<=60s):
 * a network failure or an unconfigured Operator leaves the current/cached policy untouched — this
 * only ever changes state on a definite, verified answer.
 */
export async function refreshModelPolicy(settings: ModelPolicyClientSettings, now: number = Date.now()): Promise<void> {
  void now
  const url = resolveOperatorBaseUrl(settings)
  const secret = resolveOperatorCredential(settings)
  if (!url || !secret) return
  ensureLoadedFromDisk(secret)
  const machineId = getDurableMachineId()
  if (!machineId) return
  let res: Response
  try {
    const deviceId = hashOperatorId(machineId)
    const headers = operatorHmacHeaders(secret, deviceId, '')
    res = await fetchImpl(`${url}/v1/model-policy`, {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000)
    })
  } catch (e) {
    mainLog.warn('[model-policy] fetch threw:', e)
    return
  }
  const text = await res.text().catch(() => '')
  const inspected = inspectBundleResponse({
    status: res.status,
    contentType: res.headers.get('content-type'),
    location: res.headers.get('location'),
    bodyPrefix: text.slice(0, 1024),
    expected: 'json'
  })
  if (!inspected.ok || !res.ok) {
    mainLog.warn(`[model-policy] fetch failed: ${res.status}`)
    return
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return
  }
  const body = json as { ok?: boolean; policy?: unknown; signature?: unknown }
  if (body.ok !== true) return
  if (body.policy === null) {
    // The Operator has no fleet policy configured: "not managed", not a rejection.
    clearCache()
    return
  }
  const parsed = SignedModelPolicySchema.safeParse({ policy: body.policy, signature: body.signature })
  if (!parsed.success) {
    auditLog('operator.model_policy.rejected', { reason: 'schema' })
    return
  }
  if (!verifySignatureLocal(secret, parsed.data.policy, parsed.data.signature)) {
    auditLog('operator.model_policy.rejected', { reason: 'signature' })
    return
  }
  currentPolicy = parsed.data.policy
  writeCache(parsed.data.policy, parsed.data.signature)
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
