/**
 * Fleet model policy (M2-0412): the owner picks a provider + model per capability in the Operator
 * portal, and every Métis app enforces it. This module owns the wire schema, the canonical byte
 * string both the Worker (WebCrypto HMAC) and Electron main (node:crypto HMAC) sign/verify against,
 * and the pure precedence resolution — portal policy > MDM admin-managed `allowedProviders` (can only
 * narrow) > user settings — so the Worker, the desktop app and every test share one definition.
 *
 * `askChat` and `recap` are enforced at the real ask/extraction call sites (src/main/index.ts's
 * interactive ask, src/main/import-recap.ts and src/main/brain/ingest.ts's meeting extraction).
 * `stt` is enforced where a cloud speech session starts (`enforceSttPolicy` in
 * src/shared/cloud-stt-provider.ts, checked once at session start so a live session is never
 * rewritten) and `localModel` where the on-device model is judged ready (`localModelAllowedByPolicy`;
 * a disallowed model is skipped, never downloaded or swapped). `commandAgent`, `tts` and `embeddings`
 * have no model-routed call site in this app version (command parsing is rule-based, there is no
 * text-to-speech path, no embedding model is called): they stay in the signed document so the portal
 * and audit trail are complete, but nothing enforces them and Settings does not claim otherwise.
 *
 * Native Mac app: MetisKit's policy poller exists (ModelPolicy.swift) but stays inactive until an
 * Operator credential is provisioned (BLOCKED_EXTERNAL; native pairing lands with M2-0145). The native
 * app has no cloud-model call site to route yet. Nothing here claims native enforcement.
 */
import { z } from 'zod'

export const MODEL_POLICY_CAPABILITIES = [
  'askChat',
  'commandAgent',
  'recap',
  'stt',
  'tts',
  'embeddings',
  'localModel'
] as const
export type ModelPolicyCapability = (typeof MODEL_POLICY_CAPABILITIES)[number]

export const MODEL_POLICY_CAPABILITY_LABELS: Record<ModelPolicyCapability, string> = {
  askChat: 'Ask / chat',
  commandAgent: 'Command agent',
  recap: 'Meeting recap / extraction',
  stt: 'Speech to text',
  tts: 'Text to speech',
  embeddings: 'Embeddings',
  localModel: 'Local model'
}

export function isModelPolicyCapability(raw: unknown): raw is ModelPolicyCapability {
  return typeof raw === 'string' && (MODEL_POLICY_CAPABILITIES as readonly string[]).includes(raw)
}

export const ModelPolicyFallbackSchema = z.object({
  provider: z.string().trim().min(1).max(64),
  model: z.string().trim().min(1).max(200)
})
export type ModelPolicyFallback = z.infer<typeof ModelPolicyFallbackSchema>

export const ModelPolicyEntrySchema = z.object({
  provider: z.string().trim().min(1).max(64),
  model: z.string().trim().min(1).max(200),
  fallbacks: z.array(ModelPolicyFallbackSchema).max(8).default([])
})
export type ModelPolicyEntry = z.infer<typeof ModelPolicyEntrySchema>

export const ModelPolicyCapabilitiesSchema = z.object({
  askChat: ModelPolicyEntrySchema,
  commandAgent: ModelPolicyEntrySchema,
  recap: ModelPolicyEntrySchema,
  stt: ModelPolicyEntrySchema,
  tts: ModelPolicyEntrySchema,
  embeddings: ModelPolicyEntrySchema,
  localModel: ModelPolicyEntrySchema
})
export type ModelPolicyCapabilities = z.infer<typeof ModelPolicyCapabilitiesSchema>

export const ModelPolicyDocumentSchema = z.object({
  /** `max(updated_at)` at write time (same convention as operator_settings' settingsVersion) — an
   *  opaque, monotonic stamp a client compares to its cache, never a semantic version. */
  version: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  updatedBy: z.string().trim().min(1).max(200),
  capabilities: ModelPolicyCapabilitiesSchema
})
export type ModelPolicyDocument = z.infer<typeof ModelPolicyDocumentSchema>

export const SignedModelPolicySchema = z.object({
  policy: ModelPolicyDocumentSchema,
  signature: z.string().trim().min(16).max(128)
})
export type SignedModelPolicy = z.infer<typeof SignedModelPolicySchema>

/**
 * Stable byte-for-byte string both the Worker (WebCrypto HMAC) and Electron main (node:crypto HMAC)
 * sign/verify against. Built from `MODEL_POLICY_CAPABILITIES` in a fixed order (never
 * `Object.keys`/JSON field order) so the signature is deterministic regardless of how the document was
 * constructed or serialized.
 */
export function canonicalModelPolicyPayload(policy: ModelPolicyDocument): string {
  const cap = policy.capabilities
  const capString = MODEL_POLICY_CAPABILITIES.map((key) => {
    const entry = cap[key]
    const fallbacks = entry.fallbacks.map((f) => `${f.provider}:${f.model}`).join(',')
    return `${key}=${entry.provider}:${entry.model}[${fallbacks}]`
  }).join('|')
  return `metis-model-policy.v1.${policy.version}.${policy.updatedAt}.${policy.updatedBy}.${capString}`
}

/**
 * Signed "not managed" reply: the Operator has no fleet policy. Signed like a real document so an
 * intercepted or forged `{policy:null}` can never clear a verified cached policy. `issuedAt` is the
 * Operator's clock at reply time; a client only honours it when it is newer than the policy it holds,
 * so a captured pre-policy reply cannot be replayed to wipe a policy the owner has since set.
 */
export function canonicalUnmanagedModelPolicyPayload(issuedAt: number): string {
  return `metis-model-policy.v1.unmanaged.${issuedAt}`
}

