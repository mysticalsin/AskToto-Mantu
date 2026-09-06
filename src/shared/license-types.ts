/**
 * Métis member-pass + offline-first license types.
 *
 * Extends the existing phone-home product (`src/main/license.ts`, `license-server/`).
 * This is not a second license system. Binding contract: docs/design/IDENTITY-CARD.md
 * and docs/license-v1.openapi.yaml.
 *
 * LICENSE_ACTIVATION_OPEN is the selling switch. It ships false. Flipping it is a
 * deliberate later change, together with a live server and a minting key ceremony.
 */
import { z } from 'zod'

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
