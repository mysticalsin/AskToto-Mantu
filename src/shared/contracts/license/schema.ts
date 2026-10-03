import { z } from 'zod'

export const APPLE_ENGINE_STATUSES = ['unsupported', 'disabled', 'available', 'unlicensed', 'unavailable'] as const
export type AppleEngineStatus = typeof APPLE_ENGINE_STATUSES[number]

/** Selling switch. False in this change: Activate runs the real client path and
 *  returns ActivationUnavailable. Never silently no-op. Never pretend success. */
export const LICENSE_ACTIVATION_OPEN = false

export const LICENSE_KID = 'metis-2026-1'
export const LICENSE_ISSUER = 'metis-license'
export const DEVICE_HASH_PREFIX = 'metis-device-v1'
export const DEFAULT_GRACE_DAYS = 14

export type LicenseEdition = 'personal' | 'pro' | 'enterprise'
export type LicenseState = 'unlicensed' | 'licensed' | 'grace' | 'expired'
export type LicenseSource = 'none' | 'cache' | 'mdm' | 'file'
export type SerialKind = 'hardware' | 'install'

export type MemberLicenseError =
  | 'activation_unavailable'
  | 'invalid'
  | 'tampered'
  | 'wrong_kid'
  | 'wrong_device'
  | 'expired'
  | 'not_activated'
  | 'network'

export const LicenseClaimsSchema = z.object({
  iss: z.literal(LICENSE_ISSUER),
  sub: z.string().min(1),
  edition: z.enum(['personal', 'pro', 'enterprise']),
  seats: z.number().int().positive(),
  exp: z.number().int(),
  nbf: z.number().int().optional(),
  iat: z.number().int().optional(),
  features: z.array(z.string()).default([]),
  orgId: z.string().min(1).optional(),
  kid: z.string().min(1),
  graceDays: z.number().int().nonnegative().default(DEFAULT_GRACE_DAYS)
})
export type LicenseClaims = z.infer<typeof LicenseClaimsSchema>

export const V1ActivateRequestSchema = z.object({
  licenseKey: z.string().trim().min(1).max(200),
  deviceIdHash: z.string().regex(/^[0-9a-f]{64}$/),
  appVersion: z.string().min(1).max(64),
  os: z.string().min(1).max(32)
})
export type V1ActivateRequest = z.infer<typeof V1ActivateRequestSchema>

export const V1ActivateOkSchema = z.object({
  ok: z.literal(true),
  jws: z.string().min(1)
})
export const V1ActivateErrSchema = z.object({
  ok: z.literal(false),
  error: z.enum([
    'activation_unavailable',
    'invalid',
    'revoked',
    'expired',
    'seat_limit_reached',
    'not_activated',
    'network'
  ])
})
export const V1ActivateResponseSchema = z.union([V1ActivateOkSchema, V1ActivateErrSchema])
export type V1ActivateResponse = z.infer<typeof V1ActivateResponseSchema>

export const V1RegisterRequestSchema = z.object({
  installId: z.string().uuid(),
  appVersion: z.string().min(1).max(64),
  os: z.string().min(1).max(32)
})
export type V1RegisterRequest = z.infer<typeof V1RegisterRequestSchema>

export const V1RegisterOkSchema = z.object({
  ok: z.literal(true),
  memberNumber: z.number().int().positive()
})
export const V1RegisterErrSchema = z.object({
  ok: z.literal(false),
  error: z.enum(['activation_unavailable', 'network'])
})
export const V1RegisterResponseSchema = z.union([V1RegisterOkSchema, V1RegisterErrSchema])
export type V1RegisterResponse = z.infer<typeof V1RegisterResponseSchema>

export interface MemberLicenseStatus {
  state: LicenseState
  edition: LicenseEdition
  seats: number | null
  expiresAt: number | null
  features: string[]
  orgId: string | null
  source: LicenseSource
  activationOpen: boolean
  managedFilePresent: boolean
  error?: MemberLicenseError
}

export interface MemberActivateResult {
  ok: boolean
  error?: MemberLicenseError
  status: MemberLicenseStatus
}

export interface IdentitySnapshot {
  installId: string
  installedAt: string
  installedAtLabel: string
  memberNumber: number | null
  memberNumberLabel: string
  deviceName: string
  serialKind: SerialKind
  serialDisplay: string
  license: MemberLicenseStatus
}

export const MemberActivatePayloadSchema = z.object({
  licenseKey: z.string().min(1, 'Enter the license key you were given.').max(200)
})
export type MemberActivatePayload = z.infer<typeof MemberActivatePayloadSchema>

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

export function emptyLicenseStatus(partial: Partial<MemberLicenseStatus> = {}): MemberLicenseStatus {
  return {
    state: 'unlicensed',
    edition: 'personal',
    seats: null,
    expiresAt: null,
    features: [],
    orgId: null,
    source: 'none',
    activationOpen: LICENSE_ACTIVATION_OPEN,
    managedFilePresent: false,
    ...partial
  }
}
