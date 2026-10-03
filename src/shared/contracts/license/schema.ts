import { z } from 'zod'

export const APPLE_ENGINE_STATUSES = ['unsupported', 'disabled', 'available', 'unlicensed', 'unavailable'] as const
export type AppleEngineStatus = typeof APPLE_ENGINE_STATUSES[number]

// ─── Licensing (phone-home activation against a self-hosted license server; see main/license.ts) ──────
export const LicenseActivatePayloadSchema = z.object({
  serverUrl: z.string().min(1, 'Enter the license server URL.'),
  licenseKey: z.string().min(1, 'Enter a license key.')
})
export type LicenseActivatePayload = z.infer<typeof LicenseActivatePayloadSchema>

export const LicenseConfigPayloadSchema = z.object({
  serverUrl: z.string().min(1, 'Enter the license server URL.')
})
export type LicenseConfigPayload = z.infer<typeof LicenseConfigPayloadSchema>

/** Result of an activate/heartbeat call. `error` carries either the server's own code ('invalid' |
 *  'revoked' | 'expired' | 'seat_limit_reached') or a client-side code for cases the server never sees:
 *  'network' (unreachable or a malformed response) and 'not_activated' (heartbeat with no activation on
 *  file yet). Settings.tsx maps every code to plain-language copy. */
export interface LicenseActivateResult {
  ok: boolean
  error?: string
  companyName?: string
  seatCap?: number
  expiresAt?: number | null
  /** Compact signed offline lease (MQA-282), when this server has lease signing configured. Absent on
   *  an unconfigured/older server — additive-only, see license-server/README.md. */
  lease?: string
}

/** Cached license state for display — read straight from settings, no network call (see the
 *  license:status handler). Deliberately excludes seatsUsed: that's only a point-in-time snapshot from
 *  the last activate/heartbeat response, not a live count, so the UI shows seatCap only. */
export interface LicenseStatusResult {
  licenseServerUrl: string
  licenseCompanyName: string
  licenseSeatCap: number
  licenseExpiresAt: number | null
  licenseValid: boolean
  licenseLastValidatedAt: number
  licenseGateEnabled: boolean
  /** Act 5 (MQA-281/282) — live-verified lease/trial status, independent of licenseGateEnabled (see
   *  main/license.ts's licenseDisplayStatus). null/false/0 whenever neither applies. */
  leaseExpiresAt: number | null
  trialActive: boolean
  trialDaysRemaining: number
}

/** Startup-gate verdict for App.tsx's boot gate, derived by calling checkLicenseGrace() fresh on every
 *  call (see the license:gate handler in main/index.ts). Deliberately its own small shape rather than a
 *  field on LicenseStatusResult: license:status is gated behind requireAuth() (an SSO-signed-in check),
 *  but this channel must be reachable even when signed out — a revoked or unlicensed device has to learn
 *  that BEFORE burning an SSO round trip, not after (license outranks SSO in App.tsx's gate order). */
export interface LicenseGateVerdict {
  gateEnabled: boolean
  allowed: boolean
  reason?: 'not_activated' | 'expired_grace' | 'trial_expired'
  leaseExpiresAt?: number
  trialActive?: boolean
  trialDaysRemaining?: number
}

/** GET /license/config's declared-intent pair (license-server's lib/license-gate.mjs) — informational
 *  only, read by the ActLicense onboarding scene. `error` mirrors LicenseActivateResult's client-side
 *  codes ('network' for unreachable/malformed; the server route itself never returns a business error). */
export interface LicenseConfigResult {
  ok: boolean
  error?: string
  licenseEnforcement?: boolean
  licenseUiEnabled?: boolean
  drift?: boolean
}

export {
  LICENSE_ACTIVATION_OPEN,
  MemberActivatePayloadSchema,
  emptyLicenseStatus,
  type IdentitySnapshot,
  type MemberActivatePayload,
  type MemberActivateResult,
  type MemberLicenseStatus
} from '../../license-types'
