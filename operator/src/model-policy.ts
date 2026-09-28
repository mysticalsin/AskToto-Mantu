/**
 * Fleet model policy storage + signing (M2-0412). One row, `id = 'fleet'`: the owner picks a
 * provider + model per capability in the Models portal page, and every Métis app fetches and
 * verifies this document before it will use a model. Versioned the same way `operator_settings`
 * is (`operator/src/routes/settings-store.ts`): `version` is the row's own `updated_at`, so a
 * client only needs to compare one number to know whether its cache is stale.
 *
 * Signing reuses the Worker's existing device-authentication secret (`OPERATOR_INGEST_SECRET`) —
 * the same secret (or, for a licensed seat, its per-device license token) a desktop client already
 * holds to sign its own outbound requests — per the ticket's explicit guidance to use the existing
 * seat/desktop-license device authentication now, and switch to M2-0145's per-device HMAC binding
 * once it lands. A seat that can successfully HMAC-authenticate to the Worker already proves it
 * holds that same secret, so it can verify the policy's signature completely offline.
 */
import type { D1DatabaseLike } from './d1'
import { hmacHex, timingSafeEqualHex } from './hmac'
import {
  canonicalModelPolicyPayload,
  canonicalUnmanagedModelPolicyPayload,
  resolveModelPolicyCandidates,
  ModelPolicyDocumentSchema,
  type ModelPolicyCapability,
  type ModelPolicyDocument
} from '../../src/shared/model-policy'

/** Appended verbatim to `schema-alter.sql` (migrate.mjs / migrate.contract.test.ts's documented
 *  "wholly new table" exception, same as `operator_settings`). */
export const MODEL_POLICY_MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS model_policy (
  id TEXT PRIMARY KEY,
  policy_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL
);`,
  `CREATE TABLE IF NOT EXISTS model_policy_history (
  version INTEGER PRIMARY KEY,
  policy_json TEXT NOT NULL,
  updated_by TEXT NOT NULL
);`
]

const FLEET_POLICY_ID = 'fleet'

interface ModelPolicyRow {
  policy_json: string
  updated_at: number
  updated_by: string
}

/** Reads the current fleet policy, or `null` when none has ever been set ("not managed" — today's
 *  defaults everywhere). A corrupt row (hand-edited D1, a future incompatible shape) is treated the
 *  same as "not managed" rather than a 500: a broken row must never brick every seat's model choice. */
export async function readModelPolicy(db: D1DatabaseLike | undefined): Promise<ModelPolicyDocument | null> {
  if (!db) return null
  let row: ModelPolicyRow | null
  try {
    row = await db
      .prepare('SELECT policy_json, updated_at, updated_by FROM model_policy WHERE id = ?')
      .bind(FLEET_POLICY_ID)
      .first<ModelPolicyRow>()
  } catch {
    return null
  }
  if (!row) return null
  try {
    const parsed = ModelPolicyDocumentSchema.safeParse(JSON.parse(row.policy_json))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export type ModelPolicyWriteResult =
  | { ok: true; policy: ModelPolicyDocument }
  | { ok: false; error: string }

/** Validates `capabilities` against the schema and writes a fresh document (whole-document
 *  replace, not a per-key patch — the owner's "Models" form always submits all seven capabilities
 *  together, so there is no partial-update ambiguity to resolve). */
export async function writeModelPolicy(
  db: D1DatabaseLike | undefined,
  capabilities: unknown,
  actor: string,
  now: number
): Promise<ModelPolicyWriteResult> {
  if (!db) return { ok: false, error: 'db unbound' }
  const parsedCapabilities = ModelPolicyDocumentSchema.shape.capabilities.safeParse(capabilities)
  if (!parsedCapabilities.success) {
    return { ok: false, error: parsedCapabilities.error.issues[0]?.message ?? 'invalid model policy' }
  }
  const policy: ModelPolicyDocument = {
    version: now,
    updatedAt: now,
    updatedBy: actor,
    capabilities: parsedCapabilities.data
  }
  await db
    .prepare(
      `INSERT INTO model_policy (id, policy_json, updated_at, updated_by) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET policy_json = excluded.policy_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by`
    )
    .bind(FLEET_POLICY_ID, JSON.stringify(policy), now, actor)
    .run()
  // Append-only copy keyed by version; a same-millisecond re-save is a no-op rather than an error.
  await db
    .prepare('INSERT OR IGNORE INTO model_policy_history (version, policy_json, updated_by) VALUES (?, ?, ?)')
    .bind(now, JSON.stringify(policy), actor)
    .run()
  return { ok: true, policy }
}

export async function signModelPolicy(secret: string, policy: ModelPolicyDocument): Promise<string> {
  return hmacHex(secret, canonicalModelPolicyPayload(policy))
}

export async function signUnmanagedModelPolicy(secret: string, issuedAt: number): Promise<string> {
  return hmacHex(secret, canonicalUnmanagedModelPolicyPayload(issuedAt))
}

export async function verifyModelPolicySignature(
  secret: string,
  policy: ModelPolicyDocument,
  signature: string
): Promise<boolean> {
  if (!secret || !signature) return false
  const expected = await signModelPolicy(secret, policy)
  return timingSafeEqualHex(expected, signature.toLowerCase())
}

export interface ModelPolicyRefusal {
  error: string
  code: 'model_not_allowed'
  status: 403
}

/**
 * The security boundary the ticket asks for: even an old or modified client cannot bypass the fleet
 * policy, because `/v1/ask` and `/v1/use` both call this before ever touching the vault. `null` (no
 * refusal) when there is no fleet policy yet (today's defaults — "not managed") OR the exact
 * provider+model the request named is one of the capability's declared candidates (primary or a
 * fallback); the MDM `allowedProviders` narrowing is a desktop-only precedence step and is
 * deliberately not re-applied here — this check only ever needs to answer "did the owner actually
 * approve this provider+model for this capability at all". `capability` is client-supplied, so a modified
 * client can label a request with whichever capability lists the model it wants; the boundary this
 * guarantees is therefore "the model is one the owner approved for some capability the caller names",
 * never a per-route guarantee, and the model must still be an exact provider+model match.
 */
export async function enforceModelPolicy(
  db: D1DatabaseLike | undefined,
  capability: ModelPolicyCapability,
  provider: string,
  model: string
): Promise<ModelPolicyRefusal | null> {
  const policy = await readModelPolicy(db)
  if (!policy) return null
  const candidates = resolveModelPolicyCandidates(policy, capability, null)
  const ok = candidates.some((c) => c.provider === provider && c.model === model)
  if (ok) return null
  return {
    error: "This model is not permitted by your organization's fleet model policy.",
    code: 'model_not_allowed',
    status: 403
  }
}