export const SignedUnmanagedModelPolicySchema = z.object({
  issuedAt: z.number().int().nonnegative(),
  signature: z.string().trim().min(16).max(128)
})

/** HMAC-SHA256 of `canonicalModelPolicyPayload(policy)`, lowercase hex. Uses the WebCrypto global
 *  (`crypto.subtle`) rather than `node:crypto` so this one implementation runs unmodified on the
 *  Worker, in Electron main (Node 22 exposes the same global) and in tests. */
async function signModelPolicyPayload(secret: string, policy: ModelPolicyDocument): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign'
  ])
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(canonicalModelPolicyPayload(policy))))
  return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Verifies a policy's signature against `secret` — the exact check every app runs before it will
 *  use a fetched policy (ticket acceptance: "a tampered or unsigned policy is rejected"). Constant-time
 *  compare so a partial-match timing side channel can't help an attacker forge a signature. */
export async function verifyModelPolicySignature(
  secret: string,
  policy: ModelPolicyDocument,
  signature: string
): Promise<boolean> {
  if (!secret || !signature) return false
  const expected = await signModelPolicyPayload(secret, policy)
  const actual = signature.toLowerCase().trim()
  if (expected.length !== actual.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ actual.charCodeAt(i)
  return diff === 0
}

export interface ModelPolicyResolution {
  provider: string
  model: string
  /** 'policy': the capability's primary entry. 'policy-fallback': one of its fallbacks, chosen because
   *  the primary (or an earlier fallback) was narrowed out by the MDM `allowedProviders` file. */
  source: 'policy' | 'policy-fallback'
}

/**
 * Every candidate for `capability`, primary first, narrowed to `allowedProviders` (the MDM
 * admin-managed file — `null` means unrestricted). Empty when a policy exists but every candidate was
 * narrowed out: the caller must treat that as "no model available", never silently fall back to user
 * settings, since an admin file can only NARROW a portal policy, never widen past it.
 */
export function resolveModelPolicyCandidates(
  policy: ModelPolicyDocument,
  capability: ModelPolicyCapability,
  allowedProviders: readonly string[] | null
): ModelPolicyResolution[] {
  const entry = policy.capabilities[capability]
  const candidates: { provider: string; model: string; source: ModelPolicyResolution['source'] }[] = [
    { provider: entry.provider, model: entry.model, source: 'policy' },
    ...entry.fallbacks.map((f) => ({ provider: f.provider, model: f.model, source: 'policy-fallback' as const }))
  ]
  if (!allowedProviders) return candidates
  return candidates.filter((c) => allowedProviders.includes(c.provider))
}

/** The single best candidate for `capability`, or `null` when a policy exists but the MDM allowlist
 *  narrowed out every candidate (blocked, not "unmanaged"). */
export function resolveModelPolicyChoice(
  policy: ModelPolicyDocument,
  capability: ModelPolicyCapability,
  allowedProviders: readonly string[] | null
): ModelPolicyResolution | null {
  return resolveModelPolicyCandidates(policy, capability, allowedProviders)[0] ?? null
}

/**
 * Narrow an existing `allowed` provider list (org allowlist, `string[] | null`) to what `capability`'s
 * policy entry (+fallbacks) actually permits, while unconditionally preserving `alwaysAllow` (CLI
 * providers and `'local'`) — those are governed by their own toggles (CLI connect state, on-device
 * routing mode), not by the cloud-model fleet policy, so a portal policy that never mentions them must
 * never make the CLI-first ask law or on-device processing unreachable.
 *
 * `null` in, no policy: returns `allowed` unchanged. Policy present: the result is the intersection of
 * `allowed` (if any) with the policy's provider set, plus `alwaysAllow` — reusing the exact
 * `string[] | null` shape every existing eligibility/failover check already consumes.
 */
export function narrowAllowedProvidersForCapability(
  allowed: readonly string[] | null,
  policy: ModelPolicyDocument | null,
  capability: ModelPolicyCapability,
  alwaysAllow: readonly string[] = []
): string[] | null {
  if (!policy) return allowed === null ? null : [...allowed]
  const entry = policy.capabilities[capability]
  const policySet = new Set<string>([entry.provider, ...entry.fallbacks.map((f) => f.provider), ...alwaysAllow])
  if (!allowed) return [...policySet]
  return allowed.filter((p) => policySet.has(p))
}

/**
 * Pin the model for a provider that a policy governs: when `provider` is the capability's primary
 * entry, or one of its fallbacks, return the policy's model string for it; otherwise return
 * `currentModel` unchanged (the provider isn't named in this capability's policy — e.g. a CLI provider
 * or `'local'`, which the caller should exempt before calling this, since those are never pinned by
 * this fleet policy).
 */
export function pinManagedModel(
  policy: ModelPolicyDocument | null,
  capability: ModelPolicyCapability,
  provider: string,
  currentModel: string
): string {
  if (!policy) return currentModel
  const entry = policy.capabilities[capability]
  if (entry.provider === provider) return entry.model
  const fallback = entry.fallbacks.find((f) => f.provider === provider)
  return fallback ? fallback.model : currentModel
}

/** Whether the on-device model `modelId` is permitted by the policy's `localModel` entry (primary and
 *  fallbacks match on model id). No policy means unrestricted. */
export function localModelAllowedByPolicy(policy: ModelPolicyDocument | null, modelId: string): boolean {
  if (!policy) return true
  const entry = policy.capabilities.localModel
  return entry.model === modelId || entry.fallbacks.some((f) => f.model === modelId)
}

/** Default document shape for the Models portal page's "start from today's defaults" affordance —
 *  never persisted implicitly; the owner must save it before it becomes a real policy. */
export function emptyModelPolicyEntry(provider: string, model: string): ModelPolicyEntry {
  return { provider, model, fallbacks: [] }
}
