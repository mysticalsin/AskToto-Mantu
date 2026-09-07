/**
 * Shared license-minting core (plan section 7, B1). Both `POST /v1/admin/licenses/generate`
 * (operator/src/routes/admin-core.ts, the plain flow) and `POST
 * /v1/admin/groups/:id/licenses/generate` (operator/src/routes/groups.ts, the per-group flow) mint
 * a METIS-OP-1 token through this one function, so the minting, the `issued_licenses` write and the
 * audit row can never drift between the two callers.
 *
 * The once-string itself is returned to the caller exactly once and never stored: only its SHA-256
 * hash and last4 land in `issued_licenses`.
 */
import { sha256Hex } from '../crypto'
import {
  generateOperatorLicense,
  OPERATOR_LICENSE_MAX,
  parseOperatorLicenseDays
} from '../../../src/shared/operator-license'
import { auditMeta, safeAuditText, type AdminCtx } from '../routes/admin-ctx'

export interface MintLicenseInput {
  /** Raw, unvalidated `days` from the request body. */
  days: unknown
  groupId?: string | null
  tier?: string | null
  /** Who the license was issued to: an email or a device id. Independent of `groupId`. */
  member?: string | null
  /** The signed-in admin email. Recorded as `issued_licenses.created_by` and the audit actor. */
  actor: string
  /** Audit action name. Defaults to `generate-license` (the plain flow's existing action). */
  action?: string
}

export type MintLicenseResult =
  | {
      ok: true
      token: string
      jti: string
      last4: string
      days: number
      iat: number
      exp: number
      groupId: string | null
      tier: string | null
      member: string | null
    }
  | { ok: false; error: string; status: number }

function auditDetail(last4: string, days: number, groupId: string | null, tier: string | null, member: string | null): string {
  const parts = [`${last4} ${days}d`]
  if (groupId) parts.push(`group ${groupId}`)
  if (tier) parts.push(`tier ${tier}`)
  if (member) parts.push(`member ${safeAuditText(member)}`)
  return parts.join(' · ')
}

export async function mintOperatorLicense(ctx: AdminCtx, input: MintLicenseInput): Promise<MintLicenseResult> {
  const days = parseOperatorLicenseDays(input.days)
  if (!days) return { ok: false, error: 'days must be 1-365', status: 400 }
  const secret = ctx.env.OPERATOR_INGEST_SECRET?.trim() || ''
  if (!secret) return { ok: false, error: 'Operator ingest secret missing', status: 503 }
  const minted = await generateOperatorLicense(secret, { days, now: ctx.now })
  if (minted.token.length > OPERATOR_LICENSE_MAX) {
    return { ok: false, error: 'generated license too long', status: 500 }
  }
  const groupId = input.groupId?.trim() || null
  const tier = input.tier?.trim() || null
  const member = input.member?.trim() || null
  await ctx.store.putIssuedLicense({
    jti: minted.claims.jti,
    last4: minted.last4,
    key_hash: await sha256Hex(minted.token),
    days,
    iat: minted.claims.iat,
    exp: minted.claims.exp,
    revoked: 0,
    created_at: ctx.now,
    created_by: input.actor,
    group_id: groupId,
    tier,
    member
  })
  await ctx.store.audit(
    crypto.randomUUID(),
    ctx.now,
    input.actor,
    input.action ?? 'generate-license',
    null,
    auditDetail(minted.last4, days, groupId, tier, member),
    auditMeta(ctx)
  )
  return {
    ok: true,
    token: minted.token,
    jti: minted.claims.jti,
    last4: minted.last4,
    days,
    iat: minted.claims.iat,
    exp: minted.claims.exp,
    groupId,
    tier,
    member
  }
}
