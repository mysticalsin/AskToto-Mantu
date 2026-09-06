/**
 * License renew / decline-to-renew (plan 6.7 block 0 "Needs your review", task B11), the two
 * mutations the Licenses page's expiring segment calls. HTTP wiring lives in
 * `operator/src/routes/review-queue.ts`; this module owns only the logic and the store writes, the
 * same split `../licenses/generate.ts` uses for minting.
 *
 * Approve and revoke already exist on the seat/license routes (`admin-core.ts`'s
 * `licenseOrSeatAction`, reached through `POST /v1/admin/licenses/:id/(approve|revoke)`) and are
 * not duplicated here.
 */
import { parseOperatorLicenseDays } from '../../../src/shared/operator-license'
import { issuedLicenseActive } from '../fleet'
import type { IssuedLicenseRow } from '../store'
import { auditLog, type AdminCtx } from '../routes/admin-ctx'

const DAY_MS = 24 * 60 * 60 * 1000
/** How long a license may sit expired and still be renewed in place rather than replaced by a new
 *  one. Beyond this the seat has been unlicensed long enough that a fresh Generate is the honest
 *  action, not a renewal. */
const RENEW_GRACE_MS = 30 * DAY_MS

export interface RenewedLicense {
  jti: string
  last4: string
  tier: string | null
  groupId: string | null
  member: string | null
  days: number
  exp: number
  revoked: boolean
  activatedDevice: string | null
  activatedAt: number | null
  renewalNote: string | null
}

export type LicenseMutationResult =
  | { ok: true; license: RenewedLicense }
  | { ok: false; error: string; status: number; code?: string }

function toRenewedLicense(row: IssuedLicenseRow): RenewedLicense {
  return {
    jti: row.jti,
    last4: row.last4,
    tier: row.tier ?? null,
    groupId: row.group_id ?? null,
    member: row.member ?? null,
    days: row.days,
    exp: row.exp,
    revoked: Boolean(row.revoked),
    activatedDevice: row.activated_device ?? null,
    activatedAt: row.activated_at ?? null,
    renewalNote: row.renewal_note ?? null
  }
}

/** Extends `exp` by `rawDays` (1 to 365) from the license's current `exp`, or from now when it
 *  expired within the last 30 days. Refuses a revoked license, an invalid `days`, and a license
 *  expired more than 30 days ago (`code: 'expired-too-long'`, generate a new one instead). Audits
 *  `license-renew` with only the last4 and the before/after `exp`, never member, group or tier. */
export async function renewLicense(ctx: AdminCtx, jti: string, rawDays: unknown): Promise<LicenseMutationResult> {
  const license = await ctx.store.getIssuedLicense(jti)
  if (!license) return { ok: false, error: 'not found', status: 404 }
  if (license.revoked) {
    return { ok: false, error: 'this license is revoked and cannot be renewed', status: 409, code: 'revoked' }
  }
  const days = parseOperatorLicenseDays(rawDays)
  if (!days) return { ok: false, error: 'days must be 1-365', status: 400 }

  const nowSec = Math.floor(ctx.now / 1000)
  let baseSec: number
  if (issuedLicenseActive(license, ctx.now)) {
    baseSec = license.exp
  } else {
    const expiredForMs = ctx.now - license.exp * 1000
    if (expiredForMs > RENEW_GRACE_MS) {
      return {
        ok: false,
        error: 'this license expired more than 30 days ago and can no longer be renewed, generate a new one instead',
        status: 409,
        code: 'expired-too-long'
      }
    }
    baseSec = nowSec
  }

  const beforeExp = license.exp
  const afterExp = baseSec + days * 86400
  await ctx.store.updateIssuedLicense(jti, { exp: afterExp })
  await auditLog(ctx, 'license-renew', null, `${license.last4} exp ${beforeExp} -> ${afterExp}`)
  return { ok: true, license: toRenewedLicense({ ...license, exp: afterExp }) }
}

/** Marks a license "do not renew" without touching `exp` or `revoked`: the seat keeps working until
 *  the license actually expires on its own, Tony just will not be asked about it again. */
export async function declineLicenseRenewal(ctx: AdminCtx, jti: string): Promise<LicenseMutationResult> {
  const license = await ctx.store.getIssuedLicense(jti)
  if (!license) return { ok: false, error: 'not found', status: 404 }
  await ctx.store.updateIssuedLicense(jti, { renewal_note: 'declined' })
  await auditLog(ctx, 'license-expire-declined', null, `${license.last4} declined`)
  return { ok: true, license: toRenewedLicense({ ...license, renewal_note: 'declined' }) }
}
